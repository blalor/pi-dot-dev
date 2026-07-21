import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "session-shutdown-marker";

interface SessionShutdownMarkerData {
	reason: string;
	pid: number;
	sessionId: string;
	sessionFile?: string;
	targetSessionFile?: string;
	recordedAt: string;
}

export default function sessionShutdownMarker(pi: ExtensionAPI) {
	pi.on("session_shutdown", (event, ctx) => {
		pi.appendEntry<SessionShutdownMarkerData>(CUSTOM_TYPE, {
			reason: event.reason,
			pid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			targetSessionFile: event.targetSessionFile,
			recordedAt: new Date().toISOString(),
		});
	});
}
