import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readConversation, recentConversations, searchConversations } from "./lib.ts";

const temporaryRoot = join(process.cwd(), ".pi_tmp");

async function fixture(): Promise<{ root: string; cwd: string }> {
    await mkdir(temporaryRoot, { recursive: true });
    const root = await mkdtemp(join(temporaryRoot, "conversation-history-"));
    const cwd = join(root, "project");
    const sessions = join(root, "sessions", "project");
    await mkdir(cwd);
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "first.jsonl"), [
        JSON.stringify({ type: "session", version: 3, id: "session-one", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
        JSON.stringify({ type: "session_info", id: "name", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", name: "Memory design" }),
        JSON.stringify({ type: "message", id: "user-1", parentId: "name", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "Please preserve project-only memory with visible recall." } }),
        JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will design visible conversation search." }] } }),
    ].join("\n") + "\n");
    await writeFile(join(sessions, "ignored-pi-automode.jsonl"), `${JSON.stringify({ type: "classifier" })}\n`);
    return { root, cwd };
}

test("searchConversations returns bounded raw-message excerpts", async () => {
    const { root, cwd } = await fixture();
    try {
        const results = await searchConversations({
            query: "project memory",
            cwd,
            scope: "all",
            rootDir: join(root, "sessions"),
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].sessionId, "session-one");
        assert.equal(results[0].entryId, "user-1");
        assert.match(results[0].excerpt, /project-only memory/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("recentConversations lists metadata without loading transcript output", async () => {
    const { root, cwd } = await fixture();
    try {
        const results = await recentConversations({ cwd, scope: "all", rootDir: join(root, "sessions") });
        assert.equal(results.length, 1);
        assert.equal(results[0].name, "Memory design");
        assert.equal(results[0].messageCount, 2);
        assert.match(results[0].firstUserMessage ?? "", /project-only memory/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("readConversation returns a bounded window around an entry", async () => {
    const { root, cwd } = await fixture();
    void cwd;
    try {
        const result = await readConversation({
            sessionId: "session",
            entryId: "assistant-1",
            before: 1,
            after: 0,
            rootDir: join(root, "sessions"),
        });
        assert.ok(result);
        assert.deepEqual(result.messages.map((message) => message.entryId), ["user-1", "assistant-1"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
