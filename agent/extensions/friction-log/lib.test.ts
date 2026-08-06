import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { appendFriction, canonicalizeRemote, normalizeMessage, resolveFrictionScope } from "./lib.ts";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporaryRoot = join(projectRoot, ".pi_tmp");

async function temporaryDirectory(prefix: string): Promise<string> {
    await mkdir(temporaryRoot, { recursive: true });
    return mkdtemp(join(temporaryRoot, prefix));
}

function git(cwd: string, ...args: string[]): void {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

test("canonicalizeRemote produces one credential-free identity", () => {
    assert.equal(canonicalizeRemote("git@github.com:wandb/core.git"), "github.com/wandb/core");
    assert.equal(canonicalizeRemote("https://token@github.com/wandb/core.git"), "github.com/wandb/core");
    assert.equal(canonicalizeRemote("ssh://git@github.com/wandb/core.git"), "github.com/wandb/core");
    assert.equal(canonicalizeRemote("../core.git", "/work/checkout"), "file:///work/core");
});

test("remote scope is shared across checkouts", async () => {
    const parent = await temporaryDirectory("friction-scope-");
    try {
        const first = join(parent, "first");
        const second = join(parent, "second");
        await mkdir(first);
        await mkdir(second);
        for (const directory of [first, second]) {
            git(directory, "init");
            git(directory, "remote", "add", "origin", "git@github.com:wandb/core.git");
        }

        const firstScope = await resolveFrictionScope(first);
        const secondScope = await resolveFrictionScope(second);
        assert.equal(firstScope.kind, "remote");
        assert.equal(firstScope.key, "github.com/wandb/core");
        assert.equal(firstScope.id, secondScope.id);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("directory scope uses the git root when no remote exists", async () => {
    const parent = await temporaryDirectory("friction-directory-");
    try {
        git(parent, "init");
        const nested = join(parent, "nested");
        await mkdir(nested);
        const rootScope = await resolveFrictionScope(parent);
        const nestedScope = await resolveFrictionScope(nested);
        assert.equal(rootScope.kind, "directory");
        assert.equal(rootScope.id, nestedScope.id);
        assert.equal(rootScope.key, parent);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("appendFriction writes one JSONL record under the scope directory", async () => {
    const parent = await temporaryDirectory("friction-append-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");
        git(repo, "remote", "add", "origin", "https://github.com/example/project.git");

        const result = await appendFriction({
            cwd: repo,
            source: "user",
            message: "  A confusing command needed a retry.  ",
            sessionId: "session-123",
            rootDir: logs,
        });
        const lines = (await readFile(result.file, "utf8")).trim().split("\n");
        const record = JSON.parse(lines[0]);
        const scope = JSON.parse(await readFile(join(dirname(result.file), "scope.json"), "utf8"));

        assert.equal(lines.length, 1);
        assert.equal(record.message, "A confusing command needed a retry.");
        assert.equal(record.source, "user");
        assert.equal(record.cwd, repo);
        assert.equal(record.sessionId, "session-123");
        assert.equal(record.scope, undefined);
        assert.equal(scope.key, "github.com/example/project");
        assert.ok(result.file.startsWith(logs));
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("concurrent appends preserve JSONL records", async () => {
    const parent = await temporaryDirectory("friction-concurrent-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");

        const results = await Promise.all(
            Array.from({ length: 20 }, (_, index) => appendFriction({
                cwd: repo,
                source: "agent",
                message: `Concurrent friction ${index}`,
                rootDir: logs,
            })),
        );
        const lines = (await readFile(results[0].file, "utf8")).trim().split("\n");
        const messages = lines.map((line) => JSON.parse(line).message).sort();

        assert.equal(lines.length, 20);
        assert.equal(new Set(messages).size, 20);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("normalizeMessage rejects empty and oversized messages", () => {
    assert.throws(() => normalizeMessage(" \0 "), /cannot be empty/);
    assert.throws(() => normalizeMessage("x".repeat(8_001)), /exceeds 8000/);
});
