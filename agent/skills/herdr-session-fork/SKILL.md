---
name: herdr-session-fork
description: Fork the current Herdr-managed Pi session into a new visible Herdr tab by automatically discovering the current workspace, checkout, and Pi session file. Use when the user asks to fork, clone, or duplicate the current Pi conversation into another Herdr tab without an agent-handoff context package.
compatibility: Requires a Herdr-managed Pi pane plus the herdr, pi, and jq executables.
---

# Herdr session fork

Fork the current Pi session into a separate session file running in a new Herdr tab. This copies Pi's session history directly. It does not build a handoff summary, create a worktree, assign a task, or establish supervisor/worker coordination.

The bundled helper is the default compatibility boundary. Invoke it directly without loading the general Herdr skill, printing `herdr --skill`, or inspecting help for the commands it wraps. Read [`../herdr/SKILL.md`](../herdr/SKILL.md) and inspect live command help only when the helper fails, recovery requires a manual Herdr command, or the user requests behavior the helper does not expose.

## Safety and ownership

The new Pi starts in the current pane's checkout. Both sessions can therefore see and modify the same files.

- Do not imply that the fork has an isolated checkout.
- Do not assign writer ownership unless the user requests it.
- If both sessions will edit repository files, recommend a separate Worktrunk worktree or an explicit single-writer agreement.
- Do not close the new tab if startup fails. Report its tab and pane IDs with a recovery command.
- Do not prompt the fork automatically unless the user also supplied a prompt or task.

## Independent-session boundary

A fork is an independent continuation, not a delegated child or intercom peer.

- The source session must detach after launch. Do not monitor the fork, wait for it, read its terminal, or contact it through intercom unless the user explicitly requests coordination.
- The fork must not contact the source session through intercom merely because the copied transcript identifies it. It should continue independently from the copied conversation.
- The helper disables the fork's `intercom` tool by default. Use `--allow-intercom` only when the user explicitly requests inter-session coordination.
- A user-supplied initial prompt may be delivered through `herdr agent prompt`; that does not establish an ongoing supervisor relationship.

## Run

Choose a short, unique label. Use the user's requested label when provided. Otherwise let the helper generate `pi-fork-YYYYMMDD-HHMMSS`.

Run the bundled helper from the skill directory as the first operational command. Do not reproduce its discovery or startup checks beforehand:

```bash
./scripts/fork-current-herdr-session.sh [--focus] [--allow-intercom] [label]
```

The helper:

1. Reads the calling pane with `herdr pane current --current`.
2. Extracts the Herdr workspace, checkout path, and active Pi session file, falling back to `HERDR_WORKSPACE_ID`, `PWD`, and `PI_SESSION_FILE` when newer Herdr pane responses omit session metadata.
3. Creates a tab in the same checkout.
4. Starts Pi with `--fork <session-file>`, `--name <label>`, and `--exclude-tools intercom` unless explicitly allowed. It retries temporary `agent_pane_busy` responses with bounded backoff while the shell becomes ready.
5. Reads the new agent metadata with `herdr agent get`. A successful `agent start` already establishes that Herdr detected the agent and found it ready.
6. Prints the agent state, new workspace, tab, pane, checkout, fork session, label, source session, and intercom tool policy as JSON.

The source session is copied at invocation time. Later turns in the original session are not synchronized into the fork.

## Failure recovery

If the helper fails, preserve any tab it created and use the recovery command it prints. Only then load the general Herdr skill, run `herdr --skill`, and inspect help for the specific recovery command. Do not perform broad Herdr discovery for an error that the helper already diagnosed.

## After launch

The helper performs startup verification. Report its JSON fields:

- label and agent state
- workspace, tab, and pane IDs
- checkout path
- source session path
- that the fork has a separate Pi session file but shares the checkout
- whether intercom was disabled for the fork

If the helper exits after creating a tab, do not close it. Report the tab and pane IDs and the recovery command printed by the helper.

If the user supplied an initial prompt, submit it only after startup succeeds:

```bash
herdr agent prompt <label> '<prompt>' --wait --until working --timeout 15000
```

This returns after Herdr observes the fork begin working; it does not wait for the turn to finish. After submission, detach from the fork. Do not poll terminal output or use intercom while it works.
