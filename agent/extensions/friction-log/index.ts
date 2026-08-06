import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { appendFriction } from "./lib.ts";

const TOOL_NAME = "log_friction";
const LOCAL_TOOL_PATTERN = /^(?:frog(?:[_:-].*)?|papercuts?(?:[_:-].*)?|vent(?:[_:-].*)?|friction(?:[_:-].*)?)$/i;

function preferredAgentTool(pi: ExtensionAPI): string | undefined {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools()
        .filter((tool) => active.has(tool.name) && tool.name !== TOOL_NAME)
        .map((tool) => tool.name)
        .find((name) => LOCAL_TOOL_PATTERN.test(name));
}

function modelName(ctx: ExtensionContext): string | undefined {
    return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

const frictionTool = (pi: ExtensionAPI) => defineTool({
    name: TOOL_NAME,
    label: "Log Friction",
    description:
        "Fallback logger for small, non-blocking workflow friction. Prefer any repository-local friction logger required by repository instructions or exposed as a tool, such as frog, over this global logger. Use this only when no repo-local mechanism exists.",
    promptSnippet: "Log non-blocking workflow friction when no repository-local logger exists",
    promptGuidelines: [
        "Before using log_friction, prefer the repository's own friction-capturing instructions or tools, such as frog; log_friction is only the global fallback.",
        "Use log_friction for small workflow friction worth preventing later, not for completed work, real bugs, tracked tasks, or the agent's avoidable mistakes.",
    ],
    parameters: Type.Object({
        message: Type.String({
            minLength: 1,
            maxLength: 8_000,
            description: "One or two sentences: what you were doing, what got in the way, and a likely prevention when useful",
        }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();

        const preferred = preferredAgentTool(pi);
        if (preferred) {
            return {
                content: [{
                    type: "text",
                    text: `Not logged here. Use the active repository-local friction tool ${preferred} instead.`,
                }],
                details: { redirectedTo: preferred },
            };
        }

        const result = await appendFriction({
            cwd: ctx.cwd,
            source: "agent",
            message: params.message,
            model: modelName(ctx),
            sessionId: ctx.sessionManager.getSessionId(),
        });

        return {
            content: [{ type: "text", text: `Logged friction for ${result.scope.key}.` }],
            details: { file: result.file, scope: result.scope },
        };
    },

    renderCall(args, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(`${theme.fg("toolTitle", theme.bold("log friction"))} ${theme.fg("dim", args.message)}`);
        return text;
    },

    renderResult(result, _options, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const details = result.details as { redirectedTo?: string; file?: string } | undefined;
        if (details?.redirectedTo) {
            text.setText(theme.fg("warning", `Use ${details.redirectedTo} instead`));
        } else {
            text.setText(theme.fg("success", "Friction logged"));
        }
        return text;
    },
});

export default function frictionLogExtension(pi: ExtensionAPI) {
    pi.registerTool(frictionTool(pi));

    pi.registerCommand("friction", {
        description: "Immediately append a note to the scoped friction log",
        handler: async (args, ctx) => {
            let message = args.trim();
            if (!message) {
                if (!ctx.isIdle()) {
                    ctx.ui.notify("Usage while the agent is working: /friction <message>", "warning");
                    return;
                }
                if (!ctx.hasUI) return;
                message = (await ctx.ui.input("Friction to record", "What got in the way?"))?.trim() ?? "";
                if (!message) return;
            }

            try {
                const result = await appendFriction({
                    cwd: ctx.cwd,
                    source: "user",
                    message,
                    model: modelName(ctx),
                    sessionId: ctx.sessionManager.getSessionId(),
                });
                ctx.ui.notify(`Friction logged: ${result.file}`, "info");
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not log friction: ${reason}`, "error");
            }
        },
    });
}
