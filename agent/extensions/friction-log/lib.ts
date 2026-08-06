import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_LENGTH = 8_000;

export type FrictionSource = "agent" | "user";

export interface FrictionScope {
    id: string;
    kind: "remote" | "directory";
    key: string;
    cwd: string;
    gitRoot?: string;
}

export interface FrictionEntry {
    timestamp: string;
    source: FrictionSource;
    message: string;
    cwd: string;
    model?: string;
    sessionId?: string;
}

export interface AppendFrictionOptions {
    cwd: string;
    source: FrictionSource;
    message: string;
    model?: string;
    sessionId?: string;
    rootDir?: string;
}

export interface AppendFrictionResult {
    entry: FrictionEntry;
    file: string;
    scope: FrictionScope;
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
    try {
        const result = await execFileAsync("git", ["-C", cwd, ...args], {
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 256 * 1024,
        });
        const value = result.stdout.trim();
        return value || undefined;
    } catch {
        return undefined;
    }
}

function hash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function slug(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "--")
        .replace(/^-+|-+$/g, "")
        .slice(0, 96) || "scope";
}

export function canonicalizeRemote(remote: string, baseDirectory = process.cwd()): string {
    const trimmed = remote.trim();
    const hasScheme = trimmed.includes("://");
    const scpMatch = hasScheme
        ? null
        : trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!hasScheme && !scpMatch) {
        const path = resolve(baseDirectory, trimmed)
            .replace(/\\/g, "/")
            .replace(/\/+$/, "")
            .replace(/\.git$/i, "");
        return `file://${path.startsWith("/") ? "" : "/"}${path}`;
    }
    const urlLike = scpMatch ? `ssh://${scpMatch[1]}/${scpMatch[2]}` : trimmed;

    try {
        const parsed = new URL(urlLike);
        const host = parsed.hostname.toLowerCase();
        const port = parsed.port ? `:${parsed.port}` : "";
        const path = decodeURIComponent(parsed.pathname)
            .replace(/\\/g, "/")
            .replace(/\/+$/, "")
            .replace(/\.git$/i, "")
            .replace(/^\/+/, "");

        if (parsed.protocol === "file:") {
            return `file:///${path}`;
        }
        return `${host}${port}/${path}`.replace(/\/+$/, "");
    } catch {
        return trimmed
            .replace(/^[^@\s]+@/, "")
            .replace(/[?#].*$/, "")
            .replace(/\.git\/?$/i, "")
            .replace(/\/+$/, "");
    }
}

async function canonicalDirectory(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

export async function resolveFrictionScope(cwd: string): Promise<FrictionScope> {
    const canonicalCwd = await canonicalDirectory(cwd);
    const gitRootValue = await runGit(canonicalCwd, ["rev-parse", "--show-toplevel"]);
    const gitRoot = gitRootValue ? await canonicalDirectory(gitRootValue) : undefined;

    if (gitRoot) {
        const remotes = (await runGit(gitRoot, ["remote"]))?.split("\n").filter(Boolean) ?? [];
        const preferred = remotes.includes("origin") ? "origin" : remotes.sort()[0];
        if (preferred) {
            const remoteValue = await runGit(gitRoot, ["remote", "get-url", preferred]);
            if (remoteValue) {
                const key = canonicalizeRemote(remoteValue, gitRoot);
                return {
                    id: `remote--${slug(key)}--${hash(key)}`,
                    kind: "remote",
                    key,
                    cwd: canonicalCwd,
                    gitRoot,
                };
            }
        }
    }

    const key = gitRoot ?? canonicalCwd;
    return {
        id: `directory--${slug(basename(key))}--${hash(key)}`,
        kind: "directory",
        key,
        cwd: canonicalCwd,
        gitRoot,
    };
}

export function normalizeMessage(message: string): string {
    const normalized = message.replace(/\0/g, "").trim();
    if (!normalized) throw new Error("Friction message cannot be empty");
    if (normalized.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`Friction message exceeds ${MAX_MESSAGE_LENGTH} characters`);
    }
    return normalized;
}

export function defaultLogRoot(): string {
    return join(homedir(), ".pi", "agent", "friction-log");
}

export async function appendFriction(options: AppendFrictionOptions): Promise<AppendFrictionResult> {
    const scope = await resolveFrictionScope(options.cwd);
    const rootDir = options.rootDir ?? defaultLogRoot();
    const scopeDir = join(rootDir, scope.id);
    const file = join(scopeDir, "friction.jsonl");
    const entry: FrictionEntry = {
        timestamp: new Date().toISOString(),
        source: options.source,
        message: normalizeMessage(options.message),
        cwd: scope.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };

    await mkdir(scopeDir, { recursive: true, mode: 0o700 });
    try {
        await writeFile(
            join(scopeDir, "scope.json"),
            `${JSON.stringify({ kind: scope.kind, key: scope.key }, null, 4)}\n`,
            { encoding: "utf8", mode: 0o600, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY },
        );
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });

    return { entry, file, scope };
}
