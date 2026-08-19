# Project instructions

## Extension validation

- Run `npm run check:extensions` after changing an extension.
- Run `npm run test:rpc` for RPC command validation. It disables extension discovery and loads only the extension under test.
- Do not construct ad hoc RPC shell pipelines. `scripts/pi-rpc-smoke.mjs` keeps stdin open until the asynchronous response arrives and captures complete JSONL output before inspecting it.
- For a focused RPC test, pass each required extension explicitly: `npm run test:rpc -- --extension <path> --command '<slash-command>'`.
- Keep validation isolated from unrelated global extensions. Do not remove `--no-extensions` from the RPC smoke-test invocation.
