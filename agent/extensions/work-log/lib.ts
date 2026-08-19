import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_ITEMS = 5;
const MAX_ITEM_LENGTH = 500;

export interface WorkSummary {
    decision: "log" | "skip";
    accomplished: string[];
    decisions: string[];
    artifacts: string[];
    validation: string[];
    blockers: string[];
    next: string[];
}

export interface WorkEpisode extends Omit<WorkSummary, "decision"> {
    id: string;
    startedAt: string;
    endedAt: string;
    generatedAt: string;
    sessionId: string;
    cwd: string;
    remote?: string;
    agentModel?: string;
    fromEntryId: string;
    toEntryId: string;
}

export interface WorkLogState {
    lastEntryId?: string;
    updatedAt: string;
}

export interface PendingWorkEpisode {
    version: 1;
    id: string;
    queuedAt: string;
    startedAt: string;
    endedAt: string;
    sessionId: string;
    cwd: string;
    agentModel?: string;
    fromEntryId: string;
    toEntryId: string;
    transcript: string;
}

export interface BranchEntry {
    id: string;
    timestamp: string;
    type: string;
    message?: unknown;
}

export interface EpisodeRange {
    entries: BranchEntry[];
    messageEntries: BranchEntry[];
    fromEntryId: string;
    toEntryId: string;
    startedAt: string;
    endedAt: string;
}

export function redactSensitiveText(value: string): string {
    return value
        .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [REDACTED]")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]")
        .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

function cleanItems(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => redactSensitiveText(item).replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, MAX_ITEMS)
        .map((item) => item.slice(0, MAX_ITEM_LENGTH));
}

export function parseWorkSummary(text: string): WorkSummary {
    const candidate = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (/^skip\.?$/i.test(candidate)) {
        return {
            decision: "skip",
            accomplished: [],
            decisions: [],
            artifacts: [],
            validation: [],
            blockers: [],
            next: [],
        };
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
        throw new Error("Work-log summarizer returned invalid JSON");
    }

    if (parsed.decision !== "log" && parsed.decision !== "skip") {
        throw new Error("Work-log summarizer returned an invalid decision");
    }

    const summary: WorkSummary = {
        decision: parsed.decision,
        accomplished: cleanItems(parsed.accomplished),
        decisions: cleanItems(parsed.decisions),
        artifacts: cleanItems(parsed.artifacts),
        validation: cleanItems(parsed.validation),
        blockers: cleanItems(parsed.blockers),
        next: cleanItems(parsed.next),
    };
    const materialCount = summary.accomplished.length
        + summary.decisions.length
        + summary.artifacts.length
        + summary.validation.length
        + summary.blockers.length
        + summary.next.length;
    if (materialCount === 0) summary.decision = "skip";
    return summary;
}

export function selectEpisodeRange(entries: BranchEntry[], lastEntryId?: string): EpisodeRange | undefined {
    const cursorIndex = lastEntryId ? entries.findIndex((entry) => entry.id === lastEntryId) : -1;
    if (lastEntryId && cursorIndex === -1) return undefined;
    const candidates = entries.slice(cursorIndex + 1);
    const messageEntries = candidates.filter((entry) => entry.type === "message");
    if (messageEntries.length === 0 || candidates.length === 0) return undefined;

    return {
        entries: candidates,
        messageEntries,
        fromEntryId: candidates[0].id,
        toEntryId: candidates[candidates.length - 1].id,
        startedAt: messageEntries[0].timestamp,
        endedAt: messageEntries[messageEntries.length - 1].timestamp,
    };
}

export function defaultWorkLogRoot(): string {
    return join(homedir(), ".pi", "agent", "work-log");
}

function localDateParts(timestamp: string): { year: string; month: string; date: string } {
    const value = new Date(timestamp);
    const year = String(value.getFullYear());
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return { year, month, date: `${year}-${month}-${day}` };
}

export function episodeFile(rootDir: string, timestamp: string): string {
    const { year, month, date } = localDateParts(timestamp);
    return join(rootDir, year, month, `${date}.jsonl`);
}

function safeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 160) || "unknown";
}

export function stateFile(rootDir: string, sessionId: string): string {
    return join(rootDir, "_state", `${safeSessionId(sessionId)}.json`);
}

export async function readWorkLogState(rootDir: string, sessionId: string): Promise<WorkLogState | undefined> {
    try {
        return JSON.parse(await readFile(stateFile(rootDir, sessionId), "utf8")) as WorkLogState;
    } catch {
        return undefined;
    }
}

export async function writeWorkLogState(
    rootDir: string,
    sessionId: string,
    state: WorkLogState,
): Promise<void> {
    const file = stateFile(rootDir, sessionId);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(state, null, 4)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
}

export function workEpisodeId(sessionId: string, fromEntryId: string, toEntryId: string): string {
    return createHash("sha256")
        .update(`${sessionId}\0${fromEntryId}\0${toEntryId}`)
        .digest("hex")
        .slice(0, 20);
}

export function pendingWorkFile(rootDir: string, episodeId: string): string {
    return join(rootDir, "_pending", `${safeSessionId(episodeId)}.json`);
}

export async function queuePendingWorkEpisode(rootDir: string, episode: PendingWorkEpisode): Promise<string> {
    const file = pendingWorkFile(rootDir, episode.id);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(episode)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return file;
}

export async function listPendingWorkFiles(rootDir: string): Promise<string[]> {
    const directory = join(rootDir, "_pending");
    try {
        const names = await readdir(directory);
        const staleBefore = Date.now() - 5 * 60_000;
        for (const name of names.filter((candidate) => /\.json\.\d+\.working$/.test(candidate))) {
            const claimed = join(directory, name);
            try {
                if ((await stat(claimed)).mtimeMs >= staleBefore) continue;
                const original = claimed.replace(/\.\d+\.working$/, "");
                await rename(claimed, original);
            } catch {
                // Another worker recovered or completed the item.
            }
        }
        return (await readdir(directory))
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => join(directory, name));
    } catch {
        return [];
    }
}

export async function removePendingWorkFile(file: string): Promise<void> {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
}

export async function appendWorkEpisode(rootDir: string, episode: WorkEpisode): Promise<string> {
    const file = episodeFile(rootDir, episode.endedAt);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
        const existing = await readFile(file, "utf8");
        if (existing.split("\n").some((line) => line.includes(`\"id\":\"${episode.id}\"`))) return file;
    } catch {
        // The daily file does not exist yet.
    }
    await appendFile(file, `${JSON.stringify(episode)}\n`, { encoding: "utf8", mode: 0o600 });
    return file;
}

function dailyWorkLogFiles(rootDir: string): string[] {
    const files: string[] = [];
    let years;
    try {
        years = readdirSync(rootDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
        throw error;
    }
    for (const year of years.filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))) {
        const yearDir = join(rootDir, year.name);
        const months = readdirSync(yearDir, { withFileTypes: true });
        for (const month of months.filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))) {
            const monthDir = join(yearDir, month.name);
            const names = readdirSync(monthDir, { withFileTypes: true });
            for (const entry of names) {
                if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
                    files.push(join(monthDir, entry.name));
                }
            }
        }
    }
    return files.sort();
}

export function readSessionWorkEpisodes(rootDir: string, sessionId: string): WorkEpisode[] {
    const episodes: WorkEpisode[] = [];
    const seen = new Set<string>();
    for (const file of dailyWorkLogFiles(rootDir)) {
        const content = readFileSync(file, "utf8");
        for (const [index, line] of content.split("\n").entries()) {
            if (!line.trim()) continue;
            let episode: WorkEpisode;
            try {
                episode = JSON.parse(line) as WorkEpisode;
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                throw new Error(`${file}:${index + 1}: invalid JSON: ${reason}`);
            }
            if (episode.sessionId !== sessionId || seen.has(episode.id)) continue;
            seen.add(episode.id);
            episodes.push(episode);
        }
    }
    return episodes.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function displayTimestamp(timestamp: string): string {
    const value = new Date(timestamp);
    const date = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    const time = `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
    return `${date} ${time}`;
}

type SummaryCategory = Exclude<keyof WorkSummary, "decision">;

const SUMMARY_CATEGORIES: Array<[SummaryCategory, string]> = [
    ["accomplished", "Accomplished"],
    ["decisions", "Decisions"],
    ["artifacts", "Artifacts"],
    ["validation", "Validation"],
    ["blockers", "Blockers"],
    ["next", "Next"],
];

function sessionProjects(episodes: WorkEpisode[]): string[] {
    return [...new Set(episodes.map((episode) => episode.remote ?? episode.cwd))];
}

function sessionHeader(title: string, sessionId: string, episodes: WorkEpisode[]): string[] {
    const lines = [title, "", `Session: \`${sessionId}\``, `Persisted episodes: ${episodes.length}`];
    if (episodes.length === 0) return lines;
    lines.push(`Period: ${displayTimestamp(episodes[0].startedAt)} to ${displayTimestamp(episodes.at(-1)!.endedAt)}`);
    const projects = sessionProjects(episodes);
    if (projects.length === 1) lines.push(`Project: ${projects[0]}`);
    else lines.push("Projects:", ...projects.map((project) => `- ${project}`));
    lines.push("");
    return lines;
}

function uniqueSummaryItems(episodes: WorkEpisode[], field: SummaryCategory): string[] {
    const items = episodes.flatMap((episode) => episode[field]);
    return [...new Set(items)];
}

export function renderSessionWorkLog(sessionId: string, episodes: WorkEpisode[]): string {
    const lines = sessionHeader("# Work log for current session", sessionId, episodes);
    if (episodes.length === 0) {
        lines.push("", "No work episodes have been recorded for this session yet.");
        return lines.join("\n");
    }
    for (const [field, heading] of SUMMARY_CATEGORIES) {
        const items = uniqueSummaryItems(episodes, field);
        if (items.length === 0) continue;
        lines.push(`## ${heading}`, ...items.map((item) => `- ${item}`), "");
    }
    return lines.join("\n").trimEnd();
}

export function renderSessionWorkLogEpisodes(sessionId: string, episodes: WorkEpisode[]): string {
    const lines = sessionHeader("# Work-log episodes for current session", sessionId, episodes);
    if (episodes.length === 0) {
        lines.push("", "No work episodes have been recorded for this session yet.");
        return lines.join("\n");
    }
    const includeProject = sessionProjects(episodes).length > 1;
    for (const episode of episodes) {
        lines.push(`## ${displayTimestamp(episode.startedAt)} to ${displayTimestamp(episode.endedAt)}`, "");
        if (includeProject) lines.push(`Project: ${episode.remote ?? episode.cwd}`, "");
        for (const [field, heading] of SUMMARY_CATEGORIES) {
            const items = episode[field];
            if (items.length === 0) continue;
            lines.push(`### ${heading}`, ...items.map((item) => `- ${item}`), "");
        }
    }
    return lines.join("\n").trimEnd();
}
