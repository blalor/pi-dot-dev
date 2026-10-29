import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import extension from "./index.ts";
import { defaultMemoryRoot, enroll, parseChanges, projectDirectory, readSnapshot, saveProposal, selectBatch, type SourceEpisode } from "./lib.ts";

const PROJECT = "github.com/example/repository";
async function setup(t: TestContext, options: { hasUI?: boolean; mode?: "tui" | "rpc"; actions?: string[]; reason?: string; mutate?: () => Promise<void> } = {}) {
    const parent = fileURLToPath(new URL("../../../.pi_tmp/project-memory/", import.meta.url));
    await mkdir(parent, { recursive: true });
    const home = await mkdtemp(join(parent, "ui-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    t.after(async () => { process.env.HOME = originalHome; await rm(home, { recursive: true, force: true }); });
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("No command"); };
    const notices: Array<{ text: string; level: string }> = [];
    const previews: string[] = [];
    const editors: string[] = [];
    const inputs: string[] = [];
    const widgets: Array<string[] | undefined> = [];
    const actions = [...(options.actions ?? [])];
    const pi = {
        registerCommand: (name: string, command: { handler: typeof handler }) => { assert.equal(name, "project-memory"); handler = command.handler; },
        on: () => undefined,
        exec: async (_command: string, args: string[]) => ({ code: 0, stdout: args.at(-1) === "remote" ? "origin\n" : `git@github.com:example/repository.git\n` }),
    } as unknown as ExtensionAPI;
    const ctx = {
        cwd: "/checkout", hasUI: options.hasUI ?? true, mode: options.mode ?? "rpc",
        ui: {
            notify: (text: string, level: string) => notices.push({ text, level }),
            setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
            setStatus: () => undefined,
            editor: async (_title: string, content: string) => { editors.push(content); return content; },
            select: async (title: string) => { previews.push(title); await options.mutate?.(); return actions.shift(); },
            custom: async (factory: (tui: unknown, theme: unknown, keys: KeybindingsManager, done: (action: unknown) => void) => Component | Promise<Component>, overlay: { overlay?: boolean }) => {
                assert.equal(overlay.overlay, true);
                initTheme("dark", false);
                let completed = false;
                let selected: unknown;
                const screen = await factory({ terminal: { rows: 24 }, requestRender: () => undefined }, {}, getKeybindings(), (action) => { completed = true; selected = action; });
                previews.push(stripTerminalSequences(screen.render(80).join("\n")));
                await options.mutate?.();
                const action = actions.shift();
                const keys: Record<string, string> = { Accept: "a", "Edit and accept": "e", Reject: "r", Defer: "d", "Stop review": "q" };
                screen.handleInput?.(action ? keys[action] : "\x1b");
                assert.equal(completed, true);
                return selected;
            },
            input: async (title: string) => { inputs.push(title); return options.reason; },
            confirm: async () => true,
        },
    } as unknown as ExtensionCommandContext;
    extension(pi);
    return { root: defaultMemoryRoot(), invoke: (args: string) => handler(args, ctx), notices, previews, editors, inputs, widgets, actions };
}
async function pending(root: string, count = 1) {
    await enroll(root, PROJECT);
    const episode = { id: "episode-1", remote: PROJECT, cwd: "/checkout", decisions: ["Approval required"],
        evidence: { episodeId: "episode-1", sessionId: "session-1", fromEntryId: "a", toEntryId: "z", file: "/log", line: 1 } } as SourceEpisode;
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode]);
    const changes = parseChanges(JSON.stringify({ changes: Array.from({ length: count }, (_, index) => ({ itemId: `D-00${index + 1}`, before: null,
        after: "### Approval\nKind: decision\nStatus: active\nScope: production\nRequire approval.",
        reason: "A recorded decision", uncertainty: "Not independently verified", evidenceIds: ["episode-1"] })) }), input);
    await saveProposal(root, input, changes);
}

test("help requires neither enrollment nor Git discovery", async (t) => {
    const harness = await setup(t);
    await harness.invoke("help");
    assert.match(harness.notices[0].text, /Usage:/);
    assert.equal(harness.notices[0].level, "info");
});
test("init infers the remote and status reports pending review without a model", async (t) => {
    const harness = await setup(t);
    await harness.invoke("init");
    await harness.invoke("status");
    assert.match(harness.widgets.at(-1)!.join("\n"), /Pending proposal: none/);
    assert.equal((await readSnapshot(harness.root, PROJECT)).current, "# Project memory\n");
});
test("review displays evidence before explicit acceptance and then applies", async (t) => {
    const harness = await setup(t, { actions: ["Accept"] });
    await pending(harness.root);
    await harness.invoke("review");
    assert.match(harness.previews[0], /Not independently verified/);
    assert.match(harness.previews[0], /session-1; entries a\.\.z/);
    assert.match((await readSnapshot(harness.root, PROJECT)).current, /Require approval/);
    assert.equal(harness.notices.some((notice) => notice.level === "error"), false);
    assert.equal(harness.editors.length, 0);
});
test("cancelling review leaves memory and proposal untouched", async (t) => {
    const harness = await setup(t);
    await pending(harness.root);
    await harness.invoke("review");
    const saved = await readSnapshot(harness.root, PROJECT);
    assert.equal(saved.current, "# Project memory\n");
    assert.equal(saved.pending!.changes[0].review, "pending");
});
test("rejection records interactive feedback and does not update current memory", async (t) => {
    const harness = await setup(t, { actions: ["Reject"], reason: "Not an agreed policy" });
    await pending(harness.root);
    await harness.invoke("review");
    const saved = await readSnapshot(harness.root, PROJECT);
    assert.equal(saved.current, "# Project memory\n");
    assert.equal(saved.reviewed[0].changes[0].reviewReason, "Not an agreed policy");
});
test("noninteractive review fails closed", async (t) => {
    const harness = await setup(t, { hasUI: false, actions: ["Accept"] });
    await pending(harness.root);
    await harness.invoke("review");
    assert.equal(harness.previews.length, 0);
    assert.equal(harness.notices.at(-1)!.level, "error");
    assert.equal((await readSnapshot(harness.root, PROJECT)).current, "# Project memory\n");
});
test("a concurrent memory edit during the dialog prevents acceptance", async (t) => {
    let root: string;
    const harness = await setup(t, { actions: ["Accept"], mutate: async () => {
        await writeFile(join(projectDirectory(root, PROJECT), "current.md"), "# Project memory\n\nChanged during review.\n");
    } });
    root = harness.root;
    await pending(root);
    await harness.invoke("review");
    assert.equal(harness.notices.at(-1)!.level, "error");
    assert.match((await readSnapshot(root, PROJECT)).current, /Changed during review/);
});
test("deferring advances without opening an editor or asking for input, and later review revisits it", async (t) => {
    const harness = await setup(t, { actions: ["Defer", "Accept"] });
    await pending(harness.root, 2);
    await harness.invoke("review");
    let saved = await readSnapshot(harness.root, PROJECT);
    assert.match(harness.previews[0], /change-1 \(D-001\)/);
    assert.match(harness.previews[1], /change-2 \(D-002\)/);
    assert.equal(harness.editors.length, 0);
    assert.equal(harness.inputs.length, 0);
    assert.equal(saved.pending!.changes[0].review, "deferred");
    assert.equal(saved.pending!.changes[1].review, "accepted");
    assert.doesNotMatch(saved.current, /<!-- item:D-001 -->/);
    assert.match(saved.current, /<!-- item:D-002 -->/);
    assert.match(harness.notices.at(-1)!.text, /Remaining changes are deferred/);
    harness.actions.push("Accept");
    await harness.invoke("review");
    saved = await readSnapshot(harness.root, PROJECT);
    assert.match(harness.previews[2], /change-1 \(D-001\)/);
    assert.equal(saved.pending, undefined);
    assert.match(saved.current, /<!-- item:D-001 -->/);
    assert.deepEqual(saved.reviewed[0].changes[0].reviewHistory.map((entry) => entry.decision), ["deferred", "accepted"]);
});
test("the native TUI screen allows immediate deferral and acceptance without an editor", async (t) => {
    const harness = await setup(t, { mode: "tui", actions: ["Defer", "Accept"] });
    await pending(harness.root, 2);
    await harness.invoke("review");
    const saved = await readSnapshot(harness.root, PROJECT);
    assert.equal(harness.previews.length, 2);
    assert.match(harness.previews[0], /\[d\] Defer/);
    assert.equal(harness.editors.length, 0);
    assert.equal(harness.inputs.length, 0);
    assert.equal(saved.pending!.changes[0].review, "deferred");
    assert.equal(saved.pending!.changes[1].review, "accepted");
    assert.equal(harness.notices.some((notice) => notice.level === "error"), false);
});
test("only the Edit action opens the editor", async (t) => {
    const harness = await setup(t, { mode: "tui", actions: ["Edit and accept"] });
    await pending(harness.root);
    await harness.invoke("review");
    assert.equal(harness.editors.length, 1);
    assert.match(harness.editors[0], /Require approval/);
    assert.equal((await readSnapshot(harness.root, PROJECT)).reviewed[0].changes[0].review, "edited");
});
