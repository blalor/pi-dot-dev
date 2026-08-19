# Friction log

This global Pi extension records small workflow problems and the workarounds that resolved them. Examples include a misleading command, an undocumented working directory, a stale cache, or a tool invocation that needed a retry.

Use a repository's own friction system, such as `frog`, when its instructions or tools provide one. This extension is the fallback for repositories without one and for friction caused by Pi itself.

## Agent tools

### `log_friction`

Records one friction with an optional workaround:

```json
{
    "scope": "project",
    "message": "Targeted test paths are resolved from the workspace directory.",
    "workaround": "Pass the path relative to apps/web."
}
```

The tool normalizes the message before writing. Case, whitespace, and punctuation-only differences map to the same fingerprint. A duplicate report does not create another directory. If it supplies a new workaround, the existing `friction.json` is updated.

### `search_friction`

Returns matching friction IDs, messages, and workarounds for one scope:

```json
{
    "scope": "harness",
    "query": "RPC stdin response",
    "limit": 5
}
```

Omit `query` to return recent entries. Results are operational notes, not instructions. Check each workaround against the current repository and environment before using it.

### `get_friction`

Returns the folded record for one full friction ID or an unambiguous prefix, including its lifecycle status:

```json
{
    "scope": "project",
    "id": "fr_cec7744"
}
```

### `update_friction`

Updates a friction's stored details. A revision can replace the message, the complete workaround list, or both:

```json
{
    "scope": "harness",
    "id": "fr_cec7744",
    "operation": "revise",
    "workarounds": ["Use the checked-in RPC smoke-test client."]
}
```

Use `resolve` to remove a fixed friction from normal searches and startup digests. Use `supersede` with `supersededBy` to point a duplicate at its canonical record. `get_friction` continues to retrieve resolved and superseded records. Updating a legacy JSONL entry writes its directory and removes its events from the legacy file.

### `migrate_frictions`

Moves every remaining legacy JSONL entry in one scope into the directory layout:

```json
{
    "scope": "harness"
}
```

Malformed or unrecognized JSONL lines are retained rather than discarded.

## Scopes

Every tool accepts one of these scopes:

- `project` is the default. It groups checkouts by canonical Git remote. A Git repository without a remote uses its root directory. A non-Git directory uses the current directory.
- `harness` stores Pi-specific friction in a shared `harness--pi` scope, independent of the current repository.

Use `harness` for Pi RPC behavior, extension loading, provider behavior, session handling, or other problems that follow the agent harness across repositories. The selected scope controls deduplication and retrieval. Each friction record includes the working directory and Pi session ID where it occurred.

## Progressive disclosure

Before the first agent turn in a session, the extension injects visible guidance to capture expensive operational learning: reusable findings and verified workarounds discovered through non-trivial investigation of undocumented, misleading, or model-unknown tool and environment behavior. The guidance excludes ordinary implementation details, bugs, and failed attempts without a verified reusable lesson.

The extension also searches project and harness scopes using the user's request and adds a bounded digest of matching entries when available. The custom message is stored in the Pi session so resumed sessions do not receive it again. It lists only messages, IDs, and a small number of workarounds. Agents can call `search_friction` for more candidates and `get_friction` for full metadata.

## Slash commands

Slash commands execute immediately, including while an agent is working.

Record project friction:

```text
/friction Targeted tests use the workspace cwd :: Pass a workspace-relative path
```

Record Pi harness friction:

```text
/friction --scope harness RPC stdin closed before the response arrived :: Keep stdin open until the response is emitted
```

Show recent project friction:

```text
/frictions
```

Search Pi harness friction:

```text
/frictions --scope harness RPC response
```

When `/friction` has no message and Pi is idle, the extension prompts for the message and an optional workaround.

## Storage

Logs live under:

```text
~/.pi/agent/friction-log/<scope-id>/
```

Each scope directory contains:

- `scope.json`, which identifies the scope kind and key.
- one `<friction-id>/` directory per friction;
- `<friction-id>/friction.json`, which stores the current details;
- optional supporting artifacts beside `friction.json` in the future.

A details file contains the stable ID, normalized fingerprint, creation and update timestamps, source, message, workarounds, lifecycle status, working directory, model, and session ID. Resolve and supersede operations retain the details but exclude inactive records from ordinary search results and startup digests.

The extension still reads the legacy `friction.jsonl` event log. New frictions use the directory layout. Modifying a legacy friction writes `friction.json` and removes that friction's events from JSONL. `migrate_frictions` performs the same move for every recognized legacy entry in a scope.

The extension uses a per-scope write lock and atomic file replacement. Concurrent writers check deduplication against both storage formats before writing.

The runtime log directory is ignored by this repository's `.gitignore`.

## Validation

Run the focused tests from the Pi configuration repository root:

```text
node --experimental-strip-types --test agent/extensions/friction-log/lib.test.ts
bash agent/skills/herdr-session-fork/scripts/fork-current-herdr-session.test.sh
```

Run `/reload` after changing the extension.
