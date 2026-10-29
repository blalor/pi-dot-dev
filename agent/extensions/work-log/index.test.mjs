import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import workLogExtension from "./index.ts";

async function fixture(t, getAuth, beforeStart = async () => {}) {
    const parent = join(process.cwd(), ".pi_tmp", "work-log-shutdown-tests");
    await mkdir(parent, { recursive: true });
    const home = await mkdtemp(join(parent, "home-"));
    const previousHome = process.env.HOME;
    const previousModel = process.env.PI_WORK_LOG_MODEL;
    process.env.HOME = home;
    process.env.PI_WORK_LOG_MODEL = "test/summary";
    t.after(async () => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousModel === undefined) delete process.env.PI_WORK_LOG_MODEL;
        else process.env.PI_WORK_LOG_MODEL = previousModel;
        await rm(home, { recursive: true, force: true });
    });
    const handlers = new Map();
    const commands = new Map();
    const notifications = [];
    const statuses = [];
    workLogExtension({
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: (name, command) => commands.set(name, command),
        exec: async () => ({ code: 1, stdout: "", stderr: "Not a repository" }),
    });
    const ctx = {
        cwd: home,
        isIdle: () => true,
        sessionManager: {
            getSessionId: () => "test-session",
            getBranch: () => [{
                id: "message-1",
                timestamp: "2026-10-15T16:00:00.000Z",
                type: "message",
                message: { role: "user", content: "Implemented the requested change.", timestamp: Date.now() },
            }],
        },
        modelRegistry: {
            find: (provider, id) => ({ provider, id }),
            getApiKeyAndHeaders: getAuth,
        },
        ui: {
            setStatus: (_key, value) => statuses.push(value),
            setWidget: () => {},
            notify: (message) => notifications.push(message),
        },
    };
    await beforeStart(home);
    await handlers.get("session_start")({ reason: "new" }, ctx);
    return { home, ctx, handlers, commands, notifications, statuses };
}

async function waitUntil(predicate) {
    const deadline = Date.now() + 5_000;
    while (!await predicate()) {
        assert.ok(Date.now() < deadline, "Background work did not settle");
        await delay(20);
    }
}

async function shutdownWithoutWaiting(handlers, ctx, event = "session_shutdown") {
    let timer;
    try {
        await Promise.race([
            handlers.get(event)({ reason: "quit" }, ctx),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Shutdown waited for unresolved credentials")), 1_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test("shutdown saves the snapshot without waiting for credentials", async (t) => {
    let resolveAuth;
    let authCalls = 0;
    const auth = new Promise((resolve) => { resolveAuth = resolve; });
    const { home, ctx, handlers } = await fixture(t, () => { authCalls += 1; return auth; });
    t.after(() => resolveAuth({ ok: false, error: "Test credentials unavailable" }));

    await shutdownWithoutWaiting(handlers, ctx);
    assert.equal(authCalls, 1, "Credentials should only be prepared in the background");
    const pendingDir = join(home, ".pi", "agent", "work-log", "_pending");
    const files = await readdir(pendingDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".json"));
    const pending = JSON.parse(await readFile(join(pendingDir, files[0]), "utf8"));
    assert.match(pending.transcript, /Implemented the requested change/);
});

test("tree navigation saves the snapshot without waiting for credentials", async (t) => {
    let resolveAuth;
    const auth = new Promise((resolve) => { resolveAuth = resolve; });
    const { home, ctx, handlers } = await fixture(t, () => auth);
    t.after(() => resolveAuth({ ok: false, error: "Test credentials unavailable" }));

    await shutdownWithoutWaiting(handlers, ctx, "session_before_tree");
    assert.equal((await readdir(join(home, ".pi", "agent", "work-log", "_pending"))).length, 1);
});

test("shutdown preserves pending work after credential preparation fails", async (t) => {
    let authCalls = 0;
    const { home, ctx, handlers } = await fixture(t, async () => {
        authCalls += 1;
        return { ok: false, error: "Test credentials unavailable" };
    });
    await new Promise((resolve) => setImmediate(resolve));

    await shutdownWithoutWaiting(handlers, ctx);
    assert.equal(authCalls, 1);
    assert.equal((await readdir(join(home, ".pi", "agent", "work-log", "_pending"))).length, 1);
});

test("backlog stays queued when the route changes during startup authentication", async (t) => {
    let resolveAuth;
    const auth = new Promise((resolve) => { resolveAuth = resolve; });
    const { home, statuses } = await fixture(t, () => auth, async (home) => {
        const pendingDir = join(home, ".pi", "agent", "work-log", "_pending");
        await mkdir(pendingDir, { recursive: true });
        await writeFile(join(pendingDir, "backlog.json"), JSON.stringify({
            version: 1,
            transcript: "Completed earlier work.",
        }));
    });
    await waitUntil(() => statuses.some((value) => value?.startsWith("Retrying")));
    process.env.PI_WORK_LOG_MODEL = "test/new-summary";
    resolveAuth({ ok: true, apiKey: "old-route-key" });
    await waitUntil(() => statuses.at(-1) === undefined);

    const files = await readdir(join(home, ".pi", "agent", "work-log", "_pending"));
    assert.deepEqual(files, ["backlog.json"], "The old route must not claim or process the snapshot");
});

test("late startup preparation cannot replace a newer checkpoint runtime", async (t) => {
    let resolveStartupAuth;
    let authCalls = 0;
    const startupAuth = new Promise((resolve) => { resolveStartupAuth = resolve; });
    const { home, ctx, handlers, commands, notifications } = await fixture(t, () => {
        authCalls += 1;
        return authCalls === 1 ? startupAuth : Promise.resolve({ ok: true, apiKey: "fresh-route-key" });
    });
    await waitUntil(() => authCalls === 1);
    process.env.PI_WORK_LOG_MODEL = "test/new-summary";
    // The fixture's model has no API adapter, so the foreground call fails locally
    // after preparing the runtime. No model request or external connection is made.
    await commands.get("work-log").handler("", ctx);
    assert.equal(authCalls, 2);
    assert.ok(notifications.some((message) => message.startsWith("Work-log checkpoint failed:")));
    resolveStartupAuth({ ok: true, apiKey: "old-route-key" });
    await new Promise((resolve) => setImmediate(resolve));

    await shutdownWithoutWaiting(handlers, ctx);
    assert.ok(notifications.includes("Work-log summary queued in the background."));
    assert.equal(authCalls, 2, "Shutdown must use the newer prepared runtime without authenticating again");
    // The detached worker also fails locally for the adapter-less fixture model.
    // Wait for its error record so it cannot outlive fixture cleanup.
    const pendingDir = join(home, ".pi", "agent", "work-log", "_pending");
    await waitUntil(async () => (await readdir(pendingDir)).some((name) => name.endsWith(".json.error")));
});

test("shutdown defers a changed model route instead of resolving credentials", async (t) => {
    let authCalls = 0;
    const { home, ctx, handlers, notifications } = await fixture(t, async () => {
        authCalls += 1;
        return { ok: true, apiKey: "test-key" };
    });
    // Allow startup preparation to settle before changing the configured route.
    await new Promise((resolve) => setImmediate(resolve));
    process.env.PI_WORK_LOG_MODEL = "test/new-summary";

    await shutdownWithoutWaiting(handlers, ctx);
    assert.equal(authCalls, 1);
    assert.equal((await readdir(join(home, ".pi", "agent", "work-log", "_pending"))).length, 1);
    assert.ok(notifications.some((message) => message.includes("next session")));
});
