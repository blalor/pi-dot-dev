import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
    appendCandidates,
    forgetMemory,
    listCandidates,
    parseCandidateExtraction,
    remember,
    reviseMemory,
    reviewCandidate,
    searchMemories,
    type ExtractionSource,
} from "./lib.ts";

const temporaryRoot = join(process.cwd(), ".pi_tmp");

async function fixture(): Promise<{ root: string; cwd: string }> {
    await mkdir(temporaryRoot, { recursive: true });
    const root = await mkdtemp(join(temporaryRoot, "memory-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    execFileSync("git", ["-C", cwd, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:example/project.git"], { stdio: "ignore" });
    return { root, cwd };
}

test("user and project memories are independently scoped and searchable", async () => {
    const { root, cwd } = await fixture();
    const storage = join(root, "store");
    try {
        const user = await remember({
            cwd,
            scope: "user",
            kind: "preference",
            statement: "Lead explanations with the deciding constraint.",
            authority: "user",
            rootDir: storage,
        });
        const project = await remember({
            cwd,
            scope: "project",
            kind: "decision",
            statement: "Memory candidates require review before activation.",
            authority: "user",
            rootDir: storage,
        });
        const duplicate = await remember({
            cwd,
            scope: "user",
            kind: "preference",
            statement: "lead explanations with the deciding constraint",
            authority: "user",
            rootDir: storage,
        });

        assert.equal(user.duplicate, false);
        assert.equal(project.duplicate, false);
        assert.equal(duplicate.duplicate, true);
        assert.equal((await searchMemories({ cwd, scope: "user", query: "deciding constraint", rootDir: storage }))[0].id, user.memory.id);
        assert.equal((await searchMemories({ cwd, scope: "project", query: "candidate review", rootDir: storage }))[0].id, project.memory.id);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("approved memories can be revised without losing identity", async () => {
    const { root, cwd } = await fixture();
    const storage = join(root, "store");
    try {
        const saved = await remember({
            cwd,
            scope: "user",
            kind: "preference",
            statement: "Prefer terse answers.",
            authority: "user",
            rootDir: storage,
        });
        const revised = await reviseMemory({
            cwd,
            id: saved.memory.id,
            statement: "Prefer concise answers with enough evidence to evaluate them.",
            rootDir: storage,
        });
        assert.equal(revised.id, saved.memory.id);
        assert.match(revised.statement, /enough evidence/);
        assert.equal((await searchMemories({ cwd, query: "enough evidence", rootDir: storage }))[0].id, saved.memory.id);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("forgetting retains the audit record but removes it from normal search", async () => {
    const { root, cwd } = await fixture();
    const storage = join(root, "store");
    try {
        const saved = await remember({
            cwd,
            scope: "user",
            kind: "workflow",
            statement: "Use visible history search before synthesizing old conversations.",
            authority: "user",
            rootDir: storage,
        });
        await forgetMemory({ cwd, id: saved.memory.id, rootDir: storage });
        assert.equal((await searchMemories({ cwd, scope: "user", rootDir: storage })).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("candidate parsing requires exact evidence and user authority for user scope", () => {
    const sources: ExtractionSource[] = [
        { entryId: "user-1", role: "user", text: "I prefer project-only memory with visible recall." },
        { entryId: "assistant-1", role: "assistant", text: "The project uses a candidate review queue." },
    ];
    const parsed = parseCandidateExtraction(JSON.stringify({ candidates: [
        {
            scope: "user",
            kind: "preference",
            statement: "The user prefers project-only memory with visible recall.",
            sourceEntryId: "user-1",
            evidence: "I prefer project-only memory with visible recall.",
            rationale: "This preference applies across repositories.",
        },
        {
            scope: "user",
            kind: "fact",
            statement: "Invalid assistant-derived user memory.",
            sourceEntryId: "assistant-1",
            evidence: "The project uses a candidate review queue.",
            rationale: "Assistant text cannot establish user memory.",
        },
        {
            scope: "project",
            kind: "fact",
            statement: "Invalid unsupported evidence.",
            sourceEntryId: "assistant-1",
            evidence: "This quote does not exist.",
            rationale: "Should be rejected.",
        },
    ] }), sources);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].sourceEntryId, "user-1");
});

test("candidate extraction rejects feature-specific implementation records", () => {
    const sources: ExtractionSource[] = [
        {
            entryId: "assistant-decision",
            role: "assistant",
            text: "The parsed phrase will be removed from the reminder title and stored as its due date; ambiguous phrases will remain part of the title rather than guessing.",
        },
        {
            entryId: "assistant-fact",
            role: "assistant",
            text: "Supported: today, tomorrow, tonight, weekdays, ISO dates, and named times of day.",
        },
        {
            entryId: "user-feature",
            role: "user",
            text: "For this reminder parser, ambiguous phrases should remain in the title.",
        },
    ];
    const parsed = parseCandidateExtraction(JSON.stringify({ candidates: [
        {
            scope: "project",
            kind: "decision",
            statement: "The reminders parser should leave ambiguous expressions in the title.",
            sourceEntryId: "assistant-decision",
            evidence: sources[0].text,
            rationale: "This could matter when changing this feature later.",
        },
        {
            scope: "project",
            kind: "fact",
            statement: "The reminders parser supports several date and time forms.",
            sourceEntryId: "assistant-fact",
            evidence: sources[1].text,
            rationale: "This describes the implemented capability.",
        },
        {
            scope: "project",
            kind: "workflow",
            statement: "Leave ambiguous reminder phrases in the title.",
            sourceEntryId: "user-feature",
            evidence: sources[2].text,
            rationale: "This is a feature-specific request, not an explicit standing workflow.",
        },
    ] }), sources);
    assert.deepEqual(parsed, []);
});

test("candidate extraction requires an explicit durability signal", () => {
    const sources: ExtractionSource[] = [{
        entryId: "user-1",
        role: "user",
        text: "Use the existing command helper for this change.",
    }];
    const parsed = parseCandidateExtraction(JSON.stringify({ candidates: [{
        scope: "project",
        kind: "workflow",
        statement: "Use the existing command helper.",
        sourceEntryId: "user-1",
        evidence: sources[0].text,
        rationale: "It might be useful later.",
    }] }), sources);
    assert.deepEqual(parsed, []);
});

test("autonomous candidates remain pending until approved", async () => {
    const { root, cwd } = await fixture();
    const storage = join(root, "store");
    const sources: ExtractionSource[] = [{
        entryId: "user-1",
        role: "user",
        text: "I prefer project-only memory with visible recall.",
    }];
    try {
        const extracted = parseCandidateExtraction(JSON.stringify({ candidates: [{
            scope: "user",
            kind: "preference",
            statement: "The user prefers project-only memory with visible recall.",
            sourceEntryId: "user-1",
            evidence: "I prefer project-only memory with visible recall.",
            rationale: "This preference applies across repositories.",
        }] }), sources);
        const candidates = await appendCandidates({ cwd, sessionId: "session-1", candidates: extracted, sources, rootDir: storage });
        assert.equal(candidates.length, 1);
        assert.equal((await listCandidates({ rootDir: storage }))[0].status, "pending");
        assert.equal((await searchMemories({ cwd, scope: "user", rootDir: storage })).length, 0);

        const approved = await reviewCandidate({ id: candidates[0].id.slice(0, 10), decision: "approve", rootDir: storage });
        assert.equal(approved.candidate.status, "approved");
        assert.equal(approved.memory?.source, "candidate");
        assert.equal((await searchMemories({ cwd, scope: "user", rootDir: storage })).length, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("candidate deduplication spans extraction runs", async () => {
    const { root, cwd } = await fixture();
    const storage = join(root, "store");
    const sources: ExtractionSource[] = [{ entryId: "user-1", role: "user", text: "I prefer short answers." }];
    const extracted = [{
        scope: "user" as const,
        kind: "preference" as const,
        statement: "The user prefers short answers.",
        sourceEntryId: "user-1",
        evidence: "I prefer short answers.",
        rationale: "It affects future responses.",
    }];
    try {
        assert.equal((await appendCandidates({ cwd, sessionId: "one", candidates: extracted, sources, rootDir: storage })).length, 1);
        assert.equal((await appendCandidates({ cwd, sessionId: "two", candidates: extracted, sources, rootDir: storage })).length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
