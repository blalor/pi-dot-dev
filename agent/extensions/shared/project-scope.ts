import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectScope {
    id: string;
    kind: "remote" | "directory";
    key: string;
    cwd: string;
    gitRoot?: string;
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
    try {
        const result = await execFileAsync("git", ["-C", cwd, ...args], {
            encoding: "utf8",
            timeout: 2_000,
            maxBuffer: 256 * 1024,
        });
        return result.stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

async function canonicalDirectory(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
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
    const scpMatch = hasScheme ? null : trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!hasScheme && !scpMatch) {
        const path = resolve(baseDirectory, trimmed)
            .replace(/\\/g, "/")
            .replace(/\/+$/, "")
            .replace(/\.git$/i, "");
        return `file://${path.startsWith("/") ? "" : "/"}${path}`;
    }

    try {
        const parsed = new URL(scpMatch ? `ssh://${scpMatch[1]}/${scpMatch[2]}` : trimmed);
        const host = parsed.hostname.toLowerCase();
        const port = parsed.port ? `:${parsed.port}` : "";
        const path = decodeURIComponent(parsed.pathname)
            .replace(/\\/g, "/")
            .replace(/\/+$/, "")
            .replace(/\.git$/i, "")
            .replace(/^\/+/, "");
        if (parsed.protocol === "file:") return `file:///${path}`;
        return `${host}${port}/${path}`.replace(/\/+$/, "");
    } catch {
        return trimmed
            .replace(/^[^@\s]+@/, "")
            .replace(/[?#].*$/, "")
            .replace(/\.git\/?$/i, "")
            .replace(/\/+$/, "");
    }
}

export async function resolveProjectScope(cwd: string): Promise<ProjectScope> {
    const canonicalCwd = await canonicalDirectory(cwd);
    const gitRootValue = await runGit(canonicalCwd, ["rev-parse", "--show-toplevel"]);
    const gitRoot = gitRootValue ? await canonicalDirectory(gitRootValue) : undefined;

    if (gitRoot) {
        const remotes = (await runGit(gitRoot, ["remote"]))?.split("\n").filter(Boolean) ?? [];
        const preferred = remotes.includes("origin") ? "origin" : remotes.sort()[0];
        if (preferred) {
            const remote = await runGit(gitRoot, ["remote", "get-url", preferred]);
            if (remote) {
                const key = canonicalizeRemote(remote, gitRoot);
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
