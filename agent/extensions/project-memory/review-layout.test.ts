import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { Change } from "./lib.ts";
import { chooseReviewAction } from "./review-ui.ts";

/** Exercise Pi's actual overlay positioning/compositing without writing to a terminal. */
class LayoutTui extends TuiMainScreen {
    override requestRender(): void {}
    frame(): string[] {
        const { rows, columns } = this.terminal;
        return this.compositeOverlays(Array(rows).fill("Underlying chat must not show through"), columns, rows)
            .map((line) => stripTerminalSequences(line).trimEnd());
    }
}

for (const length of ["short", "long"] as const) {
    test(`${length} proposals start at the window top with actions fixed at the bottom`, async () => {
        initTheme("dark", false);
        const terminal = {
            rows: 80, columns: 80, kittyProtocolActive: false,
            start: () => undefined, stop: () => undefined, drainInput: async () => undefined,
            write: () => undefined, moveBy: () => undefined, hideCursor: () => undefined, showCursor: () => undefined,
            clearLine: () => undefined, clearFromCursor: () => undefined, clearScreen: () => undefined,
            setTitle: () => undefined, setProgress: () => undefined, setProgramStatus: () => undefined,
        } satisfies Terminal;
        const tui = new LayoutTui(terminal);
        const change: Change = {
            id: "change-1", itemId: "D-001", before: null,
            after: length === "short" ? "A short supported claim." : Array.from({ length: 120 }, (_, index) => `Evidence paragraph ${index}.`).join("\n\n"),
            reason: "A supported correction", uncertainty: "Reported by the work log", evidence: [], review: "pending", reviewHistory: [],
        };
        type Custom = ExtensionCommandContext["ui"]["custom"];
        const ctx = {
            mode: "tui",
            ui: {
                custom: async (factory: Parameters<Custom>[0], options: Parameters<Custom>[1]) => {
                    const component = await factory(tui, {} as Theme, new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<typeof factory>[2], () => undefined);
                    const layout = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
                    tui.showOverlay(component, layout);
                    return undefined;
                },
            },
        } as unknown as ExtensionCommandContext;
        await chooseReviewAction(ctx, "local/layout-test", change);
        const frame = tui.frame();
        assert.equal(frame.length, 80);
        assert.match(frame[0], /^local\/layout-test:/);
        assert.match(frame.slice(1, 4).join("\n"), /change-1/);
        assert.match(frame.at(-2)!, /^\[a\] Accept/);
        assert.match(frame.at(-1)!, /^Up\/Down/);
        assert.equal(frame.some((line) => line.includes("Underlying chat")), false);
        if (length === "short") assert.ok(frame.slice(-5, -2).every((line) => line === ""));

        // Reuse the same mounted overlay so its positioning is also checked after resize.
        terminal.rows = 20;
        terminal.columns = 36;
        const resized = tui.frame();
        assert.equal(resized.length, 20);
        assert.match(resized[0], /^local\/layout-test:/);
        assert.match(resized.at(-1)!, /scroll$/);
        assert.match(resized.slice(-5).join("\n"), /\[d\] Defer/);
        assert.equal(resized.some((line) => line.includes("Underlying chat")), false);
        for (const line of resized) assert.ok(visibleWidth(line) <= 36);
    });
}
