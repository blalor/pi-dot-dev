import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactSensitiveText, type WorkEpisode } from "../work-log/lib.ts";

const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
    lock(path: string, options: { realpath: boolean; stale: number; retries: number; lockfilePath: string }): Promise<() => Promise<void>>;
};

export interface Evidence {
    episodeId: string;
    sessionId: string;
    fromEntryId: string;
    toEntryId: string;
    file: string;
    line: number;
}
export interface SourceEpisode extends WorkEpisode { evidence: Evidence }
export interface ReviewDecision {
    decision: "accepted" | "edited" | "rejected" | "deferred";
    at: string;
    reason: string;
    appliedText?: string;
}
export interface Change {
    id: string;
    itemId: string;
    before: string | null;
    after: string;
    reason: string;
    uncertainty: string;
    evidence: Evidence[];
    review: "pending" | "accepted" | "edited" | "rejected" | "deferred";
    reviewHistory: ReviewDecision[];
    supersededAt?: string;
    supersessionReason?: string;
    reviewedAt?: string;
    reviewReason?: string;
    appliedText?: string;
}
export interface Proposal {
    version: 1;
    id: string;
    project: string;
    createdAt: string;
    baseHash: string;
    episodeIds: string[];
    changes: Change[];
}
interface State {
    version: 1;
    project: string;
    revision: number;
    processedEpisodeIds: string[];
    localDirectories: string[];
}
export interface Snapshot {
    project: string;
    current: string;
    currentHash: string;
    state: State;
    pending?: Proposal;
    reviewed: Proposal[];
}
export interface BatchInput extends Snapshot { episodes: SourceEpisode[]; diagnostics: string[] }
interface Write { path: string; beforeHash: string; content: string | null }
const EMPTY_MEMORY = "# Project memory\n";
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROPOSAL_ID = /^[a-f0-9]{20}$/;
const DATA_START = "<!-- project-memory-data\n";
const DATA_END = "\n-->\n";

export function defaultMemoryRoot(): string {
    return join(homedir(), ".pi", "agent", "project-memory");
}
export function hash(text: string | null): string {
    return createHash("sha256").update(text === null ? "missing\0" : `content\0${text}`).digest("hex");
}
export function projectKey(remote: string): string {
    const value = remote.trim();
    let key = value;
    if (value.includes("://")) {
        const url = new URL(value);
        if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) throw new Error("Use a network Git remote or an explicit local/<name> identity");
        key = `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+/, "")}`;
    } else {
        key = value.replace(/^(?:[^@/\s]+@)?([^:/\s]+):/, "$1/");
    }
    key = key.replace(/\.git\/?$/i, "").replace(/\/$/, "");
    const parts = key.split("/");
    if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
        throw new Error("Project identity must be a Git remote or host/owner/repository; use local/<name> without a remote");
    }
    parts[0] = parts[0].toLowerCase();
    return parts.join("/");
}
export function projectDirectory(root: string, project: string): string {
    return join(root, projectKey(project));
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 4)}\n`; }
async function optionalRead(file: string): Promise<string | null> {
    try { return await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function atomicWrite(file: string, content: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => undefined); }
}
function validWritePath(path: string): boolean {
    return path === "current.md" || path === "state.json" || /^proposals\/(pending|reviewed)\/[a-f0-9]{20}\.md$/.test(path);
}
async function recover(directory: string): Promise<void> {
    const saved = await optionalRead(join(directory, "transaction.json"));
    if (saved === null) return;
    const writes = JSON.parse(saved) as Write[];
    if (!Array.isArray(writes) || writes.some((entry) => !validWritePath(entry.path)
        || typeof entry.beforeHash !== "string" || (entry.content !== null && typeof entry.content !== "string"))) {
        throw new Error("Invalid project-memory transaction");
    }
    // Check every destination before changing any of them. A manual edit must not be overwritten.
    for (const entry of writes) {
        const actual = hash(await optionalRead(join(directory, entry.path)));
        if (actual !== entry.beforeHash && actual !== hash(entry.content)) {
            throw new Error(`Interrupted transaction conflicts with ${entry.path}; preserve and reconcile it manually`);
        }
    }
    for (const entry of writes) {
        const file = join(directory, entry.path);
        if (hash(await optionalRead(file)) === hash(entry.content)) continue;
        if (entry.content === null) await unlink(file);
        else await atomicWrite(file, entry.content);
    }
    await unlink(join(directory, "transaction.json"));
}
async function commit(directory: string, contents: Record<string, string | null>, expected: Record<string, string> = {}): Promise<void> {
    for (const [path, expectedHash] of Object.entries(expected)) {
        if (!validWritePath(path) || hash(await optionalRead(join(directory, path))) !== expectedHash) throw new Error(`Concurrent edit to ${path}; reopen the proposal`);
    }
    const writes: Write[] = [];
    for (const [path, content] of Object.entries(contents)) {
        if (!validWritePath(path)) throw new Error(`Invalid transaction path: ${path}`);
        writes.push({ path, content, beforeHash: expected[path] ?? hash(await optionalRead(join(directory, path))) });
    }
    await atomicWrite(join(directory, "transaction.json"), json(writes));
    await recover(directory);
}
async function locked<T>(root: string, project: string, run: (directory: string) => Promise<T>): Promise<T> {
    const directory = projectDirectory(root, project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, { realpath: false, stale: 60_000, retries: 0, lockfilePath: join(directory, "_lock") });
    try { await recover(directory); return await run(directory); }
    finally { await release(); }
}
export function memoryItems(current: string): Map<string, string> {
    const items = new Map<string, string>();
    const pattern = /<!-- item:([A-Za-z][A-Za-z0-9_-]{0,63}) -->\n([\s\S]*?)\n<!-- \/item -->/g;
    for (const match of current.matchAll(pattern)) {
        if (items.has(match[1])) throw new Error(`Duplicate memory item ${match[1]}`);
        items.set(match[1], match[2]);
    }
    const remainder = current.replace(pattern, "");
    if (/<!--\s*(?:item:|\/item)/.test(remainder)) throw new Error("Malformed memory item markers");
    return items;
}
function validateBody(body: string): string {
    if (!body.trim() || body.length > 12_000 || /<!--|-->/.test(body)) throw new Error("Memory text is empty, too large, or contains reserved HTML comments");
    for (const field of ["Kind", "Status", "Scope"]) {
        if (!new RegExp(`^${field}: \\S.*$`, "m").test(body)) throw new Error(`Memory text requires ${field}: ...`);
    }
    return redactSensitiveText(body.trim());
}
function block(id: string, body: string): string { return `<!-- item:${id} -->\n${body}\n<!-- /item -->`; }
function replaceItem(current: string, change: Change, after: string): string {
    const existing = memoryItems(current).get(change.itemId) ?? null;
    if (existing !== change.before) throw new Error(`Memory item ${change.itemId} changed; regenerate the proposal`);
    if (existing === null) return `${current.trimEnd()}\n\n${block(change.itemId, after)}\n`;
    return current.replace(block(change.itemId, existing), () => block(change.itemId, after));
}
function evidenceText(evidence: Evidence[]): string {
    return evidence.map((source) => `- Episode ${source.episodeId}; session ${source.sessionId}; entries ${source.fromEntryId}..${source.toEntryId}; ${source.file}:${source.line}`).join("\n");
}
export function renderChange(change: Change): string {
    return [
        `## ${change.id}: ${change.itemId}`, `Review: ${change.review}`, "", "### Before", "", change.before ?? "New item.",
        "", "### Proposed", "", change.after, "", "### Reason", "", change.reason,
        "", "### Uncertainty", "", change.uncertainty || "None stated. This is a proposal, not verified ground truth.",
        "", "### Evidence", "", evidenceText(change.evidence),
        ...(change.supersededAt ? ["", `Superseded: ${change.supersededAt}. ${change.supersessionReason}`] : []),
        ...(change.reviewReason ? ["", `Review reason: ${change.reviewReason}`] : []),
        ...(change.reviewHistory.length ? ["", "### Review history", "", ...change.reviewHistory.map((entry) => `${entry.at}: ${entry.decision}. ${entry.reason}`)] : []),
        ...(change.appliedText ? ["", "### Applied text", "", change.appliedText] : []),
    ].join("\n");
}
export function renderProposal(proposal: Proposal): string {
    const visible = [`# Project-memory proposal ${proposal.id}`, `Project: ${proposal.project}`, `Created: ${proposal.createdAt}`,
        `Base memory hash: ${proposal.baseHash}`, "", ...proposal.changes.map(renderChange)].join("\n\n");
    // The embedded record keeps the reviewable Markdown and machine state in one atomic file.
    return `${visible}\n\n${DATA_START}${JSON.stringify(proposal).replace(/</g, "\\u003c")}\n-->\n`;
}
function parseProposal(content: string): Proposal {
    const start = content.lastIndexOf(DATA_START);
    if (start < 0 || !content.endsWith(DATA_END)) throw new Error("Proposal metadata is missing");
    const proposal = JSON.parse(content.slice(start + DATA_START.length, -DATA_END.length)) as Proposal;
    if (proposal.version !== 1 || !PROPOSAL_ID.test(proposal.id) || renderProposal(proposal) !== content) {
        throw new Error("Proposal was edited outside review; restore it and use the review editor");
    }
    return proposal;
}
async function proposals(directory: string, folder: "pending" | "reviewed"): Promise<Proposal[]> {
    let names: string[];
    try { names = await readdir(join(directory, "proposals", folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(names.filter((name) => /^[a-f0-9]{20}\.md$/.test(name)).sort().map(async (name) =>
        parseProposal(await readFile(join(directory, "proposals", folder, name), "utf8"))));
}
async function snapshot(directory: string, project: string): Promise<Snapshot> {
    const rawState = await optionalRead(join(directory, "state.json"));
    if (rawState === null) throw new Error(`Project ${project} is not enrolled. Run /project-memory init first.`);
    const state = JSON.parse(rawState) as State;
    if (state.version !== 1 || state.project !== project || !Array.isArray(state.processedEpisodeIds) || !Array.isArray(state.localDirectories) || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Invalid project-memory state");
    const current = await optionalRead(join(directory, "current.md"));
    if (current === null) throw new Error("Accepted memory is missing; refusing to recreate it");
    memoryItems(current);
    const pending = await proposals(directory, "pending");
    if (pending.length > 1) throw new Error("Multiple pending proposals; reconcile before continuing");
    return { project, state, current, currentHash: hash(current), pending: pending[0], reviewed: await proposals(directory, "reviewed") };
}
export async function enroll(root: string, identity: string, localDirectory?: string): Promise<string> {
    const project = projectKey(identity);
    return locked(root, project, async (directory) => {
        if (await optionalRead(join(directory, "state.json")) !== null) {
            const saved = await snapshot(directory, project);
            if (localDirectory && !saved.state.localDirectories.includes(localDirectory)) {
                saved.state.localDirectories.push(localDirectory);
                saved.state.revision += 1;
                await commit(directory, { "state.json": json(saved.state) });
            }
            return project;
        }
        if (await optionalRead(join(directory, "current.md")) !== null) throw new Error("Unenrolled memory already exists; preserve and reconcile it manually");
        await commit(directory, { "current.md": EMPTY_MEMORY, "state.json": json({ version: 1, project, revision: 0, processedEpisodeIds: [], localDirectories: localDirectory ? [localDirectory] : [] }) });
        return project;
    });
}
export async function readSnapshot(root: string, identity: string): Promise<Snapshot> {
    const project = projectKey(identity);
    return locked(root, project, (directory) => snapshot(directory, project));
}
export async function enrolledProjects(root: string): Promise<string[]> {
    const projects: string[] = [];
    async function visit(directory: string, prefix: string): Promise<void> {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        if (entries.some((entry) => entry.isFile() && entry.name === "state.json")) projects.push(projectKey(prefix));
        for (const entry of entries.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))) {
            await visit(join(directory, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
        }
    }
    await visit(root, "");
    return projects.sort();
}
export async function readSourceEpisodes(workLogRoot: string): Promise<SourceEpisode[]> {
    let entries;
    try { entries = await readdir(workLogRoot, { recursive: true, withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const files = entries.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)
        && /[\\/]\d{4}[\\/]\d{2}$/.test(entry.parentPath)).map((entry) => join(entry.parentPath, entry.name)).sort();
    const result: SourceEpisode[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        const lines = (await readFile(file, "utf8")).split("\n");
        for (const [index, line] of lines.entries()) {
            if (!line.trim()) continue;
            let episode: WorkEpisode;
            try {
                episode = JSON.parse(line) as WorkEpisode;
                for (const field of ["id", "sessionId", "fromEntryId", "toEntryId", "cwd", "endedAt", "startedAt"] as const) {
                    if (typeof episode?.[field] !== "string" || !episode[field]) throw new Error(`Missing ${field}`);
                }
                for (const field of ["accomplished", "decisions", "artifacts", "validation", "blockers", "next"] as const) {
                    if (!Array.isArray(episode[field]) || episode[field].some((value) => typeof value !== "string")) throw new Error(`Invalid ${field}`);
                }
            } catch (error) { throw new Error(`${file}:${index + 1}: ${String(error)}`); }
            if (seen.has(episode.id)) continue;
            seen.add(episode.id);
            result.push({ ...episode, evidence: { episodeId: episode.id, sessionId: episode.sessionId, fromEntryId: episode.fromEntryId, toEntryId: episode.toEntryId, file, line: index + 1 } });
        }
    }
    return result.sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id));
}
export function selectBatch(saved: Snapshot, episodes: SourceEpisode[]): BatchInput {
    const seen = new Set(saved.state.processedEpisodeIds);
    let size = 0;
    const selected: SourceEpisode[] = [];
    const diagnostics: string[] = [];
    for (const episode of episodes) {
        if (seen.has(episode.id)) continue;
        let matches: boolean;
        if (episode.remote) {
            try { matches = projectKey(episode.remote) === saved.project; }
            catch { diagnostics.push(`Ignoring unsupported remote identity on episode ${episode.id}; it is not matched by directory`); continue; }
        } else matches = saved.state.localDirectories.includes(episode.cwd);
        if (!matches) continue;
        const length = JSON.stringify(episode).length;
        if (length > 60_000) throw new Error(`Episode ${episode.id} exceeds the batch input limit; inspect it before continuing`);
        if (selected.length >= 20 || size + length > 60_000) break;
        selected.push(episode); size += length;
    }
    return { ...saved, episodes: selected, diagnostics };
}
export function parseChanges(text: string, input: BatchInput): Change[] {
    const data = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { changes?: unknown };
    if (!data || !Array.isArray(data.changes) || data.changes.length > 12) throw new Error("Expected JSON with at most 12 changes");
    const items = memoryItems(input.current);
    const used = new Set<string>();
    return data.changes.map((raw: unknown, index) => {
        const change = raw as Record<string, unknown>;
        if (!change || typeof change.itemId !== "string" || !ID.test(change.itemId) || used.has(change.itemId)) throw new Error("Invalid or duplicate memory item ID");
        used.add(change.itemId);
        if (change.before !== (items.get(change.itemId) ?? null)) throw new Error(`Incorrect before text for ${change.itemId}`);
        if (typeof change.after !== "string" || typeof change.reason !== "string" || !change.reason.trim()
            || typeof change.uncertainty !== "string" || !Array.isArray(change.evidenceIds) || !change.evidenceIds.length) throw new Error("Change requires text, rationale, uncertainty, and evidence IDs");
        const evidence = [...new Set(change.evidenceIds)].map((id) => {
            const episode = input.episodes.find((entry) => entry.id === id);
            if (!episode) throw new Error(`Unknown evidence episode: ${String(id)}`);
            return episode.evidence;
        });
        const after = `${validateBody(change.after)}\n\nEvidence:\n${evidenceText(evidence)}`;
        return { id: `change-${index + 1}`, itemId: change.itemId, before: change.before as string | null, after,
            reason: redactSensitiveText(change.reason).slice(0, 4_000), uncertainty: redactSensitiveText(change.uncertainty).slice(0, 4_000), evidence, review: "pending", reviewHistory: [] };
    });
}
export async function saveProposal(root: string, input: BatchInput, changes: Change[]): Promise<Proposal> {
    return locked(root, input.project, async (directory) => {
        const latest = await snapshot(directory, input.project);
        if (latest.pending || latest.currentHash !== input.currentHash || json(latest.state) !== json(input.state)) throw new Error("Project changed during generation; discard this result and retry");
        const proposal: Proposal = { version: 1, id: randomUUID().replace(/-/g, "").slice(0, 20),
            project: input.project, createdAt: new Date().toISOString(), baseHash: input.currentHash, episodeIds: input.episodes.map((entry) => entry.id), changes };
        const state = { ...latest.state, revision: latest.state.revision + 1, processedEpisodeIds: [...new Set([...latest.state.processedEpisodeIds, ...proposal.episodeIds])] };
        const folder = changes.length ? "pending" : "reviewed";
        await commit(directory, { [`proposals/${folder}/${proposal.id}.md`]: renderProposal(proposal), "state.json": json(state) }, { "current.md": latest.currentHash });
        return proposal;
    });
}
export async function reviewChange(root: string, project: string, expected: Proposal, changeId: string,
    decision: "accepted" | "edited" | "rejected" | "deferred", reason: string, editedText?: string): Promise<void> {
    await locked(root, project, async (directory) => {
        const saved = await snapshot(directory, projectKey(project));
        if (!saved.pending || renderProposal(saved.pending) !== renderProposal(expected)) throw new Error("Proposal changed during review; reopen it");
        const proposal = saved.pending;
        const change = proposal.changes.find((entry) => entry.id === changeId);
        if (!change || !["pending", "deferred"].includes(change.review)) throw new Error("Change is already reviewed or missing");
        let current = saved.current;
        if (decision === "accepted" || decision === "edited") {
            if (proposal.baseHash !== saved.currentHash) throw new Error("Accepted memory changed; refresh the proposal before applying it");
            const text = decision === "edited" ? validateBody(editedText ?? "") : change.after;
            const applied = decision === "edited" ? `${text}\n\nReview evidence:\n${evidenceText(change.evidence)}` : text;
            current = replaceItem(current, change, applied);
            change.appliedText = applied;
            proposal.baseHash = hash(current);
        }
        change.review = decision;
        change.reviewReason = redactSensitiveText(reason).slice(0, 4_000);
        change.reviewedAt = new Date().toISOString();
        change.reviewHistory.push({ decision, at: change.reviewedAt, reason: change.reviewReason,
            ...(change.appliedText ? { appliedText: change.appliedText } : {}) });
        const pending = proposal.changes.some((entry) => ["pending", "deferred"].includes(entry.review));
        const writes: Record<string, string | null> = {
            "current.md": current,
            "state.json": json({ ...saved.state, revision: saved.state.revision + 1 }),
            [`proposals/pending/${proposal.id}.md`]: pending ? renderProposal(proposal) : null,
        };
        if (!pending) writes[`proposals/reviewed/${proposal.id}.md`] = renderProposal(proposal);
        await commit(directory, writes, { "current.md": saved.currentHash });
    });
}
export async function refreshProposal(root: string, identity: string, expected: Proposal): Promise<void> {
    const project = projectKey(identity);
    await locked(root, project, async (directory) => {
        const saved = await snapshot(directory, project);
        if (!saved.pending || renderProposal(saved.pending) !== renderProposal(expected)) throw new Error("Proposal changed; reopen it");
        const proposal = saved.pending;
        for (const change of proposal.changes) {
            if (!["pending", "deferred"].includes(change.review)) continue;
            change.supersededAt = new Date().toISOString();
            change.supersessionReason = "Regeneration requested against current memory";
        }
        // Reconsider these episodes, including evidence whose earlier changes were accepted.
        const reconsider = new Set(proposal.episodeIds);
        const state = { ...saved.state, revision: saved.state.revision + 1, processedEpisodeIds: saved.state.processedEpisodeIds.filter((id) => !reconsider.has(id)) };
        await commit(directory, { [`proposals/pending/${proposal.id}.md`]: null,
            [`proposals/reviewed/${proposal.id}.md`]: renderProposal(proposal), "state.json": json(state) });
    });
}
