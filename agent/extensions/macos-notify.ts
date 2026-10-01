import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NOTIFICATION_DELAY_MS = 750;
const SUBAGENT_RPC_TIMEOUT_MS = 500;
const MIN_NOTIFICATION_INTERVAL_MS = 2_000;
// This is an optional, cross-extension integration rather than a core Pi lifecycle signal.
// Keep it event-only: when pi-subagents is absent, the probe times out harmlessly and
// notifications fall back to Pi's settled/idle state without requiring that package.
const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ITERM2_TAB_ATTENTION_COLOR = { red: 255, green: 180, blue: 0 } as const;
const FOCUS_IN_SEQUENCE = "\x1b[I";
const FOCUS_OUT_SEQUENCE = "\x1b[O";

type NotificationMethod = "iterm2" | "macos" | "none";

type SubagentRpcReply = {
	version?: number;
	requestId?: string;
	method?: string;
	success?: boolean;
	data?: unknown;
};

type SubagentPingData = {
	version?: number;
	capabilities?: {
		fleetStatus?: {
			version?: number;
		};
	};
};

type SubagentStatusData = {
	fleet?: {
		version?: number;
		totalActive?: number;
	};
};

function isITerm2(): boolean {
	return process.env.TERM_PROGRAM === "iTerm.app" || !!process.env.ITERM_SESSION_ID;
}

function compact(value: string, maxLength = 120): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function terminalNotificationString(value: string): string {
	// OSC strings are terminated with BEL/ST. Strip terminal control characters so
	// notification text cannot accidentally terminate the escape sequence.
	return compact(value, 180).replace(/[\x00-\x1f\x7f\x9b]/g, " ");
}

function appleScriptString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeITerm2Sequence(sequence: string): boolean {
	if (!isITerm2() || !process.stdout.isTTY) return false;
	process.stdout.write(sequence);
	return true;
}

function notifyITerm2(message: string): boolean {
	// iTerm2 OSC 9 posts a native notification associated with the session that
	// emitted it. Clicking the notification focuses that originating tab/pane.
	return writeITerm2Sequence(`\x1b]9;${terminalNotificationString(message)}\x07`);
}

function setITerm2TabColor(color: { red: number; green: number; blue: number }): boolean {
	return writeITerm2Sequence(
		`\x1b]6;1;bg;red;brightness;${color.red}\x07` +
			`\x1b]6;1;bg;green;brightness;${color.green}\x07` +
			`\x1b]6;1;bg;blue;brightness;${color.blue}\x07`,
	);
}

function resetITerm2TabColor(): boolean {
	return writeITerm2Sequence("\x1b]6;1;bg;*;default\x07");
}

function enableTerminalFocusReporting(): boolean {
	return writeITerm2Sequence("\x1b[?1004h");
}

function disableTerminalFocusReporting(): boolean {
	return writeITerm2Sequence("\x1b[?1004l");
}

async function notifyMacOS(title: string, body: string, subtitle?: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;

	const parts = [
		`display notification ${appleScriptString(compact(body, 220))}`,
		`with title ${appleScriptString(compact(title, 80))}`,
	];

	if (subtitle) {
		parts.push(`subtitle ${appleScriptString(compact(subtitle, 80))}`);
	}

	parts.push('sound name "Glass"');

	try {
		await execFileAsync("osascript", ["-e", parts.join(" ")]);
		return true;
	} catch {
		// Notifications are best-effort. Keep pi running if macOS notification
		// permissions are missing or osascript is unavailable.
		return false;
	}
}

async function notifyAttention(project: string, test = false): Promise<NotificationMethod> {
	const body = test ? "macOS notifications are working." : "The agent is done and ready for input.";

	if (notifyITerm2(`pi needs attention — ${project}: ${body}`)) {
		return "iterm2";
	}

	if (await notifyMacOS("pi needs attention", body, project)) {
		return "macos";
	}

	return "none";
}

export default function (pi: ExtensionAPI) {
	let lastNotificationAt = 0;
	let notificationGeneration = 0;
	let terminalFocused = true;
	let tabColorState: "default" | "attention" = "default";
	let focusReportingEnabled = false;
	let focusListener: ((chunk: Buffer | string) => void) | undefined;
	let subagentFleetStatusAvailable = false;
	const pendingTimers = new Set<NodeJS.Timeout>();
	const pendingRpcCancellations = new Set<() => void>();

	function clearPendingTimers(): void {
		for (const timer of pendingTimers) clearTimeout(timer);
		pendingTimers.clear();
	}

	function cancelPendingRpcRequests(): void {
		for (const cancel of [...pendingRpcCancellations]) cancel();
	}

	function setAttentionTabColor(): void {
		if (tabColorState === "attention" || terminalFocused) return;
		if (setITerm2TabColor(ITERM2_TAB_ATTENTION_COLOR)) tabColorState = "attention";
	}

	function resetTabColor(): void {
		if (tabColorState === "default") return;
		if (resetITerm2TabColor()) tabColorState = "default";
	}

	function installFocusListener(): void {
		if (focusListener || !isITerm2() || !process.stdin.isTTY || !process.stdout.isTTY) return;

		focusListener = (chunk: Buffer | string) => {
			const text = chunk.toString("utf8");
			const focusInIndex = text.lastIndexOf(FOCUS_IN_SEQUENCE);
			const focusOutIndex = text.lastIndexOf(FOCUS_OUT_SEQUENCE);

			if (focusInIndex > focusOutIndex) {
				terminalFocused = true;
				resetTabColor();
			} else if (focusOutIndex > focusInIndex) {
				terminalFocused = false;
			}
		};

		process.stdin.on("data", focusListener);
		focusReportingEnabled = enableTerminalFocusReporting();
	}

	function uninstallFocusListener(): void {
		if (focusListener) {
			process.stdin.off("data", focusListener);
			focusListener = undefined;
		}
		if (focusReportingEnabled) {
			disableTerminalFocusReporting();
			focusReportingEnabled = false;
		}
	}

	function supportsFleetStatus(value: unknown): boolean {
		const data = value as SubagentPingData;
		return (
			data?.version === SUBAGENT_RPC_PROTOCOL_VERSION &&
			data.capabilities?.fleetStatus?.version === SUBAGENT_RPC_PROTOCOL_VERSION
		);
	}

	async function requestSubagentRpc(method: "ping" | "status"): Promise<SubagentRpcReply | undefined> {
		const requestId = randomUUID();
		const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;

		return new Promise((resolve) => {
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = () => {};
			const finish = (reply: SubagentRpcReply | undefined) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				pendingRpcCancellations.delete(cancel);
				resolve(reply);
			};
			const cancel = () => finish(undefined);

			unsubscribe = pi.events.on(replyEvent, (value) => {
				const reply = value as SubagentRpcReply;
				if (reply?.requestId === requestId) finish(reply);
			});
			pendingRpcCancellations.add(cancel);
			timeout = setTimeout(cancel, SUBAGENT_RPC_TIMEOUT_MS);
			timeout.unref?.();

			pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
				version: SUBAGENT_RPC_PROTOCOL_VERSION,
				requestId,
				method,
				params: {},
			});
		});
	}

	function validRpcReply(reply: SubagentRpcReply | undefined, requestMethod: "ping" | "status"): boolean {
		return (
			reply?.version === SUBAGENT_RPC_PROTOCOL_VERSION &&
			reply.method === requestMethod &&
			reply.success === true
		);
	}

	async function detectSubagentFleetStatus(): Promise<void> {
		const reply = await requestSubagentRpc("ping");
		if (validRpcReply(reply, "ping")) {
			subagentFleetStatusAvailable = supportsFleetStatus(reply?.data);
		}
	}

	async function shouldSuppressForSubagents(): Promise<boolean> {
		if (!subagentFleetStatusAvailable) return false;

		const reply = await requestSubagentRpc("status");
		if (!validRpcReply(reply, "status")) return true;

		const data = reply?.data as SubagentStatusData;
		const fleet = data?.fleet;
		if (
			fleet?.version !== SUBAGENT_RPC_PROTOCOL_VERSION ||
			typeof fleet.totalActive !== "number" ||
			!Number.isSafeInteger(fleet.totalActive) ||
			fleet.totalActive < 0
		) {
			return true;
		}

		return fleet.totalActive > 0;
	}

	function scheduleAttentionNotification(ctx: ExtensionContext): void {
		if (process.platform !== "darwin" || !ctx.hasUI) return;

		const generation = ++notificationGeneration;
		const timer = setTimeout(async () => {
			pendingTimers.delete(timer);

			if (!ctx.isIdle() || ctx.hasPendingMessages() || (await shouldSuppressForSubagents())) return;
			if (generation !== notificationGeneration || !ctx.isIdle() || ctx.hasPendingMessages()) return;

			setAttentionTabColor();

			const now = Date.now();
			if (now - lastNotificationAt < MIN_NOTIFICATION_INTERVAL_MS) return;
			lastNotificationAt = now;

			const project = basename(ctx.cwd) || ctx.cwd;
			void notifyAttention(project);
		}, NOTIFICATION_DELAY_MS);

		timer.unref?.();
		pendingTimers.add(timer);
	}

	const unsubscribeSubagentReady = pi.events.on(SUBAGENT_RPC_READY_EVENT, (value) => {
		subagentFleetStatusAvailable = supportsFleetStatus(value);
	});

	pi.on("session_start", (_event, ctx) => {
		subagentFleetStatusAvailable = false;
		if (ctx.mode === "tui") installFocusListener();
		void detectSubagentFleetStatus();
	});

	pi.on("agent_start", async () => {
		notificationGeneration++;
		clearPendingTimers();
		cancelPendingRpcRequests();
		resetTabColor();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		scheduleAttentionNotification(ctx);
	});

	pi.on("session_shutdown", async () => {
		notificationGeneration++;
		clearPendingTimers();
		cancelPendingRpcRequests();
		unsubscribeSubagentReady();
		resetTabColor();
		uninstallFocusListener();
	});

	pi.registerCommand("mac-notify-test", {
		description: "Send a test macOS/iTerm2 notification and attention tab color",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "reset") {
				resetTabColor();
				ctx.ui.notify("Reset iTerm2 tab color", "info");
				return;
			}

			if (setITerm2TabColor(ITERM2_TAB_ATTENTION_COLOR)) tabColorState = "attention";
			const method = await notifyAttention(basename(ctx.cwd) || ctx.cwd, true);
			const message =
				method === "iterm2"
					? "Sent iTerm2 notification test and set attention tab color"
					: method === "macos"
						? "Sent macOS notification test (iTerm2 not detected)"
						: "Could not send notification";
			ctx.ui.notify(`${message}; run /mac-notify-test reset to clear`, method === "none" ? "warning" : "info");
		},
	});
}
