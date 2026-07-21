---
name: pr-plain-english-rewrite
description: Rewrite verbose PR titles, bodies, RFCs, design summaries, or review comments into plain engineer-readable prose. Use when a PR description has jargon, abstract architecture language, unexplained local context, or "word salad" that blocks reviewers from understanding what changes, what applies on merge, and what decisions remain.
---

# PR Plain English Rewrite

Use this skill to turn an over-written PR description into something an engineer can read without session context, private chat history, or a degree in thesaurus abuse.

The result should let a reviewer answer three questions quickly:

1. What changes in this PR?
2. What happens when it merges?
3. What should I review or decide?

## Inputs to collect

Before rewriting, inspect or ask for:

- The existing PR title and body, if available.
- The diff summary or changed files.
- Any non-obvious runtime effect, such as migrations, permissions, feature flags, dependency bumps, config defaults, destructive operations, or external calls.
- Whether the rewritten text is for a PR body, PR comment, RFC summary, or internal note.

Do not preserve the original structure if it hides the point.

## Output shape for PR title and body

Use this default structure:

```markdown
## Suggested PR title

```text
<type>(<scope>): <imperative subject>
```

## Suggested PR body

```markdown
## Why

<The concrete problem this PR addresses.>

## How to read this change

<Define any local terms, tiers, flags, modes, phases, or rollout states in plain English. Skip if none exist.>

## What changes

- <Specific file/resource/behavior change.>
- <Specific file/resource/behavior change.>

## What applies on merge

<Exactly what changes in production or CI when this merges. Say "nothing runtime-facing" if true.>

## What does not happen in this PR

- <Explicit non-goal or deferred item.>
- <Explicit non-goal or deferred item.>

## Before enabling/removing/rolling out <thing>

<Prerequisites, if there is a later switch, flag flip, migration, rollout, or manual action. Skip if none.>

## Reviewer focus

Please check:

- <Actionable review question.>
- <Actionable review question.>
```
```

For a PR comment, keep the same content but omit the outer "Suggested PR body" wrapper if the user wants paste-ready Markdown.

## Title rules

- Follow the repo's PR title convention when one exists.
- Use imperative mood: `add`, `remove`, `fix`, `make`, `stop`.
- Name the changed thing, not the internal journey.
- Prefer boring accuracy over cleverness.
- Avoid vague titles like `RFC`, `admin model`, `cleanup`, `improvements`, or `follow-up`.

## Rewrite rules

### Replace abstract nouns with concrete nouns

Bad:

> Establishes a three-tier governance model for administrative capability alignment.

Better:

> Defines three kinds of GitHub access: org Owner, delegated org admin, and repo admin.

### Say what merges, not what the author hopes happens later

Bad:

> This lays the foundation for future least-privilege administration.

Better:

> On merge, Terraform grants repo-admin access to these teams. It does not change GitHub org Owners.

### Define local terms before using them

Bad:

> Tier 1 is gated, Tier 2 is deferred, and Tier 3 is wired live.

Better:

> This PR uses three access levels:
>
> 1. GitHub org Owner: full org control. Added in Terraform, but turned off.
> 2. Delegated org admin: narrower org-level access. Not implemented here.
> 3. Repo admin: admin access to specific repos. This is what merges now.

### Split policy from implementation

Bad:

> Enforces the owner-management boundary through reviewed infrastructure ownership.

Better:

> The policy proposal is in the RFC. The code in this PR only adds repo-admin grants and a disabled org Owner resource.

### Name the switch

If behavior is gated, name the gate and its current value.

Bad:

> Owner management remains disabled pending sign-off.

Better:

> `manage_github_org_owners = false`, so Terraform creates zero `github_membership` resources.

### State non-goals plainly

Bad:

> Tier 2 remains outside the present scope.

Better:

> This PR does not add delegated org admin roles.

### Preserve risk, remove drama

Bad:

> This prevents unreviewed privilege sprawl and avoids catastrophic governance drift.

Better:

> Today, GitHub org Owner changes happen outside PR review. This PR adds a reviewed Terraform path for those changes later.

## Words and phrases to cut or translate

Cut these unless the repo already uses them as exact product terms:

- foundation
- framework
- governance model
- landing spot
- capability
- alignment
- posture
- ownership boundary
- source of truth, unless naming the actual file or system
- future-proof
- robust
- holistic
- strategic
- architecture
- enablement
- stakeholder
- operating model

Translate common phrases:

| Word salad | Plain English |
|---|---|
| gated Tier-1 | org Owner Terraform code is present but turned off |
| live Tier-3 grants | repo-admin grants apply on merge |
| landing spot | replacement repo access before an Owner downgrade |
| delegated admin | narrower GitHub org role, not full Owner |
| additive-only impact | this grants access but does not remove access |
| drift reconciliation | compare live GitHub state with Terraform |
| machine identity policy | rules for service accounts |

## Required callouts

If any apply, make them explicit in the body:

- Database migration.
- New dependency.
- Dependency or lockfile change.
- Auth or permission behavior change.
- Public API, schema, or contract change.
- Destructive or irreversible operation.
- Feature flag added, removed, reused, or flipped.
- Configuration default change.

Do not bury these in prose. Use bullets.

## Review-question rules

Reviewer questions should be checkable from the diff or from named external facts.

Good:

- "Do these repo-admin grants match the teams that own these repos?"
- "Should the direct grant for `alice` be moved to a team?"
- "Is `enable_widget_sync` safe to turn on in production after this merges?"

Bad:

- "Does this model feel right?"
- "Any thoughts?"
- "Is the architecture acceptable?"

## Tone

- Plain, direct, and specific.
- No hype.
- No executive memo voice.
- No em dashes.
- Short paragraphs.
- Use bullets when the reader needs to compare facts.
- Keep necessary technical terms, but define them once.

## Final self-check

Before returning the rewrite:

1. Can a reviewer say what applies on merge after reading for 30 seconds?
2. Are all local terms defined before use?
3. Did you separate implemented code from deferred decisions?
4. Did you call out permission, dependency, migration, destructive, flag, and config-default changes when present?
5. Did you remove abstract filler that does not name a file, resource, behavior, risk, or decision?
6. Did you avoid em dashes?
