import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HelperModelTask = "memory" | "workLog" | "recap";

export interface HelperModelRuntime {
    model: Model<Api>;
    apiKey: string;
    headers?: Record<string, string | null>;
}

interface HelperModelConfig {
    memory?: unknown;
    workLog?: unknown;
    recap?: unknown;
}

export function defaultHelperModelConfigPath(): string {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    return join(agentDir, "helper-models.json");
}

export function parseHelperModelSpec(spec: string): { provider: string; id: string } | undefined {
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1) return undefined;
    return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export async function configuredHelperModel(
    task: HelperModelTask,
    environmentValue?: string,
    configPath = defaultHelperModelConfigPath(),
): Promise<string> {
    const override = environmentValue?.trim();
    if (override) return override;

    let config: HelperModelConfig;
    try {
        config = JSON.parse(await readFile(configPath, "utf8")) as HelperModelConfig;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read helper-model configuration ${configPath}: ${reason}`);
    }

    const value = config[task];
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Helper model ${task} is not configured in ${configPath}`);
    }
    return value.trim();
}

export async function resolveHelperModelRuntime(
    ctx: ExtensionContext,
    options: {
        task: HelperModelTask;
        label: string;
        environmentValue?: string;
    },
): Promise<HelperModelRuntime> {
    const spec = await configuredHelperModel(options.task, options.environmentValue);
    const configured = parseHelperModelSpec(spec);
    if (!configured) throw new Error(`${options.label} model ${spec} must use provider/model-id`);

    const model = ctx.modelRegistry.find(configured.provider, configured.id);
    if (!model) throw new Error(`${options.label} model ${spec} is unavailable`);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
    }
    return { model, apiKey: auth.apiKey, headers: auth.headers };
}
