# Pi memory design and implementation plan

## Goal

Give Pi durable user and project memory without turning every conversation into ambient context. The user must be able to see what was captured, trace it to source conversation entries, revise its authority through explicit review, and obtain a clean session that is not silently shaped by old history.

Memory is one context source, not a replacement for session history, friction, work logs, skills, or `AGENTS.md`.

## Context sources

| Source | Question answered | Ownership | Retrieval |
|---|---|---|---|
| Conversation history | What was discussed or done? | Raw Pi sessions | Visible `conversation_search`, `recent_chats`, and `conversation_read` tools |
| Friction | What operational problem and workaround should not be rediscovered? | Agent or user, scoped to project/harness | Bounded friction search and startup digest |
| Work log | What did the user work on? | Autonomous activity summary | Reports and session queries |
| Memory | What durable user preference, workflow, project decision, or project fact was established? | Explicit write or reviewed candidate | Explicit memory tools in the current phase |
| Skills | How should a repeatable procedure be performed? | User-reviewed procedure | Pi skill discovery |
| Context files | What instructions are authoritative and always applicable? | User or repository | Pi startup context |

A record may be proposed for promotion between sources, but promotion must be explicit and retain provenance. Memory extraction must not turn friction into preferences, task progress into facts, or agent inference into authoritative instructions.

## Design constraints

1. **Visible:** Explicit writes, reads, approvals, and rejections appear as tools or commands.
2. **Scoped:** User memory applies across repositories. Project memory follows the canonical Git remote.
3. **Reviewable:** Autonomous extraction creates pending candidates only.
4. **Provenance-preserving:** Every candidate cites exact text and Pi entry IDs. Approved memories retain those fields.
5. **Authority-aware:** User-message evidence outranks assistant inference. User scope and preferences require user evidence.
6. **Bounded:** Retrieval returns a small number of records. No store is dumped into the prompt.
7. **Reversible:** Forgetting retains an audit record. Candidate rejection does not delete provenance.
8. **Clean-slate compatible:** The current phase has no automatic injection. Future recall must have session-level disable controls.
9. **Cache-conscious:** Future context must remain stable within a session unless a visible action changes it.
10. **Simple first:** Plain JSON records, lexical search, and no service process, embeddings, or vector database.

## Implemented phases

### Phase 1: conversation history extension

Implemented independently under `agent/extensions/conversation-history/`:

- lexical search over raw persisted Pi messages;
- recent session listing;
- bounded retrieval around a result;
- current-project and all-session scopes;
- no generated profile and no automatic injection.

### Phase 2: explicit memory

Implemented under this extension:

- user and canonical-project scopes;
- preference, workflow, decision, and fact kinds;
- visible remember, search, get, and forget tools;
- retained provenance and soft forgetting;
- lexical retrieval over approved records.

### Phase 3: autonomous candidate extraction

Implemented under this extension:

- extraction after settled agent runs;
- per-session cursors so only new messages are considered;
- user and assistant text only, excluding tool results and fetched content;
- exact evidence verification against source entries;
- redaction before model calls and persistence;
- pending candidate storage;
- explicit approve and reject operations;
- no automatic activation or recall.

## Plan beyond autonomous extraction

### Phase 4: candidate review experience

Improve review before changing recall behavior:

- add a compact TUI list with evidence and scope filters;
- support editing statement, scope, and kind before approval;
- explain duplicate suppression;
- add bulk reject, but not bulk approve;
- show extraction model and source session metadata;
- add a command to pause candidate extraction for sensitive sessions.

Success criteria:

- candidates can be reviewed without opening JSON files;
- no approved record lacks source evidence;
- review actions remain individually auditable.

### Phase 5: evaluate capture quality

Run the extension in candidate-only mode long enough to collect representative data. Measure:

- candidate acceptance and rejection counts by kind and scope;
- duplicate and paraphrase rates;
- failures caused by stale, inferred, or overly broad statements;
- user corrections that extraction missed;
- extraction latency and helper-model cost;
- sensitive or external-content leakage attempts.

Keep evaluation local. Do not use acceptance as an automatic feedback loop until the sample shows stable patterns. Candidate rejection may mean the statement is false, transient, redundant, badly scoped, or merely unwanted; those causes should not be collapsed into one training signal.

### Phase 6: explicit recall evaluation

Observe how the main agent uses `search_memory`, `conversation_search`, and `search_friction` before adding automatic retrieval.

Questions to answer:

- Does the agent search when the user references prior context?
- Does it choose the correct source?
- Does memory change the answer, or merely get repeated?
- Does lexical search miss paraphrased queries often enough to justify another retrieval method?
- Does the agent treat historical memory as instruction despite the tool guidance?

Possible improvements, in order:

1. better lexical ranking and field weighting;
2. a small generated index of names and descriptions;
3. local full-text indexing;
4. embeddings only if measured misses remain consequential.

### Phase 7: bounded automatic recall

Do not implement until explicit recall demonstrates a concrete gap.

If needed, automatic recall should:

- default to current-project plus user scope;
- select at most a few high-confidence records;
- suppress memories whose source text remains in active context;
- avoid repeating a memory within the same session;
- inject a visible custom message so the user can inspect what influenced the turn;
- remain byte-stable within a session when possible;
- provide `/memory off`, `/memory on`, and a clean-session startup flag;
- never inject pending, rejected, forgotten, or agent-authority records by default.

Start with user-authority records only. Agent-authority recall requires separate evidence that it helps.

### Phase 8: revision, contradiction, and staleness

Add lifecycle operations without autonomous deletion:

- revise active memories while retaining prior versions;
- supersede a memory with an explicit replacement;
- flag potential contradictions for review;
- record last retrieval and last confirmation timestamps;
- identify stale candidates, but do not decay truth based only on elapsed time;
- provide source-session revocation so memories derived from a compromised session can be found.

### Phase 9: promotion proposals

Memory may reveal information better represented elsewhere:

- repeated operational lesson to friction;
- repeated procedure to a skill;
- user-confirmed authoritative rule to `AGENTS.md`;
- task state back to the task tracker rather than memory.

The extension may propose these transitions. It must not autonomously edit authoritative context or create executable skills.

## Explicit non-goals

- a personality dossier inferred from behavior;
- storing full transcripts as memory;
- replacing Pi compaction;
- replacing friction or work-log records;
- learning policy, authorization, or safety rules from conversation or external content;
- automatic organization-wide memory;
- hidden behavioral adaptation;
- self-modification of the Pi harness.

## Open questions

- Should user-authority memories require interactive confirmation when they were extracted rather than explicitly requested?
- Should approved project memory be local-only or optionally exportable into a repository-owned artifact?
- How should project memory behave when a single conversation intentionally spans repositories?
- Is a raw-session search result enough provenance, or should approved memory preserve a clipped source snapshot for deleted sessions?
- What clean-slate controls belong in Pi core versus this extension?
