# Suitable W&B models

This guide maps the preferred OpenAI models, GPT-5.6 Sol and GPT-5.5, to models available from W&B Serverless Inference. These are workload analogies, not drop-in replacements.

| Preferred model | W&B model | Comparison |
| --- | --- | --- |
| GPT-5.6 Sol | GLM-5.2 | Best starting point for long-running coding and terminal work. It has a 262K context window. Z.AI reports 81.0 on Terminal-Bench 2.1. |
| GPT-5.6 Sol | Kimi K2.7 Code | Closest feature profile: coding-specialized, agent-oriented, 262K context, and image input. |
| GPT-5.5 | GLM-5.1 | Similar generational position as the predecessor to GLM-5.2. It has a 203K context window. |
| GPT-5.5 | DeepSeek V4-Pro | Similar role as a large, deliberate generalist. Its 1.049M context window suits repository analysis. |

## Recommended order

1. Use **GLM-5.2** for the normal GPT-5.6 Sol coding workload.
2. Use **Kimi K2.7 Code** when screenshots, diagrams, or other image input matter.
3. Use **DeepSeek V4-Pro** for codebases or document sets that benefit from its 1.049M context window.
4. Evaluate **Qwen3.6-27B** for routine edits when lower latency matters; the current configuration contains no latency measurements.
5. Use **GLM-5.1** only when it provides a measured latency or cost advantage over GLM-5.2.

## Serving differences

In this repository, `agent-config/models-store.json` configures GPT-5.5 and GPT-5.6 Sol to use the Codex Responses API with tool search, a 128K maximum output, and selectable reasoning levels. `agent-config/models.json` configures the W&B models to use OpenAI-compatible Chat Completions without reasoning-effort control and with a 16K maximum output. These protocol and output-budget differences affect tool use even when benchmark scores are close.

GLM-5.2 is the closest overall substitute. Kimi K2.7 Code is the closest multimodal coding substitute. The current W&B catalog has no clear GPT-5.6 Sol peer.

## References

- [W&B Serverless Inference models](https://docs.wandb.ai/inference/models)
- [W&B List Models API](https://docs.wandb.ai/inference/api-reference/list-models)
- [OpenAI GPT-5.6](https://openai.com/index/gpt-5-6/)
- [Z.AI GLM-5.2](https://z.ai/blog/glm-5.2)
- [Moonshot AI Kimi K2.7 Code](https://www.kimi.com/resources/kimi-k2-7-code)
