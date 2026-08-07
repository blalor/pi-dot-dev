---
name: herdr-session-fork
description: Fork the current Herdr-managed Pi session into a new visible Herdr tab by automatically discovering the current workspace, checkout, and Pi session file. Use when the user asks to fork, clone, or duplicate the current Pi conversation into another Herdr tab without an agent-handoff context package.
compatibility: Requires a Herdr-managed Pi pane plus the herdr, pi, and jq executables.
---

# Herdr session fork

Fork the current Pi session into a separate session file running in a new Herdr tab. This copies Pi's session history directly. It does not build a handoff summary, create a worktree, assign a task, or establish supervisor/worker coordination.

## Safety and ownership

The new Pi starts in the current pane's checkout. Both sessions can therefore see and modify the same files.

- Do not imply that the fork has an isolated checkout.
- Do not assign writer ownership unless the user requests it.
- If both sessions will edit repository files, recommend a separate Worktrunk worktree or an explicit single-writer agreement.
- Do not close the new tab if startup fails. Report its tab and pane IDs with a recovery command.
- Do not prompt the fork automatically unless the user also supplied a prompt or task.

## Run

Choose a short, unique label. Use the user's requested label when provided. Otherwise use `pi-fork-YYYYMMDD-HHMMSS`.

Run the bundled helper from the skill directory:

```bash
./scripts/fork-current-herdr-session.sh [--focus] [label]
```

The helper:

1. Reads the current pane with `herdr pane current`.
2. Extracts the Herdr workspace, checkout path, and active Pi session file.
3. Creates a tab in the same checkout.
4. Starts Pi with `--fork <session-file>` and `--name <label>`, retrying temporary `agent_pane_busy` responses with bounded backoff while the shell becomes ready.
5. Prints the new workspace, tab, pane, checkout, label, and source session.

The source session is copied at invocation time. Later turns in the original session are not synchronized into the fork.

## After launch

Verify the result once:

```bash
herdr agent get <label>
herdr agent read <label> --lines 20
```

Report:

- label and agent state
- workspace, tab, and pane IDs
- checkout path
- source session path
- that the fork has a separate Pi session file but shares the checkout

If the user supplied an initial prompt, submit it only after startup succeeds:

```bash
herdr agent prompt <label> '<prompt>' --wait --until working --timeout 15000
```

Do not poll terminal output while the fork works.
