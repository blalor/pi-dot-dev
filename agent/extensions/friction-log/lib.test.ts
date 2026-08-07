import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
    appendFriction,
    canonicalizeRemote,
    formatFrictionSummary,
    getFriction,
    normalizeMessage,
    readFrictions,
    resolveFrictionScope,
    searchFrictions,
    updateFriction,
} from "./lib.ts";

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

test("harness scope is shared across repositories and isolated from project friction", async () => {
    const parent = await temporaryDirectory("friction-harness-");
    try {
        const first = join(parent, "first");
        const second = join(parent, "second");
        const logs = join(parent, "logs");
        await mkdir(first);
        await mkdir(second);
        git(first, "init");
        git(second, "init");

        const firstHarness = await resolveFrictionScope(first, "harness");
        const secondHarness = await resolveFrictionScope(second, "harness");
        const project = await appendFriction({
            cwd: first,
            scope: "project",
            source: "agent",
            message: "The same words can describe different scoped friction.",
            rootDir: logs,
        });
        const harness = await appendFriction({
            cwd: first,
            scope: "harness",
            source: "agent",
            message: "The same words can describe different scoped friction.",
            workaround: "Apply the harness workaround.",
            rootDir: logs,
        });
        const fromSecondRepo = await searchFrictions({
            cwd: second,
            scope: "harness",
            query: "harness workaround",
            rootDir: logs,
        });

        assert.equal(firstHarness.id, "harness--pi");
        assert.equal(firstHarness.id, secondHarness.id);
        assert.notEqual(project.file, harness.file);
        assert.equal(project.duplicate, false);
        assert.equal(harness.duplicate, false);
        assert.equal(fromSecondRepo.total, 1);
        assert.equal(fromSecondRepo.entries[0].id, harness.entry.id);
        assert.match(formatFrictionSummary(fromSecondRepo.scope, fromSecondRepo.entries), /Pi harness/);
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
        assert.equal(record.type, "friction");
        assert.match(record.id, /^fr_[a-f0-9]{12}$/);
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

test("duplicate writes reuse a friction and append only a new workaround", async () => {
    const parent = await temporaryDirectory("friction-deduplicate-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");

        const first = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "The TEST command needs a workspace-relative path!",
            rootDir: logs,
        });
        const duplicate = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "the test command needs a workspace relative path",
            rootDir: logs,
        });
        const updated = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "The test command needs a workspace-relative path.",
            workaround: "Pass the path relative to apps/web.",
            rootDir: logs,
        });
        const repeatedWorkaround = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "The test command needs a workspace-relative path.",
            workaround: "pass the path relative to apps web",
            rootDir: logs,
        });
        const lines = (await readFile(first.file, "utf8")).trim().split("\n");
        const collection = await readFrictions({ cwd: repo, rootDir: logs });

        assert.equal(first.duplicate, false);
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.workaroundAdded, false);
        assert.equal(updated.duplicate, true);
        assert.equal(updated.workaroundAdded, true);
        assert.equal(repeatedWorkaround.workaroundAdded, false);
        assert.equal(lines.length, 2);
        assert.equal(collection.total, 1);
        assert.deepEqual(collection.entries[0].workarounds, ["Pass the path relative to apps/web."]);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("legacy friction records participate in deduplication and retrieval", async () => {
    const parent = await temporaryDirectory("friction-legacy-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");
        const initial = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "placeholder",
            rootDir: logs,
        });
        await writeFile(initial.file, `${JSON.stringify({
            timestamp: "2026-01-01T00:00:00.000Z",
            source: "agent",
            message: "Legacy friction has no ID.",
            cwd: repo,
        })}\n`);

        const duplicate = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "legacy friction has no id",
            workaround: "Use the migrated reader.",
            rootDir: logs,
        });
        const collection = await readFrictions({ cwd: repo, rootDir: logs });

        assert.equal(duplicate.duplicate, true);
        assert.equal(collection.total, 1);
        assert.match(collection.entries[0].id, /^fr_/);
        assert.deepEqual(collection.entries[0].workarounds, ["Use the migrated reader."]);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("search, lookup, and summaries progressively disclose known friction", async () => {
    const parent = await temporaryDirectory("friction-search-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");
        const vitest = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "Vitest paths are relative to the workspace.",
            workaround: "Use apps/web-relative paths.",
            rootDir: logs,
        });
        await appendFriction({
            cwd: repo,
            source: "agent",
            message: "zsh expands unquoted globs before ripgrep runs.",
            workaround: "Quote the glob.",
            rootDir: logs,
        });

        const search = await searchFrictions({ cwd: repo, rootDir: logs, query: "vitest workspace path" });
        const found = await getFriction({ cwd: repo, rootDir: logs }, vitest.entry.id.slice(0, 8));
        const summary = formatFrictionSummary(search.scope, search.entries, { total: search.total });

        assert.equal(search.total, 2);
        assert.equal(search.entries.length, 1);
        assert.equal(search.entries[0].id, vitest.entry.id);
        assert.equal(found?.id, vitest.entry.id);
        assert.match(summary, /apps\/web-relative paths/);
        assert.match(summary, /search_friction/);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("revision events replace folded fields without rewriting history", async () => {
    const parent = await temporaryDirectory("friction-revise-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");

        const original = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "The original friction message.",
            workaround: "The obsolete workaround.",
            rootDir: logs,
        });
        const revised = await updateFriction({
            cwd: repo,
            source: "agent",
            id: original.entry.id,
            operation: "revise",
            message: "The corrected friction message.",
            workarounds: ["The supported workaround.", "the supported workaround"],
            rootDir: logs,
        });
        const lines = (await readFile(original.file, "utf8")).trim().split("\n");

        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).message, "The original friction message.");
        assert.equal(JSON.parse(lines[1]).type, "update");
        assert.equal(revised.entry.message, "The corrected friction message.");
        assert.deepEqual(revised.entry.workarounds, ["The supported workaround."]);
        assert.equal(revised.entry.status, "active");
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("resolved and superseded frictions remain retrievable but leave search results", async () => {
    const parent = await temporaryDirectory("friction-lifecycle-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");

        const canonical = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "The canonical startup friction.",
            rootDir: logs,
        });
        const duplicate = await appendFriction({
            cwd: repo,
            source: "agent",
            message: "A related startup failure with different wording.",
            rootDir: logs,
        });
        await updateFriction({
            cwd: repo,
            source: "agent",
            id: duplicate.entry.id.slice(0, 8),
            operation: "supersede",
            supersededBy: canonical.entry.id.slice(0, 8),
            rootDir: logs,
        });
        await updateFriction({
            cwd: repo,
            source: "agent",
            id: canonical.entry.id,
            operation: "resolve",
            rootDir: logs,
        });

        const search = await searchFrictions({ cwd: repo, rootDir: logs });
        const resolved = await getFriction({ cwd: repo, rootDir: logs }, canonical.entry.id);
        const superseded = await getFriction({ cwd: repo, rootDir: logs }, duplicate.entry.id);

        assert.equal(search.total, 0);
        assert.deepEqual(search.entries, []);
        assert.equal(resolved?.status, "resolved");
        assert.equal(superseded?.status, "superseded");
        assert.equal(superseded?.supersededBy, canonical.entry.id);
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

test("concurrent duplicate writes produce one logical and physical friction record", async () => {
    const parent = await temporaryDirectory("friction-concurrent-deduplicate-");
    try {
        const repo = join(parent, "repo");
        const logs = join(parent, "logs");
        await mkdir(repo);
        git(repo, "init");

        const results = await Promise.all(
            Array.from({ length: 20 }, () => appendFriction({
                cwd: repo,
                source: "agent",
                message: "The same concurrent friction occurred.",
                rootDir: logs,
            })),
        );
        const lines = (await readFile(results[0].file, "utf8")).trim().split("\n");

        assert.equal(lines.length, 1);
        assert.equal(results.filter((result) => !result.duplicate).length, 1);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("normalizeMessage rejects empty and oversized messages", () => {
    assert.throws(() => normalizeMessage(" \0 "), /cannot be empty/);
    assert.throws(() => normalizeMessage("x".repeat(8_001)), /exceeds 8000/);
});

test("search accepts queries longer than the stored message limit", async () => {
    const parent = await temporaryDirectory("friction-long-query-");
    const logs = join(parent, "logs");
    const repository = join(parent, "repository");
    await mkdir(repository);
    git(repository, "init");
    git(repository, "remote", "add", "origin", "git@github.com:example/long-query.git");

    try {
        await appendFriction({
            cwd: repository,
            source: "agent",
            message: "Startup prompt search should not use storage validation.",
            rootDir: logs,
        });

        const result = await searchFrictions({
            cwd: repository,
            query: `${"context ".repeat(1_100)}startup prompt`,
            rootDir: logs,
        });

        assert.equal(result.entries.length, 1);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});
