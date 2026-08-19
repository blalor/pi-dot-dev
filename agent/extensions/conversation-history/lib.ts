import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveProjectScope } from "../shared/project-scope.ts";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_EXCERPT_CHARS = 1_200;

export type ConversationScope = "current-project" | "all";

export interface ConversationMessage {
    entryId: string;
    timestamp: string;
    role: "user" | "assistant" | "custom";
    text: string;
}

export interface ConversationSession {
    file: string;
    id: string;
    cwd: string;
    timestamp: string;
    name?: string;
    messages: ConversationMessage[];
}

export interface ConversationSearchResult {
    sessionId: string;
    sessionName?: string;
    cwd: string;
    sessionTimestamp: string;
    entryId: string;
    messageTimestamp: string;
    role: ConversationMessage["role"];
    excerpt: string;
    score: number;
    file: string;
}

export interface RecentConversation {
    sessionId: string;
    name?: string;
    cwd: string;
    timestamp: string;
    updatedAt: string;
    messageCount: number;
    firstUserMessage?: string;
    file: string;
}

export function defaultSessionRoot(): string {
    return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
}

async function sessionFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    let children;
    try {
        children = await readdir(directory, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const child of children) {
        const path = join(directory, child.name);
        if (child.isDirectory()) files.push(...await sessionFiles(path));
        else if (child.isFile() && child.name.endsWith(".jsonl") && !child.name.endsWith("-pi-automode.jsonl")) files.push(path);
    }
    return files;
}

function textContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .flatMap((part) => {
            if (!part || typeof part !== "object") return [];
            const value = part as { type?: string; text?: unknown };
            return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
        })
        .join("\n");
}

function parseLine(line: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    } catch {
        return undefined;
    }
}

export async function readConversationSession(file: string): Promise<ConversationSession | undefined> {
    let contents: string;
    try {
        const handle = await readFile(file);
        if (handle.byteLength > MAX_FILE_BYTES) return undefined;
        contents = handle.toString("utf8");
    } catch {
        return undefined;
    }

    const lines = contents.split("\n").filter(Boolean);
    const header = lines.length > 0 ? parseLine(lines[0]) : undefined;
    if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;

    let name: string | undefined;
    const messages: ConversationMessage[] = [];
    for (const line of lines.slice(1)) {
        const entry = parseLine(line);
        if (!entry) continue;
        if (entry.type === "session_info" && typeof entry.name === "string") {
            name = entry.name;
            continue;
        }
        if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message || typeof entry.message !== "object") continue;
        const message = entry.message as Record<string, unknown>;
        const role = message.role;
        if (role !== "user" && role !== "assistant" && role !== "custom") continue;
        const text = textContent(message.content).trim();
        if (!text) continue;
        messages.push({
            entryId: entry.id,
            timestamp: typeof entry.timestamp === "string" ? entry.timestamp : String(message.timestamp ?? header.timestamp ?? ""),
            role,
            text,
        });
    }

    return {
        file,
        id: header.id,
        cwd: header.cwd,
        timestamp: typeof header.timestamp === "string" ? header.timestamp : "",
        ...(name ? { name } : {}),
        messages,
    };
}

async function matchingSessionFiles(rootDir: string, query: string): Promise<string[]> {
    const firstTerm = terms(query)[0];
    if (!firstTerm) return [];
    try {
        const result = await execFileAsync("rg", [
            "--files-with-matches",
            "--fixed-strings",
            "--ignore-case",
            "--glob", "*.jsonl",
            "--glob", "!*-pi-automode.jsonl",
            firstTerm,
            rootDir,
        ], { encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
        return result.stdout.split("\n").filter(Boolean);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 1) return [];
        return sessionFiles(rootDir);
    }
}

async function readSessions(files: string[]): Promise<ConversationSession[]> {
    const sessions: ConversationSession[] = [];
    for (const file of files) {
        const session = await readConversationSession(file);
        if (session) sessions.push(session);
    }
    return sessions;
}

export async function listConversationSessions(rootDir = defaultSessionRoot()): Promise<ConversationSession[]> {
    return readSessions(await sessionFiles(rootDir));
}

function terms(value: string): string[] {
    return value
        .normalize("NFKC")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./-]+/u)
        .filter((term) => term.length > 1);
}

function matchScore(text: string, query: string): number {
    const normalized = text.normalize("NFKC").toLowerCase();
    const wanted = [...new Set(terms(query))];
    if (wanted.length === 0) return 0;
    let score = normalized.includes(query.trim().toLowerCase()) ? 4 : 0;
    for (const term of wanted) {
        const matches = normalized.split(term).length - 1;
        if (matches === 0) return 0;
        score += Math.min(matches, 3);
    }
    return score;
}

function excerpt(text: string, query: string, maxChars = MAX_EXCERPT_CHARS): string {
    const flattened = text.replace(/\s+/g, " ").trim();
    if (flattened.length <= maxChars) return flattened;
    const firstTerm = terms(query)[0] ?? "";
    const match = flattened.toLowerCase().indexOf(firstTerm.toLowerCase());
    const start = Math.max(0, Math.min(match === -1 ? 0 : match - Math.floor(maxChars / 3), flattened.length - maxChars));
    return `${start > 0 ? "…" : ""}${flattened.slice(start, start + maxChars).trim()}${start + maxChars < flattened.length ? "…" : ""}`;
}

async function filterScope(sessions: ConversationSession[], cwd: string, scope: ConversationScope): Promise<ConversationSession[]> {
    if (scope === "all") return sessions;
    const current = await resolveProjectScope(cwd);
    const cache = new Map<string, string>();
    const filtered: ConversationSession[] = [];
    for (const session of sessions) {
        let id = cache.get(session.cwd);
        if (!id) {
            id = (await resolveProjectScope(session.cwd)).id;
            cache.set(session.cwd, id);
        }
        if (id === current.id) filtered.push(session);
    }
    return filtered;
}

export async function searchConversations(options: {
    query: string;
    cwd: string;
    scope?: ConversationScope;
    limit?: number;
    rootDir?: string;
}): Promise<ConversationSearchResult[]> {
    const query = options.query.trim();
    if (!query) throw new Error("Conversation search query cannot be empty");
    const rootDir = options.rootDir ?? defaultSessionRoot();
    const sessions = await filterScope(
        await readSessions(await matchingSessionFiles(rootDir, query)),
        options.cwd,
        options.scope ?? "current-project",
    );
    const limit = Math.max(1, Math.min(options.limit ?? 10, 30));
    return sessions
        .flatMap((session) => session.messages.map((message) => ({ session, message, score: matchScore(message.text, query) })))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || right.message.timestamp.localeCompare(left.message.timestamp))
        .slice(0, limit)
        .map(({ session, message, score }) => ({
            sessionId: session.id,
            ...(session.name ? { sessionName: session.name } : {}),
            cwd: session.cwd,
            sessionTimestamp: session.timestamp,
            entryId: message.entryId,
            messageTimestamp: message.timestamp,
            role: message.role,
            excerpt: excerpt(message.text, query),
            score,
            file: session.file,
        }));
}

export async function recentConversations(options: {
    cwd: string;
    scope?: ConversationScope;
    limit?: number;
    rootDir?: string;
}): Promise<RecentConversation[]> {
    const sessions = await filterScope(
        await listConversationSessions(options.rootDir),
        options.cwd,
        options.scope ?? "current-project",
    );
    const limit = Math.max(1, Math.min(options.limit ?? 10, 30));
    return sessions
        .map((session) => ({
            sessionId: session.id,
            ...(session.name ? { name: session.name } : {}),
            cwd: session.cwd,
            timestamp: session.timestamp,
            updatedAt: session.messages.at(-1)?.timestamp ?? session.timestamp,
            messageCount: session.messages.length,
            ...(session.messages.find((message) => message.role === "user")
                ? { firstUserMessage: excerpt(session.messages.find((message) => message.role === "user")!.text, "", 300) }
                : {}),
            file: session.file,
        }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit);
}

export async function readConversation(options: {
    sessionId: string;
    entryId?: string;
    before?: number;
    after?: number;
    rootDir?: string;
}): Promise<{ session: ConversationSession; messages: ConversationMessage[] } | undefined> {
    const sessions = await listConversationSessions(options.rootDir);
    const matches = sessions.filter((session) => session.id === options.sessionId || session.id.startsWith(options.sessionId));
    if (matches.length !== 1) return undefined;
    const session = matches[0];
    if (!options.entryId) return { session, messages: session.messages.slice(0, 20) };
    const index = session.messages.findIndex((message) => message.entryId === options.entryId || message.entryId.startsWith(options.entryId!));
    if (index === -1) return undefined;
    const before = Math.max(0, Math.min(options.before ?? 2, 10));
    const after = Math.max(0, Math.min(options.after ?? 2, 10));
    return { session, messages: session.messages.slice(Math.max(0, index - before), index + after + 1) };
}
