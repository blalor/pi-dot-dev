# Memory

This Pi extension stores explicit user- and project-scoped memories and autonomously extracts reviewable candidates from new conversation turns. It does not inject memory into prompts automatically.

## Scope and authority

- `user` applies across repositories. It is intended for explicit preferences, corrections, and stable workflows.
- `project` follows the canonical Git remote, so linked worktrees and separate checkouts share a scope. It is intended for durable decisions and project facts.
- Exact user-message evidence gives a memory user authority. Agent-derived records retain agent authority.

Operational quirks, command surprises, workarounds, and expensive environment discoveries belong in friction logging rather than memory. Current work and accomplishments belong in the work log. Authoritative rules belong in user-controlled context files such as `AGENTS.md`.

## Tools

- `remember_memory` explicitly writes an active memory through a visible tool call.
- `search_memory` performs bounded lexical retrieval across approved user and current-project memories.
- `get_memory` returns a full record with provenance.
- `revise_memory` updates a memory through a visible tool call.
- `forget_memory` marks a memory forgotten without deleting its audit record.
- `review_memory_candidate` approves or rejects an extracted candidate.

## Autonomous extraction

After each settled agent run, the extension sends only new user and assistant text messages to a configured helper model. Tool results and fetched external content are excluded. Assistant messages provide context but cannot be candidate evidence.

Autonomous candidates are deliberately limited to explicit standing preferences and stable workflows from user messages. The evidence must itself contain a durability signal such as “I prefer,” “always,” “going forward,” or “remember that.” Feature requirements, implementation decisions, capability lists, and repository facts are rejected; exceptional project facts or decisions can still be saved explicitly with `remember_memory`.

Extraction produces pending candidates, never active memories. Review them with:

```text
/memory candidates
/memory approve <candidate-id>
/memory reject <candidate-id>
```

The persistent `memory` route in `~/.pi/agent/helper-models.json` selects the extraction model. `PI_MEMORY_MODEL=provider/model-id` temporarily overrides it. The route must name an available, authenticated model; configuration errors do not fall back to the active model. See [`../../helper-models.md`](../../helper-models.md).

## Storage

```text
~/.pi/agent/memory/
  user/<memory-id>/memory.json
  projects/<project-scope>/<memory-id>/memory.json
  _candidates/<candidate-id>/candidate.json
  _state/<session-id>.json
```

Files use owner-only permissions and atomic replacement. Common credential patterns are redacted before helper-model calls and persistence. Pattern matching is not a complete secret scanner.

## Current limits

- Search is lexical; there are no embeddings or vector database.
- Candidate deduplication normalizes exact statements but does not merge paraphrases.
- Candidate extraction uses a model and can miss memories or propose poor ones. Review is the quality boundary.
- There is no automatic recall or context injection.
- Existing session history is not backfilled automatically.

See [`DESIGN.md`](DESIGN.md) for design constraints, implemented phases, and the plan beyond autonomous extraction.
