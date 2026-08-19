export const REMINDERS_LIST_NAME = "mmm, pi";
export const CONTEXT_PREFIX = "PI_CONTEXT_JSON: ";

export interface PiTodoContext {
    version: 1;
    projectId: string;
    projectKey: string;
    cwd: string;
    gitRoot?: string;
    sessionId: string;
    sessionName?: string;
    sessionFile?: string;
    createdAt: string;
}

export interface ReminderRecord {
    id: string;
    title: string;
    notes: string;
    completed: boolean;
    createdAt?: string;
    dueAt?: string;
}

export interface ReminderSearchResult extends ReminderRecord {
    context?: PiTodoContext;
    relevance: number;
}

export interface ParsedTodoInput {
    title: string;
    dueAt?: string;
    datePhrase?: string;
}

export interface ProcessResult {
    stdout: string;
    stderr: string;
    code: number;
}

export type ScriptExecutor = (args: string[], signal?: AbortSignal) => Promise<ProcessResult>;

const JXA_SCRIPT = String.raw`
function iso(value) {
    if (!value) return undefined;
    try { return value.toISOString(); } catch (_) { return String(value); }
}

function listByName(app, name) {
    const list = app.lists.byName(name);
    return list.exists() ? list : undefined;
}

function ensureList(app, name) {
    const existing = listByName(app, name);
    if (existing) return existing;
    const created = app.List({ name: name });
    app.lists.push(created);
    return app.lists.byName(name);
}

function reminderRecord(reminder) {
    return {
        id: String(reminder.id()),
        title: String(reminder.name() || ""),
        notes: String(reminder.body() || ""),
        completed: Boolean(reminder.completed()),
        createdAt: iso(reminder.creationDate()),
        dueAt: iso(reminder.dueDate())
    };
}

function run(argv) {
    const action = argv[0];
    const listName = argv[1];
    const payload = argv[2] ? JSON.parse(argv[2]) : {};
    const app = Application("Reminders");

    if (action === "add") {
        const list = ensureList(app, listName);
        const properties = { name: payload.title, body: payload.notes };
        if (payload.dueAt) properties.dueDate = new Date(payload.dueAt);
        const reminder = app.Reminder(properties);
        list.reminders.push(reminder);
        return JSON.stringify({ listCreatedOrFound: true, reminder: reminderRecord(reminder) });
    }

    if (action === "search") {
        const list = listByName(app, listName);
        if (!list) return JSON.stringify({ listFound: false, reminders: [] });
        return JSON.stringify({
            listFound: true,
            reminders: list.reminders().map(reminderRecord)
        });
    }

    throw new Error("Unknown reminders action: " + action);
}
`;

function cleanLine(value: string): string {
    return value.replace(/[\r\n]+/g, " ").trim();
}

export function formatReminderNotes(context: PiTodoContext): string {
    const session = context.sessionName
        ? `${cleanLine(context.sessionName)} (${context.sessionId})`
        : context.sessionId;
    return [
        "Created by Pi",
        `Project: ${cleanLine(context.projectKey)}`,
        `Working directory: ${cleanLine(context.cwd)}`,
        `Session: ${session}`,
        ...(context.sessionFile ? [`Session file: ${cleanLine(context.sessionFile)}`] : []),
        `Created: ${context.createdAt}`,
        `${CONTEXT_PREFIX}${JSON.stringify(context)}`,
    ].join("\n");
}

export function parseReminderContext(notes: string): PiTodoContext | undefined {
    const line = notes.split(/\r?\n/).find((candidate) => candidate.startsWith(CONTEXT_PREFIX));
    if (!line) return undefined;
    try {
        const value = JSON.parse(line.slice(CONTEXT_PREFIX.length)) as Partial<PiTodoContext>;
        if (value.version !== 1 || !value.projectId || !value.projectKey || !value.cwd || !value.sessionId || !value.createdAt) {
            return undefined;
        }
        return value as PiTodoContext;
    } catch {
        return undefined;
    }
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const DATE_SUFFIX = new RegExp(
    String.raw`\s+(?:on\s+)?(?:(today|tomorrow|tonight)|(?:(this|next)\s+)?(${WEEKDAYS.join("|")})|(\d{4}-\d{2}-\d{2}))(?:\s+(?:(?:at\s+)?(morning|afternoon|evening|night|noon|midnight)|(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?))?\s*$`,
    "i",
);

function namedTime(value: string | undefined): { hour: number; minute: number } | undefined {
    switch (value?.toLocaleLowerCase()) {
        case "morning": return { hour: 9, minute: 0 };
        case "afternoon": return { hour: 13, minute: 0 };
        case "evening": return { hour: 18, minute: 0 };
        case "night": return { hour: 20, minute: 0 };
        case "noon": return { hour: 12, minute: 0 };
        case "midnight": return { hour: 0, minute: 0 };
        default: return undefined;
    }
}

function clockTime(hourText: string | undefined, minuteText: string | undefined, meridiem: string | undefined): {
    hour: number;
    minute: number;
} | undefined {
    if (!hourText) return undefined;
    let hour = Number(hourText);
    const minute = minuteText ? Number(minuteText) : 0;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return undefined;
    if (meridiem) {
        if (hour < 1 || hour > 12) return undefined;
        if (meridiem.toLocaleLowerCase() === "pm" && hour !== 12) hour += 12;
        if (meridiem.toLocaleLowerCase() === "am" && hour === 12) hour = 0;
    } else if (minuteText === undefined || hour > 23) {
        return undefined;
    }
    return { hour, minute };
}

export function parseTodoInput(input: string, now = new Date()): ParsedTodoInput {
    const original = input.trim();
    const match = DATE_SUFFIX.exec(original);
    if (!match) return { title: original };

    const title = original.slice(0, match.index).trim();
    if (!title) return { title: original };

    const [phrase, relativeDay, weekdayModifier, weekday, isoDate, timeName, hourText, minuteText, meridiem] = match;
    const parsedTime = namedTime(timeName) ?? clockTime(hourText, minuteText, meridiem);
    if ((timeName || hourText) && !parsedTime) return { title: original };
    const time = parsedTime
        ?? namedTime(relativeDay?.toLocaleLowerCase() === "tonight" ? "evening" : "morning")!;
    const due = new Date(now.getTime());
    due.setSeconds(0, 0);

    if (isoDate) {
        const [year, month, day] = isoDate.split("-").map(Number);
        due.setFullYear(year, month - 1, day);
        if (due.getFullYear() !== year || due.getMonth() !== month - 1 || due.getDate() !== day) {
            return { title: original };
        }
    } else if (weekday) {
        const target = WEEKDAYS.indexOf(weekday.toLocaleLowerCase() as typeof WEEKDAYS[number]);
        let daysAhead = (target - now.getDay() + 7) % 7;
        if (weekdayModifier?.toLocaleLowerCase() === "next") daysAhead += 7;
        due.setDate(due.getDate() + daysAhead);
    } else if (relativeDay?.toLocaleLowerCase() === "tomorrow") {
        due.setDate(due.getDate() + 1);
    }

    due.setHours(time.hour, time.minute, 0, 0);
    if (weekday && !weekdayModifier && due.getTime() <= now.getTime()) {
        due.setDate(due.getDate() + 7);
    }

    return {
        title,
        dueAt: due.toISOString(),
        datePhrase: phrase.trim(),
    };
}

function queryTerms(query: string): string[] {
    return [...new Set(query.toLocaleLowerCase().split(/[^\p{L}\p{N}._/-]+/u).filter(Boolean))];
}

export function searchReminderRecords(options: {
    reminders: ReminderRecord[];
    current: PiTodoContext;
    query?: string;
    scope?: "current-project" | "all";
    includeCompleted?: boolean;
    limit?: number;
}): ReminderSearchResult[] {
    const terms = queryTerms(options.query ?? "");
    const scope = options.scope ?? "current-project";
    const limit = Math.max(1, Math.min(options.limit ?? 10, 30));

    return options.reminders.flatMap((reminder) => {
        if (reminder.completed && !options.includeCompleted) return [];
        const context = parseReminderContext(reminder.notes);
        const sameProject = context?.projectId === options.current.projectId;
        if (scope === "current-project" && !sameProject) return [];

        const searchable = `${reminder.title}\n${reminder.notes}`.toLocaleLowerCase();
        if (terms.length > 0 && !terms.every((term) => searchable.includes(term))) return [];

        let relevance = 0;
        if (context?.sessionId === options.current.sessionId) relevance += 100;
        if (sameProject) relevance += 50;
        for (const term of terms) {
            if (reminder.title.toLocaleLowerCase().includes(term)) relevance += 10;
            else relevance += 2;
        }
        if (!reminder.completed) relevance += 1;
        return [{ ...reminder, context, relevance }];
    }).sort((left, right) =>
        right.relevance - left.relevance
        || (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
    ).slice(0, limit);
}

async function runJxa(
    execute: ScriptExecutor,
    action: "add" | "search",
    payload: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<unknown> {
    signal?.throwIfAborted();
    const result = await execute(["-l", "JavaScript", "-e", JXA_SCRIPT, action, REMINDERS_LIST_NAME, JSON.stringify(payload)], signal);
    if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `osascript exited with status ${result.code}`);
    }
    try {
        return JSON.parse(result.stdout.trim());
    } catch {
        throw new Error("Reminders returned an invalid response");
    }
}

export async function addReminder(
    execute: ScriptExecutor,
    title: string,
    context: PiTodoContext,
    signal?: AbortSignal,
    dueAt?: string,
): Promise<ReminderRecord> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error("Todo text is required");
    const response = await runJxa(execute, "add", {
        title: cleanTitle,
        notes: formatReminderNotes(context),
        ...(dueAt ? { dueAt } : {}),
    }, signal) as { reminder?: ReminderRecord };
    if (!response.reminder) throw new Error("Reminders did not return the created todo");
    return response.reminder;
}

export async function readReminders(
    execute: ScriptExecutor,
    signal?: AbortSignal,
): Promise<{ listFound: boolean; reminders: ReminderRecord[] }> {
    const response = await runJxa(execute, "search", {}, signal) as {
        listFound?: boolean;
        reminders?: ReminderRecord[];
    };
    return {
        listFound: response.listFound === true,
        reminders: Array.isArray(response.reminders) ? response.reminders : [],
    };
}
