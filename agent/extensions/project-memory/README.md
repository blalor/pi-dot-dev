# Project memory

This extension reconciles work-log episodes into proposed updates to project knowledge. A batch job prepares changes; an interactive review accepts, edits, rejects, or defers them. Generation never updates accepted memory.

The work log remains historical evidence. Project memory contains accepted current understanding, including scoped decisions, hypotheses, known issues, and open questions. It is not an instruction file and is not automatically injected into agent prompts.

## Getting started

Reload Pi, then enroll a project from its checkout:

```text
/reload
/project-memory init
```

The project identity comes from the preferred Git remote, using `origin` when available. SSH and HTTPS remotes normalize to the same identity. Worktrees with the same remote share memory. Without a remote, supply an explicit identity:

```text
/project-memory init local/ideas
```

Explicit enrollment records the current directory for matching episodes without remotes. Repeat enrollment from another local directory to associate it with the same identity. Episodes that have a remote are always matched by that remote, not by directory.

Prepare an initial batch outside Pi:

```bash
project-memory propose --all
```

Then review it in Pi:

```text
/project-memory review
```

For an explicitly named project, append its identity to any Pi subcommand, for example `/project-memory review local/ideas`.

Enrollment and scheduling are separate, explicit actions. Installing or reloading the extension does not enroll repositories, run a model, or install a scheduled job.

## Storage

Runtime data lives outside checkouts and is excluded from the Pi configuration repository:

```text
~/.pi/agent/project-memory/
    github.com/owner/repository/
        current.md
        state.json
        proposals/
            pending/
                <proposal-id>.md
            reviewed/
                <proposal-id>.md
        transaction.json          # Present only during an unfinished update
```

`current.md` contains accepted items with stable IDs and HTML boundary markers. Each generated item has Kind, Status, Scope, and evidence references. Updates replace the item with the same ID. Resolved or superseded conclusions should preserve their relevant history and rationale.

Each proposal is a readable Markdown document containing before/after text, rationale, uncertainty, source references, and per-change review decisions. An embedded JSON comment holds its machine representation. Do not edit proposal files directly; review rejects changes that disagree with that representation. Use the review editor instead.

Evidence identifies the work-log episode, daily JSONL file and line, Pi session ID, and entry range. These are provenance references, not a claim that generation inspected the original transcript, repository, or linked artifact. Source files must remain available to inspect the underlying evidence.

`state.json` records the enrolled identity, local directories, processed episode IDs, and a monotonically increasing revision. Every generation or review update advances that revision, so returning to an earlier cursor cannot make an old in-flight generation result valid again. An episode is processed only after its proposal and cursor have been saved together. A batch with no proposed changes is also archived so it is not reconsidered on every run.

There is at most one pending proposal per project. Additional generation waits for its review; deferred changes remain pending. This deliberately bounds the review backlog, but also delays newer episodes until the proposal is reviewed or refreshed.

## Review

`/project-memory review` opens a full-window, top-aligned read-only document showing the before/after text, rationale, uncertainty, and evidence. The action bar stays at the bottom of the window, including for short proposals. Actions are available directly; there is no preview to edit or submit. Scroll with Up/Down, PgUp/PgDn, Home/End, or the mouse wheel.

- **a: Accept:** apply the proposed item.
- **e: Edit and accept:** open an editor for the replacement item, then confirm it. Retain Kind, Status, and Scope lines. Original proposed text and applied text are recorded separately; evidence references are retained. This is the only action that opens an editor.
- **r: Reject:** leave memory unchanged and record a required reason.
- **d: Defer:** immediately leave the item pending and advance to the next item. No editor or reason prompt is required. Deferred items are skipped for the rest of this review session and revisited on a later `/project-memory review`.
- **q or Escape: Stop review:** leave remaining changes pending.

If every remaining item was deferred in this session, review ends without presenting those items again. RPC clients receive a single read-only selector containing the preview and actions instead of a custom terminal screen; clients must display the full selector text to show all evidence.

Review decisions have an append-only history. Deferring and later accepting a change retains both decisions. Refresh records supersession separately rather than replacing the original decision, reason, or timestamp. Edits, rejections, and deferrals are supplied to subsequent generation. This helps the model avoid repeating a rejected inference; it is not a semantic guarantee that every future paraphrase will be detected.

Acceptance checks the proposal version and accepted-memory hash again after the dialog. A stale proposal cannot overwrite newer memory. After accepting one change, remaining independent changes in that proposal expect the resulting memory hash.

Use `/project-memory refresh` to archive unreviewed changes as superseded and regenerate against current memory. Previously accepted changes and review decisions remain recorded. The covered episodes are reconsidered. If regeneration fails, a later batch can retry them.

Review requires interactive Pi or an RPC client that supports extension UI dialogs. No model-callable approval tool or CLI approval command is registered.

## Batch generation

```bash
project-memory init github.com/owner/repository
project-memory init local/ideas /absolute/path/to/ideas
project-memory list
project-memory show github.com/owner/repository
project-memory pending github.com/owner/repository
project-memory propose github.com/owner/repository
project-memory propose github.com/owner/repository --refresh
project-memory propose --all
```

Filesystem and other unsupported remote identities are skipped with a warning. They are not matched by directory, and their presence does not stop unrelated projects from being processed.

`propose --all` only visits enrolled projects. A failed project does not prevent other enrolled projects from being processed; the command exits unsuccessfully if any project failed.

Each batch reads up to 20 unprocessed episodes within a 60,000-character episode budget. Generated output is limited to 12 changes. The input includes accepted memory and prior edits/rejections, with a total limit of 180,000 characters. Oversized input fails visibly instead of silently truncating evidence. A model failure or invalid output does not advance the cursor.

Early work-log records without an `id` receive a stable in-memory identity derived from their session and entry range, using the current work-log writer's ID function. Source files are not rewritten, and duplicates with a later ID-bearing copy are deduplicated. Missing session/range fields and invalid explicit IDs still fail with a source file and line number.

Only persisted daily work-log records are read. Pending work-log snapshots, raw transcripts, repositories, Slack, and GitHub are not queried. Generated evidence IDs must refer to supplied episodes. The model is instructed to distinguish reports from verified facts, preserve scope, and avoid treating a newer statement as automatically authoritative. Human review is still required to judge those conclusions.

Generation uses the existing `workLog` route in `~/.pi/agent/helper-models.json`. `PI_PROJECT_MEMORY_MODEL=provider/model-id` overrides it for the process. There is no active-session model fallback. The standalone job uses Pi's normal model runtime and stored credentials; it does not load user extensions or grant the model tools.

## Scheduling

On macOS, after enrolling at least one project:

```bash
project-memory schedule install
project-memory schedule status
```

This installs a per-user LaunchAgent that runs `project-memory propose --all` at a daily interval while the user is logged in. It does not start an immediate batch or wake a sleeping computer. The job uses absolute Node and script paths, not an interactive shell or its PATH. Remove and reinstall it if the Node executable moves.

The installed file is `~/Library/LaunchAgents/com.blalor.pi-project-memory.plist`. Output and failures go to `_schedule.stdout.log` and `_schedule.stderr.log` in the project-memory root. Check these logs and `/project-memory status`; background failures do not currently send notifications. Shell-only environment overrides are not inherited by launchd, so configure the persistent helper route for scheduled runs.

Remove the schedule without deleting memory:

```bash
project-memory schedule remove
```

On other systems, schedule `project-memory propose --all` using the local scheduler. Scheduling is not required for manual batches.

## Recovery and privacy

Cross-process project locks serialize filesystem updates. Locks use a reserved `_lock` directory inside each project rather than a sibling name that could collide with another project identity. Generation runs outside the lock, then verifies that memory and bookkeeping have not changed before saving its result. A concurrent review or batch causes the stale result to fail rather than overwrite newer state. An abandoned lock becomes recoverable after its stale interval.

A write-ahead `transaction.json` makes proposal/cursor saves and memory/review updates recoverable across process interruption. The next project operation completes an interrupted update idempotently. Unexpected manual edits cause recovery to stop rather than overwrite them. This is local process-crash recovery, not a replicated storage or power-loss guarantee.

Files are created with owner-only permissions. Inputs and generated text pass through the work log's credential-pattern redactor before being sent or persisted. That redactor is not a complete secret or personal-information scanner. Model calls send project summaries, accepted memory, and review feedback to the configured provider. Inspect the provider and its data policy before enrollment.

Accepted memory and reviewed proposals can contain private project information. Keep backups of the project-memory directory as well as the source work log. External editors do not participate in project locks: do not manually edit files while a batch or review operation runs. Do not rename item markers while a proposal is pending; refresh after intentional manual edits to accepted memory.

## Commands and validation

Pi commands: `/project-memory help|init|status|show|propose|review|refresh [identity]`.

`status` and `show` use a temporary widget. They do not inject accepted memory or pending proposals into the model conversation. To use memory during a task, explicitly ask the agent to read the project's `current.md`.

From the Pi configuration repository:

```bash
node --experimental-strip-types --test agent/extensions/project-memory/*.test.*
npm run check:extensions
npm run test:rpc -- --extension agent/extensions/project-memory/index.ts --command '/project-memory help'
```

The review transport test uses the same RPC smoke harness with `--ui-responses <json-file>` to answer its expected dialogs. It uses an isolated home directory and synthetic proposals, then verifies that deferral advances to the next item without an editor or input dialog.
