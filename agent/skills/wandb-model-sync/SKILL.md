---
name: wandb-model-sync
description: Synchronize Pi's wandb provider in models.json with W&B Serverless Inference, assign documented context windows and modalities, and recommend W&B substitutes for preferred models. Use when W&B adds or removes inference models, model metadata needs refreshing, or the user asks which W&B models suit coding, reasoning, vision, or long-context work.
compatibility: Requires Python 3, network access to api.inference.wandb.ai and docs.wandb.ai, and a W&B API key in WANDB_API_KEY or Pi auth.json.
---

# W&B model sync

Update the `wandb` provider from live W&B data and make recommendations supported by current documentation. Do not treat a model-name resemblance as evidence of equivalent quality.

## Safety and scope

- Never print, persist, or pass the W&B API key as a literal command argument. The helper reads `WANDB_API_KEY` or `wandb.key` from Pi's `auth.json`.
- Modify only `providers.wandb` in `models.json`. Preserve other providers and unrelated working-tree changes.
- Use W&B's authenticated model endpoint as the source of available IDs and W&B's model catalog as the source of display names, modalities, and context windows.
- Fail rather than assigning Pi's 128K fallback when an endpoint model lacks documented metadata.
- Do not send chat-completion requests merely to validate configuration. Listing models is sufficient unless the user requests a paid inference test.
- Treat benchmark results from different harnesses or benchmark versions as incomparable unless the source supplies a controlled comparison.

## Locate files

Work from the repository root. In this repository the files are:

```text
agent/models.json
agent/auth.json
agent/models-store.json
SUITABLE_MODELS.md
```

Before editing, inspect `git status --short` and the existing `wandb` provider. Determine which changes predate the task.

## Fetch current metadata

Resolve this skill's directory from the loaded `SKILL.md`, then run its helper. Store snapshots under a session-specific child of `.pi_tmp`:

```bash
snapshot_dir=".pi_tmp/wandb-model-sync/${PI_SESSION_ID:-manual}"
mkdir -p "$snapshot_dir"
python3 agent/skills/wandb-model-sync/scripts/fetch_catalog.py \
    --auth-file agent/auth.json \
    --output "$snapshot_dir/catalog.json"
```

The helper:

1. calls `GET https://api.inference.wandb.ai/v1/models` with bearer authentication;
2. parses the model tables at `https://docs.wandb.ai/inference/models`;
3. converts documented decimal values such as `32.8k`, `262k`, and `1049k` to integer token counts;
4. records live models without catalog metadata in `missingDocumentation` and leaves their metadata fields null;
5. writes no credentials to its output.

Inspect the generated model count, IDs, `missingDocumentation`, and `documentedButUnavailable` lists before editing. A nonempty `missingDocumentation` list blocks automatic reconciliation. Research those models in W&B or the model provider's official documentation and cite the source before assigning metadata. If no authoritative context window and modality are available, stop and report the discrepancy rather than using Pi's defaults.

## Reconcile `models.json`

The final `providers.wandb.models` array must contain exactly the IDs in `catalog.json.models`. Add new IDs and remove unavailable IDs. Each entry must explicitly define:

```json
{
    "id": "owner/model-id",
    "name": "Catalog display name (W&B)",
    "reasoning": false,
    "input": ["text"],
    "contextWindow": 262000,
    "maxTokens": 16384
}
```

Apply these rules:

- Copy `id`, catalog display name, `input`, and `contextWindow` from the snapshot. Append ` (W&B)` to the display name.
- Preserve a matching model's existing `reasoning` value unless current W&B documentation or the provider's model card establishes a change.
- For a new model, set `reasoning: true` only when W&B or the model provider explicitly describes reasoning or thinking support. Otherwise use `false`. Do not infer reasoning support solely from words such as `Coder`, `Instruct`, or `Agent` in the ID.
- Keep `maxTokens: 16384` unless W&B documents a different supported output limit and the user wants it exposed.
- Keep provider compatibility settings unless current API documentation requires a change. In particular, do not enable reasoning-effort controls without evidence that W&B accepts them.
- Omit `apiKey` when authentication is stored in `auth.json`. Keep `authHeader: true` for bearer authentication.

If a live endpoint model lacks catalog metadata, stop automatic reconciliation and report the exact ID until authoritative metadata is found. Models listed in the catalog but absent from the endpoint are informational; remove them from `models.json` because the authenticated endpoint defines availability. Do not silently retain unavailable models or invent metadata.

## Suggest suitable models

Read the preferred models from the user's request and, when relevant, their local metadata in `agent/models-store.json`. Compare W&B candidates on concrete dimensions:

- coding or terminal specialization;
- general reasoning;
- text versus image input;
- documented context window;
- configured maximum output;
- Chat Completions versus Responses API features;
- benchmark results from named, linked sources using the same benchmark version and agent scaffold.

Recommendations must distinguish three concepts:

1. **Closest workload fit:** the W&B model intended for the same kind of task.
2. **Closest interface fit:** matching modality, context, and tool-serving features.
3. **Proven performance peer:** supported only by controlled comparative evidence.

If controlled evidence is absent, say that no performance peer is established. Do not claim that a model is faster, cheaper, stronger, or weaker without a current source or a local measurement.

When `SUITABLE_MODELS.md` exists, update it so model names, context sizes, modalities, serving differences, and references remain consistent with the synchronized configuration. Include enough context for a reader who did not see the current session. Remove recommendations for models no longer returned by the endpoint.

## Validation

Validate syntax, exact endpoint coverage, explicit context sizes, and Pi loading:

```bash
jq empty agent/models.json

jq -n \
    --slurpfile catalog "$snapshot_dir/catalog.json" \
    --slurpfile config agent/models.json '
        ($catalog[0].models | map(.id) | sort) as $live |
        ($config[0].providers.wandb.models | map(.id) | sort) as $configured |
        {
            liveCount: ($live | length),
            configuredCount: ($configured | length),
            missing: ($live - $configured),
            stale: ($configured - $live),
            duplicateIds: [$configured | group_by(.)[] | select(length > 1) | .[0]],
            missingContextWindows: [
                $config[0].providers.wandb.models[] |
                select(.contextWindow == null) |
                .id
            ]
        }
    '

pi --list-models wandb
git diff --check
git diff -- agent/models.json SUITABLE_MODELS.md
```

Success requires equal nonzero counts, empty `missing`, `stale`, `duplicateIds`, and `missingContextWindows` arrays, and all W&B models appearing in `pi --list-models wandb` with the intended context and image columns.

Run a reviewer after editing. Ask it to compare IDs against the snapshot, metadata against W&B's catalog, recommendations against cited evidence, and the diff against the user's requested scope.

## Report

Report:

- retrieval time and documented endpoint;
- live, added, removed, and unchanged model counts;
- changed context windows or modalities;
- primary recommendations by workload;
- serving limitations relative to the preferred models;
- validation results;
- unresolved endpoint/catalog discrepancies or claims lacking comparative evidence.
