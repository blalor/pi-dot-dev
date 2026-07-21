import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OSC_SET_ICON_TITLE = "\x1b]1;";
const OSC_TERMINATOR = "\x07";
const DEFAULT_TAB_TITLE = "pi";

function isITerm2(): boolean {
    return process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);
}

function sanitizeTitle(title: string): string {
    const sanitized = title.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    return sanitized.trim() ? sanitized : "";
}

function setTabTitle(name: string | undefined, ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || !process.stdout.isTTY || !isITerm2()) return;

    const title = sanitizeTitle(name ?? "") || DEFAULT_TAB_TITLE;
    process.stdout.write(`${OSC_SET_ICON_TITLE}${title}${OSC_TERMINATOR}`);
}

export default function iterm2SessionTab(pi: ExtensionAPI) {
    pi.on("session_start", (_event, ctx) => {
        setTabTitle(pi.getSessionName(), ctx);
    });

    pi.on("session_info_changed", (event, ctx) => {
        setTabTitle(event.name, ctx);
    });
}
