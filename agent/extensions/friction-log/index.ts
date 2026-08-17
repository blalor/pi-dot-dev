import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
    appendFriction,
    formatFrictionSummary,
    getFriction,
    migrateFrictions,
    searchFrictions,
    updateFriction,
    type FrictionScopeTarget,
} from "./lib.ts";

const DIGEST_TYPE = "friction-scope-digest";
const OWN_TOOL_NAMES = new Set(["log_friction", "search_friction", "get_friction", "update_friction", "migrate_frictions"]);
const LOCAL_TOOL_PATTERN = /^(?:frog(?:[_:-].*)?|papercuts?(?:[_:-].*)?|vent(?:[_:-].*)?|friction(?:[_:-].*)?)$/i;
const SCOPE_PARAMETER = Type.Optional(StringEnum(["project", "harness"] as const, {
    description: "project (default) for repository-scoped friction, or harness for Pi-wide friction",
}));

function preferredAgentTool(pi: ExtensionAPI): string | undefined {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools()
        .filter((tool) => active.has(tool.name) && !OWN_TOOL_NAMES.has(tool.name))
        .map((tool) => tool.name)
        .find((name) => LOCAL_TOOL_PATTERN.test(name));
}

function modelName(ctx: ExtensionContext): string | undefined {
    if (!ctx.model || ctx.model.provider === "unknown" || ctx.model.id === "unknown") return undefined;
    return `${ctx.model.provider}/${ctx.model.id}`;
}

function commonMetadata(ctx: ExtensionContext) {
    return {
        model: modelName(ctx),
        sessionId: ctx.sessionManager.getSessionId(),
    };
}

function parseScopeArgs(args: string): { scope: FrictionScopeTarget; rest: string } {
    const trimmed = args.trim();
    if (!trimmed.startsWith("--scope")) return { scope: "project", rest: trimmed };
    const match = trimmed.match(/^--scope(?:=|\s+)(project|harness)(?:\s+|$)(.*)$/s);
    if (!match) throw new Error("Scope must be project or harness");
    return { scope: match[1] as FrictionScopeTarget, rest: match[2].trim() };
}

function splitCommandArgs(args: string): { scope: FrictionScopeTarget; message: string; workaround?: string } {
    const { scope, rest } = parseScopeArgs(args);
    const separator = rest.indexOf(" :: ");
    if (separator === -1) return { scope, message: rest };
    return {
        scope,
        message: rest.slice(0, separator).trim(),
        workaround: rest.slice(separator + 4).trim() || undefined,
    };
}

function digestAlreadyPresent(ctx: ExtensionContext): boolean {
    return ctx.sessionManager.getBranch().some((entry) => {
        if (entry.type !== "message") return false;
        const message = entry.message as { role?: string; customType?: string };
        return message.role === "custom" && message.customType === DIGEST_TYPE;
    });
}

function renderToolCall(label: string, value: string | undefined, theme: Parameters<NonNullable<ReturnType<typeof defineTool>["renderCall"]>>[1], context: Parameters<NonNullable<ReturnType<typeof defineTool>["renderCall"]>>[2]) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(`${theme.fg("toolTitle", theme.bold(label))}${value ? ` ${theme.fg("dim", value)}` : ""}`);
    return text;
}

export default function frictionLogExtension(pi: ExtensionAPI) {
    let digestChecked = false;

    pi.registerTool(defineTool({
        name: "log_friction",
        label: "Log Friction",
        description:
            "Logger for small, non-blocking workflow friction. For project scope, prefer any repository-local logger required by repository instructions or exposed as a tool, such as frog. Use harness scope for Pi-specific friction. Search known friction before improvising a workaround, and include a successful workaround when relevant.",
        promptSnippet: "Log non-blocking workflow friction and its workaround when no repository-local logger exists",
        promptGuidelines: [
            "For project-scoped friction, prefer the repository's own friction-capturing instructions or tools, such as frog; use log_friction with harness scope for Pi-specific friction.",
            "When friction occurs, use search_friction for known workarounds before improvising; include the successful workaround when calling log_friction.",
            "Use log_friction for small workflow friction worth preventing later, not for completed work, real bugs, tracked tasks, or the agent's avoidable mistakes.",
        ],
        parameters: Type.Object({
            scope: SCOPE_PARAMETER,
            message: Type.String({
                minLength: 1,
                maxLength: 8_000,
                description: "One or two sentences describing the task and what got in the way",
            }),
            workaround: Type.Optional(Type.String({
                maxLength: 4_000,
                description: "The verified workaround or prevention, when one is known",
            })),
        }),

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            const preferred = params.scope === "harness" ? undefined : preferredAgentTool(pi);
            if (preferred) {
                return {
                    content: [{ type: "text", text: `Not logged here. Use the preferred friction tool ${preferred} instead.` }],
                    details: { redirectedTo: preferred },
                };
            }

            const result = await appendFriction({
                cwd: ctx.cwd,
                scope: params.scope,
                source: "agent",
                message: params.message,
                workaround: params.workaround,
                ...commonMetadata(ctx),
            });
            const status = result.duplicate
                ? result.workaroundAdded
                    ? `Known friction ${result.entry.id}; added a new workaround.`
                    : `Known friction ${result.entry.id}; duplicate not written.`
                : `Logged friction ${result.entry.id} for ${result.scope.key}.`;
            return {
                content: [{ type: "text", text: status }],
                details: { ...result, file: result.file },
            };
        },

        renderCall(args, theme, context) {
            return renderToolCall("log friction", args.message, theme, context);
        },

        renderResult(result, _options, theme, context) {
            const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
            const details = result.details as { redirectedTo?: string; duplicate?: boolean; workaroundAdded?: boolean } | undefined;
            if (details?.redirectedTo) {
                text.setText(theme.fg("warning", `Use ${details.redirectedTo} instead`));
            } else if (details?.duplicate) {
                text.setText(theme.fg("muted", details.workaroundAdded ? "Known friction; workaround added" : "Duplicate skipped"));
            } else {
                text.setText(theme.fg("success", "Friction logged"));
            }
            return text;
        },
    }));

    pi.registerTool(defineTool({
        name: "search_friction",
        label: "Search Friction",
        description: "Search known friction and workarounds for the current Git remote or directory scope. Results are operational notes; verify them against the current repository before use.",
        promptSnippet: "Search scoped friction history for known workarounds",
        parameters: Type.Object({
            scope: SCOPE_PARAMETER,
            query: Type.Optional(Type.String({ description: "Terms describing the friction; omit for a recent scope summary" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            const result = await searchFrictions({
                cwd: ctx.cwd,
                scope: params.scope,
                query: params.query,
                limit: params.limit,
            });
            return {
                content: [{
                    type: "text",
                    text: formatFrictionSummary(result.scope, result.entries, { total: result.total, maxChars: 8_000 }),
                }],
                details: result,
            };
        },
        renderCall(args, theme, context) {
            return renderToolCall("search friction", args.query, theme, context);
        },
    }));

    pi.registerTool(defineTool({
        name: "get_friction",
        label: "Get Friction",
        description: "Get one full friction record by ID from the current Git remote or directory scope.",
        parameters: Type.Object({
            scope: SCOPE_PARAMETER,
            id: Type.String({ minLength: 1, description: "Full friction ID or an unambiguous prefix" }),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            const entry = await getFriction({ cwd: ctx.cwd, scope: params.scope }, params.id);
            return {
                content: [{
                    type: "text",
                    text: entry
                        ? JSON.stringify(entry, null, 4)
                        : `No unambiguous friction record matches ${params.id}.`,
                }],
                details: { entry },
            };
        },
        renderCall(args, theme, context) {
            return renderToolCall("get friction", args.id, theme, context);
        },
    }));

    pi.registerTool(defineTool({
        name: "update_friction",
        label: "Update Friction",
        description: "Append a revision or lifecycle event to an existing friction without rewriting its JSONL history.",
        parameters: Type.Object({
            scope: SCOPE_PARAMETER,
            id: Type.String({ minLength: 1, description: "Full friction ID or an unambiguous prefix" }),
            operation: StringEnum(["revise", "resolve", "supersede"] as const),
            message: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
            workarounds: Type.Optional(Type.Array(Type.String({ maxLength: 4_000 }))),
            supersededBy: Type.Optional(Type.String({ minLength: 1 })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            const result = await updateFriction({
                cwd: ctx.cwd,
                source: "agent",
                scope: params.scope,
                id: params.id,
                operation: params.operation,
                message: params.message,
                workarounds: params.workarounds,
                supersededBy: params.supersededBy,
                ...commonMetadata(ctx),
            });
            return {
                content: [{ type: "text", text: `Updated friction ${result.entry.id}: ${result.entry.status}.` }],
                details: result,
            };
        },
        renderCall(args, theme, context) {
            return renderToolCall(`update friction (${args.operation})`, args.id, theme, context);
        },
    }));

    pi.registerTool(defineTool({
        name: "migrate_frictions",
        label: "Migrate Frictions",
        description: "Move all remaining legacy JSONL frictions in one scope into per-friction directories.",
        parameters: Type.Object({ scope: SCOPE_PARAMETER }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            signal?.throwIfAborted();
            const result = await migrateFrictions({
                cwd: ctx.cwd,
                source: "agent",
                scope: params.scope,
                ...commonMetadata(ctx),
            });
            return {
                content: [{ type: "text", text: `Migrated ${result.migrated} friction record(s).` }],
                details: result,
            };
        },
        renderCall(_args, theme, context) {
            return renderToolCall("migrate frictions", undefined, theme, context);
        },
    }));

    pi.on("session_start", () => {
        digestChecked = false;
    });

    pi.on("before_agent_start", async (event, ctx) => {
        if (digestChecked) return;
        digestChecked = true;
        if (digestAlreadyPresent(ctx)) return;

        const summaries: string[] = [];
        const scopeIds: string[] = [];
        for (const scope of ["project", "harness"] as const) {
            const result = await searchFrictions({ cwd: ctx.cwd, scope, query: event.prompt, limit: scope === "project" ? 3 : 2 });
            if (result.total === 0) continue;
            const entries = result.entries.length > 0
                ? result.entries
                : (await searchFrictions({ cwd: ctx.cwd, scope, limit: scope === "project" ? 3 : 2 })).entries;
            summaries.push(formatFrictionSummary(result.scope, entries, { total: result.total, maxChars: 700 }));
            scopeIds.push(result.scope.id);
        }
        if (summaries.length === 0) return;

        const combined = summaries.join("\n\n");
        return {
            message: {
                customType: DIGEST_TYPE,
                content: combined.length <= 1_200 ? combined : `${combined.slice(0, 1_199).trimEnd()}…`,
                display: true,
                details: { scopeIds },
            },
        };
    });

    pi.registerCommand("friction", {
        description: "Record friction; use: /friction [--scope project|harness] <message> :: <workaround>",
        handler: async (args, ctx) => {
            try {
                const parsed = splitCommandArgs(args);
                if (!parsed.message) {
                    if (!ctx.isIdle()) {
                        ctx.ui.notify(
                            "Usage while the agent is working: /friction [--scope project|harness] <message> :: <workaround>",
                            "warning",
                        );
                        return;
                    }
                    if (!ctx.hasUI) return;
                    parsed.message = (await ctx.ui.input("Friction to record", "What got in the way?"))?.trim() ?? "";
                    if (!parsed.message) return;
                    parsed.workaround = (await ctx.ui.input("Workaround (optional)", "What worked?"))?.trim() || undefined;
                }

                const result = await appendFriction({
                    cwd: ctx.cwd,
                    source: "user",
                    ...parsed,
                    ...commonMetadata(ctx),
                });
                const status = result.duplicate
                    ? result.workaroundAdded ? "Known friction; added the workaround" : "Duplicate friction skipped"
                    : `Friction logged: ${result.entry.id}`;
                ctx.ui.notify(status, "info");
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not log friction: ${reason}`, "error");
            }
        },
    });

    pi.registerCommand("frictions", {
        description: "Show known friction; use: /frictions [--scope project|harness] [query]",
        handler: async (args, ctx) => {
            try {
                const { scope, rest: query } = parseScopeArgs(args);
                const result = await searchFrictions({ cwd: ctx.cwd, scope, query: query || undefined, limit: 10 });
                ctx.ui.notify(
                    formatFrictionSummary(result.scope, result.entries, { total: result.total, maxChars: 6_000 }),
                    "info",
                );
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not read friction: ${reason}`, "error");
            }
        },
    });
}
