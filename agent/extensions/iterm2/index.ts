import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
    clearStatusSequence,
    integrationEnabled,
    notificationSequence,
    statusSequence,
    titleSequence,
    userVariableSequence,
} from "./lib.ts";
import { observePromptMarkers } from "./prompt-markers.ts";

const STATUS_REPAIR_DELAY_MS = 75;
const STATUS_REPAIR_MAX_DELAY_MS = 250;
const NOTIFICATION_DELAY_MS = 750;
const MIN_NOTIFICATION_INTERVAL_MS = 2_000;
const SUBAGENT_RPC_TIMEOUT_MS = 500;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SESSION_VARIABLES = ["pi_session_file", "pi_session_id", "pi_session_name", "pi_cwd"] as const;

type RpcReply = {
    version?: number;
    requestId?: string;
    method?: string;
    success?: boolean;
    data?: unknown;
};

type PingData = { version?: number; capabilities?: { fleetStatus?: { version?: number } } };
type FleetData = { fleet?: { version?: number; totalActive?: number } };

export interface TerminalOutput {
    enabled(): boolean;
    write(sequence: string): void;
    observePromptMarkers(onPromptStart: () => void): () => void;
}

const terminal: TerminalOutput = {
    enabled: () => integrationEnabled(process.env, Boolean(process.stdout.isTTY)),
    write: (sequence) => { process.stdout.write(sequence); },
    observePromptMarkers: (onPromptStart) => observePromptMarkers(process.stdout, onPromptStart),
};

export function installITerm2Integration(pi: ExtensionAPI, output: TerminalOutput): void {
    let active = false;
    let prompt: { kind: string; title?: string } | undefined;
    let sessionName: string | undefined;
    let lastStatus: string | undefined;
    let lastNotificationAt = Number.NEGATIVE_INFINITY;
    let generation = 0;
    let notificationTimer: ReturnType<typeof setTimeout> | undefined;
    let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let statusRepairTimer: ReturnType<typeof setTimeout> | undefined;
    let firstInvalidatedAt: number | undefined;
    let stopObservingOutput: (() => void) | undefined;
    let subagentFleetStatusAvailable = false;
    const pendingRpcCancellations = new Set<() => void>();

    function cancelAttention(): void {
        generation++;
        if (notificationTimer) clearTimeout(notificationTimer);
        notificationTimer = undefined;
        for (const cancel of [...pendingRpcCancellations]) cancel();
    }

    function publishStatus(ctx: ExtensionContext, force = false): void {
        if (!active) return;
        const status = prompt ? "Waiting" : ctx.isIdle() ? "Idle" : "Working";
        const detail = prompt ? prompt.title || "Custom interaction" : "";
        const sequence = statusSequence(status, detail);
        if (force || sequence !== lastStatus) {
            output.write(sequence);
            lastStatus = sequence;
        }
    }

    function stopStatusRepair(): void {
        stopObservingOutput?.();
        stopObservingOutput = undefined;
        if (statusRepairTimer) clearTimeout(statusRepairTimer);
        statusRepairTimer = undefined;
        firstInvalidatedAt = undefined;
    }

    function repairAfterPrompt(ctx: ExtensionContext): void {
        if (!active) return;
        // iTerm2 asynchronously clears tab status on OSC 133;A. Reassert after
        // the redraw instead of trusting the extension's cached status. Debounce
        // batches, but cap the delay so streaming output cannot starve repairs.
        lastStatus = undefined;
        const now = Date.now();
        firstInvalidatedAt ??= now;
        if (statusRepairTimer) clearTimeout(statusRepairTimer);
        const delay = Math.min(STATUS_REPAIR_DELAY_MS,
            Math.max(0, firstInvalidatedAt + STATUS_REPAIR_MAX_DELAY_MS - now));
        statusRepairTimer = setTimeout(() => {
            statusRepairTimer = undefined;
            firstInvalidatedAt = undefined;
            publishStatus(ctx, true);
        }, delay);
        statusRepairTimer.unref?.();
    }

    function cancelStatusRefresh(): void {
        if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
        statusRefreshTimer = undefined;
    }

    function refreshAfterCompaction(ctx: ExtensionContext): void {
        cancelStatusRefresh();
        // session_compact runs before Pi clears its compaction busy flag. Later
        // extension handlers can also await work, so one deferred refresh is not
        // sufficient. Stop once idle; new agent work still reports Working.
        const refresh = () => {
            statusRefreshTimer = undefined;
            if (!active) return;
            publishStatus(ctx);
            if (!ctx.isIdle()) {
                statusRefreshTimer = setTimeout(refresh, 100);
                statusRefreshTimer.unref?.();
            }
        };
        statusRefreshTimer = setTimeout(refresh, 100);
        statusRefreshTimer.unref?.();
    }

    function publishIdentity(ctx: ExtensionContext): void {
        if (!active) return;
        output.write(titleSequence(sessionName));
        const values = [
            ctx.sessionManager.getSessionFile() ?? "",
            ctx.sessionManager.getSessionId(),
            sessionName ?? "",
            ctx.cwd,
        ];
        SESSION_VARIABLES.forEach((name, index) => output.write(userVariableSequence(name, values[index])));
    }

    function supportsFleetStatus(value: unknown): boolean {
        const data = value as PingData | undefined;
        return data?.version === 1 && data.capabilities?.fleetStatus?.version === 1;
    }

    function requestSubagentRpc(method: "ping" | "status"): Promise<RpcReply | undefined> {
        const requestId = randomUUID();
        const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
        return new Promise((resolve) => {
            let settled = false;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let unsubscribe = () => {};
            const finish = (reply: RpcReply | undefined) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                unsubscribe();
                pendingRpcCancellations.delete(cancel);
                resolve(reply);
            };
            const cancel = () => finish(undefined);
            unsubscribe = pi.events.on(replyEvent, (value) => {
                const reply = value as RpcReply | undefined;
                if (reply?.requestId === requestId) finish(reply);
            });
            pendingRpcCancellations.add(cancel);
            timeout = setTimeout(cancel, SUBAGENT_RPC_TIMEOUT_MS);
            timeout.unref?.();
            pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method, params: {} });
        });
    }

    function validReply(reply: RpcReply | undefined, method: "ping" | "status"): boolean {
        return reply?.version === 1 && reply.method === method && reply.success === true;
    }

    async function detectSubagents(): Promise<void> {
        const requestGeneration = generation;
        const reply = await requestSubagentRpc("ping");
        if (active && generation === requestGeneration && validReply(reply, "ping")) {
            subagentFleetStatusAvailable = supportsFleetStatus(reply?.data);
        }
    }

    async function suppressCompletion(): Promise<boolean> {
        if (!subagentFleetStatusAvailable) return false;
        const reply = await requestSubagentRpc("status");
        if (!validReply(reply, "status")) return true;
        const fleet = (reply?.data as FleetData | undefined)?.fleet;
        return fleet?.version !== 1 || typeof fleet.totalActive !== "number" ||
            !Number.isSafeInteger(fleet.totalActive) || fleet.totalActive < 0 || fleet.totalActive > 0;
    }

    function notifyAttention(ctx: ExtensionContext, message: string): void {
        const now = Date.now();
        if (now - lastNotificationAt < MIN_NOTIFICATION_INTERVAL_MS) return;
        lastNotificationAt = now;
        output.write(notificationSequence(`pi needs attention: ${sessionName || basename(ctx.cwd)}: ${message}`));
    }

    function scheduleCompletion(ctx: ExtensionContext): void {
        if (!active) return;
        cancelAttention();
        const requestGeneration = generation;
        notificationTimer = setTimeout(async () => {
            notificationTimer = undefined;
            if (!active || prompt || !ctx.isIdle() || ctx.hasPendingMessages()) return;
            if (await suppressCompletion()) return;
            if (!active || generation !== requestGeneration || prompt || !ctx.isIdle() || ctx.hasPendingMessages()) return;
            notifyAttention(ctx, "The agent is done and ready for input.");
        }, NOTIFICATION_DELAY_MS);
        notificationTimer.unref?.();
    }

    const unsubscribeReady = pi.events.on(SUBAGENT_RPC_READY_EVENT, (value) => {
        if (active) subagentFleetStatusAvailable = supportsFleetStatus(value);
    });

    pi.on("session_start", (_event, ctx) => {
        cancelAttention();
        cancelStatusRefresh();
        stopStatusRepair();
        active = ctx.mode === "tui" && output.enabled();
        prompt = undefined;
        lastStatus = undefined;
        subagentFleetStatusAvailable = false;
        sessionName = pi.getSessionName();
        if (!active) return;
        stopObservingOutput = output.observePromptMarkers(() => repairAfterPrompt(ctx));
        publishIdentity(ctx);
        publishStatus(ctx, true);
        void detectSubagents();
    });

    pi.on("session_info_changed", (event, ctx) => {
        sessionName = event.name;
        publishIdentity(ctx);
        publishStatus(ctx);
    });

    pi.on("agent_start", (_event, ctx) => {
        if (!active) return;
        cancelAttention();
        publishStatus(ctx);
    });

    pi.on("agent_settled", (_event, ctx) => {
        if (!active) return;
        publishStatus(ctx);
        scheduleCompletion(ctx);
    });

    pi.on("session_before_compact", (event, ctx) => {
        if (!active || event.reason !== "manual") return;
        cancelAttention();
        publishStatus(ctx);
    });

    pi.on("session_compact", (event, ctx) => {
        if (active && event.reason === "manual") refreshAfterCompaction(ctx);
    });

    pi.on("session_compact_failed", (event, ctx) => {
        if (!active || event.reason !== "manual") return;
        publishStatus(ctx);
        if (!ctx.isIdle()) refreshAfterCompaction(ctx);
    });

    // These public events cover all ctx.ui prompts, including custom UI. Pi emits
    // only the outer start/end pair for overlapping prompts and cleans up failures.
    pi.on("ui_prompt_start", (event, ctx) => {
        if (!active) return;
        cancelAttention();
        prompt = { kind: event.kind, title: event.title };
        publishStatus(ctx);
        // Approval waits need attention even while a run or subagent is active.
        notifyAttention(ctx, event.title || "An interaction is waiting for input.");
    });

    pi.on("ui_prompt_end", (_event, ctx) => {
        if (!active) return;
        prompt = undefined;
        publishStatus(ctx);
    });

    pi.on("session_shutdown", () => {
        cancelAttention();
        cancelStatusRefresh();
        stopStatusRepair();
        unsubscribeReady();
        if (active) {
            output.write(clearStatusSequence());
            SESSION_VARIABLES.forEach((name) => output.write(userVariableSequence(name, "")));
        }
        active = false;
        prompt = undefined;
    });

    pi.registerCommand("iterm2-test", {
        description: "Test native iTerm2 status and attention notifications",
        handler: async (_args, ctx) => {
            if (!active || ctx.mode !== "tui") {
                ctx.ui.notify("iTerm2 integration requires a native interactive iTerm2 session outside Herdr.", "info");
                return;
            }
            publishIdentity(ctx);
            publishStatus(ctx, true);
            output.write(notificationSequence("Pi iTerm2 notifications are working."));
            ctx.ui.notify("Sent an iTerm2 notification and refreshed tab status.", "info");
        },
    });
}

export default function iterm2(pi: ExtensionAPI): void {
    installITerm2Integration(pi, terminal);
}
