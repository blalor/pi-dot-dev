import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { appendWorkEpisode } from "../work-log/lib.ts";
import { generationPrompt, propose } from "./batch.ts";
import { enroll, enrolledProjects, hash, memoryItems, parseChanges, projectDirectory, projectKey, readSnapshot,
    readSourceEpisodes, refreshProposal, renderProposal, reviewChange, saveProposal, selectBatch,
    type BatchInput, type Proposal, type SourceEpisode } from "./lib.ts";

const temporaryRoot = fileURLToPath(new URL("../../../.pi_tmp/project-memory/", import.meta.url));
const PROJECT = "github.com/example/repository";
const BODY = "### Approval required\n\nKind: decision\nStatus: active\nScope: production\n\nDeployments require approval.";
function episode(id = "episode-1", remote: string | undefined = PROJECT): SourceEpisode {
    return { id, sessionId: "session-1", fromEntryId: "entry-1", toEntryId: "entry-9", cwd: "/checkout",
        remote, startedAt: "2026-01-01T12:00:00Z", endedAt: "2026-01-01T13:00:00Z", generatedAt: "2026-01-01T13:01:00Z",
        accomplished: ["Reviewed deployment policy"], decisions: ["Require approval"], artifacts: [], validation: [], blockers: [], next: [],
        evidence: { episodeId: id, sessionId: "session-1", fromEntryId: "entry-1", toEntryId: "entry-9", file: "/work-log/2026/01/2026-01-01.jsonl", line: 1 } };
}
async function setup(t: TestContext) {
    await mkdir(temporaryRoot, { recursive: true });
    const root = await mkdtemp(join(temporaryRoot, "case-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await enroll(root, PROJECT);
    return root;
}
function response(input: BatchInput, itemId = "D-001", after = BODY) {
    return JSON.stringify({ changes: [{ itemId, before: memoryItems(input.current).get(itemId) ?? null,
        after, reason: "An explicit decision was recorded", uncertainty: "Reported by an episode; not independently verified", evidenceIds: [input.episodes[0].id] }] });
}
async function prepare(root: string, source = episode()): Promise<Proposal> {
    const input = selectBatch(await readSnapshot(root, PROJECT), [source]);
    return saveProposal(root, input, parseChanges(response(input), input));
}

test("project identity normalizes transports and rejects unsafe paths", () => {
    for (const value of ["git@github.com:example/repository.git", "https://user:password@github.com/example/repository.git?token=hidden", "ssh://git@github.com/example/repository", PROJECT]) {
        assert.equal(projectKey(value), PROJECT);
    }
    for (const value of ["../escape", "/absolute/repo", "host/../repo", "host/repo?secret", "file:///tmp/repo", "host/repo\\escape"]) {
        assert.throws(() => projectKey(value));
    }
    assert.equal(projectKey("local/ideas"), "local/ideas");
});
test("enrollment is explicit, idempotent, private, and supports nested identities", async (t) => {
    const root = await setup(t);
    await enroll(root, PROJECT);
    await enroll(root, `${PROJECT}/nested.lock`);
    assert.deepEqual(await enrolledProjects(root), [PROJECT, `${PROJECT}/nested.lock`]);
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(saved.current, "# Project memory\n");
    assert.equal((await stat(join(projectDirectory(root, PROJECT), "state.json"))).mode & 0o777, 0o600);
    await assert.rejects(readSnapshot(root, "local/unknown"), /not enrolled/);
    assert.deepEqual(await enrolledProjects(root), [PROJECT, `${PROJECT}/nested.lock`]);
});
test("sources come only from daily logs, retain provenance, and deduplicate", async (t) => {
    const root = await setup(t);
    const logs = join(root, "logs");
    await appendWorkEpisode(logs, episode());
    await mkdir(join(logs, "_pending"));
    await writeFile(join(logs, "_pending", "2026-01-01.jsonl"), "not JSON");
    const saved = await readSourceEpisodes(logs);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].evidence.episodeId, "episode-1");
    assert.equal(saved[0].evidence.line, 1);
    assert.match(saved[0].evidence.file, /2026\/01\/2026-01-01.jsonl$/);
    await writeFile(saved[0].evidence.file, `${JSON.stringify(episode())}\n${JSON.stringify(episode())}\n`);
    assert.equal((await readSourceEpisodes(logs)).length, 1);
    await writeFile(saved[0].evidence.file, "{broken\n");
    await assert.rejects(readSourceEpisodes(logs), /jsonl:1:/);
});
test("selection scopes by remote across worktrees and explicitly mapped local paths", async (t) => {
    const root = await setup(t);
    const saved = await readSnapshot(root, PROJECT);
    assert.deepEqual(selectBatch(saved, [episode(), episode("other", "github.com/other/repository")]).episodes.map((entry) => entry.id), ["episode-1"]);
    const local = episode("local"); delete local.remote;
    await enroll(root, "local/checkout", "/checkout");
    assert.equal(selectBatch(await readSnapshot(root, "local/checkout"), [local, episode()]).episodes.length, 1);
    assert.equal(selectBatch(saved, Array.from({ length: 25 }, (_, index) => episode(`ep-${index}`))).episodes.length, 20);
});
test("generation saves proposals and cursors without changing accepted memory", async (t) => {
    const root = await setup(t);
    const result = await propose(PROJECT, { root, episodes: [episode()], generate: async (input) => response(input) });
    assert.equal(result.status, "generated");
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(saved.current, "# Project memory\n");
    assert.deepEqual(saved.state.processedEpisodeIds, ["episode-1"]);
    assert.equal(saved.pending?.changes[0].review, "pending");
    assert.match(saved.pending!.changes[0].after, /session-1; entries entry-1\.\.entry-9/);
    const again = await propose(PROJECT, { root, episodes: [episode()], generate: async () => { throw new Error("must not generate with pending review"); } });
    assert.equal(again.status, "pending");
});
test("model failure and invalid output leave source episodes unprocessed", async (t) => {
    const root = await setup(t);
    for (const generate of [async () => { throw new Error("provider failure"); }, async () => "broken", async () => '{"changes":[{}]}']) {
        await assert.rejects(propose(PROJECT, { root, episodes: [episode()], generate }));
        assert.deepEqual((await readSnapshot(root, PROJECT)).state.processedEpisodeIds, []);
    }
});
test("no-change results are archived and not reconsidered on each schedule", async (t) => {
    const root = await setup(t);
    await propose(PROJECT, { root, episodes: [episode()], generate: async () => '{"changes":[]}' });
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(saved.pending, undefined);
    assert.equal(saved.reviewed.length, 1);
    assert.equal((await propose(PROJECT, { root, episodes: [episode()] })).status, "empty");
});
test("invalid citations, stale before text, duplicate IDs and marker injection fail closed", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const parsed = JSON.parse(response(input));
    for (const patch of [{ before: "invented" }, { evidenceIds: ["unknown"] }, { after: "<!-- item:evil -->" }, { itemId: "../../escape" }, { after: "No scope or status" }]) {
        const output = { changes: [{ ...parsed.changes[0], ...patch }] };
        assert.throws(() => parseChanges(JSON.stringify(output), input));
    }
    assert.throws(() => parseChanges(JSON.stringify({ changes: [...parsed.changes, ...parsed.changes] }), input), /duplicate/);
});
test("accepting applies only one item and preserves source provenance", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    await reviewChange(root, PROJECT, proposal, "change-1", "accepted", "Approved");
    const saved = await readSnapshot(root, PROJECT);
    assert.match(saved.current, /Deployments require approval/);
    assert.match(saved.current, /Episode episode-1/);
    assert.equal(saved.pending, undefined);
    assert.equal(saved.reviewed[0].changes[0].review, "accepted");
    await assert.rejects(reviewChange(root, PROJECT, proposal, "change-1", "accepted", "Again"), /changed during review/);
});
test("edits are recorded separately from the original proposal", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    await reviewChange(root, PROJECT, proposal, "change-1", "edited", "Narrow the scope", BODY.replace("production", "staging"));
    const saved = await readSnapshot(root, PROJECT);
    assert.match(saved.current, /Scope: staging/);
    assert.match(saved.reviewed[0].changes[0].after, /Scope: production/);
    assert.match(saved.reviewed[0].changes[0].appliedText!, /Scope: staging/);
    const input = selectBatch(saved, [episode("episode-2")]);
    assert.match(generationPrompt(input), /Narrow the scope/);
});
test("rejection retains reasons for future generation without changing memory", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    await reviewChange(root, PROJECT, proposal, "change-1", "rejected", "This was a suggestion, not an adopted policy");
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(saved.current, "# Project memory\n");
    assert.match(generationPrompt(selectBatch(saved, [episode("episode-2")])), /suggestion, not an adopted policy/);
});
test("deferral retains a pending change and blocks further batches", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    await reviewChange(root, PROJECT, proposal, "change-1", "deferred", "Need to ask the team");
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(saved.pending!.changes[0].review, "deferred");
    assert.equal(saved.current, "# Project memory\n");
    await reviewChange(root, PROJECT, saved.pending!, "change-1", "accepted", "Confirmed");
    const accepted = await readSnapshot(root, PROJECT);
    assert.match(accepted.current, /approval/);
    assert.deepEqual(accepted.reviewed[0].changes[0].reviewHistory.map((entry) => entry.decision), ["deferred", "accepted"]);
    assert.equal(accepted.reviewed[0].changes[0].reviewHistory[0].reason, "Need to ask the team");
});
test("partial acceptance advances the expected hash for remaining independent changes", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const raw = JSON.parse(response(input));
    raw.changes.push({ ...raw.changes[0], itemId: "D-002", after: BODY.replace("Approval required", "Another decision") });
    const proposal = await saveProposal(root, input, parseChanges(JSON.stringify(raw), input));
    await reviewChange(root, PROJECT, proposal, "change-1", "accepted", "First");
    const next = await readSnapshot(root, PROJECT);
    assert.equal(next.pending!.baseHash, next.currentHash);
    await reviewChange(root, PROJECT, next.pending!, "change-2", "accepted", "Second");
    assert.equal(memoryItems((await readSnapshot(root, PROJECT)).current).size, 2);
});
test("updates replace existing stable items instead of appending contradictions", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    await reviewChange(root, PROJECT, proposal, "change-1", "accepted", "First");
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode("episode-2")]);
    const update = await saveProposal(root, input, parseChanges(response(input, "D-001", BODY.replace("Status: active", "Status: superseded")), input));
    await reviewChange(root, PROJECT, update, "change-1", "accepted", "Policy changed");
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(memoryItems(saved.current).size, 1);
    assert.match(saved.current, /Status: superseded/);
    assert.match(saved.reviewed.find((entry) => entry.id === update.id)!.changes[0].before!, /Status: active/);
});
test("stale memory blocks approval and refreshing preserves history for regeneration", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    const currentFile = join(projectDirectory(root, PROJECT), "current.md");
    await writeFile(currentFile, "# Project memory\n\nManual clarification.\n");
    await assert.rejects(reviewChange(root, PROJECT, proposal, "change-1", "accepted", "Approve"), /changed; refresh/);
    assert.match(await readFile(currentFile, "utf8"), /Manual clarification/);
    await refreshProposal(root, PROJECT, proposal);
    const refreshed = await readSnapshot(root, PROJECT);
    assert.equal(refreshed.pending, undefined);
    assert.equal(refreshed.reviewed[0].changes[0].review, "pending");
    assert.ok(refreshed.reviewed[0].changes[0].supersededAt);
    assert.deepEqual(refreshed.state.processedEpisodeIds, []);
    const regenerated = await prepare(root);
    assert.notEqual(regenerated.id, proposal.id);
    assert.equal((await readSnapshot(root, PROJECT)).reviewed.length, 1);
});
test("generation result is discarded if the project changes during the model request", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    await writeFile(join(projectDirectory(root, PROJECT), "current.md"), "# Project memory\n\nChanged.\n");
    await assert.rejects(saveProposal(root, input, parseChanges(response(input), input)), /changed during generation/);
    assert.deepEqual((await readSnapshot(root, PROJECT)).state.processedEpisodeIds, []);
});
test("concurrent generators cannot save duplicate proposals or advance cursors twice", async (t) => {
    const root = await setup(t);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const changes = parseChanges(response(input), input);
    const results = await Promise.allSettled([saveProposal(root, input, changes), saveProposal(root, input, changes)]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    const saved = await readSnapshot(root, PROJECT);
    assert.deepEqual(saved.state.processedEpisodeIds, ["episode-1"]);
    assert.equal((await readdir(join(projectDirectory(root, PROJECT), "proposals", "pending"))).length, 1);
});
test("interrupted application recovers idempotently at every write boundary", async (t) => {
    for (let boundary = 0; boundary <= 4; boundary += 1) {
        await t.test(`boundary ${boundary}`, async (t) => {
            const root = await setup(t);
            const proposal = await prepare(root);
            const directory = projectDirectory(root, PROJECT);
            const pending = `proposals/pending/${proposal.id}.md`;
            const reviewed = `proposals/reviewed/${proposal.id}.md`;
            const applied = `# Project memory\n\n<!-- item:D-001 -->\n${proposal.changes[0].after}\n<!-- /item -->\n`;
            proposal.changes[0].review = "accepted";
            proposal.changes[0].reviewReason = "Approved";
            proposal.changes[0].appliedText = proposal.changes[0].after;
            proposal.baseHash = hash(applied);
            const oldState = await readFile(join(directory, "state.json"), "utf8");
            const state = JSON.parse(oldState);
            const writes = [
                { path: "current.md", beforeHash: hash("# Project memory\n"), content: applied },
                { path: "state.json", beforeHash: hash(oldState), content: JSON.stringify({ ...state, revision: state.revision + 1 }) },
                { path: pending, beforeHash: hash(await readFile(join(directory, pending), "utf8")), content: null },
                { path: reviewed, beforeHash: hash(null), content: renderProposal(proposal) },
            ];
            await writeFile(join(directory, "transaction.json"), JSON.stringify(writes));
            for (const entry of writes.slice(0, boundary)) {
                const file = join(directory, entry.path);
                if (entry.content === null) await rm(file);
                else { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, entry.content); }
            }
            const saved = await readSnapshot(root, PROJECT);
            assert.equal(saved.current, applied);
            assert.equal(saved.pending, undefined);
            assert.equal(saved.reviewed[0].changes[0].review, "accepted");
            assert.equal((await readSnapshot(root, PROJECT)).current, applied);
            await assert.rejects(readFile(join(directory, "transaction.json")), /ENOENT/);
        });
    }
});
test("interrupted proposal persistence recovers its source cursor with the proposal", async (t) => {
    const root = await setup(t);
    const directory = projectDirectory(root, PROJECT);
    const input = selectBatch(await readSnapshot(root, PROJECT), [episode()]);
    const oldState = await readFile(join(directory, "state.json"), "utf8");
    const proposal: Proposal = { version: 1, id: "a".repeat(20), project: PROJECT, createdAt: new Date().toISOString(), baseHash: input.currentHash,
        episodeIds: ["episode-1"], changes: parseChanges(response(input), input) };
    await writeFile(join(directory, "transaction.json"), JSON.stringify([
        { path: `proposals/pending/${proposal.id}.md`, beforeHash: hash(null), content: renderProposal(proposal) },
        { path: "state.json", beforeHash: hash(oldState), content: JSON.stringify({ ...input.state, processedEpisodeIds: ["episode-1"] }) },
    ]));
    const saved = await readSnapshot(root, PROJECT);
    assert.equal(saved.pending!.id, proposal.id);
    assert.deepEqual(saved.state.processedEpisodeIds, ["episode-1"]);
});
test("recovery refuses to overwrite unexpected manual changes", async (t) => {
    const root = await setup(t);
    const directory = projectDirectory(root, PROJECT);
    await writeFile(join(directory, "transaction.json"), JSON.stringify([
        { path: "current.md", beforeHash: hash("# Project memory\n"), content: "# Recovered memory\n" },
    ]));
    await writeFile(join(directory, "current.md"), "# Manual update\n");
    await assert.rejects(readSnapshot(root, PROJECT), /conflicts with current.md/);
    assert.equal(await readFile(join(directory, "current.md"), "utf8"), "# Manual update\n");
});
test("proposal edits outside the review API are rejected rather than silently accepted", async (t) => {
    const root = await setup(t);
    const proposal = await prepare(root);
    const file = join(projectDirectory(root, PROJECT), "proposals", "pending", `${proposal.id}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace("Deployments require approval", "No approval required"));
    await assert.rejects(readSnapshot(root, PROJECT), /edited outside review/);
});
