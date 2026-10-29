import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { enroll, parseChanges, readSnapshot, saveProposal, selectBatch, type SourceEpisode } from "./lib.ts";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("real RPC review defers the first item and accepts the second without any editor submission", async (t) => {
    const parent = join(projectRoot, ".pi_tmp", "project-memory");
    await mkdir(parent, { recursive: true });
    const home = await mkdtemp(join(parent, "rpc-review-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const agentDir = join(home, ".pi", "agent");
    const root = join(agentDir, "project-memory");
    const project = "local/rpc-review-test";
    await enroll(root, project);
    const source = { id: "fixture-episode", remote: project, cwd: "/fixture-checkout", decisions: ["Two fixture decisions"],
        evidence: { episodeId: "fixture-episode", sessionId: "fixture-session", fromEntryId: "a", toEntryId: "z", file: "/fixture.jsonl", line: 1 } } as SourceEpisode;
    const input = selectBatch(await readSnapshot(root, project), [source]);
    const changes = parseChanges(JSON.stringify({ changes: [1, 2].map((number) => ({
        itemId: `D-00${number}`, before: null,
        after: `### Fixture decision ${number}\nKind: decision\nStatus: active\nScope: test fixture\nThis is synthetic evidence.`,
        reason: "Exercise the review transport", uncertainty: "Test data only", evidenceIds: ["fixture-episode"],
    })) }), input);
    await saveProposal(root, input, changes);
    const responses = join(home, "responses.json");
    await writeFile(responses, JSON.stringify([{ method: "select", value: "Defer" }, { method: "select", value: "Accept" }]));
    const output = join(home, "rpc.jsonl");
    const result = spawnSync("npm", ["run", "test:rpc", "--",
        "--extension", join(projectRoot, "agent/extensions/project-memory/index.ts"),
        "--command", `/project-memory review ${project}`, "--ui-responses", responses, "--output", output], {
        cwd: projectRoot,
        env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir,
            PI_RPC_BIN: join(projectRoot, "node_modules/.bin/pi") },
        encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const records = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const dialogs = records.filter((record) => record.type === "extension_ui_request" && ["select", "editor", "input", "confirm"].includes(record.method));
    assert.deepEqual(dialogs.map((record) => record.method), ["select", "select"]);
    assert.match(dialogs[0].title, /D-001/);
    assert.match(dialogs[0].title, /fixture-session/);
    assert.match(dialogs[1].title, /D-002/);
    const saved = await readSnapshot(root, project);
    assert.equal(saved.pending!.changes[0].review, "deferred");
    assert.equal(saved.pending!.changes[1].review, "accepted");
    assert.doesNotMatch(saved.current, /<!-- item:D-001 -->/);
    assert.match(saved.current, /<!-- item:D-002 -->/);
});
