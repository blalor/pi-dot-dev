import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import autoSessionName from "../agent/extensions/auto-session-name.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness({ name, hasUserMessage = false }: { name?: string; hasUserMessage?: boolean } = {}) {
    const handlers = new Map<string, Handler>();
    let attempts = 0;
    const pi = {
        on(event: string, handler: Handler) { handlers.set(event, handler); },
        getSessionName: () => name,
        setSessionName: () => { assert.fail("No model is configured; naming must not succeed"); },
        registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const ctx = {
        // Count generation attempts without calling a model or external service.
        get model() { attempts++; return undefined; },
        sessionManager: {
            getBranch: () => hasUserMessage ? [{ type: "message", message: { role: "user" } }] : [],
        },
    } as unknown as ExtensionContext;
    autoSessionName(pi);
    return {
        emit: async (event: string, fields: object = {}) => {
            await handlers.get(event)?.({ type: event, ...fields }, ctx);
        },
        attempts: () => attempts,
    };
}

test("custom turns without a prompt preserve eligibility for the first user prompt", async () => {
    const h = harness();
    await h.emit("session_start");
    for (let n = 0; n < 2; n++) {
        await h.emit("before_agent_start", {
            messageType: "custom",
            message: { customType: "background-update", content: "Work completed", display: false },
        });
    }
    assert.equal(h.attempts(), 0);
    await h.emit("before_agent_start", { messageType: "user", prompt: "Explain this repository" });
    assert.equal(h.attempts(), 1);
});

test("only the first user turn attempts automatic naming", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("before_agent_start", { messageType: "user", prompt: "Explain this repository" });
    await h.emit("before_agent_start", { messageType: "user", prompt: "Explain another file" });
    assert.equal(h.attempts(), 1);
});

test("named sessions and sessions with user history remain ineligible", async () => {
    for (const options of [{ name: "Existing title" }, { hasUserMessage: true }]) {
        const h = harness(options);
        await h.emit("session_start");
        await h.emit("before_agent_start", { messageType: "user", prompt: "Explain this repository" });
        assert.equal(h.attempts(), 0);
    }
});

test("shutdown disables eligibility and a fresh session restores it", async () => {
    const h = harness();
    await h.emit("session_start");
    await h.emit("session_shutdown");
    await h.emit("before_agent_start", { messageType: "user", prompt: "Explain this repository" });
    assert.equal(h.attempts(), 0);
    await h.emit("session_start");
    await h.emit("before_agent_start", { messageType: "custom", message: {} });
    await h.emit("before_agent_start", { messageType: "user", prompt: "Explain this repository" });
    assert.equal(h.attempts(), 1);
});
