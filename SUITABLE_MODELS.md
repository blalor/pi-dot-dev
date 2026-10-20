# Suitable W&B models

This guide maps the preferred OpenAI models, GPT-5.6 Sol and GPT-5.5, to models available from W&B Serverless Inference. These are workload analogies, not drop-in replacements. Availability was checked against the authenticated production endpoint on 2026-10-20 at 14:14 UTC; all 23 returned models have general-availability status and documented tool-calling support.

| Preferred model | W&B model | Comparison |
| --- | --- | --- |
| GPT-5.6 Sol | Kimi K2.7 Code | W&B describes it as purpose-built for long-horizon agentic coding and software engineering. It accepts text and images with a 262K context window. |
| GPT-5.6 Sol | MiniMax M3 | W&B describes it as optimized for coding and agentic workflows. It accepts text and images with a 262K context window. |
| GPT-5.6 Sol | GLM-5.3 | W&B describes it as built for reasoning, software engineering, and long-horizon agentic tasks. It accepts text with a 1,048,576-token context window. |
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

In this repository, `agent/models-store.json` configures GPT-5.5 and GPT-5.6 Sol to use the Codex Responses API with tool search, a 272K context window, a 128K maximum output, and selectable reasoning levels. `agent/models.json` configures the W&B models to use OpenAI-compatible Chat Completions without reasoning-effort control and with a 16K maximum output. These protocol and output-budget differences affect tool use.

For **workload fit**, Kimi K2.7 Code and MiniMax M3 are coding candidates based on W&B's catalog descriptions. For **interface fit**, both accept text and images with 262,144-token contexts, compared with the preferred models' local 272,000-token contexts. DeepSeek V4.1-Flash accepts text and images with a 1,048,576-token context, making it an interface candidate for larger inputs. Tool-calling support does not imply Responses API tool-search compatibility. No controlled comparison establishes any current W&B model as a performance peer of GPT-5.5 or GPT-5.6 Sol.

## Catalog validation

The authenticated [production model endpoint](https://api.inference.wandb.ai/v1/models) returned 23 models. Context windows, input modalities, reasoning, and tool-calling metadata agreed between W&B's structured catalog and models.dev export. The sync added GLM-5.3, NVIDIA Nemotron 3.5 Super VL, and Reflection Beam 1.0; no models were removed, and existing context windows and modalities were unchanged. The catalog also lists 27 models absent from the endpoint; those are not configured.

The OpenAPI fingerprint changed from the helper's recorded baseline. The current catalog and models.dev response schema references were inspected, and structured metadata validation passed. Without a saved baseline schema, the precise schema diff is unknown. This warning does not change the provider's compatibility settings or its 16,384-token output budget.

## References

- [W&B Serverless Inference models](https://docs.wandb.ai/inference/models)
- [W&B List Models API](https://docs.wandb.ai/inference/api-reference/list-models)
- [OpenAI GPT-5.6](https://openai.com/index/gpt-5-6/)
- [W&B structured model catalog](https://trace.wandb.ai/inference/catalog/models)
- [W&B models.dev metadata](https://trace.wandb.ai/inference/modelsdev/models)
- [Moonshot AI Kimi K2.7 Code](https://www.kimi.com/resources/kimi-k2-7-code)
