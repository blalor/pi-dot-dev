import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProjectScope, type ProjectScope } from "../shared/project-scope.ts";

const MAX_STATEMENT_CHARS = 1_000;
const MAX_EVIDENCE_CHARS = 1_000;
const MAX_RATIONALE_CHARS = 1_000;

export type MemoryScopeTarget = "user" | "project";
export type MemoryKind = "preference" | "workflow" | "decision" | "fact";
export type MemoryAuthority = "user" | "agent";
export type MemoryStatus = "active" | "forgotten";
export type CandidateStatus = "pending" | "approved" | "rejected";

export interface MemoryScope {
    id: string;
    kind: "user" | ProjectScope["kind"];
    key: string;
    cwd: string;
    gitRoot?: string;
}

export interface MemoryRecord {
    version: 1;
    id: string;
    scope: MemoryScopeTarget;
    scopeId: string;
    scopeKey: string;
    kind: MemoryKind;
    statement: string;
    authority: MemoryAuthority;
    source: "explicit" | "candidate";
    evidence?: string;
    sourceSessionId?: string;
    sourceEntryIds: string[];
    createdAt: string;
    updatedAt: string;
    status: MemoryStatus;
}

export interface MemoryCandidate {
    version: 1;
    id: string;
    proposedScope: MemoryScopeTarget;
    projectScopeId?: string;
    projectScopeKey?: string;
    kind: MemoryKind;
    statement: string;
    authority: MemoryAuthority;
    evidence: string;
    rationale: string;
    sourceSessionId: string;
    sourceEntryIds: string[];
    cwd: string;
    createdAt: string;
    updatedAt: string;
    status: CandidateStatus;
    reviewedAt?: string;
    memoryId?: string;
}

export interface ExtractionSource {
    entryId: string;
    role: "user" | "assistant";
    text: string;
}

export interface ExtractedCandidate {
    scope: MemoryScopeTarget;
    kind: MemoryKind;
    statement: string;
    sourceEntryId: string;
    evidence: string;
    rationale: string;
}

export interface MemoryState {
    lastEntryId?: string;
    updatedAt: string;
}

export function defaultMemoryRoot(): string {
    return join(homedir(), ".pi", "agent", "memory");
}

function hash(value: string, length = 12): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 160) || "unknown";
}

function cleanText(value: string, max: number, label: string): string {
    const cleaned = redactSensitiveText(value)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) throw new Error(`${label} cannot be empty`);
    if (cleaned.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return cleaned;
}

export function redactSensitiveText(value: string): string {
    return value
        .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [REDACTED]")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]")
        .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

export function memoryFingerprint(statement: string): string {
    return cleanText(statement, MAX_STATEMENT_CHARS, "Memory statement")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export async function resolveMemoryScope(cwd: string, target: MemoryScopeTarget): Promise<MemoryScope> {
    if (target === "user") return { id: "user", kind: "user", key: "user", cwd };
    return resolveProjectScope(cwd);
}

function scopeDirectory(rootDir: string, scope: MemoryScope): string {
    return scope.kind === "user" ? join(rootDir, "user") : join(rootDir, "projects", scope.id);
}

function memoryFile(rootDir: string, scope: MemoryScope, id: string): string {
    return join(scopeDirectory(rootDir, scope), id, "memory.json");
}

function candidateFile(rootDir: string, id: string): string {
    return join(rootDir, "_candidates", id, "candidate.json");
}

async function atomicJson(file: string, value: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.${safeName(file.split("/").at(-1) ?? "record")}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 4)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    });
    await rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
    try {
        return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
        return undefined;
    }
}

async function recordFiles(directory: string, suffix: string): Promise<string[]> {
    let children;
    try {
        children = await readdir(directory, { withFileTypes: true });
    } catch {
        return [];
    }
    return children
        .filter((child) => child.isDirectory())
        .map((child) => join(directory, child.name, suffix));
}

async function ensureScopeMetadata(rootDir: string, scope: MemoryScope): Promise<void> {
    if (scope.kind === "user") return;
    const file = join(scopeDirectory(rootDir, scope), "scope.json");
    if (await readJson(file)) return;
    await atomicJson(file, { kind: scope.kind, key: scope.key });
}

export async function listMemories(options: {
    cwd: string;
    scope?: MemoryScopeTarget | "both";
    includeForgotten?: boolean;
    rootDir?: string;
}): Promise<MemoryRecord[]> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const targets: MemoryScopeTarget[] = options.scope === "user" || options.scope === "project"
        ? [options.scope]
        : ["user", "project"];
    const entries: MemoryRecord[] = [];
    for (const target of targets) {
        const scope = await resolveMemoryScope(options.cwd, target);
        for (const file of await recordFiles(scopeDirectory(rootDir, scope), "memory.json")) {
            const memory = await readJson<MemoryRecord>(file);
            if (memory && (options.includeForgotten || memory.status === "active")) entries.push(memory);
        }
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function remember(options: {
    cwd: string;
    scope: MemoryScopeTarget;
    kind: MemoryKind;
    statement: string;
    authority: MemoryAuthority;
    source?: MemoryRecord["source"];
    evidence?: string;
    sourceSessionId?: string;
    sourceEntryIds?: string[];
    rootDir?: string;
}): Promise<{ memory: MemoryRecord; duplicate: boolean; file: string }> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const scope = await resolveMemoryScope(options.cwd, options.scope);
    await ensureScopeMetadata(rootDir, scope);
    const statement = cleanText(options.statement, MAX_STATEMENT_CHARS, "Memory statement");
    const fingerprint = memoryFingerprint(statement);
    const existing = (await listMemories({ cwd: options.cwd, scope: options.scope, includeForgotten: true, rootDir }))
        .find((memory) => memoryFingerprint(memory.statement) === fingerprint);
    if (existing) {
        const file = memoryFile(rootDir, scope, existing.id);
        if (existing.status === "forgotten") {
            existing.status = "active";
            existing.updatedAt = new Date().toISOString();
            await atomicJson(file, existing);
            return { memory: existing, duplicate: false, file };
        }
        return { memory: existing, duplicate: true, file };
    }

    const timestamp = new Date().toISOString();
    const memory: MemoryRecord = {
        version: 1,
        id: `mem_${hash(`${scope.id}\0${fingerprint}`)}`,
        scope: options.scope,
        scopeId: scope.id,
        scopeKey: scope.key,
        kind: options.kind,
        statement,
        authority: options.authority,
        source: options.source ?? "explicit",
        ...(options.evidence ? { evidence: cleanText(options.evidence, MAX_EVIDENCE_CHARS, "Memory evidence") } : {}),
        ...(options.sourceSessionId ? { sourceSessionId: options.sourceSessionId } : {}),
        sourceEntryIds: [...new Set(options.sourceEntryIds ?? [])],
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "active",
    };
    const file = memoryFile(rootDir, scope, memory.id);
    await atomicJson(file, memory);
    return { memory, duplicate: false, file };
}

function searchTerms(value: string): Set<string> {
    return new Set(memoryFingerprint(value).split(" ").filter((term) => term.length > 1));
}

export async function searchMemories(options: {
    cwd: string;
    query?: string;
    scope?: MemoryScopeTarget | "both";
    limit?: number;
    rootDir?: string;
}): Promise<MemoryRecord[]> {
    const memories = await listMemories(options);
    const query = options.query?.trim() ?? "";
    const wanted = query ? searchTerms(query) : new Set<string>();
    const limit = Math.max(1, Math.min(options.limit ?? 10, 30));
    return memories
        .map((memory) => {
            if (!query) return { memory, score: 0 };
            const available = searchTerms(`${memory.statement} ${memory.evidence ?? ""}`);
            let overlap = 0;
            for (const term of wanted) if (available.has(term)) overlap += 1;
            return { memory, score: wanted.size > 0 ? overlap / wanted.size : 0 };
        })
        .filter(({ score }) => !query || score > 0)
        .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
        .slice(0, limit)
        .map(({ memory }) => memory);
}

export async function getMemory(options: {
    cwd: string;
    id: string;
    rootDir?: string;
}): Promise<MemoryRecord | undefined> {
    const matches = (await listMemories({ cwd: options.cwd, scope: "both", includeForgotten: true, rootDir: options.rootDir }))
        .filter((memory) => memory.id === options.id || memory.id.startsWith(options.id));
    return matches.length === 1 ? matches[0] : undefined;
}

export async function reviseMemory(options: {
    cwd: string;
    id: string;
    statement?: string;
    kind?: MemoryKind;
    evidence?: string;
    authority?: MemoryAuthority;
    sourceSessionId?: string;
    sourceEntryIds?: string[];
    rootDir?: string;
}): Promise<MemoryRecord> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const memory = await getMemory({ cwd: options.cwd, id: options.id, rootDir });
    if (!memory) throw new Error(`No unambiguous memory matches ${options.id}`);
    if (options.statement === undefined && options.kind === undefined && options.evidence === undefined) {
        throw new Error("A revision requires a statement, kind, or evidence");
    }
    if (options.statement !== undefined) {
        const statement = cleanText(options.statement, MAX_STATEMENT_CHARS, "Memory statement");
        const collision = (await listMemories({ cwd: options.cwd, scope: memory.scope, rootDir }))
            .find((candidate) => candidate.id !== memory.id && memoryFingerprint(candidate.statement) === memoryFingerprint(statement));
        if (collision) throw new Error(`Revised memory duplicates ${collision.id}`);
        memory.statement = statement;
    }
    if (options.kind !== undefined) memory.kind = options.kind;
    if (options.evidence !== undefined) memory.evidence = cleanText(options.evidence, MAX_EVIDENCE_CHARS, "Memory evidence");
    if (options.authority !== undefined) memory.authority = options.authority;
    if (options.sourceSessionId !== undefined) memory.sourceSessionId = options.sourceSessionId;
    if (options.sourceEntryIds !== undefined) memory.sourceEntryIds = [...new Set(options.sourceEntryIds)];
    memory.updatedAt = new Date().toISOString();
    memory.status = "active";
    const scope = await resolveMemoryScope(options.cwd, memory.scope);
    await atomicJson(memoryFile(rootDir, scope, memory.id), memory);
    return memory;
}

export async function forgetMemory(options: {
    cwd: string;
    id: string;
    rootDir?: string;
}): Promise<MemoryRecord> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const memory = await getMemory(options);
    if (!memory) throw new Error(`No unambiguous memory matches ${options.id}`);
    const scope = await resolveMemoryScope(options.cwd, memory.scope);
    memory.status = "forgotten";
    memory.updatedAt = new Date().toISOString();
    await atomicJson(memoryFile(rootDir, scope, memory.id), memory);
    return memory;
}

function hasExplicitDurabilitySignal(evidence: string): boolean {
    return /\b(?:i|we)\s+(?:strongly\s+)?prefer\b|\b(?:i|we)\s+(?:do not|don't|never)\s+want\b|\b(?:always|never)\b|\b(?:from now on|going forward|in the future|across (?:all )?(?:repositories|projects)|for all (?:repositories|projects)|user-wide|standing (?:rule|preference)|please remember|remember that|keep in mind)\b/i.test(evidence);
}

export function parseCandidateExtraction(text: string, sources: ExtractionSource[]): ExtractedCandidate[] {
    const candidate = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        throw new Error("Memory extractor returned invalid JSON");
    }
    const values = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown }).candidates)
        ? (parsed as { candidates: unknown[] }).candidates
        : []);
    const byId = new Map(sources.map((source) => [source.entryId, source]));
    const result: ExtractedCandidate[] = [];
    for (const raw of values.slice(0, 5)) {
        if (!raw || typeof raw !== "object") continue;
        const value = raw as Record<string, unknown>;
        if (value.scope !== "user" && value.scope !== "project") continue;
        if (value.kind !== "preference" && value.kind !== "workflow") continue;
        if (typeof value.statement !== "string" || typeof value.sourceEntryId !== "string" || typeof value.evidence !== "string" || typeof value.rationale !== "string") continue;
        const source = byId.get(value.sourceEntryId);
        if (!source || source.role !== "user" || !source.text.includes(value.evidence)) continue;
        if (!hasExplicitDurabilitySignal(value.evidence)) continue;
        result.push({
            scope: value.scope,
            kind: value.kind,
            statement: cleanText(value.statement, MAX_STATEMENT_CHARS, "Candidate statement"),
            sourceEntryId: value.sourceEntryId,
            evidence: cleanText(value.evidence, MAX_EVIDENCE_CHARS, "Candidate evidence"),
            rationale: cleanText(value.rationale, MAX_RATIONALE_CHARS, "Candidate rationale"),
        });
    }
    return result;
}

export async function appendCandidates(options: {
    cwd: string;
    sessionId: string;
    candidates: ExtractedCandidate[];
    sources: ExtractionSource[];
    rootDir?: string;
}): Promise<MemoryCandidate[]> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const project = await resolveProjectScope(options.cwd);
    const sourceRoles = new Map(options.sources.map((source) => [source.entryId, source.role]));
    const existing = await listCandidates({ status: "all", rootDir });
    const knownFingerprints = new Set(existing.map((candidate) => `${candidate.proposedScope}\0${memoryFingerprint(candidate.statement)}`));
    const written: MemoryCandidate[] = [];
    for (const extracted of options.candidates) {
        const fingerprint = `${extracted.scope}\0${memoryFingerprint(extracted.statement)}`;
        if (knownFingerprints.has(fingerprint)) continue;
        const timestamp = new Date().toISOString();
        const authority: MemoryAuthority = sourceRoles.get(extracted.sourceEntryId) === "user" ? "user" : "agent";
        const record: MemoryCandidate = {
            version: 1,
            id: `cand_${hash(`${options.sessionId}\0${extracted.sourceEntryId}\0${fingerprint}`)}`,
            proposedScope: extracted.scope,
            ...(extracted.scope === "project" ? { projectScopeId: project.id, projectScopeKey: project.key } : {}),
            kind: extracted.kind,
            statement: extracted.statement,
            authority,
            evidence: extracted.evidence,
            rationale: extracted.rationale,
            sourceSessionId: options.sessionId,
            sourceEntryIds: [extracted.sourceEntryId],
            cwd: options.cwd,
            createdAt: timestamp,
            updatedAt: timestamp,
            status: "pending",
        };
        await atomicJson(candidateFile(rootDir, record.id), record);
        knownFingerprints.add(fingerprint);
        written.push(record);
    }
    return written;
}

export async function listCandidates(options: {
    status?: CandidateStatus | "all";
    rootDir?: string;
} = {}): Promise<MemoryCandidate[]> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const candidates: MemoryCandidate[] = [];
    for (const file of await recordFiles(join(rootDir, "_candidates"), "candidate.json")) {
        const candidate = await readJson<MemoryCandidate>(file);
        if (candidate && (options.status === "all" || candidate.status === (options.status ?? "pending"))) candidates.push(candidate);
    }
    return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function getCandidate(id: string, rootDir = defaultMemoryRoot()): Promise<MemoryCandidate | undefined> {
    const matches = (await listCandidates({ status: "all", rootDir }))
        .filter((candidate) => candidate.id === id || candidate.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
}

export async function reviewCandidate(options: {
    id: string;
    decision: "approve" | "reject";
    rootDir?: string;
}): Promise<{ candidate: MemoryCandidate; memory?: MemoryRecord }> {
    const rootDir = options.rootDir ?? defaultMemoryRoot();
    const candidate = await getCandidate(options.id, rootDir);
    if (!candidate) throw new Error(`No unambiguous candidate matches ${options.id}`);
    if (candidate.status !== "pending") throw new Error(`Candidate ${candidate.id} is already ${candidate.status}`);

    let memory: MemoryRecord | undefined;
    if (options.decision === "approve") {
        memory = (await remember({
            cwd: candidate.cwd,
            scope: candidate.proposedScope,
            kind: candidate.kind,
            statement: candidate.statement,
            authority: candidate.authority,
            source: "candidate",
            evidence: candidate.evidence,
            sourceSessionId: candidate.sourceSessionId,
            sourceEntryIds: candidate.sourceEntryIds,
            rootDir,
        })).memory;
        candidate.status = "approved";
        candidate.memoryId = memory.id;
    } else {
        candidate.status = "rejected";
    }
    candidate.reviewedAt = new Date().toISOString();
    candidate.updatedAt = candidate.reviewedAt;
    await atomicJson(candidateFile(rootDir, candidate.id), candidate);
    return { candidate, ...(memory ? { memory } : {}) };
}

export function stateFile(rootDir: string, sessionId: string): string {
    return join(rootDir, "_state", `${safeName(sessionId)}.json`);
}

export async function readMemoryState(rootDir: string, sessionId: string): Promise<MemoryState | undefined> {
    return readJson<MemoryState>(stateFile(rootDir, sessionId));
}

export async function writeMemoryState(rootDir: string, sessionId: string, state: MemoryState): Promise<void> {
    await atomicJson(stateFile(rootDir, sessionId), state);
}
