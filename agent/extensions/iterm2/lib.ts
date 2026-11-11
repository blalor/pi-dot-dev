export type SessionStatus = "working" | "blocked" | "idle";

export function integrationEnabled(environment: NodeJS.ProcessEnv, isTTY: boolean): boolean {
    // An inherited iTerm2 marker does not make a Herdr pane a native iTerm2 session.
    return isTTY && environment.HERDR_ENV !== "1" &&
        (environment.TERM_PROGRAM === "iTerm.app" || Boolean(environment.ITERM_SESSION_ID));
}

export function terminalText(value: string, maxLength = 180): string {
    // Titles and notifications must not contain terminal controls.
    return value.replace(/[\x00-\x1f\x7f-\x9f;]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function statusSequence(status: SessionStatus, detail: string): string {
    // Every report replaces the root record. Base64 keeps free text out of the
    // colon-delimited fields; decoded text must still be free of controls.
    const message = terminalText(detail);
    return `\x1b]7501;state=${status}:app=pi${status === "blocked" ? ":kind=question" : ""}${message ? `:msg=${Buffer.from(message, "utf8").toString("base64")}` : ""}\x07`;
}

export function clearStatusSequence(): string {
    return "\x1b]7501;state=clear\x07";
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
