# Suitable W&B models

This guide maps the preferred OpenAI models, GPT-6.1 Sol (`gpt-6.1-sol`) and GPT-5.5, to models available from W&B Serverless Inference. These are workload analogies, not drop-in replacements. Availability was checked against the authenticated production endpoint on 2026-10-27 at 13:22:56 UTC; all 23 returned models have general-availability status and documented tool-calling support.

| Preferred model | W&B model | Comparison |
| --- | --- | --- |
| GPT-6.1 Sol | Kimi K2.7 Code | W&B describes it as purpose-built for long-horizon agentic coding and software engineering. It accepts text and images, but its 262,144-token context is smaller than Sol's locally configured 500,000 tokens. |
| GPT-6.1 Sol | MiniMax M3 | W&B describes it as optimized for coding and agentic workflows. It accepts text and images with the same 262,144-token context constraint. |
| GPT-6.1 Sol | GLM-5.3 | W&B describes it as built for reasoning, software engineering, and long-horizon agentic tasks. Its 1,048,576-token context exceeds Sol's local context, but it accepts text only. |
| GPT-6.1 Sol | DeepSeek V4.1-Flash | A coding, reasoning, and agentic-workload candidate that accepts text and images with a 1,048,576-token context. It covers Sol's local input modalities and context capacity, but not its Responses API interface or configured output budget. |
| GPT-5.5 | DeepSeek V4.1-Flash | Multimodal model for coding, reasoning, and agentic workloads with a 1.049M context window. |
| GPT-5.5 | DeepSeek V4-Pro-0813 | General-availability text-only model with a 1.049M context window for repository analysis. |

## Recommendations by workload

- Evaluate **Kimi K2.7 Code** for long-horizon coding and software-engineering tasks.
- Compare **MiniMax M3** for coding and agentic work that needs image input.
- Evaluate **GLM-5.3** for text-only reasoning and software-engineering tasks that need a 1,048,576-token context window. GLM-5.2 remains available.
- Evaluate **NVIDIA Nemotron 3.5 Super VL** for visual understanding and reasoning with a 1,048,576-token context window.
- **Reflection Beam 1.0** is another text-only coding and reasoning candidate with a 1,048,576-token context window. Its catalog description does not establish a performance advantage over the other candidates.
- Use **DeepSeek V4.1-Flash** when coding work needs image input and a 1.049M context window.
- Use **DeepSeek V4-Pro-0813** for text-only codebases or document sets that benefit from its 1.049M context window. The unversioned DeepSeek V4-Pro is no longer returned by the production endpoint.

## Serving differences

In this repository, `agent/models-store.json` configures GPT-6.1 Sol (`openai-codex/gpt-6.1-sol`) to accept text and images and use the Codex Responses API with tool search, a 500,000-token context window, a 128,000-token maximum output, and selectable reasoning levels. GPT-5.5 remains a comparison target in this guide but is no longer present in the local model store; its current serving configuration is not verified here. `agent/models.json` configures the W&B models to use OpenAI-compatible Chat Completions without reasoning-effort control and with a 16K maximum output. These protocol and output-budget differences affect tool use.

For **workload fit**, Kimi K2.7 Code and MiniMax M3 are coding candidates based on W&B's catalog descriptions. For **interface fit**, their text and image inputs match GPT-6.1 Sol's local modalities, but their 262,144-token contexts do not cover its 500,000-token context capacity. DeepSeek V4.1-Flash and NVIDIA Nemotron 3.5 Super VL accept text and images with 1,048,576-token contexts, covering that input capacity. Neither matches Sol's configured 128,000-token output budget: every W&B model here is limited to 16,384 output tokens. Tool-calling support does not imply Responses API tool-search compatibility. No controlled comparison establishes any current W&B model as a performance peer of GPT-5.5 or GPT-6.1 Sol.

## Catalog validation

The authenticated [production model endpoint](https://api.inference.wandb.ai/v1/models) returned 23 models. Context windows, input modalities, reasoning, and tool-calling metadata agreed between W&B's structured catalog and models.dev export. All 23 configured models matched the endpoint and validated metadata. No models were added or removed; context windows and modalities were unchanged. `agent/models.json` required no edits. The catalog also lists 27 models absent from the endpoint; those are not configured.

The OpenAPI fingerprint changed from the helper's recorded baseline. The current catalog and models.dev response schema references were inspected, and structured metadata validation passed. Without a saved baseline schema, the precise schema diff is unknown. This warning does not change the provider's compatibility settings or its 16,384-token output budget.

## References

- [W&B Serverless Inference models](https://docs.wandb.ai/inference/models)
- [W&B List Models API](https://docs.wandb.ai/inference/api-reference/list-models)
- [Local Pi model metadata](file:///Users/blalor/.pi/agent/models-store.json), source for GPT-6.1 Sol's configured capabilities and limits
- [Local W&B provider configuration](file:///Users/blalor/.pi/agent/models.json)
- [W&B structured model catalog](https://trace.wandb.ai/inference/catalog/models)
- [W&B models.dev metadata](https://trace.wandb.ai/inference/modelsdev/models)
- [Moonshot AI Kimi K2.7 Code](https://www.kimi.com/resources/kimi-k2-7-code)
