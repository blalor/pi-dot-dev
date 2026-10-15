---
name: iterm-session-fork
description: Fork the current Pi conversation into a new visible iTerm2 tab. Use when the user asks to fork, clone, or duplicate the current conversation without an agent-handoff context package.
compatibility: Requires macOS, iTerm2, python3, pi, osascript, ITERM_SESSION_ID, and PI_SESSION_FILE. macOS must permit terminal automation of iTerm2.
---

# iTerm2 session fork

Fork the current Pi session into a separate session file in a new iTerm2 tab in the calling session's window. This copies Pi's session history directly. It does not build a summary, create a worktree, assign a task, or establish supervisor/worker coordination.

Use pi-intercom's `handover` with an explicit reachable target when that session only needs a summary and next task. Use `agent-handoff` for checkout isolation, writer ownership, or a bounded task contract.

## Safety and ownership

The fork shares the source checkout. Both sessions can see and modify the same files.

- Do not imply checkout isolation or assign writer ownership unless requested.
- If both sessions will edit files, use a separate Worktrunk worktree or an explicit single-writer agreement. The bundled fork path uses the current checkout, not a new worktree.
- Preserve any tab created if startup fails. Report available identifiers and the recovery command.
- Do not prompt the fork unless the user supplied a prompt or task.

## Independent-session boundary

A fork is an independent continuation, not a delegated child.

- Detach after launch. Do not monitor it, read its terminal, or contact it through intercom unless the user requests coordination.
- The fork must not contact the source session merely because the copied transcript identifies it.
- The helper disables the fork's `intercom` tool by default. Pass `--allow-intercom` only for explicitly requested inter-session coordination.
- An initial user-supplied prompt does not establish an ongoing supervisor relationship.

## Run

Run from the source Pi session's checkout, using the helper path resolved from this skill directory:

```bash
python3 <absolute-agent-handoff-skill-directory>/scripts/launch-iterm.py --fork-current
```

Optional arguments:

- `--label <name>`: use a short unique label; otherwise the helper generates one.
- `--focus`: focus the new tab. By default, restore the previously selected tab.
- `--allow-intercom`: keep the intercom tool enabled.
- `--prompt-file <absolute-path>`: submit the user-supplied task at startup. Write it to a session-scoped temporary file outside tracked files first. Otherwise the fork starts without a prompt.

Do not change directory to the skill directory before invoking the helper: its default checkout is the command's working directory. Do not override `--cwd` for a conversation fork.

The helper reads `PI_SESSION_FILE` from Pi's shell-tool environment and matches the calling iTerm2 session through `ITERM_SESSION_ID`. It fails before creating a tab when these are missing or invalid. It does not guess from the newest session file or the frontmost window. Run it through Pi's `bash` tool, which injects current session metadata.

It creates a tab using iTerm2's default profile and a private temporary launch script, not simulated keystrokes. The script removes itself when it starts; if automation fails before startup, its path is printed for recovery. Pi receives `--fork <source-session>`, `--name <label>`, and, by default, `--exclude-tools intercom`. The source history is copied when the new Pi reads it; subsequent source turns are not synchronized.

## Report and recovery

Report the label, window ID, terminal session ID, checkout, source session, and intercom policy from the JSON response. Explain that the fork has a separate Pi history but shares the checkout.

`state: command-submitted` means iTerm2 accepted the launch command, **not** that Pi is ready or has begun working. Do not claim startup verification. Leave readiness inspection to the user unless they request coordination or troubleshooting.

If the helper fails, preserve any tab created. An automation denial may require enabling iTerm2 control in macOS Privacy & Security > Automation. Do not retry blindly: the tab may exist even if the response was lost. If Pi exits, the tab retains a recovery shell. Use the returned `recoveryCommand` there only after checking that Pi is no longer running; do not type it into an active Pi session.

After launch, detach. Do not use intercom's `openProjectPaneIfMissing` or subagents' `project.open`: those launch paths still depend on Herdr.
