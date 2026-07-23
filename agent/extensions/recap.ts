import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "recap";
const MAX_CONVERSATION_CHARS = 120_000;
const DEFAULT_RECAP_MODEL = "openai-codex/gpt-5.4-mini";
const RECAP_MODEL = process.env.PI_RECAP_MODEL ?? DEFAULT_RECAP_MODEL;

const SYSTEM_PROMPT = `You generate Claude Code-style session recaps.
Return exactly one concise sentence, no more than 40 words.
Mention what the user is working on and the most useful next step.
Do not use markdown, bullets, labels, or a "recap:" prefix.`;

const isRecapMessage = (message: unknown): boolean => {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: string; customType?: string };
	return candidate.role === "custom" && candidate.customType === CUSTOM_TYPE;
};

const truncateConversation = (text: string): { text: string; truncated: boolean } => {
	if (text.length <= MAX_CONVERSATION_CHARS) {
		return { text, truncated: false };
	}

	const headLength = Math.floor(MAX_CONVERSATION_CHARS * 0.2);
	const tailLength = MAX_CONVERSATION_CHARS - headLength;
	return {
		text: `${text.slice(0, headLength)}\n\n[...middle of conversation truncated for recap generation...]\n\n${text.slice(-tailLength)}`,
		truncated: true,
	};
};

const buildConversationText = (ctx: ExtensionCommandContext) => {
	const messages = ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.filter((message) => !isRecapMessage(message));

	return serializeConversation(convertToLlm(messages));
};

const extractText = (response: Awaited<ReturnType<typeof complete>>): string =>
	response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.replace(/^\s*(?:[-*]\s*)?(?:recap\s*:\s*)?/i, "")
		.replace(/\s+/g, " ")
		.trim();

const parseModelSpec = (spec: string): { provider: string; id: string } | undefined => {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return undefined;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
};

const getRecapModel = (ctx: ExtensionCommandContext): Model<Api> | undefined => {
	const parsed = parseModelSpec(RECAP_MODEL);
	if (!parsed) return ctx.model;
	return ctx.modelRegistry.find(parsed.provider, parsed.id) ?? ctx.model;
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("recap", {
		description: "Generate a Claude-style one-line recap of the current session",
		handler: async (args, ctx) => {
			const recapModel = getRecapModel(ctx);
			if (!recapModel) {
				ctx.ui.notify("No recap model available", "error");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Waiting for current turn before generating recap...", "info");
				await ctx.waitForIdle();
			}

			const rawConversation = buildConversationText(ctx);
			if (!rawConversation.trim()) {
				ctx.ui.notify("No conversation to recap yet", "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(recapModel);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify(auth.ok ? `No API key for ${recapModel.provider}` : auth.error, "error");
				return;
			}

			const conversation = truncateConversation(rawConversation);
			const extraInstructions = args.trim() ? `\nAdditional user instruction: ${args.trim()}` : "";

			ctx.ui.notify(`Generating recap with ${recapModel.provider}/${recapModel.id}...`, "info");

			try {
				const response = await complete(
					recapModel,
					{
						systemPrompt: SYSTEM_PROMPT,
						messages: [
							{
								role: "user" as const,
								content: [
									{
										type: "text" as const,
										text: `Generate an on-demand session recap.${extraInstructions}\n${conversation.truncated ? "The conversation was truncated; prioritize current state and next step.\n" : ""}\n<conversation>\n${conversation.text}\n</conversation>`,
									},
								],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						maxTokens: 96,
						reasoningEffort: "minimal",
					},
				);

				if (response.stopReason === "error") {
					throw new Error(response.errorMessage ?? "Provider returned an empty error response");
				}

				const recap = extractText(response);
				if (!recap) {
					ctx.ui.notify("Recap was empty", "warning");
					return;
				}

				pi.sendMessage({
					customType: CUSTOM_TYPE,
					content: `※ recap: ${recap}`,
					display: true,
					details: { generatedAt: Date.now(), truncated: conversation.truncated },
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Recap failed: ${message}`, "error");
			}
		},
	});
}
