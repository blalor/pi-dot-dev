#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = resolve(projectRoot, ".pi_tmp", "rpc-smoke.jsonl");

function usage() {
    console.error("Usage: pi-rpc-smoke.mjs [--command <slash-command>] [--output <path>] [--timeout <ms>]");
}

function parseArgs(argv) {
    const options = {
        command: "/frictions --scope harness",
        output: defaultOutput,
        timeoutMs: 15_000,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = argv[index + 1];
        if (argument === "--command" && value) {
            options.command = value;
            index += 1;
        } else if (argument === "--output" && value) {
            options.output = resolve(value);
            index += 1;
        } else if (argument === "--timeout" && value && /^\d+$/.test(value)) {
            options.timeoutMs = Number(value);
            index += 1;
        } else if (argument === "-h" || argument === "--help") {
            usage();
            process.exit(0);
        } else {
            usage();
            throw new Error(`Unknown or incomplete argument: ${argument}`);
        }
    }

    if (!options.command.startsWith("/")) {
        throw new Error("--command must be a slash command");
    }
    return options;
}

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += decoder.write(chunk);
        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;
            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const requestId = `rpc-smoke-${randomUUID()}`;
    const executable = process.env.PI_RPC_BIN ?? resolve(projectRoot, "bin", "pi");
    const child = spawn(executable, ["--mode", "rpc", "--no-session", "--no-approve"], {
        cwd: projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines = [];
    const stderrChunks = [];
    let commandResponse;
    let notification;
    let parseError;
    let inputClosed = false;

    const closeInputWhenComplete = () => {
        if (inputClosed || !commandResponse || !notification) return;
        inputClosed = true;
        child.stdin.end();
    };

    attachJsonlReader(child.stdout, (line) => {
        if (!line) return;
        stdoutLines.push(line);
        try {
            const event = JSON.parse(line);
            if (event.type === "response" && event.id === requestId) commandResponse = event;
            if (event.type === "extension_ui_request" && event.method === "notify") notification = event;
            closeInputWhenComplete();
        } catch (error) {
            parseError ??= error;
            child.stdin.end();
        }
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const timeout = setTimeout(() => {
        child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdin.write(`${JSON.stringify({ id: requestId, type: "prompt", message: options.command })}\n`);

    const exit = await new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    clearTimeout(timeout);

    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, stdoutLines.length > 0 ? `${stdoutLines.join("\n")}\n` : "", "utf8");
    const stderrOutput = Buffer.concat(stderrChunks).toString("utf8");
    if (stderrOutput) await writeFile(`${options.output}.stderr`, stderrOutput, "utf8");

    if (parseError) throw new Error(`Pi emitted invalid JSONL: ${parseError.message}`);
    if (!commandResponse) throw new Error(`No response arrived before Pi exited (${JSON.stringify(exit)})`);
    if (!commandResponse.success) throw new Error(`RPC command failed: ${commandResponse.error ?? "unknown error"}`);
    if (!notification) throw new Error("The extension command emitted no notification");
    if (exit.signal === "SIGTERM") throw new Error(`RPC smoke test timed out after ${options.timeoutMs} ms`);
    if (exit.code !== 0) throw new Error(`Pi exited with status ${exit.code}`);

    console.log(`RPC command succeeded; captured ${stdoutLines.length} records in ${options.output}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
