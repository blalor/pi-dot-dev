import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
    appendWorkEpisode,
    episodeFile,
    parseWorkSummary,
    readWorkLogState,
    redactSensitiveText,
    selectEpisodeRange,
    workEpisodeId,
    writeWorkLogState,
    type WorkEpisode,
} from "./lib.ts";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporaryRoot = join(projectRoot, ".pi_tmp");

async function temporaryDirectory(prefix: string): Promise<string> {
    await mkdir(temporaryRoot, { recursive: true });
    return mkdtemp(join(temporaryRoot, prefix));
}

test("parseWorkSummary accepts SKIP", () => {
    const summary = parseWorkSummary("SKIP");
    assert.equal(summary.decision, "skip");
    assert.deepEqual(summary.accomplished, []);
});

test("parseWorkSummary normalizes and bounds structured output", () => {
    const summary = parseWorkSummary(`\`\`\`json
{
  "decision": "log",
  "accomplished": ["  Added   episode logging.  "],
  "decisions": ["Use idle boundaries."],
  "artifacts": [],
  "validation": ["Tests passed."],
  "blockers": [],
  "next": ["Connect the daily rollup."]
}
\`\`\``);
    assert.equal(summary.decision, "log");
    assert.deepEqual(summary.accomplished, ["Added episode logging."]);
    assert.deepEqual(summary.decisions, ["Use idle boundaries."]);
});

test("parseWorkSummary rejects malformed output and skips empty records", () => {
    assert.throws(() => parseWorkSummary("not json"), /invalid JSON/);
    assert.throws(() => parseWorkSummary('{"decision":"LOG","accomplished":["work"]}'), /invalid decision/);
    assert.throws(() => parseWorkSummary('{"accomplished":["work"]}'), /invalid decision/);
    assert.equal(parseWorkSummary('{"decision":"log"}').decision, "skip");
});

test("redactSensitiveText removes common credentials", () => {
    const redacted = redactSensitiveText("Authorization: Bearer abc.def-123 API_KEY=secret-value ghp_abcdefghijklmnopqrstuvwxyz");
    assert.doesNotMatch(redacted, /abc\.def|secret-value|ghp_/);
    assert.match(redacted, /REDACTED/);
});

test("selectEpisodeRange returns only entries after the persisted cursor", () => {
    const entries = [
        { id: "a", type: "message", timestamp: "2026-08-06T10:00:00.000Z" },
        { id: "b", type: "model_change", timestamp: "2026-08-06T10:01:00.000Z" },
        { id: "c", type: "message", timestamp: "2026-08-06T10:02:00.000Z" },
        { id: "d", type: "message", timestamp: "2026-08-06T10:03:00.000Z" },
    ];
    const range = selectEpisodeRange(entries, "b");
    assert.ok(range);
    assert.equal(range.fromEntryId, "c");
    assert.equal(range.toEntryId, "d");
    assert.equal(range.messageEntries.length, 2);
    assert.equal(range.startedAt, "2026-08-06T10:02:00.000Z");
    assert.equal(selectEpisodeRange(entries, "missing"), undefined);
});

test("daily episode append and session cursor persistence use separate paths", async () => {
    const root = await temporaryDirectory("work-log-");
    try {
        const episode: WorkEpisode = {
            id: workEpisodeId("session/123", "a", "z"),
            startedAt: "2026-08-06T10:00:00.000Z",
            endedAt: "2026-08-06T10:30:00.000Z",
            generatedAt: "2026-08-06T10:31:00.000Z",
            sessionId: "session/123",
            cwd: "/work/project",
            remote: "github.com/example/project",
            agentModel: "example/model",
            fromEntryId: "a",
            toEntryId: "z",
            accomplished: ["Implemented work logging."],
            decisions: [],
            artifacts: [],
            validation: ["Tests passed."],
            blockers: [],
            next: [],
        };

        const file = await appendWorkEpisode(root, episode);
        await appendWorkEpisode(root, episode);
        await writeWorkLogState(root, episode.sessionId, {
            lastEntryId: episode.toEntryId,
            updatedAt: episode.generatedAt,
        });
        const records = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const record = records[0];
        const state = await readWorkLogState(root, episode.sessionId);

        assert.equal(file, episodeFile(root, episode.endedAt));
        assert.equal(records.length, 1);
        assert.equal(record.sessionId, "session/123");
        assert.equal(record.accomplished[0], "Implemented work logging.");
        assert.equal(state?.lastEntryId, "z");
        assert.ok(!file.includes("_state"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
