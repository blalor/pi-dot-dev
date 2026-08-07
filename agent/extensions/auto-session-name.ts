import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_PROMPT_CHARS = 4_000;
const MAX_NAME_CHARS = 28;
const SYSTEM_PROMPT = `Create a short session title from the user's prompt.
Return only the title: 2 to 5 plain words, at most ${MAX_NAME_CHARS} characters.
Use specific nouns and verbs. Do not use quotes, markdown, labels, or ending punctuation.`;

function hasUserMessage(ctx: ExtensionContext): boolean {
    return ctx.sessionManager.getBranch().some(
        (entry) => entry.type === "message" && entry.message.role === "user",
    );
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
        .filter(
            (part): part is { type: "text"; text: string } =>
                typeof part === "object" &&
                part !== null &&
                (part as { type?: unknown }).type === "text" &&
                typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("\n");
}

function originalPrompt(ctx: ExtensionContext): string | undefined {
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        const text = contentText(entry.message.content).trim();
        return text || undefined;
    }
    return undefined;
}

function extractText(response: Awaited<ReturnType<typeof complete>>): string {
    return response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ");
}

function normalizeName(value: string): string {
    const normalized = value
        .replace(/^\s*(?:session\s+)?title\s*:\s*/i, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[.!?:;,\-–—]+$/g, "")
        .trim();

    const characters = Array.from(normalized);
    if (characters.length <= MAX_NAME_CHARS) return normalized;

    const prefix = characters.slice(0, MAX_NAME_CHARS + 1).join("");
    const lastSpace = prefix.lastIndexOf(" ");
    return (lastSpace >= 12 ? prefix.slice(0, lastSpace) : characters.slice(0, MAX_NAME_CHARS).join("")).trim();
}

async function generateName(prompt: string, ctx: ExtensionContext): Promise<string | undefined> {
    const model = ctx.model;
    if (!model) return undefined;

    try {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) return undefined;

        const response = await complete(
            model,
            {
                systemPrompt: SYSTEM_PROMPT,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: prompt.slice(0, MAX_PROMPT_CHARS),
                            },
                        ],
                        timestamp: Date.now(),
                    },
                ],
            },
            {
                apiKey: auth.apiKey,
                headers: auth.headers,
                maxTokens: 64,
                reasoningEffort: "minimal",
            },
        );

        if (response.stopReason === "error") return undefined;
        return normalizeName(extractText(response)) || undefined;
    } catch {
        return undefined;
    }
}

export default function autoSessionName(pi: ExtensionAPI) {
    let eligible = false;
    let sessionGeneration = 0;

    pi.on("session_start", (_event, ctx) => {
        sessionGeneration += 1;
        eligible = !pi.getSessionName() && !hasUserMessage(ctx);
    });

    pi.on("session_shutdown", () => {
        sessionGeneration += 1;
        eligible = false;
    });

    pi.on("before_agent_start", (event, ctx) => {
        if (!eligible || pi.getSessionName()) return;

        eligible = false;
        const prompt = event.prompt.trim();
        const expectedGeneration = sessionGeneration;
        if (!prompt) return;

        void generateName(prompt, ctx).then((name) => {
            if (!name || expectedGeneration !== sessionGeneration || pi.getSessionName()) return;
            pi.setSessionName(name);
        });
    });

    pi.registerCommand("auto-name", {
        description: "Generate a short session name from the original prompt",
        handler: async (_args, ctx) => {
            const existingName = pi.getSessionName();
            if (existingName) {
                ctx.ui.notify(`Session already named: ${existingName}`, "info");
                return;
            }

            const prompt = originalPrompt(ctx);
            if (!prompt) {
                ctx.ui.notify("No original text prompt found", "warning");
                return;
            }

            const expectedGeneration = sessionGeneration;
            ctx.ui.notify("Generating session name...", "info");
            const name = await generateName(prompt, ctx);

            if (expectedGeneration !== sessionGeneration) return;
            if (pi.getSessionName()) {
                ctx.ui.notify("Session was named while generation was running", "info");
                return;
            }
            if (!name) {
                ctx.ui.notify("Could not generate a session name", "warning");
                return;
            }

            pi.setSessionName(name);
            ctx.ui.notify(`Session named: ${name}`, "info");
        },
    });
}
