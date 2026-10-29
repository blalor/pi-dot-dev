import assert from "node:assert/strict";
import test from "node:test";
import { KeybindingsManager, Text, TUI_KEYBINDINGS, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ReviewScreen, type ReviewAction } from "./review-ui.ts";

function screen(options: { rows?: number; keys?: KeybindingsManager } = {}) {
    let rows = options.rows ?? 12;
    let renders = 0;
    const actions: Array<ReviewAction | undefined> = [];
    const component = new ReviewScreen("A project-memory proposal",
        new Text(Array.from({ length: 60 }, (_, index) => `Source ${index}: evidence and rationale`).join("\n"), 0, 0),
        () => rows, options.keys ?? new KeybindingsManager(TUI_KEYBINDINGS), () => { renders += 1; }, (action) => { actions.push(action); });
    return { component, actions, rows: (value: number) => { rows = value; }, renders: () => renders };
}

test("review is read-only and each action is directly available", () => {
    const keys: Array<[string, ReviewAction | undefined]> = [["a", "Accept"], ["e", "Edit and accept"], ["r", "Reject"], ["d", "Defer"], ["q", undefined], ["\x1b", undefined]];
    for (const [key, expected] of keys) {
        const fixture = screen();
        const before = fixture.component.render(80);
        fixture.component.handleInput("x");
        fixture.component.handleInput("\r");
        assert.equal(fixture.actions.length, 0, "typing or submitting must not accept or modify the preview");
        assert.deepEqual(fixture.component.render(80), before);
        fixture.component.handleInput(key);
        assert.deepEqual(fixture.actions, [expected]);
    }
});
test("navigation scrolls to evidence without choosing an action", () => {
    const fixture = screen();
    assert.match(fixture.component.render(80)[1], /Source 0:/);
    fixture.component.handleInput("\x1b[B");
    assert.match(fixture.component.render(80)[1], /Source 1:/);
    fixture.component.handleInput("\x1b[6~");
    assert.doesNotMatch(fixture.component.render(80)[1], /Source [01]:/);
    fixture.component.handleInput("\x1b[H");
    assert.match(fixture.component.render(80)[1], /Source 0:/);
    fixture.component.handleInput("\x1b[F");
    assert.match(fixture.component.render(80).join("\n"), /Source 59:/);
    fixture.component.handleInput("\x1b[5~");
    assert.doesNotMatch(fixture.component.render(80).join("\n"), /Source 59:/);
    assert.equal(fixture.actions.length, 0);
    assert.ok(fixture.renders() > 0);
});
test("screen stays within narrow widths and terminal height after resize", () => {
    const fixture = screen({ rows: 24 });
    fixture.component.render(80);
    fixture.component.handleInput("\x1b[F");
    fixture.rows(10);
    fixture.component.invalidate();
    const narrow = fixture.component.render(24);
    assert.ok(narrow.length <= 10);
    for (const line of narrow) assert.ok(visibleWidth(line) <= 24);
    assert.match(narrow.join("\n"), /\[d\] Defer/);
    fixture.rows(1);
    assert.equal(fixture.component.render(1).length, 1);
});
test("configured navigation and mouse wheel work without editing", () => {
    const fixture = screen({ keys: new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": ["j"] }) });
    fixture.component.render(80);
    fixture.component.handleInput("j");
    assert.match(fixture.component.render(80)[1], /Source 1:/);
    const handled = fixture.component.handleMouse({ type: "wheel", wheelDelta: 3 } as TuiMouseEvent);
    assert.equal(handled?.handled, true);
    assert.match(fixture.component.render(80)[1], /Source 4:/);
    assert.equal(fixture.actions.length, 0);
});
test("holding navigation keys scrolls on Kitty-protocol terminals", () => {
    const fixture = screen();
    fixture.component.render(80);
    fixture.component.handleInput("\x1b[1;1:2B");
    assert.match(fixture.component.render(80)[1], /Source 1:/);
    fixture.component.handleInput("\x1b[1;1:2B");
    assert.match(fixture.component.render(80)[1], /Source 2:/);
    fixture.component.handleInput("\x1b[1;1:3B");
    assert.match(fixture.component.render(80)[1], /Source 2:/);
    assert.equal(fixture.actions.length, 0);
});
test("key release and repeat events cannot approve the next item", () => {
    const fixture = screen();
    fixture.component.handleInput("\x1b[97;1:3u");
    fixture.component.handleInput("\x1b[97;1:2u");
    assert.equal(fixture.actions.length, 0);
});
