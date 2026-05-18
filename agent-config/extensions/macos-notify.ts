import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NOTIFICATION_DELAY_MS = 750;
const MIN_NOTIFICATION_INTERVAL_MS = 2_000;

type NotificationMethod = "iterm2" | "macos" | "none";

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

function notifyITerm2(message: string): boolean {
	if (!isITerm2() || !process.stdout.isTTY) return false;

	// iTerm2 OSC 9 posts a native notification associated with the session that
	// emitted it. Clicking the notification focuses that originating tab/pane.
	process.stdout.write(`\x1b]9;${terminalNotificationString(message)}\x07`);
	return true;
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
	const pendingTimers = new Set<NodeJS.Timeout>();

	function clearPendingTimers(): void {
		for (const timer of pendingTimers) clearTimeout(timer);
		pendingTimers.clear();
	}

	function scheduleAttentionNotification(ctx: ExtensionContext): void {
		if (process.platform !== "darwin" || !ctx.hasUI) return;

		const timer = setTimeout(() => {
			pendingTimers.delete(timer);

			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

			const now = Date.now();
			if (now - lastNotificationAt < MIN_NOTIFICATION_INTERVAL_MS) return;
			lastNotificationAt = now;

			const project = basename(ctx.cwd) || ctx.cwd;
			void notifyAttention(project);
		}, NOTIFICATION_DELAY_MS);

		timer.unref?.();
		pendingTimers.add(timer);
	}

	pi.on("agent_end", async (_event, ctx) => {
		scheduleAttentionNotification(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearPendingTimers();
	});

	pi.registerCommand("mac-notify-test", {
		description: "Send a test macOS/iTerm2 notification",
		handler: async (_args, ctx) => {
			const method = await notifyAttention(basename(ctx.cwd) || ctx.cwd, true);
			const message =
				method === "iterm2"
					? "Sent iTerm2 notification test"
					: method === "macos"
						? "Sent macOS notification test (iTerm2 not detected)"
						: "Could not send notification";
			ctx.ui.notify(message, method === "none" ? "warning" : "info");
		},
	});
}
