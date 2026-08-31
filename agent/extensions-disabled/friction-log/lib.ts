import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_WORKAROUND_LENGTH = 4_000;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

export type FrictionSource = "agent" | "user";
export type FrictionScopeTarget = "project" | "harness";
export type FrictionStatus = "active" | "resolved" | "superseded";
export type FrictionUpdateOperation = "revise" | "resolve" | "supersede";

export interface FrictionScope {
    id: string;
    kind: "remote" | "directory" | "harness";
    key: string;
    cwd: string;
    gitRoot?: string;
}

export interface FrictionRecord {
    type: "friction";
    id: string;
    fingerprint: string;
    timestamp: string;
    source: FrictionSource;
    message: string;
    workaround?: string;
    cwd: string;
    model?: string;
    sessionId?: string;
}

export interface WorkaroundRecord {
    type: "workaround";
    frictionId: string;
    timestamp: string;
    source: FrictionSource;
    workaround: string;
    cwd: string;
    model?: string;
    sessionId?: string;
}

export interface FrictionUpdateRecord {
    type: "update";
    frictionId: string;
    timestamp: string;
    source: FrictionSource;
    operation: FrictionUpdateOperation;
    message?: string;
    workarounds?: string[];
    supersededBy?: string;
    cwd: string;
    model?: string;
    sessionId?: string;
}

export interface KnownFriction {
    id: string;
    fingerprint: string;
    createdAt: string;
    updatedAt: string;
    source: FrictionSource;
    message: string;
    workarounds: string[];
    status: FrictionStatus;
    supersededBy?: string;
    cwd: string;
    model?: string;
    sessionId?: string;
}

export interface AppendFrictionOptions {
    cwd: string;
    scope?: FrictionScopeTarget;
    source: FrictionSource;
    message: string;
    workaround?: string;
    model?: string;
    sessionId?: string;
    rootDir?: string;
}

export interface AppendFrictionResult {
    entry: KnownFriction;
    file: string;
    scope: FrictionScope;
    duplicate: boolean;
    workaroundAdded: boolean;
}

export interface UpdateFrictionOptions {
    cwd: string;
    scope?: FrictionScopeTarget;
    source: FrictionSource;
    id: string;
    operation: FrictionUpdateOperation;
    message?: string;
    workarounds?: string[];
    supersededBy?: string;
    model?: string;
    sessionId?: string;
    rootDir?: string;
}

export interface UpdateFrictionResult {
    entry: KnownFriction;
    file: string;
    scope: FrictionScope;
}

export interface MigrateFrictionsOptions extends ReadFrictionOptions {
    source: FrictionSource;
    model?: string;
    sessionId?: string;
}

export interface MigrateFrictionsResult {
    migrated: number;
    files: string[];
    legacyFile: string;
    scope: FrictionScope;
}

export interface ReadFrictionOptions {
    cwd: string;
    scope?: FrictionScopeTarget;
    rootDir?: string;
}

export interface SearchFrictionOptions extends ReadFrictionOptions {
    query?: string;
    limit?: number;
}

export interface FrictionCollection {
    entries: KnownFriction[];
    total: number;
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

async function canonicalDirectory(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

export async function resolveFrictionScope(
    cwd: string,
    target: FrictionScopeTarget = "project",
): Promise<FrictionScope> {
    const canonicalCwd = await canonicalDirectory(cwd);
    if (target === "harness") {
        return {
            id: "harness--pi",
            kind: "harness",
            key: "pi",
            cwd: canonicalCwd,
        };
    }

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

export function normalizeWorkaround(workaround: string | undefined): string | undefined {
    if (workaround === undefined) return undefined;
    const normalized = workaround.replace(/\0/g, "").trim();
    if (!normalized) return undefined;
    if (normalized.length > MAX_WORKAROUND_LENGTH) {
        throw new Error(`Friction workaround exceeds ${MAX_WORKAROUND_LENGTH} characters`);
    }
    return normalized;
}

function normalizeWorkarounds(workarounds: string[]): string[] {
    const normalized: string[] = [];
    for (const value of workarounds) {
        const workaround = normalizeWorkaround(value);
        if (!workaround) continue;
        if (!normalized.some((known) => frictionFingerprint(known) === frictionFingerprint(workaround))) {
            normalized.push(workaround);
        }
    }
    return normalized;
}

export function frictionFingerprint(message: string): string {
    return message
        .replace(/\0/g, "")
        .trim()
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function defaultLogRoot(): string {
    return join(homedir(), ".pi", "agent", "friction-log");
}

function pathsForScope(scope: FrictionScope, rootDir = defaultLogRoot()) {
    const scopeDir = join(rootDir, scope.id);
    return {
        scopeDir,
        scopeFile: join(scopeDir, "scope.json"),
        logFile: join(scopeDir, "friction.jsonl"),
        lockFile: join(scopeDir, ".write.lock"),
    };
}

function frictionFile(scopeDir: string, id: string): string {
    return join(scopeDir, id, "friction.json");
}

async function storedFrictionExists(scopeDir: string, id: string): Promise<boolean> {
    try {
        await stat(frictionFile(scopeDir, id));
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

async function writeStoredFriction(scopeDir: string, entry: KnownFriction): Promise<string> {
    const file = frictionFile(scopeDir, entry.id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.friction.json.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...entry }, null, 4)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    });
    await rename(temporary, file);
    return file;
}

async function ensureScope(scope: FrictionScope, rootDir?: string) {
    const paths = pathsForScope(scope, rootDir);
    await mkdir(paths.scopeDir, { recursive: true, mode: 0o700 });
    try {
        await writeFile(
            paths.scopeFile,
            `${JSON.stringify({ kind: scope.kind, key: scope.key }, null, 4)}\n`,
            { encoding: "utf8", mode: 0o600, flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY },
        );
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return paths;
}

async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
        try {
            const handle = await open(lockFile, "wx", 0o600);
            await handle.writeFile(`${process.pid} ${randomUUID()}\n`, "utf8");
            return async () => {
                await handle.close();
                await unlink(lockFile).catch(() => undefined);
            };
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            try {
                const lockStat = await stat(lockFile);
                if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
                    await unlink(lockFile);
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() >= deadline) throw new Error("Timed out waiting for the friction log write lock");
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
    }
}

async function readRecords(file: string): Promise<unknown[]> {
    let contents: string;
    try {
        contents = await readFile(file, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }

    const records: unknown[] = [];
    for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        try {
            records.push(JSON.parse(line));
        } catch {
            // Keep retrieval available if one line was torn or manually damaged.
        }
    }
    return records;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function foldRecords(records: unknown[]): KnownFriction[] {
    const byId = new Map<string, KnownFriction>();
    const byFingerprint = new Map<string, KnownFriction>();

    for (const raw of records) {
        if (!raw || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;

        if (record.type === "workaround") {
            const frictionId = stringValue(record.frictionId);
            const workaround = stringValue(record.workaround);
            if (!frictionId || !workaround) continue;
            const existing = byId.get(frictionId);
            if (!existing) continue;
            if (!existing.workarounds.some((value) => frictionFingerprint(value) === frictionFingerprint(workaround))) {
                existing.workarounds.push(workaround);
            }
            existing.updatedAt = stringValue(record.timestamp) ?? existing.updatedAt;
            continue;
        }

        if (record.type === "update") {
            const frictionId = stringValue(record.frictionId);
            const operation = stringValue(record.operation);
            if (!frictionId || !operation) continue;
            const existing = byId.get(frictionId);
            if (!existing) continue;

            if (operation === "revise") {
                const revisedMessage = stringValue(record.message);
                if (revisedMessage) {
                    byFingerprint.delete(existing.fingerprint);
                    existing.message = revisedMessage;
                    existing.fingerprint = frictionFingerprint(revisedMessage);
                    byFingerprint.set(existing.fingerprint, existing);
                }
                if (Array.isArray(record.workarounds)) {
                    existing.workarounds = record.workarounds
                        .map((value) => stringValue(value))
                        .filter((value): value is string => Boolean(value));
                }
            } else if (operation === "resolve") {
                existing.status = "resolved";
                delete existing.supersededBy;
            } else if (operation === "supersede") {
                const supersededBy = stringValue(record.supersededBy);
                if (!supersededBy) continue;
                existing.status = "superseded";
                existing.supersededBy = supersededBy;
            } else {
                continue;
            }
            existing.updatedAt = stringValue(record.timestamp) ?? existing.updatedAt;
            continue;
        }

        const message = stringValue(record.message);
        if (!message) continue;
        const fingerprint = stringValue(record.fingerprint) ?? frictionFingerprint(message);
        const id = stringValue(record.id) ?? `fr_${hash(fingerprint)}`;
        const timestamp = stringValue(record.timestamp) ?? new Date(0).toISOString();
        const existing = byFingerprint.get(fingerprint);
        const workaround = stringValue(record.workaround);

        if (existing) {
            if (workaround && !existing.workarounds.some((value) => frictionFingerprint(value) === frictionFingerprint(workaround))) {
                existing.workarounds.push(workaround);
            }
            existing.updatedAt = timestamp;
            byId.set(id, existing);
            continue;
        }

        const entry: KnownFriction = {
            id,
            fingerprint,
            createdAt: timestamp,
            updatedAt: timestamp,
            source: record.source === "user" ? "user" : "agent",
            message,
            workarounds: workaround ? [workaround] : [],
            status: "active",
            cwd: stringValue(record.cwd) ?? "",
            ...(stringValue(record.model) ? { model: stringValue(record.model) } : {}),
            ...(stringValue(record.sessionId) ? { sessionId: stringValue(record.sessionId) } : {}),
        };
        byId.set(id, entry);
        byFingerprint.set(fingerprint, entry);
    }

    return [...new Set(byFingerprint.values())];
}

function storedFriction(raw: unknown): KnownFriction | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    const id = stringValue(record.id);
    const message = stringValue(record.message);
    const createdAt = stringValue(record.createdAt);
    const updatedAt = stringValue(record.updatedAt);
    if (!id || !message || !createdAt || !updatedAt) return undefined;
    const status = record.status === "resolved" || record.status === "superseded" ? record.status : "active";
    const workarounds = Array.isArray(record.workarounds)
        ? record.workarounds.map((value) => stringValue(value)).filter((value): value is string => Boolean(value))
        : [];
    return {
        id,
        fingerprint: stringValue(record.fingerprint) ?? frictionFingerprint(message),
        createdAt,
        updatedAt,
        source: record.source === "user" ? "user" : "agent",
        message,
        workarounds,
        status,
        ...(status === "superseded" && stringValue(record.supersededBy)
            ? { supersededBy: stringValue(record.supersededBy) }
            : {}),
        cwd: stringValue(record.cwd) ?? "",
        ...(stringValue(record.model) ? { model: stringValue(record.model) } : {}),
        ...(stringValue(record.sessionId) ? { sessionId: stringValue(record.sessionId) } : {}),
    };
}

async function readStoredFrictions(scopeDir: string): Promise<KnownFriction[]> {
    let children;
    try {
        children = await readdir(scopeDir, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }

    const entries: KnownFriction[] = [];
    for (const child of children) {
        if (!child.isDirectory() || !child.name.startsWith("fr_")) continue;
        try {
            const parsed = JSON.parse(await readFile(frictionFile(scopeDir, child.name), "utf8"));
            const entry = storedFriction(parsed);
            if (entry && entry.id === child.name) entries.push(entry);
        } catch {
            // Keep other frictions readable when one stored file is missing or malformed.
        }
    }
    return entries;
}

async function combinedFrictions(paths: ReturnType<typeof pathsForScope>): Promise<KnownFriction[]> {
    const legacy = foldRecords(await readRecords(paths.logFile));
    const stored = await readStoredFrictions(paths.scopeDir);
    const byId = new Map(legacy.map((entry) => [entry.id, entry]));
    for (const entry of stored) {
        for (const [id, candidate] of byId) {
            if (id === entry.id || candidate.fingerprint === entry.fingerprint) byId.delete(id);
        }
        byId.set(entry.id, entry);
    }
    return [...byId.values()];
}

async function removeLegacyEntry(logFile: string, entry: KnownFriction): Promise<void> {
    let contents: string;
    try {
        contents = await readFile(logFile, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
    }

    const aliases = new Set([entry.id]);
    const parsed = contents.split("\n").map((line) => {
        if (!line.trim()) return { line, record: undefined };
        try {
            return { line, record: JSON.parse(line) as Record<string, unknown> };
        } catch {
            return { line, record: undefined };
        }
    });
    for (const { record } of parsed) {
        if (!record || record.type === "workaround" || record.type === "update") continue;
        const message = stringValue(record.message);
        if (!message) continue;
        const fingerprint = stringValue(record.fingerprint) ?? frictionFingerprint(message);
        if (fingerprint === entry.fingerprint) {
            aliases.add(stringValue(record.id) ?? `fr_${hash(fingerprint)}`);
        }
    }

    const kept = parsed.filter(({ line, record }) => {
        if (!line.trim()) return false;
        if (!record) return true;
        if (record.type === "workaround" || record.type === "update") {
            return !aliases.has(stringValue(record.frictionId) ?? "");
        }
        const message = stringValue(record.message);
        if (!message) return true;
        const fingerprint = stringValue(record.fingerprint) ?? frictionFingerprint(message);
        const id = stringValue(record.id) ?? `fr_${hash(fingerprint)}`;
        return !aliases.has(id) && fingerprint !== entry.fingerprint;
    });
    await writeFile(logFile, kept.length > 0 ? `${kept.map(({ line }) => line).join("\n")}\n` : "", {
        encoding: "utf8",
        mode: 0o600,
    });
}

export async function readFrictions(options: ReadFrictionOptions): Promise<FrictionCollection> {
    const scope = await resolveFrictionScope(options.cwd, options.scope);
    const paths = pathsForScope(scope, options.rootDir);
    const entries = await combinedFrictions(paths);
    return { entries, total: entries.length, file: paths.logFile, scope };
}

function queryTerms(value: string): Set<string> {
    return new Set(
        frictionFingerprint(value)
            .split(" ")
            .filter((term) => term.length > 2),
    );
}

function relevance(entry: KnownFriction, query: string): number {
    if (!query.trim()) return 0;
    const wanted = queryTerms(query);
    if (wanted.size === 0) return 0;
    const available = queryTerms(`${entry.message} ${entry.workarounds.join(" ")}`);
    let overlap = 0;
    for (const term of wanted) if (available.has(term)) overlap += 1;
    return overlap / wanted.size;
}

export async function searchFrictions(options: SearchFrictionOptions): Promise<FrictionCollection> {
    const collection = await readFrictions(options);
    const query = options.query?.trim() ?? "";
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
    const activeEntries = collection.entries.filter((entry) => entry.status === "active");
    const entries = activeEntries
        .map((entry) => ({ entry, score: relevance(entry, query) }))
        .filter(({ score }) => !query || score > 0)
        .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
        .slice(0, limit)
        .map(({ entry }) => entry);
    return { ...collection, entries, total: activeEntries.length };
}

export async function getFriction(options: ReadFrictionOptions, id: string): Promise<KnownFriction | undefined> {
    const { entries } = await readFrictions(options);
    const exact = entries.find((entry) => entry.id === id);
    if (exact) return exact;
    const matches = entries.filter((entry) => entry.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
}

export function formatFrictionSummary(
    scope: FrictionScope,
    entries: KnownFriction[],
    options: { total?: number; maxChars?: number } = {},
): string {
    const total = options.total ?? entries.length;
    const maxChars = options.maxChars ?? 1_200;
    const scopeLabel = scope.kind === "harness" ? "the Pi harness" : scope.key;
    const lines = [`Known friction for ${scopeLabel} (${total} entr${total === 1 ? "y" : "ies"}; verify notes before use):`];

    if (entries.length === 0) {
        lines.push("", "No matching friction was found.");
        return lines.join("\n");
    }

    for (const entry of entries) {
        const block = [`- [${entry.id}] ${entry.message}`];
        if (entry.workarounds.length > 0) {
            block.push(`  Workaround: ${entry.workarounds.slice(-2).join("; ")}`);
        }
        const candidate = [...lines, ...block, "", "Use search_friction for more entries and get_friction for full details."].join("\n");
        if (candidate.length > maxChars && lines.length > 1) break;
        lines.push(...block);
    }

    lines.push("", "Use search_friction for more entries and get_friction for full details.");
    const summary = lines.join("\n");
    return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1).trimEnd()}…`;
}

export async function appendFriction(options: AppendFrictionOptions): Promise<AppendFrictionResult> {
    const scope = await resolveFrictionScope(options.cwd, options.scope);
    const paths = await ensureScope(scope, options.rootDir);
    const release = await acquireLock(paths.lockFile);

    try {
        const message = normalizeMessage(options.message);
        const workaround = normalizeWorkaround(options.workaround);
        const fingerprint = frictionFingerprint(message);
        const entries = await combinedFrictions(paths);
        const existing = entries.find((entry) => entry.fingerprint === fingerprint);

        if (existing) {
            const workaroundAlreadyKnown = workaround
                ? existing.workarounds.some((value) => frictionFingerprint(value) === frictionFingerprint(workaround))
                : false;
            if (workaround && !workaroundAlreadyKnown) {
                existing.workarounds.push(workaround);
                existing.updatedAt = new Date().toISOString();
                const file = await writeStoredFriction(paths.scopeDir, existing);
                await removeLegacyEntry(paths.logFile, existing);
                return { entry: existing, file, scope, duplicate: true, workaroundAdded: true };
            }
            return {
                entry: existing,
                file: await storedFrictionExists(paths.scopeDir, existing.id)
                    ? frictionFile(paths.scopeDir, existing.id)
                    : paths.logFile,
                scope,
                duplicate: true,
                workaroundAdded: false,
            };
        }

        const timestamp = new Date().toISOString();
        const entry: KnownFriction = {
            id: `fr_${hash(fingerprint)}`,
            fingerprint,
            createdAt: timestamp,
            updatedAt: timestamp,
            source: options.source,
            message,
            workarounds: workaround ? [workaround] : [],
            status: "active",
            cwd: scope.cwd,
            ...(options.model ? { model: options.model } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        };
        const file = await writeStoredFriction(paths.scopeDir, entry);
        return { entry, file, scope, duplicate: false, workaroundAdded: Boolean(workaround) };
    } finally {
        await release();
    }
}

export async function updateFriction(options: UpdateFrictionOptions): Promise<UpdateFrictionResult> {
    const scope = await resolveFrictionScope(options.cwd, options.scope);
    const paths = await ensureScope(scope, options.rootDir);
    const release = await acquireLock(paths.lockFile);

    try {
        const entries = await combinedFrictions(paths);
        const entry = entries.find((candidate) => candidate.id === options.id)
            ?? entries.filter((candidate) => candidate.id.startsWith(options.id)).at(0);
        if (!entry || entries.filter((candidate) => candidate.id.startsWith(options.id)).length > 1) {
            throw new Error(`No unambiguous friction record matches ${options.id}`);
        }
        const legacyIdentity = { ...entry };

        if (options.operation === "revise") {
            if (options.message === undefined && options.workarounds === undefined) {
                throw new Error("A revision requires a message or workaround list");
            }
            if (options.message !== undefined) {
                const message = normalizeMessage(options.message);
                const fingerprint = frictionFingerprint(message);
                const collision = entries.find((candidate) => candidate.id !== entry.id && candidate.fingerprint === fingerprint);
                if (collision) throw new Error(`Revised message duplicates ${collision.id}`);
                entry.message = message;
                entry.fingerprint = fingerprint;
            }
            if (options.workarounds !== undefined) entry.workarounds = normalizeWorkarounds(options.workarounds);
        } else if (options.operation === "resolve") {
            entry.status = "resolved";
            delete entry.supersededBy;
        } else if (options.operation === "supersede") {
            if (!options.supersededBy) throw new Error("A superseding friction ID is required");
            const matches = entries.filter((candidate) => candidate.id.startsWith(options.supersededBy!));
            const target = entries.find((candidate) => candidate.id === options.supersededBy) ?? matches.at(0);
            if (!target || matches.length > 1) {
                throw new Error(`No unambiguous superseding friction matches ${options.supersededBy}`);
            }
            if (target.id === entry.id) throw new Error("A friction cannot supersede itself");
            entry.status = "superseded";
            entry.supersededBy = target.id;
        }

        entry.updatedAt = new Date().toISOString();
        const file = await writeStoredFriction(paths.scopeDir, entry);
        await removeLegacyEntry(paths.logFile, legacyIdentity);
        return { entry, file, scope };
    } finally {
        await release();
    }
}

export async function migrateFrictions(options: MigrateFrictionsOptions): Promise<MigrateFrictionsResult> {
    const scope = await resolveFrictionScope(options.cwd, options.scope);
    const paths = await ensureScope(scope, options.rootDir);
    const release = await acquireLock(paths.lockFile);

    try {
        const legacy = foldRecords(await readRecords(paths.logFile));
        const stored = await readStoredFrictions(paths.scopeDir);
        const storedIds = new Set(stored.map((entry) => entry.id));
        const files: string[] = [];
        for (const entry of legacy) {
            if (!storedIds.has(entry.id)) files.push(await writeStoredFriction(paths.scopeDir, entry));
            await removeLegacyEntry(paths.logFile, entry);
        }
        return { migrated: files.length, files, legacyFile: paths.logFile, scope };
    } finally {
        await release();
    }
}
