import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installITerm2Integration } from "../agent/extensions/iterm2/index.ts";
import { integrationEnabled, statusSequence, titleSequence, userVariableSequence } from "../agent/extensions/iterm2/lib.ts";
import { observePromptMarkers } from "../agent/extensions/iterm2/prompt-markers.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function harness({ enabled = true, mode = "tui" } = {}) {
    const handlers = new Map<string, Handler>();
    const listeners = new Map<string, Set<(value: any) => void>>();
    const commands = new Map<string, any>();
    const writes: string[] = [];
    const notices: string[] = [];
    let visibleStatus: string | undefined;
    const stream = {
        write(chunk: string | Uint8Array) {
            const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
            writes.push(text);
            // Model released iTerm2 clearing the status on Pi's prompt markers.
            if (/\x1b\]133;A(?:\x07|\x1b\\)/.test(text)) visibleStatus = undefined;
            const status = text.match(/\x1b\]21337;status=([^;]*)/);
            if (status) visibleStatus = status[1] || undefined;
            return true;
        },
    };
    let idle = true;
    let pending = false;
    let name: string | undefined = "Build widget";
    let fleet: number | "invalid" | "absent" = "absent";
    const bus = {
        on(event: string, handler: (value: any) => void) {
            const list = listeners.get(event) ?? new Set();
            list.add(handler);
            listeners.set(event, list);
            return () => { list.delete(handler); };
        },
        emit(event: string, value: any) {
            for (const handler of listeners.get(event) ?? []) handler(value);
            if (event === "subagents:rpc:v1:request" && fleet !== "absent") {
                const data = value.method === "ping"
                    ? { version: 1, capabilities: { fleetStatus: { version: 1 } } }
                    : { fleet: { version: 1, totalActive: fleet } };
                bus.emit(`subagents:rpc:v1:reply:${value.requestId}`, {
                    version: 1, requestId: value.requestId, method: value.method, success: true, data,
                });
            }
        },
    };
    const pi = {
        on(event: string, handler: Handler) { handlers.set(event, handler); },
        events: bus,
        getSessionName: () => name,
        registerCommand(command: string, definition: any) { commands.set(command, definition); },
    } as unknown as ExtensionAPI;
    const ctx = {
        mode, cwd: "/work/widget", isIdle: () => idle, hasPendingMessages: () => pending,
        sessionManager: { getSessionFile: () => "/sessions/widget.jsonl", getSessionId: () => "session-123" },
        ui: { notify: (message: string) => { notices.push(message); } },
    } as unknown as ExtensionContext;
    installITerm2Integration(pi, {
        enabled: () => enabled,
        write: (value) => { stream.write(value); },
        observePromptMarkers: (callback) => observePromptMarkers(stream, callback),
    });
    return {
        writes, notices, commands, ctx, bus, listeners,
        render: (text: string) => { stream.write(text); },
        visibleStatus: () => visibleStatus,
        setIdle: (value: boolean) => { idle = value; },
        setPending: (value: boolean) => { pending = value; },
        setName: (value: string | undefined) => { name = value; },
        setFleet: (value: typeof fleet) => { fleet = value; },
        emit: async (event: string, fields: object = {}) => { await handlers.get(event)?.({ type: event, ...fields }, ctx); },
        statuses: () => writes.filter((value) => value.startsWith("\x1b]21337;")),
        notifications: () => writes.filter((value) => value.startsWith("\x1b]9;")),
    };
}

test("integration only activates in a native iTerm2 TTY, not inherited Herdr terminals", () => {
    assert.equal(integrationEnabled({ TERM_PROGRAM: "iTerm.app" }, true), true);
    assert.equal(integrationEnabled({ ITERM_SESSION_ID: "tab" }, true), true);
    assert.equal(integrationEnabled({ TERM_PROGRAM: "iTerm.app", HERDR_ENV: "1" }, true), false);
    assert.equal(integrationEnabled({ TERM_PROGRAM: "iTerm.app" }, false), false);
    assert.equal(integrationEnabled({}, true), false);
});

test("OSC fields reject control sequences and field injection; metadata is base64 encoded", () => {
    const sequence = statusSequence("Waiting", "approve;indicator=#000000\x07\x1b\\next\nline");
    assert.equal((sequence.match(/;indicator=/g) ?? []).length, 1);
    assert.equal((sequence.match(/\x07/g) ?? []).length, 1);
    assert.equal(sequence.includes("\x1b\\"), false);
    assert.equal(titleSequence("\x07\n"), "\x1b]1;pi\x07");
    const value = "a;\x07\x1b]9;injected";
    const encoded = userVariableSequence("pi_session_name", value).slice("\x1b]1337;SetUserVar=pi_session_name=".length, -1);
    assert.equal(Buffer.from(encoded, "base64").toString(), value);
});

test("prompt observer preserves write arguments, receiver, callbacks and backpressure", () => {
    const calls: unknown[][] = [];
    const receivers: unknown[] = [];
    let observed = 0;
    const callback = () => {};
    const stream = {
        write(this: unknown, ...args: unknown[]) {
            receivers.push(this);
            calls.push(args);
            return false;
        },
    };
    const original = stream.write;
    const stop = observePromptMarkers(stream, () => { observed++; });
    const chunk = Buffer.from("\x1b]133;A\x07text");
    assert.equal(stream.write(chunk, "utf8", callback), false);
    assert.equal(receivers[0], stream);
    assert.deepEqual(calls[0], [chunk, "utf8", callback]);
    assert.equal(observed, 1);
    stop();
    assert.equal(stream.write, original);
    stream.write("\x1b]133;A\x07");
    assert.equal(observed, 1);
});

test("prompt observer scans explicitly encoded strings as emitted bytes", () => {
    let observed = 0;
    const calls: unknown[][] = [];
    const stream = { write: (...args: unknown[]) => { calls.push(args); return true; } };
    const stop = observePromptMarkers(stream, () => { observed++; });
    const marker = "\x1b]133;A\x07";
    for (const encoding of ["hex", "base64", "utf8"] as const) {
        const text = Buffer.from(marker).toString(encoding);
        stream.write(text, encoding);
        assert.deepEqual(calls.at(-1), [text, encoding]);
    }
    assert.equal(observed, 3);
    // UTF-16 emits NUL-interleaved bytes, not an OSC marker.
    stream.write(marker, "utf16le");
    assert.equal(observed, 3);
    stop();
});

test("prompt observer handles split markers and ST without reporting unrelated output", () => {
    let observed = 0;
    const stream = { write: (..._args: unknown[]) => true };
    const stop = observePromptMarkers(stream, () => { observed++; });
    for (const chunk of ["\x1b]1;renamed\x07", "plain text", "\x1b]133;B\x07", "\x1b]133;A;k=s\x07"]) stream.write(chunk);
    assert.equal(observed, 0);
    for (const chunk of ["\x1b]13", Buffer.from("3;A"), "\x07"]) stream.write(chunk);
    assert.equal(observed, 1);
    stream.write("more text");
    assert.equal(observed, 1);
    for (const chunk of ["\x1b]133;A", "\x1b", "\\"]) stream.write(chunk);
    assert.equal(observed, 2);
    // Multiple markers in one write schedule one repair for the redraw batch.
    stream.write("\x1b]133;A\x07text\x1b]133;A\x07");
    assert.equal(observed, 3);
    stop();
});

test("observer cleanup preserves a later stdout wrapper and disables its retained link", () => {
    let observed = 0;
    const stream = { write: (..._args: unknown[]) => true };
    const stop = observePromptMarkers(stream, () => { observed++; });
    const observedWriter = stream.write;
    const laterWriter = (...args: unknown[]) => observedWriter.apply(stream, args);
    stream.write = laterWriter;
    stop();
    assert.equal(stream.write, laterWriter);
    stream.write("\x1b]133;A\x07");
    assert.equal(observed, 0);
});

test("prompt redraw restores Idle, Working and Waiting without extra extension notifications", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    for (const state of ["Idle", "Working", "Waiting"]) {
        if (state === "Working") {
            h.setIdle(false);
            await h.emit("agent_start");
        } else if (state === "Waiting") {
            await h.emit("ui_prompt_start", { kind: "confirm", title: "Allow command?" });
        }
        assert.equal(h.visibleStatus(), state);
        const notifications = h.notifications().length;
        h.render("\x1b]133;A\x07transcript redraw\x1b]133;B\x07\x1b]133;C\x07");
        assert.equal(h.visibleStatus(), undefined);
        t.mock.timers.tick(74);
        assert.equal(h.visibleStatus(), undefined);
        t.mock.timers.tick(1);
        assert.equal(h.visibleStatus(), state);
        assert.equal(h.notifications().length, notifications);
    }
    await h.emit("session_shutdown");
});

test("status repair reports the latest state rather than replaying a stale snapshot", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    h.render("\x1b]133;A\x07");
    h.setIdle(false);
    await h.emit("agent_start");
    await h.emit("ui_prompt_start", { kind: "custom" });
    t.mock.timers.tick(75);
    assert.equal(h.visibleStatus(), "Waiting");
    await h.emit("session_shutdown");
});

test("redraw batches debounce, continuous streaming cannot starve repair, and quiet sessions do not poll", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    h.setIdle(false);
    await h.emit("agent_start");
    const count = h.statuses().length;
    for (let n = 0; n < 5; n++) {
        h.render("\x1b]133;A\x07");
        t.mock.timers.tick(50);
    }
    assert.equal(h.visibleStatus(), "Working");
    assert.equal(h.statuses().length, count + 1);
    h.render("\x1b]133;A\x07");
    t.mock.timers.tick(50);
    h.render("\x1b]133;A\x07");
    t.mock.timers.tick(74);
    assert.equal(h.statuses().length, count + 1);
    t.mock.timers.tick(1);
    assert.equal(h.statuses().length, count + 2);
    t.mock.timers.tick(10000);
    assert.equal(h.statuses().length, count + 2);
    await h.emit("session_shutdown");
});

test("shutdown and session replacement cancel queued redraw repair and detach the observer", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    h.render("\x1b]133;A\x07");
    await h.emit("session_shutdown");
    const count = h.statuses().length;
    t.mock.timers.tick(1000);
    h.render("\x1b]133;A\x07");
    t.mock.timers.tick(1000);
    assert.equal(h.statuses().length, count);
    // A fresh session_start also cancels any outstanding repair from its predecessor.
    const replacement = harness();
    await replacement.emit("session_start");
    replacement.render("\x1b]133;A\x07");
    await replacement.emit("session_start", { reason: "resume" });
    const replacementCount = replacement.statuses().length;
    t.mock.timers.tick(1000);
    assert.equal(replacement.statuses().length, replacementCount);
    await replacement.emit("session_shutdown");
});

test("status follows idle, working, all prompt kinds, resumed work, and final settlement", async () => {
    const h = harness();
    await h.emit("session_start");
    assert.equal(h.statuses().at(-1), statusSequence("Idle", ""));
    h.setIdle(false);
    await h.emit("agent_start");
    assert.equal(h.statuses().at(-1), statusSequence("Working", ""));
    for (const kind of ["select", "confirm", "input", "editor", "custom"]) {
        await h.emit("ui_prompt_start", { kind, title: kind === "custom" ? undefined : "Allow command?" });
        assert.match(h.statuses().at(-1)!, /status=Waiting/);
        assert.match(h.statuses().at(-1)!, kind === "custom" ? /detail=Custom interaction/ : /detail=Allow command\?/);
        await h.emit("ui_prompt_end", { kind });
        assert.equal(h.statuses().at(-1), statusSequence("Working", ""));
    }
    h.setIdle(true);
    await h.emit("agent_settled");
    assert.equal(h.statuses().at(-1), statusSequence("Idle", ""));
    await h.emit("session_shutdown");
});

test("working reloads, idle dialogs, status deduplication and rename metadata", async () => {
    const h = harness();
    h.setIdle(false);
    await h.emit("session_start", { reason: "reload" });
    assert.match(h.statuses().at(-1)!, /status=Working/);
    const count = h.statuses().length;
    await h.emit("agent_start");
    assert.equal(h.statuses().length, count);
    h.setName("Renamed");
    await h.emit("session_info_changed", { name: "Renamed" });
    assert.ok(h.writes.includes(titleSequence("Renamed")));
    assert.ok(h.writes.includes(userVariableSequence("pi_session_file", "/sessions/widget.jsonl")));
    assert.equal(h.statuses().length, count);
    assert.equal(h.statuses().at(-1), statusSequence("Working", ""));
    h.setIdle(true);
    await h.emit("ui_prompt_start", { kind: "custom" });
    await h.emit("ui_prompt_end", { kind: "custom" });
    assert.equal(h.statuses().at(-1), statusSequence("Idle", ""));
    await h.emit("session_info_changed", { name: undefined });
    assert.ok(h.writes.includes(titleSequence(undefined)));
    await h.emit("session_shutdown");
});

test("manual compaction reports Working then refreshes after successful post-hook cleanup", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    h.setIdle(false);
    await h.emit("session_before_compact", { reason: "manual" });
    assert.match(h.statuses().at(-1)!, /status=Working/);
    await h.emit("session_compact", { reason: "manual" });
    // Another success hook may still be awaiting work when our first refresh runs.
    t.mock.timers.tick(100);
    assert.match(h.statuses().at(-1)!, /status=Working/);
    h.setIdle(true);
    t.mock.timers.tick(100);
    assert.match(h.statuses().at(-1)!, /status=Idle/);
    assert.equal(h.notifications().length, 0);
    await h.emit("session_shutdown");
});

test("failed and cancelled manual compaction return to Idle without a completion notification", async () => {
    for (const aborted of [false, true]) {
        const h = harness();
        await h.emit("session_start");
        h.setIdle(false);
        await h.emit("session_before_compact", { reason: "manual" });
        assert.match(h.statuses().at(-1)!, /status=Working/);
        // Pi clears manual compaction state before emitting the failure event.
        h.setIdle(true);
        await h.emit("session_compact_failed", { reason: "manual", aborted });
        assert.match(h.statuses().at(-1)!, /status=Idle/);
        assert.equal(h.notifications().length, 0);
        await h.emit("session_shutdown");
    }
});

test("compaction refresh cannot write after shutdown", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    h.setIdle(false);
    await h.emit("session_before_compact", { reason: "manual" });
    await h.emit("session_compact", { reason: "manual" });
    await h.emit("session_shutdown");
    const count = h.writes.length;
    t.mock.timers.tick(1000);
    assert.equal(h.writes.length, count);
});

test("RPC, print and non-iTerm2 sessions never emit terminal sequences", async () => {
    for (const options of [{ mode: "rpc" }, { mode: "print" }, { enabled: false }]) {
        const h = harness(options);
        await h.emit("session_start");
        await h.emit("ui_prompt_start", { kind: "confirm" });
        await h.emit("agent_start");
        await h.emit("agent_settled");
        await h.commands.get("iterm2-test").handler("", h.ctx);
        await h.emit("session_shutdown");
        assert.deepEqual(h.writes, []);
        assert.match(h.notices[0], /requires a native interactive/);
    }
});

test("completion notifications are delayed, throttled, and cancelled by new work or pending messages", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    await h.emit("session_start");
    await h.emit("agent_settled");
    t.mock.timers.tick(749);
    assert.equal(h.notifications().length, 0);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(h.notifications().length, 1);
    await h.emit("agent_settled");
    t.mock.timers.tick(750);
    await setImmediate();
    assert.equal(h.notifications().length, 1);
    await h.emit("agent_settled");
    h.setIdle(false);
    await h.emit("agent_start");
    t.mock.timers.tick(3000);
    await setImmediate();
    assert.equal(h.notifications().length, 1);
    h.setIdle(true);
    h.setPending(true);
    await h.emit("agent_settled");
    t.mock.timers.tick(750);
    await setImmediate();
    assert.equal(h.notifications().length, 1);
    h.setPending(false);
    await h.emit("agent_settled");
    t.mock.timers.tick(750);
    await setImmediate();
    assert.equal(h.notifications().length, 2);
    await h.emit("session_shutdown");
});

test("active or invalid subagent fleets suppress completion but not approval attention", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    for (const fleet of [1, "invalid"] as const) {
        const h = harness();
        h.setFleet(fleet);
        await h.emit("session_start");
        await h.emit("agent_settled");
        t.mock.timers.tick(750);
        await setImmediate();
        assert.equal(h.notifications().length, 0);
        await h.emit("ui_prompt_start", { kind: "confirm", title: "Allow tool?" });
        assert.equal(h.notifications().length, 1);
        await h.emit("ui_prompt_end", { kind: "confirm" });
        h.setFleet(0);
        await h.emit("agent_settled");
        t.mock.timers.tick(3000);
        await setImmediate();
        assert.equal(h.notifications().length, 2);
        await h.emit("session_shutdown");
    }
});

test("fleet timeout is conservative after capability discovery; absent package falls back to idle", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    h.setFleet(0);
    await h.emit("session_start");
    h.setFleet("absent");
    await h.emit("agent_settled");
    t.mock.timers.tick(750);
    t.mock.timers.tick(500);
    await setImmediate();
    assert.equal(h.notifications().length, 0);
    await h.emit("session_shutdown");
    const fallback = harness();
    await fallback.emit("session_start");
    t.mock.timers.tick(500);
    await setImmediate();
    await fallback.emit("agent_settled");
    t.mock.timers.tick(750);
    await setImmediate();
    assert.equal(fallback.notifications().length, 1);
    await fallback.emit("session_shutdown");
});

test("shutdown cancels in-flight fleet queries, unsubscribes and clears status and metadata", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = harness();
    h.setFleet(0);
    await h.emit("session_start");
    h.setFleet("absent");
    await h.emit("agent_settled");
    t.mock.timers.tick(750);
    await h.emit("session_shutdown");
    const count = h.writes.length;
    t.mock.timers.tick(5000);
    await setImmediate();
    assert.equal(h.writes.length, count);
    assert.equal(h.notifications().length, 0);
    assert.equal([...h.listeners.values()].reduce((sum, list) => sum + list.size, 0), 0);
    assert.match(h.statuses().at(-1)!, /status=;indicator=;detail=/);
    for (const variable of ["pi_session_file", "pi_session_id", "pi_session_name", "pi_cwd"]) {
        assert.ok(h.writes.includes(userVariableSequence(variable, "")));
    }
});
