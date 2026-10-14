export type SessionStatus = "Working" | "Waiting" | "Idle";

export function integrationEnabled(environment: NodeJS.ProcessEnv, isTTY: boolean): boolean {
    // An inherited iTerm2 marker does not make a Herdr pane a native iTerm2 session.
    return isTTY && environment.HERDR_ENV !== "1" &&
        (environment.TERM_PROGRAM === "iTerm.app" || Boolean(environment.ITERM_SESSION_ID));
}

export function terminalText(value: string, maxLength = 180): string {
    // OSC 21337 uses semicolon-delimited fields. Strip both delimiters and controls.
    return value.replace(/[\x00-\x1f\x7f-\x9f;]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

const STATUS_COLORS: Record<SessionStatus, string> = {
    Working: "#4a90d9",
    Waiting: "#ffb400",
    Idle: "#808080",
};

export function statusSequence(status: SessionStatus, detail: string): string {
    return `\x1b]21337;status=${status};indicator=${STATUS_COLORS[status]};detail=${terminalText(detail)}\x07`;
}

export function clearStatusSequence(): string {
    return "\x1b]21337;status=;indicator=;detail=\x07";
}

export function titleSequence(name: string | undefined): string {
    return `\x1b]1;${terminalText(name ?? "", 120) || "pi"}\x07`;
}

export function notificationSequence(message: string): string {
    // OSC 9 notifications belong to the emitting session; clicking reveals its tab.
    return `\x1b]9;${terminalText(message)}\x07`;
}

export function userVariableSequence(name: string, value: string): string {
    return `\x1b]1337;SetUserVar=${name}=${Buffer.from(value, "utf8").toString("base64")}\x07`;
}
