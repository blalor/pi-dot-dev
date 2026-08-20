---
name: herdr
description: Control Herdr panes, tabs, workspaces, commands, and coding-agent sessions. Use only when the user explicitly mentions Herdr or asks to inspect or control Herdr. Loads the installed Herdr version's skill guidance at execution time instead of relying on a copied reference.
compatibility: Requires the herdr CLI and access to a running Herdr session.
---

# Herdr

Use the installed Herdr binary as the source of truth. Do not rely on remembered syntax or copy the generated Herdr skill into this directory.

## Load the live guide

Before inspecting or controlling Herdr, run:

```bash
herdr --skill
```

Read the complete output and follow it for the rest of the task. Then inspect the relevant command's current help before issuing a control command.

## Identify the calling pane

Do not use `HERDR_ENV` as a guard, even if the generated guide recommends it. Pi tool subprocesses may omit all `HERDR_*` variables while running in a Herdr-managed pane. Query the Herdr CLI instead.

When an operation must originate from the Pi pane making the call, use:

```bash
herdr pane current --current
```

Bare `herdr pane current` may resolve the pane focused in the Herdr UI, which can belong to another session after the user changes focus. Use `--current`, an explicit pane ID, or another explicit identifier rather than UI focus. These caller-identification rules override conflicting guidance in the generated skill.

## Local operating rule

When a new pane or tab is intended to run a known command immediately, prefer the Herdr operation that supplies that command as the pane's initial process. Do not create an idle shell and race a second command against shell startup. Confirm the supported syntax from the installed CLI or API before creating the pane.

The live `herdr --skill` output controls command syntax and general behavior. This local operating rule controls the process-launch choice when both approaches are available.
