import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveProjectScope, type ProjectScope } from "../shared/project-scope.ts";
import {
    REMINDERS_LIST_NAME,
    addReminder,
    parseTodoInput,
    readReminders,
    searchReminderRecords,
    type PiTodoContext,
    type ReminderRecord,
    type ScriptExecutor,
} from "./lib.ts";

function formatReminder(reminder: ReminderRecord): string {
    const context = "context" in reminder ? (reminder as ReminderRecord & { context?: PiTodoContext }).context : undefined;
    const status = reminder.completed ? "completed" : "open";
    const lines = [`- [${status}] ${reminder.title}`, `  Reminder: ${reminder.id}`];
    if (context) {
        lines.push(`  Project: ${context.projectKey}`);
        lines.push(`  Session: ${context.sessionName ?? context.sessionId}`);
    }
    if (reminder.dueAt) lines.push(`  Due: ${reminder.dueAt}`);
    return lines.join("\n");
}

export default function remindersTodosExtension(pi: ExtensionAPI) {
    const scopePromises = new Map<string, Promise<ProjectScope>>();
    let addTail: Promise<void> = Promise.resolve();

    const execute: ScriptExecutor = async (args, signal) => {
        return pi.exec("osascript", args, { signal, timeout: 15_000 });
    };

    const projectScope = (cwd: string): Promise<ProjectScope> => {
        let promise = scopePromises.get(cwd);
        if (!promise) {
            promise = resolveProjectScope(cwd);
            scopePromises.set(cwd, promise);
        }
        return promise;
    };

    const currentContext = async (ctx: ExtensionContext): Promise<PiTodoContext> => {
        const scope = await projectScope(ctx.cwd);
        return {
            version: 1,
            projectId: scope.id,
            projectKey: scope.key,
            cwd: ctx.cwd,
            ...(scope.gitRoot ? { gitRoot: scope.gitRoot } : {}),
            sessionId: ctx.sessionManager.getSessionId(),
            ...(pi.getSessionName() ? { sessionName: pi.getSessionName() } : {}),
            ...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
            createdAt: new Date().toISOString(),
        };
    };

    const enqueueAdd = async (title: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<ReminderRecord> => {
        let reminder: ReminderRecord | undefined;
        const operation = addTail.then(async () => {
            const parsed = parseTodoInput(title);
            reminder = await addReminder(execute, parsed.title, await currentContext(ctx), signal, parsed.dueAt);
        });
        addTail = operation.catch(() => undefined);
        await operation;
        return reminder!;
    };

    pi.on("session_start", (_event, ctx) => {
        void projectScope(ctx.cwd);
    });

    pi.registerCommand("todo", {
        description: `Add a project- and session-linked todo to the “${REMINDERS_LIST_NAME}” Reminders list`,
        handler: async (args, ctx) => {
            const text = args.trim();
            if (!text) {
                ctx.ui.notify("Usage: /todo <todo text>", "warning");
                return;
            }

            try {
                const reminder = await enqueueAdd(text, ctx);
                const due = reminder.dueAt ? ` (due ${reminder.dueAt})` : "";
                ctx.ui.notify(`Added todo to ${REMINDERS_LIST_NAME}: ${reminder.title}${due}`, "info");
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not add todo: ${reason}`, "error");
            }
        },
    });

    pi.registerTool(defineTool({
        name: "reminders_todos",
        label: "Reminders Todos",
        description: `Add or search Pi-linked todos in the macOS Reminders list named “${REMINDERS_LIST_NAME}”. Add recognizes trailing dates such as “friday morning” or “tomorrow at 3pm”. Search defaults to incomplete todos linked to the current canonical Git project.`,
        promptSnippet: "Add or search project-linked todos in macOS Reminders",
        promptGuidelines: [
            "Use reminders_todos when the user asks to add a todo or search reminders associated with current or prior Pi work.",
        ],
        parameters: Type.Object({
            action: StringEnum(["add", "search"] as const),
            text: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000, description: "Todo title for add" })),
            query: Type.Optional(Type.String({ maxLength: 1_000, description: "Terms that must appear in the title or notes for search" })),
            scope: Type.Optional(StringEnum(["current-project", "all"] as const, {
                description: "Search the current canonical Git project (default) or the entire list",
            })),
            includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed reminders in search results" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            if (params.action === "add") {
                if (!params.text?.trim()) throw new Error("text is required when action is add");
                const reminder = await enqueueAdd(params.text, ctx, signal);
                const due = reminder.dueAt ? ` (due ${reminder.dueAt})` : "";
                return {
                    content: [{ type: "text", text: `Added to ${REMINDERS_LIST_NAME}: ${reminder.title}${due}` }],
                    details: { reminder },
                };
            }

            const [stored, current] = await Promise.all([
                readReminders(execute, signal),
                currentContext(ctx),
            ]);
            if (!stored.listFound) {
                return {
                    content: [{
                        type: "text",
                        text: `The Reminders list “${REMINDERS_LIST_NAME}” does not exist yet. Adding the first todo will create it.`,
                    }],
                    details: { results: [], listFound: false },
                };
            }
            const results = searchReminderRecords({
                reminders: stored.reminders,
                current,
                query: params.query,
                scope: params.scope,
                includeCompleted: params.includeCompleted,
                limit: params.limit,
            });
            const text = results.length > 0
                ? results.map(formatReminder).join("\n")
                : "No matching todos were found.";
            return {
                content: [{ type: "text", text }],
                details: { results, listFound: true },
            };
        },
    }));
}
