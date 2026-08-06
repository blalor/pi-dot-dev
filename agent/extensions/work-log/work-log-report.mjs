#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORIES = [
    ["accomplished", "Accomplished"],
    ["decisions", "Decisions"],
    ["artifacts", "Artifacts"],
    ["validation", "Validation"],
    ["blockers", "Blockers"],
    ["next", "Next"],
];

export function defaultRoot() {
    return join(homedir(), ".pi", "agent", "work-log");
}

function pad(value) {
    return String(value).padStart(2, "0");
}

export function localDateString(value = new Date()) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function parseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error(`Invalid date: ${value}. Expected YYYY-MM-DD.`);
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
    if (localDateString(date) !== value) throw new Error(`Invalid date: ${value}.`);
    return date;
}

function shiftDate(value, days) {
    const result = new Date(value);
    result.setDate(result.getDate() + days);
    return result;
}

export function parseArguments(args, now = new Date()) {
    if (args.includes("--help") || args.includes("-h")) return { help: true };
    if (args.length === 0 || (args.length === 1 && args[0] === "today")) {
        const date = localDateString(now);
        return { since: date, until: date };
    }
    if (args.length === 1 && args[0] === "yesterday") {
        const date = localDateString(shiftDate(now, -1));
        return { since: date, until: date };
    }

    let since;
    let until;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--since") since = args[++index];
        else if (arg === "--until") until = args[++index];
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (!since || !until) throw new Error("Date ranges require both --since and --until.");
    parseDate(since);
    parseDate(until);
    if (since > until) throw new Error("--since must not be later than --until.");
    return { since, until };
}

export function datesInRange(since, until) {
    const dates = [];
    for (let current = parseDate(since); localDateString(current) <= until; current = shiftDate(current, 1)) {
        dates.push(localDateString(current));
    }
    return dates;
}

export function fileForDate(root, date) {
    const [year, month] = date.split("-");
    return join(root, year, month, `${date}.jsonl`);
}

function validateEpisode(value, file, lineNumber) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${file}:${lineNumber}: expected a JSON object`);
    }
    for (const field of ["startedAt", "endedAt", "sessionId", "cwd"]) {
        if (typeof value[field] !== "string" || !value[field]) {
            throw new Error(`${file}:${lineNumber}: missing string field ${field}`);
        }
    }
    if (typeof value.id !== "string" || !value.id) {
        const range = typeof value.fromEntryId === "string" && typeof value.toEntryId === "string"
            ? `${value.fromEntryId}:${value.toEntryId}`
            : `${file}:${lineNumber}`;
        value = { ...value, id: `legacy:${value.sessionId}:${range}` };
    }
    for (const [field] of CATEGORIES) {
        if (value[field] !== undefined && !Array.isArray(value[field])) {
            throw new Error(`${file}:${lineNumber}: ${field} must be an array`);
        }
    }
    return value;
}

export async function readEpisodes(root, since, until) {
    const episodes = [];
    const seen = new Set();
    for (const date of datesInRange(since, until)) {
        const file = fileForDate(root, date);
        let content;
        try {
            content = await readFile(file, "utf8");
        } catch (error) {
            if (error && typeof error === "object" && error.code === "ENOENT") continue;
            throw error;
        }
        for (const [index, line] of content.split("\n").entries()) {
            if (!line.trim()) continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            } catch (error) {
                throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`);
            }
            const episode = validateEpisode(parsed, file, index + 1);
            if (seen.has(episode.id)) continue;
            seen.add(episode.id);
            episodes.push(episode);
        }
    }
    return episodes.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function uniqueItems(episodes, field) {
    const seen = new Set();
    const result = [];
    for (const episode of episodes) {
        for (const item of episode[field] ?? []) {
            if (typeof item !== "string") continue;
            const normalized = item.trim();
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            result.push(normalized);
        }
    }
    return result;
}

function formatTime(timestamp, includeDate) {
    const value = new Date(timestamp);
    const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
    return includeDate ? `${localDateString(value)} ${time}` : time;
}

export function renderReport(episodes, since, until) {
    const lines = ["# Work log report", "", `Period: ${since}${since === until ? "" : ` to ${until}`}`, `Episodes: ${episodes.length}`, ""];
    if (episodes.length === 0) {
        lines.push("No work episodes recorded.", "");
        return `${lines.join("\n")}\n`;
    }

    const groups = new Map();
    for (const episode of episodes) {
        const key = episode.remote || episode.cwd;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(episode);
    }

    const includeDate = since !== until;
    for (const [project, projectEpisodes] of groups) {
        lines.push(`## ${project}`, "");
        for (const [field, heading] of CATEGORIES) {
            const items = uniqueItems(projectEpisodes, field);
            if (items.length === 0) continue;
            lines.push(`### ${heading}`, ...items.map((item) => `- ${item}`), "");
        }
        lines.push("### Sessions");
        for (const episode of projectEpisodes) {
            const start = formatTime(episode.startedAt, includeDate);
            const end = formatTime(episode.endedAt, includeDate);
            const cwd = episode.remote && episode.cwd ? `, ${episode.cwd}` : "";
            lines.push(`- ${start} to ${end}: \`${episode.sessionId}\`${cwd}`);
        }
        lines.push("");
    }
    return `${lines.join("\n")}\n`;
}

export function usage() {
    return `Usage:
  work-log-report [today]
  work-log-report yesterday
  work-log-report --since YYYY-MM-DD --until YYYY-MM-DD

Reads only ~/.pi/agent/work-log daily JSONL files and writes Markdown to stdout.
It does not call models, agents, network services, Git, or other activity sources.`;
}

export async function main(args = process.argv.slice(2), options = {}) {
    const parsed = parseArguments(args, options.now ?? new Date());
    if (parsed.help) {
        (options.stdout ?? process.stdout).write(`${usage()}\n`);
        return 0;
    }
    const episodes = await readEpisodes(options.root ?? defaultRoot(), parsed.since, parsed.until);
    (options.stdout ?? process.stdout).write(renderReport(episodes, parsed.since, parsed.until));
    return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            process.stderr.write(`work-log-report: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
            process.exitCode = 2;
        },
    );
}
