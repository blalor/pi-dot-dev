import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { generationPrompt } from "./batch.ts";
import { enroll, memoryItems, parseChanges, projectDirectory, readSnapshot, refreshProposal, reviewChange, saveProposal,
    selectBatch, type BatchInput, type SourceEpisode } from "./lib.ts";

const PROJECT = "github.com/example/repository";
const BODY = "### Approval\n\nKind: decision\nStatus: active\nScope: production\n\nApproval is required.";
function episode(id = "episode-1", remote = PROJECT): SourceEpisode {
    return { id, remote, cwd: "/checkout", endedAt: "2026-01-01T00:00:00Z", decisions: ["Approval is required"],
        evidence: { episodeId: id, sessionId: "session", fromEntryId: "a", toEntryId: "z", file: "/log", line: 1 } } as SourceEpisode;
}
async function setup(t: TestContext) {
    const parent = fileURLToPath(new URL("../../../.pi_tmp/project-memory/", import.meta.url));
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "regression-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await enroll(root, PROJECT, "/checkout");
    return root;
}
function changes(input: BatchInput, count = 1) {
    return parseChanges(JSON.stringify({ changes: Array.from({ length: count }, (_, index) => ({
        itemId: `D-00${index + 1}`, before: memoryItems(input.current).get(`D-00${index + 1}`) ?? null,
        after: BODY, reason: "An explicit decision", uncertainty: "Summary evidence only", evidenceIds: [input.episodes[0].id],
    })) }), input);
}

test("manual edits between hash validation and transaction construction are not adopted as the base", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const proposal = await saveProposal(root, input, changes(input));
    const currentFile = join(projectDirectory(root, PROJECT), "current.md");
    const manual = "# Project memory\n\nManual edit during transaction setup.\n";
    const originalRead = fsPromises.readFile;
    let currentReads = 0;
    const patched = t.mock.method(fsPromises, "readFile", async (...args: unknown[]) => {
        const result = await Reflect.apply(originalRead, fsPromises, args);
        // First read: snapshot. Second read: expected-hash check. Change the file
        // after returning its previous bytes to reproduce the interleaving.
        if (String(args[0]) === currentFile && ++currentReads === 2) await writeFile(currentFile, manual);
        return result;
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(reviewChange(root, PROJECT, proposal, "change-1", "accepted", "Approved"), /conflicts with current.md/);
    } finally { patched.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(await readFile(currentFile, "utf8"), manual);
});
test("an ABA refresh cannot admit generation that missed new rejection feedback", async (t) => {
    const root = await setup(t);
    const original = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const proposal = await saveProposal(root, original, changes(original, 2));
    await reviewChange(root, PROJECT, proposal, "change-1", "rejected", "This was never agreed");
    const partlyReviewed = await readSnapshot(root, PROJECT);
    await refreshProposal(root, PROJECT, partlyReviewed.pending!);
    const latest = await readSnapshot(root, PROJECT);
    assert.equal(latest.current, original.current);
    assert.deepEqual(latest.state.processedEpisodeIds, original.state.processedEpisodeIds);
    assert.equal(latest.pending, undefined);
    assert.ok(latest.state.revision > original.state.revision);
    await assert.rejects(saveProposal(root, original, changes(original)), /changed during generation/);
    assert.match(generationPrompt(selectBatch(latest, [episode()])), /This was never agreed/);
});
test("refresh preserves deferral status, timestamp, reason and complete review history", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const proposal = await saveProposal(root, input, changes(input));
    await reviewChange(root, PROJECT, proposal, "change-1", "deferred", "Need evidence from production");
    const deferred = (await readSnapshot(root, PROJECT)).pending!;
    const original = structuredClone(deferred.changes[0]);
    await refreshProposal(root, PROJECT, deferred);
    const saved = await readSnapshot(root, PROJECT);
    const archived = saved.reviewed[0].changes[0];
    assert.equal(archived.review, original.review);
    assert.equal(archived.reviewReason, original.reviewReason);
    assert.equal(archived.reviewedAt, original.reviewedAt);
    assert.deepEqual(archived.reviewHistory, original.reviewHistory);
    assert.ok(archived.supersededAt);
    assert.match(generationPrompt(selectBatch(saved, [episode()])), /Need evidence from production/);
});
test("unsupported historical remotes warn without blocking unrelated projects or matching by cwd", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [
        episode("filesystem", "file:///tmp/cache"), episode("relative", "../cache"), episode(),
    ]);
    assert.deepEqual(input.episodes.map((entry) => entry.id), ["episode-1"]);
    assert.equal(input.diagnostics.length, 2);
    assert.match(input.diagnostics[0], /not matched by directory/);
});
test("redaction operates on string values without consuming JSON delimiters or escaped newlines", async (t) => {
    const root = await setup(t);
    const current = `# Project memory\n\n<!-- item:D-001 -->\n${BODY}\n\nAPI_KEY=[REDACTED]\n\nEvidence:\n- Existing reference\n<!-- /item -->\n`;
    await writeFile(join(projectDirectory(root, PROJECT), "current.md"), current);
    const source = episode();
    source.decisions = ["API_KEY=secret-value\n\nA separate paragraph survives."];
    const input = selectBatch(await readSnapshot(root, PROJECT), [source]);
    const prompt = generationPrompt(input);
    const parsed = JSON.parse(prompt);
    assert.equal(parsed.current, current);
    assert.equal(parsed.episodes[0].decisions[0], "API_KEY=[REDACTED]\n\nA separate paragraph survives.");
    assert.equal(prompt.includes("secret-value"), false);
    // The model's exact-before protocol still agrees with the stored memory.
    assert.equal(changes(input)[0].before, memoryItems(current).get("D-001"));
});
test("valid sibling identities ending in .lock do not occupy another project's lock", async (t) => {
    const root = await setup(t);
    await enroll(root, "local/example");
    await enroll(root, "local/example.lock");
    assert.equal((await readSnapshot(root, "local/example")).project, "local/example");
    assert.equal((await readSnapshot(root, "local/example.lock")).project, "local/example.lock");
    const input = selectBatch(await readSnapshot(root, "local/example"), [episode("example", "local/example")]);
    await saveProposal(root, input, changes(input));
    assert.ok((await readSnapshot(root, "local/example")).pending);
});
