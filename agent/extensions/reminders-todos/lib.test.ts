import assert from "node:assert/strict";
import test from "node:test";
import {
    CONTEXT_PREFIX,
    REMINDERS_LIST_NAME,
    addReminder,
    formatReminderNotes,
    parseReminderContext,
    parseTodoInput,
    readReminders,
    searchReminderRecords,
    type PiTodoContext,
    type ReminderRecord,
    type ScriptExecutor,
} from "./lib.ts";

function context(overrides: Partial<PiTodoContext> = {}): PiTodoContext {
    return {
        version: 1,
        projectId: "remote--example-project--123",
        projectKey: "github.com/example/project",
        cwd: "/work/project",
        gitRoot: "/work/project",
        sessionId: "session-current",
        sessionName: "Fix reminder integration",
        sessionFile: "/sessions/current.jsonl",
        createdAt: "2026-08-07T10:00:00.000Z",
        ...overrides,
    };
}

function reminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
    return {
        id: "reminder-1",
        title: "Repair session lookup",
        notes: formatReminderNotes(context()),
        completed: false,
        createdAt: "2026-08-07T10:01:00.000Z",
        ...overrides,
    };
}

test("reminder notes preserve human-readable and machine-readable Pi context", () => {
    const value = context({ sessionName: "Fix\nreminders" });
    const notes = formatReminderNotes(value);

    assert.match(notes, /^Created by Pi$/m);
    assert.match(notes, /^Project: github\.com\/example\/project$/m);
    assert.match(notes, /^Session: Fix reminders \(session-current\)$/m);
    assert.ok(notes.includes(`\n${CONTEXT_PREFIX}`));
    assert.deepEqual(parseReminderContext(notes), value);
    assert.equal(parseReminderContext("ordinary reminder notes"), undefined);
    assert.equal(parseReminderContext(`${CONTEXT_PREFIX}{bad json`), undefined);
});

test("todo input parses trailing natural-language dates in local time", () => {
    const mondayAfternoon = new Date(2026, 7, 3, 14, 0, 0, 0);
    const fridayMorning = parseTodoInput("Ship the release friday morning", mondayAfternoon);
    const fridayAtThree = parseTodoInput("Check deployment Friday at 3pm", mondayAfternoon);
    const nextFriday = parseTodoInput("Review metrics next friday", mondayAfternoon);
    const tomorrowEvening = parseTodoInput("Prepare slides tomorrow evening", mondayAfternoon);

    assert.equal(fridayMorning.title, "Ship the release");
    assert.equal(fridayMorning.datePhrase?.toLocaleLowerCase(), "friday morning");
    assert.deepEqual(
        [new Date(fridayMorning.dueAt!).getDay(), new Date(fridayMorning.dueAt!).getHours(), new Date(fridayMorning.dueAt!).getMinutes()],
        [5, 9, 0],
    );
    assert.deepEqual(
        [new Date(fridayAtThree.dueAt!).getDay(), new Date(fridayAtThree.dueAt!).getHours()],
        [5, 15],
    );
    assert.equal(new Date(nextFriday.dueAt!).getDate(), 14);
    assert.deepEqual(
        [new Date(tomorrowEvening.dueAt!).getDate(), new Date(tomorrowEvening.dueAt!).getHours()],
        [4, 18],
    );
});

test("todo input leaves ambiguous or invalid trailing text unchanged", () => {
    const now = new Date(2026, 7, 3, 14, 0, 0, 0);
    assert.deepEqual(parseTodoInput("Prepare the friday report", now), { title: "Prepare the friday report" });
    assert.deepEqual(parseTodoInput("Call support friday at 3", now), { title: "Call support friday at 3" });
    assert.deepEqual(parseTodoInput("Schedule release 2026-02-30", now), { title: "Schedule release 2026-02-30" });
    assert.deepEqual(parseTodoInput("friday morning", now), { title: "friday morning" });
});

test("search prioritizes the current session, then the current project", () => {
    const current = context();
    const sameSession = reminder({ id: "same-session", title: "Write release notes" });
    const sameProject = reminder({
        id: "same-project",
        title: "Write migration notes",
        notes: formatReminderNotes(context({ sessionId: "session-old", sessionName: "Older work" })),
    });
    const otherProject = reminder({
        id: "other-project",
        title: "Write unrelated notes",
        notes: formatReminderNotes(context({
            projectId: "other",
            projectKey: "github.com/example/other",
            sessionId: "session-other",
        })),
    });

    assert.deepEqual(
        searchReminderRecords({ reminders: [sameProject, otherProject, sameSession], current })
            .map((item) => item.id),
        ["same-session", "same-project"],
    );
    assert.deepEqual(
        searchReminderRecords({
            reminders: [sameProject, otherProject, sameSession],
            current,
            query: "write notes",
            scope: "all",
        }).map((item) => item.id),
        ["same-session", "same-project", "other-project"],
    );
});

test("search excludes completed and untagged reminders by default", () => {
    const current = context();
    const completed = reminder({ id: "completed", completed: true });
    const untagged = reminder({ id: "untagged", notes: "manually created" });

    assert.deepEqual(searchReminderRecords({ reminders: [completed, untagged], current }), []);
    assert.deepEqual(
        searchReminderRecords({
            reminders: [completed, untagged],
            current,
            scope: "all",
            includeCompleted: true,
        }).map((item) => item.id),
        ["completed", "untagged"],
    );
});

test("Reminders bridge passes values as argv rather than interpolating them into JXA", async () => {
    const calls: string[][] = [];
    const execute: ScriptExecutor = async (args) => {
        calls.push(args);
        return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({ reminder: reminder({ title: `Quote ' and \"double\"` }) }),
        };
    };

    const dueAt = "2026-08-14T13:00:00.000Z";
    const created = await addReminder(execute, `Quote ' and \"double\"`, context(), undefined, dueAt);
    assert.equal(created.title, `Quote ' and \"double\"`);
    assert.equal(calls[0][4], "add");
    assert.equal(calls[0][5], REMINDERS_LIST_NAME);
    const payload = JSON.parse(calls[0][6]);
    assert.equal(payload.title, `Quote ' and \"double\"`);
    assert.equal(payload.dueAt, dueAt);
    assert.match(payload.notes, /session-current/);
    assert.doesNotMatch(calls[0][3], /session-current|Quote/);
});

test("Reminders bridge handles a missing list without creating it during search", async () => {
    const execute: ScriptExecutor = async (args) => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ listFound: false, reminders: [], action: args[4] }),
    });
    assert.deepEqual(await readReminders(execute), { listFound: false, reminders: [] });
});
