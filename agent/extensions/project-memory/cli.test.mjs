import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main, schedulePlist } from "./cli.mjs";
import { enroll, readSnapshot } from "./lib.ts";

const temporaryRoot = fileURLToPath(new URL("../../../.pi_tmp/project-memory/", import.meta.url));
async function setup(t) {
    await mkdir(temporaryRoot, { recursive: true });
    const root = await mkdtemp(join(temporaryRoot, "cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let output = "";
    return { root, stdout: { write: (text) => { output += text; } }, output: () => output };
}
function episode(project) {
    return { id: "episode-1", remote: project, cwd: "/checkout", endedAt: "2026-01-01T00:00:00Z",
        evidence: { episodeId: "episode-1", sessionId: "session", fromEntryId: "a", toEntryId: "z", file: "/log", line: 1 } };
}

test("CLI loads outside a repository and prints help without model access", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./cli.mjs", import.meta.url)), "--help"], { cwd: "/", encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Generation only writes proposals/);
});
test("CLI init, list, show and pending use the selected project", async (t) => {
    const harness = await setup(t);
    await main(["init", "local/ideas"], harness);
    await main(["list"], harness);
    await main(["show", "local/ideas"], harness);
    await main(["pending", "local/ideas"], harness);
    assert.match(harness.output(), /local\/ideas/);
    assert.match(harness.output(), /# Project memory/);
    assert.match(harness.output(), /No pending proposal/);
});
test("scheduled all-project generation isolates a project failure", async (t) => {
    const harness = await setup(t);
    await enroll(harness.root, "local/first");
    await enroll(harness.root, "local/second");
    await assert.rejects(main(["propose", "--all"], { ...harness, batch: {
        episodes: [episode("local/first"), { ...episode("local/second"), id: "episode-2" }],
        generate: async (input) => { if (input.project === "local/first") throw new Error("Provider unavailable"); return '{"changes":[]}'; },
    } }), /One or more projects failed/);
    assert.deepEqual((await readSnapshot(harness.root, "local/first")).state.processedEpisodeIds, []);
    assert.deepEqual((await readSnapshot(harness.root, "local/second")).state.processedEpisodeIds, ["episode-2"]);
    assert.match(harness.output(), /local\/first: FAILED/);
    assert.match(harness.output(), /local\/second: generated/);
});
test("launchd configuration uses absolute executables and only enrolled-project batches", () => {
    const plist = schedulePlist("/some path/node", "/some & path/cli.mjs", "/private/root");
    assert.match(plist, /<string>\/some path\/node<\/string>/);
    assert.match(plist, /some &amp; path/);
    assert.match(plist, /<string>propose<\/string><string>--all<\/string>/);
    assert.match(plist, /<integer>86400<\/integer>/);
    assert.doesNotMatch(plist, /RunAtLoad/);
});
