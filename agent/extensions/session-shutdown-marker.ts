import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "session-shutdown-marker";

interface SessionShutdownMarkerData {
	sessionComplete: boolean;
	reason: string;
	pid: number;
	sessionId: string;
	sessionFile?: string;
	targetSessionFile?: string;
	recordedAt: string;
}

function isSessionShutdownMarker(entry: unknown): entry is {
	type: "custom";
	customType: typeof CUSTOM_TYPE;
	data?: { sessionComplete?: unknown };
} {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; customType?: unknown };
	return candidate.type === "custom" && candidate.customType === CUSTOM_TYPE;
}

export default function sessionShutdownMarker(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		let latestMarker: { data?: { sessionComplete?: unknown } } | undefined;
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index];
			if (isSessionShutdownMarker(entry)) {
				latestMarker = entry;
				break;
			}
		}

		// Legacy shutdown markers have no sessionComplete field and represent true.
		if (!latestMarker || latestMarker.data?.sessionComplete === false) {
			return;
		}

		pi.appendEntry<SessionShutdownMarkerData>(CUSTOM_TYPE, {
			sessionComplete: false,
			reason: event.reason,
			pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			recordedAt: new Date().toISOString(),
		});
	});

	pi.on("session_shutdown", (event, ctx) => {
		pi.appendEntry<SessionShutdownMarkerData>(CUSTOM_TYPE, {
			sessionComplete: true,
			reason: event.reason,
			pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			targetSessionFile: event.targetSessionFile,
			recordedAt: new Date().toISOString(),
		});
	});
}
