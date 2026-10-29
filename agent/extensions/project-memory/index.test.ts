import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import { defaultMemoryRoot, enroll, parseChanges, projectDirectory, readSnapshot, saveProposal, selectBatch, type SourceEpisode } from "./lib.ts";

const PROJECT = "github.com/example/repository";
async function setup(t: TestContext, options: { hasUI?: boolean; actions?: string[]; reason?: string; mutate?: () => Promise<void> } = {}) {
    const parent = fileURLToPath(new URL("../../../.pi_tmp/project-memory/", import.meta.url));
    await mkdir(parent, { recursive: true });
    const home = await mkdtemp(join(parent, "ui-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    t.after(async () => { process.env.HOME = originalHome; await rm(home, { recursive: true, force: true }); });
    let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> = async () => { throw new Error("No command"); };
    const notices: Array<{ text: string; level: string }> = [];
    const previews: string[] = [];
    const widgets: Array<string[] | undefined> = [];
    const actions = [...(options.actions ?? [])];
    const pi = {
        registerCommand: (name: string, command: { handler: typeof handler }) => { assert.equal(name, "project-memory"); handler = command.handler; },
        on: () => undefined,
        exec: async (_command: string, args: string[]) => ({ code: 0, stdout: args.at(-1) === "remote" ? "origin\n" : `git@github.com:example/repository.git\n` }),
    } as unknown as ExtensionAPI;
    const ctx = {
        cwd: "/checkout", hasUI: options.hasUI ?? true,
        ui: {
            notify: (text: string, level: string) => notices.push({ text, level }),
            setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
            setStatus: () => undefined,
            editor: async (_title: string, content: string) => { previews.push(content); return content; },
            select: async () => { await options.mutate?.(); return actions.shift(); },
            input: async () => options.reason,
            confirm: async () => true,
        },
    } as unknown as ExtensionCommandContext;
    extension(pi);
    return { root: defaultMemoryRoot(), invoke: (args: string) => handler(args, ctx), notices, previews, widgets };
}
async function pending(root: string) {
    await enroll(root, PROJECT);
    const episode = { id: "episode-1", remote: PROJECT, cwd: "/checkout", decisions: ["Approval required"],
        evidence: { episodeId: "episode-1", sessionId: "session-1", fromEntryId: "a", toEntryId: "z", file: "/log", line: 1 } } as SourceEpisode;
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode]);
    const changes = parseChanges(JSON.stringify({ changes: [{ itemId: "D-001", before: null,
        after: "### Approval\nKind: decision\nStatus: active\nScope: production\nRequire approval.",
        reason: "A recorded decision", uncertainty: "Not independently verified", evidenceIds: ["episode-1"] }] }), input);
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
