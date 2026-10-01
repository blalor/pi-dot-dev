---
name: agent-handoff
description: Hand repository work from the current Pi session to a visible Pi peer. Use when the user wants an independently inspectable agent session with bounded context transfer, optional Worktrunk isolation, optional pi-intercom supervision, or a structured handoff to an existing reachable peer.
compatibility: Requires pi. Herdr is preferred for visible peer sessions; Worktrunk is preferred when the peer needs an isolated checkout. pi-intercom is optional for supervised handoffs.
---

# Agent Handoff

Hand a bounded task to a visible Pi session. Transfer only the decisions and evidence the peer needs, choose checkout ownership deliberately, and add intercom coordination only when the task needs supervision.

This differs from an ordinary `pi-subagents` worker launch. Use a visible peer when the user wants a long-lived tab they can inspect, focus, and continue independently. Use a normal subagent when a background child and parent-owned lifecycle are sufficient.

## Existing peer handover

Use pi-intercom's `handover` action when the target is already reachable through intercom, including a session on a saved Herdr machine, and a compact model-generated summary is enough. It sends the current state, decisions, changed files, open questions, and the next task without creating a second context artifact.

Do not use `handover` to create checkout isolation, transfer ownership of a shared checkout without an explicit agreement, or replace a handoff contract that requires defined scope, acceptance, and external-action boundaries. Use this skill's spawned-peer path in those cases. For an existing peer that needs those controls, agree on the contract first, then send it with `handover` or `send`.

## Default fast path

Use the fast path when the outcome is bounded, the target repository or PR is known, the work is low risk, and no conversation-only context must be reconstructed:

1. Inspect the current checkout only enough to choose writer ownership.
2. Create a Worktrunk worktree only when parallel writers or a different branch require one.
3. Start one named Pi in a visible Herdr tab.
4. Send a compact prompt containing outcome, scope, acceptance, checkout ownership, and explicitly authorized external actions.
5. Treat successful `agent start` and `agent prompt --wait --until working` responses as startup verification, report the tab and checkout, then detach.

Do not build a context artifact, launch reconnaissance, preflight intercom, read the new terminal, or repeat successful launcher verification on this path. Do not inspect help for commands already specified by this skill unless a command fails or non-default behavior is required.

Use the detailed supervised path below only when the checkout is shared, requirements are ambiguous, conversation history is load-bearing, the task is destructive or externally sensitive, or the user explicitly requests ongoing coordination.

## Handoff contract

Resolve these fields before spawning the visible peer. On the fast path, encode them in a short prompt rather than producing a separate handoff document:

- **Outcome:** the concrete result assigned to the peer
- **Scope:** repository, files, issue, Bead, PR, or investigation boundary
- **Acceptance:** checks and evidence required before the peer stops
- **Checkout:** shared checkout, existing separate checkout, or new Worktrunk worktree
- **Writer:** which session may modify each checkout
- **Context:** established facts, resolved decisions, relevant paths, and known risks
- **Permissions:** local edits, commits, task-tracker updates, and any authorized external actions
- **Withheld actions:** push, PR merge or mutation, deployment, destructive cleanup, task closure, or other actions not authorized by the user
- **Coordination:** stable peer label; add an exact supervisor intercom target only for a supervised handoff

Ask the user only when more than one plausible target or checkout base remains, or when an unresolved decision would change the work materially.

## Choose handoff depth

Default to the fast direct handoff. Escalate to focused reconnaissance or full session transfer only when a prerequisite below is genuinely unresolved.

### Direct handoff, default

Use a direct handoff when the current user request is self-contained or durable sources such as a Bead, issue, PR, branch, or repository instructions contain the context the peer needs. Copy a bounded current request directly into the handoff contract; it does not require transcript transfer. Let the peer perform implementation reconnaissance.

A task being non-trivial, cross-repository, or implementation-heavy does not justify a context-builder by itself. Do not investigate the implementation merely to make the prompt exhaustive. Inspect only enough to choose the checkout, writer, scope, and action boundaries safely.

### Focused reconnaissance

Use focused reconnaissance only when a narrow technical question blocks correct dispatch, such as which repository owns the change, which branch or PR is the right base, or which files define the boundary. Run a fresh-context `scout` with that question. Limit the result to facts needed for routing the task; do not ask it to summarize the session or design the implementation.

### Full session transfer

Use a forked `context-builder` only when conversation history is itself required input, for example:

- the user asks to continue or duplicate the whole current effort in another session
- important decisions or evidence exist only in the transcript
- several investigations, abandoned approaches, or cross-cutting decisions must be preserved
- the peer must continue the supervisor's reasoning rather than take ownership of a bounded task

Do not select full session transfer merely because more context might be useful.

### Latency and duplication guardrails

- A direct handoff should normally reach a working peer within 90 seconds after checkout preparation.
- Focused reconnaissance should have a two-minute runtime limit and an output target of 80 lines or fewer.
- Full session transfer should have a five-minute runtime limit and an output target of 150 lines or fewer unless the user explicitly asks for a larger archival handoff.
- Do not ask a context agent to repeat repository inspection already completed by the supervisor.
- Assign repository investigation to one owner: the supervisor only when needed for safe dispatch, otherwise the visible peer.
- Do not encode the same context in a large artifact and then repeat it in a large prompt. The prompt must stand alone, but artifact references should replace supporting detail rather than duplicate it.

## Choose checkout ownership

A separate worktree is optional.

Use the same checkout only when the peer is read-only, or when writer ownership transfers completely to the peer and the supervisor stops editing project files there until ownership returns.

Create a separate Worktrunk worktree when:

- both sessions may write concurrently
- the peer needs a different branch, PR head, or base
- the supervisor must keep working in the current checkout
- the current checkout is dirty and the peer does not need its uncommitted files
- the task is broad or experimental enough to benefit from isolation

Keep one writer per checkout. Uncommitted files are not copied into a new worktree. Do not stash, discard, or create a commit merely to make dispatch convenient.

When isolation is needed, load and follow the `worktrunk-worktrees` skill. Inspect state first:

```bash
command -v wt
wt list
```

Create the checkout with a new branch:

```bash
if ! wt_output=$(wt switch \
    --create "$branch" \
    --base "$base" \
    --no-cd \
    --format json \
    -y 2>&1); then
    printf '%s\n' "$wt_output" >&2
    exit 1
fi
printf '%s\n' "$wt_output"

checkout_path=$(jq -Rr \
    'fromjson? | select(type == "object" and has("path")) | .path' \
    <<< "$wt_output" | tail -n 1)
```

Worktrunk can print hook progress around its JSON result, so parse it one line at a time with `fromjson?`. Do not silently replace Worktrunk with raw `git worktree` after a failure. Inspect partial state and report the error first.

For an existing pull request, `--base pr:<number>` creates an isolated branch from the PR head. Tell the peer which remote branch a later, explicitly authorized push would update.

## Build optional context

For a direct handoff, do not create an artifact. Reference durable task sources in the prompt and tell the peer what to inspect.

Before focused reconnaissance or full session transfer, list available agents and use only an executable, non-disabled agent:

```typescript
subagent({ action: "list" })
```

### Focused reconnaissance

Ask one routing question and keep the result bounded:

```typescript
subagent({
  agent: "scout",
  task: `Answer only this dispatch question: <narrow question>.

Inspect <explicit repositories or files>. Return at most 80 lines containing:
- the answer
- supporting file paths or external references
- any checkout or scope risk that changes the handoff

Do not design or implement the solution. Do not summarize the session. Do not modify files.`,
  context: "fresh",
  timeoutMs: 120000,
  acceptance: "checked"
})
```

Put the answer directly into the peer prompt. Do not create a separate artifact unless the result contains evidence the peer cannot cheaply recover.

### Full session transfer

Create a session-scoped artifact outside tracked project files. Prefer a project `.pi_tmp` directory when it is already ignored; otherwise use `mktemp`.

Launch a forked context builder only after selecting full session transfer deliberately:

```typescript
subagent({
  agent: "context-builder",
  task: `Build a compact session-transfer handoff for: <task>.

Preserve only conversation-derived information that is not already durable in the referenced Bead, issue, PR, branch, or repository. Write one artifact containing:
- outcome, scope, and non-goals
- established decisions and their evidence
- abandoned approaches the peer must not repeat
- relevant durable sources to inspect rather than restating them
- acceptance checks
- permissions and withheld actions

Keep the artifact at 150 lines or fewer. Do not perform broad repository reconnaissance. Do not modify files. Do not launch other subagents.`,
  context: "fork",
  async: true,
  timeoutMs: 300000,
  output: "<absolute-session-temp-path>/handoff.md",
  outputMode: "file-only",
  acceptance: "checked"
})
```

The peer cannot rely on an artifact that is still being written, so wait for this run:

```typescript
subagent_wait({ id: "<run-id>", timeoutMs: 300000 })
```

Read and check the artifact before using it. A failed context-builder may still leave partial output; inspect it, but do not present the run as successful. If it fails, write only the missing conversation-derived facts yourself rather than rebuilding a full repository report.

The peer prompt must stand alone. Include the artifact path and load-bearing constraints, but do not duplicate the artifact's supporting detail.

For a direct handoff, launch as soon as the handoff contract is resolved. The prompt must include outcome, scope, acceptance, checkout and writer ownership, essential context, permissions, and withheld actions. Add coordination instructions only for a supervised handoff.

## Add intercom only when needed

The fast path does not require an intercom preflight or handshake. The peer can work independently in its visible tab, and the source session detaches after reporting the launch.

For a supervised handoff, load and follow the `pi-intercom` skill, choose a short unique label, and include the supervisor's exact session ID in the prompt. Use:

- `send` for a plan-changing discovery or completion
- `ask` only when a decision or authorization blocks progress
- `reply` to answer an inbound question
- `pending` when more than one peer may be waiting

Call `status` or `list` only when establishing the supervised channel or diagnosing delivery. An `ask` blocks and times out after ten minutes; do not use it for routine progress.

## Spawn the visible peer

### Herdr

Prefer Herdr when the current session has `HERDR_WORKSPACE_ID`. Do not guess a workspace ID.

```bash
command -v herdr
printf 'workspace=%s tab=%s pane=%s\n' \
    "${HERDR_WORKSPACE_ID:-}" \
    "${HERDR_TAB_ID:-}" \
    "${HERDR_PANE_ID:-}"

if [ -z "${HERDR_WORKSPACE_ID:-}" ]; then
    printf 'No current Herdr workspace ID.\n' >&2
    exit 1
fi

tab_json=$(herdr tab create \
    --workspace "$HERDR_WORKSPACE_ID" \
    --cwd "$checkout_path" \
    --label "$label" \
    --no-focus)
printf '%s\n' "$tab_json"

pane_id=$(jq -r '.result.root_pane.pane_id' <<< "$tab_json")
tab_id=$(jq -r '.result.tab.tab_id' <<< "$tab_json")

herdr agent start "$label" \
    --kind pi \
    --pane "$pane_id" \
    --timeout 60000 \
    -- --name "$label"
```

Passing `--name` through Herdr gives Pi a stable visible target and, when used, a stable pi-intercom target.

A newly created tab can briefly exist before its shell is ready. If `herdr agent start` returns `agent_pane_busy`, preserve the tab and inspect it once with `herdr pane get "$pane_id"` and `herdr pane read "$pane_id"`. Retry `herdr agent start` once only if that inspection already shows an interactive shell. Otherwise stop and follow the startup-failure reporting path. Do not add a sleep or polling loop.

### Visible fallback

If Herdr is unavailable, use the visible peer patterns from the `pi-intercom` skill. Prefer a cmux split, then a private tmux socket. Start Pi with `--name "$label"` in `"$checkout_path"`.

Do not silently replace the requested visible peer with a headless subagent. If no visible launcher is available, explain the limitation.

## Prompt the peer

The prompt must stand on its own even when a context artifact exists:

```text
Take ownership of <bounded outcome>.

Checkout:
- Path: <absolute checkout path>
- Branch and base: <branch and base>
- Writer ownership: <peer is sole writer here | read-only>

Context:
- Handoff artifact: <absolute path, when present>
- Relevant task or PR: <identifier and URL>
- Established facts: <short list>
- Preserve: <required behavior>
- Non-goals: <explicit exclusions>

Acceptance:
- <behavior and validation evidence>

Permissions:
- Authorized: <explicit local and external actions>
- Withheld: <push, PR mutation, deployment, task closure, cleanup, etc.>

Coordination (supervised handoff only; omit this block on the fast path):
- Supervisor intercom target: <exact session ID or unique name>
- Send a HANDSHAKE message before editing with cwd, branch, and writer role.
- Use intercom send for plan-changing progress and completion.
- Use intercom ask only when blocked on a decision or authorization.
- Do not create another writer in this checkout.

Read repository instructions and relevant skills before editing. Stop for an unapproved product, API, architecture, scope, destructive, or external-action decision.

On completion, report changed files, commits, commands with results, validation evidence, remaining risks, checkout status, and the exact withheld action needed next.
```

Submit the prompt and wait only for Herdr to observe that work started:

```bash
herdr agent prompt "$label" "$prompt" \
    --wait \
    --until working \
    --timeout 15000
```

A successful `agent start` followed by this successful prompt response is sufficient verification on the fast path. Do not follow it with `agent get`, `agent read`, or `intercom list`.

For a supervised handoff, the peer may send a non-blocking intercom handshake and proceed. Require a blocking `ask` plus supervisor `reply` before editing only when writer ownership is transferring in a shared checkout or action boundaries need explicit acknowledgement.

## Supervise and receive completion

This section applies only when the handoff was explicitly launched as supervised. Otherwise detach after launch and let the user inspect the visible peer.

The peer should use intercom for information that changes what the supervisor needs to know:

- handshake and checkout identity
- plan-changing discoveries
- blocked decisions or authorization requests
- validation failures that change scope
- completion handoff

Reply to blocking questions with `intercom({ action: "reply", ... })`. Do not invent a target when the incoming message already supplies reply context.

Completion does not authorize push, merge, deployment, task closure, worktree removal, or tab closure. The supervisor checks the peer's report and checkout before requesting those actions. If writer ownership was transferred in a shared checkout, explicitly acknowledge its return before the supervisor edits there again.

## Report the dispatch

Tell the user:

- peer label and live state
- launcher and tab or pane IDs
- checkout path, branch, base, and writer ownership
- assigned outcome
- actions deliberately withheld
- context artifact and intercom details only when those mechanisms were used

## Failure handling

- **Focused reconnaissance or context builder fails:** inspect any partial result, add only the missing dispatch-critical facts manually, and report the failed subagent honestly. Do not turn the recovery into a full repository summary.
- **Branch or worktree already exists:** choose a new branch or stop. Never reuse another writer's checkout.
- **Dirty checkout contains required changes:** transfer sole writer ownership or ask for an explicit materialization plan. Do not stash or discard automatically.
- **Worktrunk partially succeeds:** inspect `wt list` before retrying. Do not create a duplicate checkout.
- **Herdr tab creation succeeds but Pi startup fails:** preserve the tab and report its tab and pane IDs plus the recovery command.
- **Pi starts but prompt submission fails:** preserve the session and report the exact retry command.
- **Peer does not appear in intercom:** check `intercom status` and `intercom list`; verify the same-machine Pi session loaded pi-intercom.
- **Intercom ask times out:** do not assume authorization. Re-prompt through the visible launcher or stop the handoff.
- **Two writers touch one checkout:** stop both writers and inspect the diff before continuing.
- **Peer completes:** keep its tab and checkout until the user requests cleanup or the project workflow explicitly requires it.
