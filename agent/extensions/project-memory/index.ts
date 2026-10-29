import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { propose } from "./batch.ts";
import { defaultMemoryRoot, enroll, projectDirectory, projectKey, readSnapshot, refreshProposal,
    reviewChange } from "./lib.ts";
import { chooseReviewAction } from "./review-ui.ts";
import { redactSensitiveText } from "../work-log/lib.ts";

async function identity(pi: ExtensionAPI, ctx: ExtensionCommandContext, explicit?: string): Promise<string> {
    if (explicit) return projectKey(explicit);
    const remotes = await pi.exec("git", ["-C", ctx.cwd, "remote"], { timeout: 2_000 });
    const names = remotes.code === 0 ? remotes.stdout.trim().split("\n").filter(Boolean).sort() : [];
    const name = names.includes("origin") ? "origin" : names[0];
    if (name) {
        const remote = await pi.exec("git", ["-C", ctx.cwd, "remote", "get-url", name], { timeout: 2_000 });
        if (remote.code === 0 && remote.stdout.trim()) return projectKey(remote.stdout);
    }
    throw new Error("No Git remote. Supply an explicit identity, for example /project-memory init local/ideas");
}
async function review(root: string, project: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) throw new Error("Review requires interactive Pi or an RPC client with extension dialogs");
    const deferred = new Set<string>();
    while (true) {
        const saved = await readSnapshot(root, project);
        const proposal = saved.pending;
        if (!proposal) { ctx.ui.notify("No pending project-memory proposal.", "info"); return; }
        if (proposal.baseHash !== saved.currentHash) throw new Error("Proposal is stale. Run /project-memory refresh to regenerate against accepted memory");
        const change = proposal.changes.find((entry) => ["pending", "deferred"].includes(entry.review)
            && !deferred.has(`${proposal.id}/${entry.id}`));
        if (!change) {
            ctx.ui.notify("Remaining changes are deferred. Run /project-memory review later to revisit them.", "info");
            return;
        }
        const action = await chooseReviewAction(ctx, project, change);
        if (!action || action === "Stop review") return;
        let edited: string | undefined;
        if (action === "Edit and accept") {
            edited = await ctx.ui.editor("Edit the replacement memory item, including Kind, Status, and Scope", change.after);
            if (edited === undefined) return;
            if (!await ctx.ui.confirm("Apply edited memory?", edited)) continue;
        }
        let reason = action === "Defer" ? "Deferred for later review" : "Approved during interactive review";
        if (action === "Reject") {
            const input = await ctx.ui.input("Reject: explain why so future proposals can use this feedback");
            if (input === undefined) return;
            if (!input.trim()) { ctx.ui.notify("A rejection needs a reason.", "warning"); continue; }
            reason = input;
        }
        const decision = action === "Accept" ? "accepted" : action === "Edit and accept" ? "edited" : action === "Reject" ? "rejected" : "deferred";
        await reviewChange(root, project, proposal, change.id, decision, reason, edited);
        ctx.ui.notify(`${change.itemId}: ${decision}`, "info");
        if (decision === "deferred") deferred.add(`${proposal.id}/${change.id}`);
    }
}
export default function projectMemoryExtension(pi: ExtensionAPI): void {
    pi.registerCommand("project-memory", {
        description: "Maintain project knowledge: help, init, status, show, propose, review, refresh [project identity]",
        handler: async (args, ctx) => {
            try {
                const [action = "status", explicit, ...extra] = args.trim().split(/\s+/).filter(Boolean);
                const usage = "Usage: /project-memory help|init|status|show|propose|review|refresh [project identity]";
                if (extra.length || !["help", "init", "status", "show", "propose", "review", "refresh"].includes(action)) throw new Error(usage);
                if (action === "help") { ctx.ui.notify(usage, "info"); return; }
                const root = defaultMemoryRoot();
                const project = await identity(pi, ctx, explicit);
                if (action === "init") {
                    await enroll(root, project, ctx.cwd);
                    ctx.ui.notify(`Enrolled ${project}. Batch generation: project-memory propose --all. Schedule: project-memory schedule install`, "info");
                    return;
                }
                if (action === "review") { await review(root, project, ctx); return; }
                if (action === "refresh") {
                    if (!ctx.hasUI) throw new Error("Refresh requires interactive confirmation");
                    const saved = await readSnapshot(root, project);
                    if (saved.pending) {
                        if (!await ctx.ui.confirm("Regenerate proposal?", "Unreviewed changes will be archived as superseded. Accepted memory and review decisions are retained.")) return;
                        await refreshProposal(root, project, saved.pending);
                    }
                }
                if (action === "propose" || action === "refresh") {
                    ctx.ui.setStatus("project-memory", "Preparing project-memory proposal...");
                    try {
                        const result = await propose(project, { root });
                        for (const warning of result.diagnostics) ctx.ui.notify(redactSensitiveText(warning), "warning");
                        ctx.ui.notify(`Project memory: ${result.status}${result.proposal ? `; ${result.proposal.changes.length} proposed changes` : ""}. Review with /project-memory review.`, "info");
                    } finally { ctx.ui.setStatus("project-memory", undefined); }
                    return;
                }
                const saved = await readSnapshot(root, project);
                const text = action === "show" ? saved.current : [
                    `Project: ${project}`, `Directory: ${projectDirectory(root, project)}`,
                    `Processed episodes: ${saved.state.processedEpisodeIds.length}`,
                    `Pending proposal: ${saved.pending?.id ?? "none"}`,
                    `Proposal stale: ${saved.pending && saved.pending.baseHash !== saved.currentHash ? "yes" : "no"}`,
                    `Reviewed batches: ${saved.reviewed.length}`,
                ].join("\n");
                ctx.ui.setWidget("project-memory", text.split("\n"));
            } catch (error) { ctx.ui.notify(redactSensitiveText(error instanceof Error ? error.message : String(error)), "error"); }
        },
    });
    pi.on("before_agent_start", (_event, ctx) => { ctx.ui.setWidget("project-memory", undefined); });
}
