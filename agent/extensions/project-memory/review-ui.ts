import { getMarkdownTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, Key, Markdown, matchesKey, ScrollView, Text, truncateToWidth,
    type Component, type KeybindingsManager, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderChange, type Change } from "./lib.ts";

const ACTIONS = ["Accept", "Edit and accept", "Reject", "Defer", "Stop review"] as const;
export type ReviewAction = typeof ACTIONS[number];

/** A read-only viewport. Only an explicit action key can finish the screen. */
export class ReviewScreen implements Component {
    private readonly viewport: ScrollView;
    private readonly title: string;
    private readonly rows: () => number;
    private readonly keybindings: KeybindingsManager;
    private readonly requestRender: () => void;
    private readonly done: (action: ReviewAction | undefined) => void;
    private readonly footer = new Text("[a] Accept  [e] Edit  [r] Reject  [d] Defer  [q/Esc] Stop\nUp/Down, PgUp/PgDn, Home/End: scroll", 0, 0);

    constructor(
        title: string,
        content: Component,
        rows: () => number,
        keybindings: KeybindingsManager,
        requestRender: () => void,
        done: (action: ReviewAction | undefined) => void,
    ) {
        this.title = title;
        this.rows = rows;
        this.keybindings = keybindings;
        this.requestRender = requestRender;
        this.done = done;
        this.viewport = new ScrollView(content, { follow: "none" });
    }
    render(width: number): string[] {
        const availableRows = Math.max(1, Math.floor(this.rows()));
        const footer = this.footer.render(width).slice(0, Math.max(0, availableRows - 2));
        const lines = this.viewport.render(width);
        const height = Math.max(0, availableRows - footer.length - 1);
        this.viewport.updateLayout(lines.length, height, this.requestRender);
        const body = Array.from({ length: height }, (_, index) => lines[this.viewport.scrollTop + index] ?? "");
        return [truncateToWidth(this.title, width), ...body, ...footer];
    }
    handleInput(data: string): void {
        if (isKeyRelease(data)) return;
        const finish = (action: ReviewAction | undefined) => {
            if (!isKeyRepeat(data)) this.done(action);
        };
        if (matchesKey(data, "a")) finish("Accept");
        else if (matchesKey(data, "e")) finish("Edit and accept");
        else if (matchesKey(data, "r")) finish("Reject");
        else if (matchesKey(data, "d")) finish("Defer");
        else if (matchesKey(data, "q") || this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
        else if (this.keybindings.matches(data, "tui.select.up")) this.viewport.scrollBy(-1);
        else if (this.keybindings.matches(data, "tui.select.down")) this.viewport.scrollBy(1);
        else if (this.keybindings.matches(data, "tui.select.pageUp")) this.viewport.scrollBy(-this.viewport.viewportHeight);
        else if (this.keybindings.matches(data, "tui.select.pageDown")) this.viewport.scrollBy(this.viewport.viewportHeight);
        else if (matchesKey(data, Key.home)) this.viewport.scrollToStart();
        else if (matchesKey(data, Key.end)) this.viewport.scrollToEnd();
    }
    handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
        if (event.type !== "wheel") return undefined;
        this.viewport.scrollBy(event.wheelDelta ?? 0);
        return { handled: true };
    }
    invalidate(): void { this.viewport.invalidate(); this.footer.invalidate(); }
}

export async function chooseReviewAction(ctx: ExtensionCommandContext, project: string, change: Change): Promise<ReviewAction | undefined> {
    const title = `${project}: ${change.id} (${change.itemId})`;
    const preview = renderChange(change);
    if (ctx.mode !== "tui") {
        // RPC supports read-only selectors but not custom terminal components.
        // Keep the evidence and actions in one dialog, with no editor submission.
        const action = await ctx.ui.select(`${title}\n\n${preview}`, [...ACTIONS]);
        return ACTIONS.find((candidate) => candidate === action);
    }
    return ctx.ui.custom<ReviewAction | undefined>((tui, _theme, keybindings, done) =>
        new ReviewScreen(title, new Markdown(preview, 0, 0, getMarkdownTheme()),
            () => tui.terminal.rows, keybindings, () => tui.requestRender(), done),
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "top-left" } });
}
