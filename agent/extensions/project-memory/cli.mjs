#!/usr/bin/env -S node --experimental-strip-types

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { propose } from "./batch.ts";
import { defaultMemoryRoot, enroll, enrolledProjects, projectDirectory, readSnapshot, refreshProposal } from "./lib.ts";
import { redactSensitiveText } from "../work-log/lib.ts";

const exec = promisify(execFile);
const LABEL = "com.blalor.pi-project-memory";
const CLI = fileURLToPath(import.meta.url);
function xml(text) { return String(text).replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]); }
export function schedulePlist(node, cli, root) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key><array>
        <string>${xml(node)}</string><string>--experimental-strip-types</string>
        <string>${xml(cli)}</string><string>propose</string><string>--all</string>
    </array>
    <key>StartInterval</key><integer>86400</integer>
    <key>WorkingDirectory</key><string>${xml(homedir())}</string>
    <key>StandardOutPath</key><string>${xml(join(root, "_schedule.stdout.log"))}</string>
    <key>StandardErrorPath</key><string>${xml(join(root, "_schedule.stderr.log"))}</string>
</dict></plist>
`;
}
async function schedule(action, output) {
    if (process.platform !== "darwin") throw new Error("The bundled scheduler uses macOS launchd; use cron or another scheduler to run project-memory propose --all elsewhere");
    const root = defaultMemoryRoot();
    const file = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    const domain = `gui/${process.getuid()}`;
    if (action === "status") {
        const { stdout } = await exec("launchctl", ["print", `${domain}/${LABEL}`]);
        output.write(stdout); return;
    }
    if (action === "remove") {
        try { await exec("launchctl", ["print", `${domain}/${LABEL}`]); }
        catch (error) {
            if (!/Could not find (service|domain)/i.test(String(error.stderr))) throw error;
            await unlink(file).catch((failure) => { if (failure.code !== "ENOENT") throw failure; });
            output.write("Project-memory schedule is not loaded; its configuration was removed.\n"); return;
        }
        await exec("launchctl", ["bootout", `${domain}/${LABEL}`]);
        await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
        output.write("Project-memory schedule removed. Memory and proposals were retained.\n"); return;
    }
    if (action !== "install") throw new Error("Usage: project-memory schedule install|remove|status");
    if (!(await enrolledProjects(root)).length) throw new Error("Enroll at least one project before installing the schedule");
    await mkdir(dirname(file), { recursive: true });
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Do not silently replace an existing job or change its executable/configuration.
    await writeFile(file, schedulePlist(process.execPath, CLI, root), { mode: 0o600, flag: "wx" });
    try { await exec("launchctl", ["bootstrap", domain, file]); }
    catch (error) { await unlink(file); throw error; }
    output.write(`Daily proposal generation installed: ${file}\nOnly enrolled projects are processed. Run project-memory propose --all for an initial batch.\n`);
}
export function usage() {
    return `Usage:
  project-memory init <Git-remote-or-project-key> [local-directory]
  project-memory list
  project-memory show <project>
  project-memory pending <project>
  project-memory propose <project> [--refresh]
  project-memory propose --all
  project-memory schedule install|remove|status

Generation only writes proposals. Review and approval use /project-memory review in Pi.
Schedule installation is explicit; only enrolled projects are processed.`;
}
export async function main(args = process.argv.slice(2), options = {}) {
    const root = options.root ?? defaultMemoryRoot();
    const output = options.stdout ?? process.stdout;
    const [command, identity, ...rest] = args;
    if (!command || command === "--help" || command === "-h") { output.write(`${usage()}\n`); return; }
    if (command === "list" && args.length === 1) { output.write(`${(await enrolledProjects(root)).join("\n")}\n`); return; }
    if (command === "init" && identity && rest.length <= 1) {
        const localDirectory = rest[0] ? realpathSync(rest[0]) : undefined;
        output.write(`Enrolled ${await enroll(root, identity, localDirectory)}\n`); return;
    }
    if (command === "schedule" && identity && !rest.length) {
        if (options.root) throw new Error("Schedule management always uses the default memory directory");
        await schedule(identity, output); return;
    }
    if (command === "propose" && identity && (rest.length === 0 || (rest.length === 1 && rest[0] === "--refresh" && identity !== "--all"))) {
        const projects = identity === "--all" ? await enrolledProjects(root) : [identity];
        let failed = false;
        for (const project of projects) {
            try {
                if (rest[0] === "--refresh") {
                    const saved = await readSnapshot(root, project);
                    if (saved.pending) await refreshProposal(root, project, saved.pending);
                }
                const result = await propose(project, { root, ...options.batch });
                for (const warning of result.diagnostics) output.write(`${project}: WARNING: ${redactSensitiveText(warning)}\n`);
                output.write(`${project}: ${result.status}${result.proposal ? ` (${result.proposal.changes.length} changes; ${result.proposal.id})` : ""}\n`);
            } catch (error) {
                failed = true;
                output.write(`${project}: FAILED: ${redactSensitiveText(String(error))}\n`);
            }
        }
        if (failed) throw new Error("One or more projects failed; their unprocessed episodes will be retried on the next run");
        return;
    }
    if ((command === "show" || command === "pending") && identity && !rest.length) {
        const saved = await readSnapshot(root, identity);
        if (command === "show") output.write(saved.current);
        else if (saved.pending) {
            output.write(await readFile(join(projectDirectory(root, identity), "proposals", "pending", `${saved.pending.id}.md`), "utf8"));
        } else output.write("No pending proposal.\n");
        return;
    }
    throw new Error(usage());
}
if (process.argv[1] && realpathSync(process.argv[1]) === CLI) {
    main().catch((error) => {
        process.stderr.write(`project-memory: ${redactSensitiveText(String(error))}\n`);
        process.exitCode = 1;
    });
}
