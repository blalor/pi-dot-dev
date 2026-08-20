import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredHelperModel, parseHelperModelSpec } from "./helper-models.ts";

test("helper model configuration persists task-specific model routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-helper-models-"));
    const file = join(directory, "helper-models.json");
    await writeFile(file, JSON.stringify({
        memory: "wandb/Qwen/Qwen3.5-35B-A3B",
        workLog: "anthropic/claude-haiku",
        recap: "openai-codex/gpt-5.4-mini",
    }));

    assert.equal(await configuredHelperModel("memory", undefined, file), "wandb/Qwen/Qwen3.5-35B-A3B");
    assert.equal(await configuredHelperModel("workLog", undefined, file), "anthropic/claude-haiku");
    assert.equal(await configuredHelperModel("recap", undefined, file), "openai-codex/gpt-5.4-mini");
});

test("environment values temporarily override persistent routes", async () => {
    assert.equal(
        await configuredHelperModel("recap", "  wandb/OpenPipe/Qwen3-14B-Instruct  ", "/missing/config.json"),
        "wandb/OpenPipe/Qwen3-14B-Instruct",
    );
});

test("qualified model parsing preserves slashes in provider model IDs", () => {
    assert.deepEqual(parseHelperModelSpec("wandb/Qwen/Qwen3.5-35B-A3B"), {
        provider: "wandb",
        id: "Qwen/Qwen3.5-35B-A3B",
    });
    assert.equal(parseHelperModelSpec("not-qualified"), undefined);
});
