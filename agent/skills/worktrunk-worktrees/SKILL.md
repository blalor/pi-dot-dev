---
name: worktrunk-worktrees
description: Use Worktrunk (`wt`) instead of raw `git worktree` for creating, switching, listing, merging, or removing git worktrees, especially in agent workflows. Load when the user mentions Worktrunk, worktrunk, `wt`, worktrees, parallel agent branches, branch cleanup, or asks why raw `git worktree` was used.
---

# Worktrunk worktrees

Use this skill whenever worktree management is part of the task.

The `pi-worktrunk` extension only updates Worktrunk status markers for Pi lifecycle events. It does not teach the agent how to manage worktrees. This skill is the operational guidance: prefer `wt` for worktree workflows.

## Core rule

Prefer Worktrunk commands over raw `git worktree` commands:

- Use `wt list` instead of `git worktree list` for normal discovery.
- Use `wt switch` instead of manually `cd`-ing between worktrees when practical.
- Use `wt switch --create <branch>` instead of `git worktree add ...` for new task branches.
- Use `wt remove` instead of `git worktree remove` for cleanup.
- Use `wt merge` for local merge/squash/rebase/remove workflows when the user asks to integrate the work locally.

Raw `git worktree` is acceptable only when:

- diagnosing low-level Git metadata problems,
- following an existing repo skill that specifically requires Git internals,
- Worktrunk is unavailable or errors in a way that blocks the task,
- reading Git's raw porcelain output is necessary for a script or test.

When using raw `git worktree` despite this skill, state the reason briefly.

## Initial checks

Before creating, removing, or merging worktrees, inspect Worktrunk state:

```bash
command -v wt
wt list
```

For configuration-sensitive behavior:

```bash
wt config show
```

Use `wt --help` or subcommand help instead of guessing flags:

```bash
wt switch --help
wt remove --help
wt merge --help
wt config --help
```

## Create or switch worktrees

Create a new branch and worktree:

```bash
wt switch --create <branch-name>
```

Create from a specific base:

```bash
wt switch --create <branch-name> --base <base-branch-or-shortcut>
```

Useful shortcuts:

- `^` default branch
- `@` current branch/worktree
- `-` previous worktree
- `pr:<number>` GitHub PR branch
- `mr:<number>` GitLab MR branch

Examples:

```bash
wt switch --create fix-login --base ^
wt switch --create experiment --base @
wt switch pr:123
wt switch -
```

If shell integration is unavailable, `wt switch` may print a path instead of changing the current process directory. In non-interactive agent contexts, use the printed path or run subsequent commands with `-C`/`cwd`.

## List and inspect

Use:

```bash
wt list
```

`wt list` includes branch/worktree status, dirty state, ahead/behind information, marker state, path, commit age, and commit message. In this environment, Pi may mark active work with Worktrunk markers such as `🤖` and idle/waiting sessions with `💬`.

## Remove worktrees

Remove the current worktree:

```bash
wt remove
```

Remove a named branch/worktree:

```bash
wt remove <branch-name>
```

Keep the branch:

```bash
wt remove --no-delete-branch <branch-name>
```

Force removal only with clear user intent or after verifying the dirty/unmerged state:

```bash
wt remove --force <branch-name>      # dirty worktree
wt remove -D <branch-name>           # unmerged branch
wt remove --force -D <branch-name>   # both
```

Prefer `wt remove` because it handles branch deletion rules, hooks, trash/background cleanup, and Worktrunk state.

## Merge local work

When the user asks to integrate a branch locally, prefer:

```bash
wt merge
```

This merges the current branch into the target branch, defaulting to the repository default branch. It may squash, rebase, run hooks, fast-forward the target, and remove the worktree according to Worktrunk configuration.

Common variants:

```bash
wt merge <target-branch>
wt merge --no-remove
wt merge --no-squash
wt merge --no-commit
```

Do not run `wt merge` casually. It can commit, squash, rebase, run hooks, update the target branch, and remove the worktree.

## Agent workflow guidance

For a task that needs an isolated worktree:

1. Run `wt list`.
2. Choose or create a branch with `wt switch --create <branch>`.
3. Continue work in the Worktrunk-created path.
4. Use `wt list` to report status.
5. Use `wt remove` only when cleanup is requested or clearly part of the workflow.

Do not manually invent worktree paths when Worktrunk can compute them from config. This keeps worktrees in the configured location and preserves hooks/status behavior.

## If Worktrunk is missing or insufficient

If `wt` is unavailable:

```bash
command -v wt || true
```

Then explain that Worktrunk is unavailable and fall back to Git only if the task should continue.

If Worktrunk fails, capture the exact command and error. Use raw Git commands only for diagnosis or recovery, not as the default workflow.
