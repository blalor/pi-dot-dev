import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { repositoryFacts } from "./shutdown-worker.mjs";

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

test("background repository collection tolerates a deleted working directory", async () => {
    await mkdir(temporaryRoot, { recursive: true });
    const cwd = await mkdtemp(join(temporaryRoot, "work-log-deleted-cwd-"));
    await rm(cwd, { recursive: true, force: true });

    const result = await repositoryFacts(cwd, "2026-08-06T10:00:00.000Z");
    assert.equal(result.remote, undefined);
    assert.match(result.facts, /Repository unavailable/);
});
