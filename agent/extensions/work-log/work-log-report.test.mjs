import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
    datesInRange,
    fileForDate,
    parseArguments,
    readEpisodes,
    renderReport,
} from "./work-log-report.mjs";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const temporaryRoot = join(projectRoot, ".pi_tmp");

async function temporaryDirectory(prefix) {
    await mkdir(temporaryRoot, { recursive: true });
    return mkdtemp(join(temporaryRoot, prefix));
}

function episode(overrides = {}) {
    return {
        id: "episode-1",
        startedAt: "2026-08-06T10:00:00.000Z",
        endedAt: "2026-08-06T10:30:00.000Z",
        generatedAt: "2026-08-06T10:31:00.000Z",
        sessionId: "session-1",
        cwd: "/work/project",
        remote: "github.com/example/project",
        accomplished: ["Implemented reporting."],
        decisions: [],
        artifacts: [],
        validation: ["Tests passed."],
        blockers: [],
        next: [],
        ...overrides,
    };
}

async function writeEpisodes(root, date, episodes) {
    const file = fileForDate(root, date);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${episodes.map((item) => JSON.stringify(item)).join("\n")}\n`);
    return file;
}

test("parseArguments supports the documented periods", () => {
    const now = new Date(2026, 7, 6, 14, 0, 0);
    assert.deepEqual(parseArguments([], now), { since: "2026-08-06", until: "2026-08-06" });
    assert.deepEqual(parseArguments(["today"], now), { since: "2026-08-06", until: "2026-08-06" });
    assert.deepEqual(parseArguments(["yesterday"], now), { since: "2026-08-05", until: "2026-08-05" });
    assert.deepEqual(parseArguments(["--since", "2026-08-01", "--until", "2026-08-06"], now), {
        since: "2026-08-01",
        until: "2026-08-06",
    });
    assert.throws(() => parseArguments(["--since", "2026-08-01"]), /both --since and --until/);
    assert.throws(() => parseArguments(["--since", "2026-08-07", "--until", "2026-08-06"]), /must not be later/);
});

test("datesInRange includes both boundaries", () => {
    assert.deepEqual(datesInRange("2026-07-30", "2026-08-02"), [
        "2026-07-30",
        "2026-07-31",
        "2026-08-01",
        "2026-08-02",
    ]);
});

test("readEpisodes reads only dated work-log files and deduplicates IDs", async () => {
    const root = await temporaryDirectory("work-report-read-");
    try {
        await writeEpisodes(root, "2026-08-05", [episode()]);
        const legacy = episode({ id: undefined, sessionId: "legacy-session", fromEntryId: "a", toEntryId: "z" });
        await writeEpisodes(root, "2026-08-06", [episode(), episode({ id: "episode-2", sessionId: "session-2" }), legacy]);
        await mkdir(join(root, "_state"), { recursive: true });
        await writeFile(join(root, "_state", "ignored.json"), JSON.stringify({ lastEntryId: "x" }));

        const episodes = await readEpisodes(root, "2026-08-05", "2026-08-06");
        assert.deepEqual(episodes.map((item) => item.id), [
            "episode-1",
            "episode-2",
            "legacy:legacy-session:a:z",
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("readEpisodes reports malformed records with file and line", async () => {
    const root = await temporaryDirectory("work-report-invalid-");
    try {
        const file = fileForDate(root, "2026-08-06");
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "{bad json}\n");
        await assert.rejects(() => readEpisodes(root, "2026-08-06", "2026-08-06"), new RegExp(`${file}:1: invalid JSON`));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("renderReport groups by project and deduplicates category items", () => {
    const report = renderReport([
        episode(),
        episode({
            id: "episode-2",
            sessionId: "session-2",
            accomplished: ["Implemented reporting.", "Documented usage."],
            decisions: ["Use deterministic formatting."],
        }),
    ], "2026-08-06", "2026-08-06");

    assert.match(report, /^# Work log report/m);
    assert.match(report, /^## github\.com\/example\/project$/m);
    assert.equal(report.match(/- Implemented reporting\./g)?.length, 1);
    assert.match(report, /- Documented usage\./);
    assert.match(report, /`session-1`/);
    assert.match(report, /`session-2`/);
});

test("renderReport handles an empty period", () => {
    assert.match(renderReport([], "2026-08-06", "2026-08-06"), /No work episodes recorded\./);
});
