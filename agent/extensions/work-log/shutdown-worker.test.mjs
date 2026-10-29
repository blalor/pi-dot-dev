import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { repositoryFacts } from "./shutdown-worker.mjs";
import { readWorkLogHealth } from "./lib.ts";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporaryRoot = join(projectRoot, ".pi_tmp");
const worker = join(dirname(fileURLToPath(import.meta.url)), "shutdown-worker.mjs");

test("the worker entrypoint loads outside the session working directory", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", worker], {
        cwd: process.env.HOME,
        input: JSON.stringify({ file: join(temporaryRoot, "missing-pending.json") }),
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
});

test("dependency import failures preserve the pending snapshot and appear in health", async (t) => {
    await mkdir(temporaryRoot, { recursive: true });
    const root = await mkdtemp(join(temporaryRoot, "work-log-import-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const pendingDir = join(root, "_pending");
    await mkdir(pendingDir);
    const pendingFile = join(pendingDir, "episode.json");
    const snapshot = JSON.stringify({ version: 1, transcript: "Work completed." });
    await writeFile(pendingFile, snapshot);

    // Exercise an actual ESM resolution failure without changing installed dependencies.
    const source = (await readFile(worker, "utf8"))
        .replace('"./lib.ts"', JSON.stringify(pathToFileURL(join(dirname(worker), "lib.ts")).href))
        .replace('import("@earendil-works/pi-ai/compat")', 'import("missing-work-log-test-dependency")');
    const brokenWorker = join(root, "worker.mjs");
    await writeFile(brokenWorker, source);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", brokenWorker], {
        cwd: process.env.HOME,
        input: JSON.stringify({ file: pendingFile, rootDir: root }),
        encoding: "utf8",
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(await readFile(pendingFile, "utf8"), snapshot);
    assert.deepEqual((await readdir(pendingDir)).sort(), ["episode.json", "episode.json.error"]);
    assert.equal((await stat(`${pendingFile}.error`)).mode & 0o777, 0o600);
    const health = await readWorkLogHealth(root);
    assert.equal(health.pendingCount, 1);
    assert.equal(health.failedCount, 1);
    assert.match(health.latestFailure, /Cannot find package 'missing-work-log-test-dependency'/);
});

test("background repository collection tolerates a deleted working directory", async () => {
    await mkdir(temporaryRoot, { recursive: true });
    const cwd = await mkdtemp(join(temporaryRoot, "work-log-deleted-cwd-"));
    await rm(cwd, { recursive: true, force: true });

    const result = await repositoryFacts(cwd, "2026-08-06T10:00:00.000Z");
    assert.equal(result.remote, undefined);
    assert.match(result.facts, /Repository unavailable/);
});
