# Suitable W&B models

This guide maps the preferred OpenAI models, GPT-5.6 Sol and GPT-5.5, to models available from W&B Serverless Inference. These are workload analogies, not drop-in replacements.

| Preferred model | W&B model | Comparison |
| --- | --- | --- |
| GPT-5.6 Sol | Kimi K2.7 Code | W&B describes it as purpose-built for long-horizon agentic coding and software engineering. It accepts text and images with a 262K context window. |
| GPT-5.6 Sol | MiniMax M3 | W&B describes it as optimized for coding and agentic workflows. It accepts text and images with a 262K context window. |
| GPT-5.6 Sol | GLM-5.2 | Candidate for long-running coding and terminal work. W&B now documents a 1.049M context window. Z.AI reports 81.0 on Terminal-Bench 2.1. |
| GPT-5.5 | DeepSeek V4.1-Flash | Multimodal model for coding, reasoning, and agentic workloads with a 1.049M context window. |
| GPT-5.5 | DeepSeek V4-Pro-0813 | General-availability text-only model with a 1.049M context window for repository analysis. |

## Recommendations by workload

- Evaluate **Kimi K2.7 Code** for long-horizon coding and software-engineering tasks.
- Compare **MiniMax M3** for coding and agentic work that needs image input.
- Evaluate **GLM-5.2** for terminal-heavy tasks; its cited Terminal-Bench result does not establish parity with GPT-5.6 Sol.
- Use **DeepSeek V4.1-Flash** when coding work needs image input and a 1.049M context window.
- Use **DeepSeek V4-Pro-0813** for text-only codebases or document sets that benefit from its 1.049M context window; the unversioned DeepSeek V4-Pro entry is deprecated.

## Serving differences

In this repository, `agent/models-store.json` configures GPT-5.5 and GPT-5.6 Sol to use the Codex Responses API with tool search, a 272K context window, a 128K maximum output, and selectable reasoning levels. `agent/models.json` configures the W&B models to use OpenAI-compatible Chat Completions without reasoning-effort control and with a 16K maximum output. These protocol and output-budget differences affect tool use.

Kimi K2.7 Code, MiniMax M3, and DeepSeek V4.1-Flash are documented multimodal coding candidates. No controlled comparison establishes any current W&B model as a performance peer of GPT-5.5 or GPT-5.6 Sol.

## References

- [W&B Serverless Inference models](https://docs.wandb.ai/inference/models)
- [W&B List Models API](https://docs.wandb.ai/inference/api-reference/list-models)
- [OpenAI GPT-5.6](https://openai.com/index/gpt-5-6/)
- [Z.AI GLM-5.2](https://z.ai/blog/glm-5.2)
- [Moonshot AI Kimi K2.7 Code](https://www.kimi.com/resources/kimi-k2-7-code)
