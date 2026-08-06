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

The tool normalizes the message before writing. Case, whitespace, and punctuation-only differences map to the same fingerprint. A duplicate report is not appended. If the duplicate supplies a new workaround, the log appends a workaround event to the existing friction ID.

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

Returns the folded record for one full friction ID or an unambiguous prefix:

```json
{
    "scope": "project",
    "id": "fr_cec7744"
}
```

## Scopes

Every tool accepts one of these scopes:

- `project` is the default. It groups checkouts by canonical Git remote. A Git repository without a remote uses its root directory. A non-Git directory uses the current directory.
- `harness` stores Pi-specific friction in a shared `harness--pi` scope, independent of the current repository.

Use `harness` for Pi RPC behavior, extension loading, provider behavior, session handling, or other problems that follow the agent harness across repositories. The selected scope controls deduplication and retrieval. The JSONL record still includes the working directory and Pi session ID where the friction occurred.

## Progressive disclosure

Before the first agent turn in a session, the extension searches both project and harness scopes using the user's request. It injects a bounded digest of matching entries. When no entry matches, it uses recent entries. The digest is stored in the Pi session so resumed sessions do not receive it again.

The digest lists only messages, IDs, and a small number of workarounds. Agents can call `search_friction` for more candidates and `get_friction` for full metadata.

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
- `friction.jsonl`, an append-only event log.

A friction event contains its stable ID, normalized fingerprint, timestamp, source, message, optional workaround, working directory, model, and session ID. Later workaround events refer to the friction ID. Readers fold these events into one logical record.

The extension uses a per-scope write lock. Concurrent writers therefore check deduplication against the latest log state before appending. Existing records from the earlier write-only format remain readable and participate in deduplication.

The runtime log directory is ignored by this repository's `.gitignore`.

## Validation

Run the focused tests from the Pi configuration repository root:

```text
node --experimental-strip-types --test agent/extensions/friction-log/lib.test.ts
```

Run `/reload` after changing the extension.
