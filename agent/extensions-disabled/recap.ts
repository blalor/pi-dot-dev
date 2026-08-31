import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { resolveHelperModelRuntime, type HelperModelRuntime } from "./shared/helper-models.ts";

const CUSTOM_TYPE = "recap";
const MAX_CONVERSATION_CHARS = 120_000;
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

const getRecapRuntime = (ctx: ExtensionCommandContext): Promise<HelperModelRuntime> =>
	resolveHelperModelRuntime(ctx, {
		task: "recap",
		label: "Recap",
		environmentValue: process.env.PI_RECAP_MODEL,
	});

export default function (pi: ExtensionAPI) {
	pi.registerCommand("recap", {
		description: "Generate a Claude-style one-line recap of the current session",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Waiting for current turn before generating recap...", "info");
				await ctx.waitForIdle();
			}

			const rawConversation = buildConversationText(ctx);
			if (!rawConversation.trim()) {
				ctx.ui.notify("No conversation to recap yet", "warning");
				return;
			}

			let runtime: HelperModelRuntime;
			try {
				runtime = await getRecapRuntime(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const recapModel = runtime.model;
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
						apiKey: runtime.apiKey,
						headers: runtime.headers,
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
