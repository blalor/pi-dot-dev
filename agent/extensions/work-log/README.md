# Work log extension

This Pi extension records compact summaries of meaningful work while the session context is still available. The bundled `work-log-report` command formats those records for a day or date range. It does not read GitHub, Slack, Git, session transcripts, or any source outside the work log.

## Checkpoint behavior

The extension summarizes a work episode at these boundaries:

- 20 minutes after the agent becomes idle
- The next settled boundary after an episode has lasted two hours
- Before context compaction
- When switching or forking a session
- Before navigating the session tree
- During normal session shutdown
- When the user runs `/work-log`

Run `/work-log show` to read a roll-up of work already persisted for the active session. Use `/work-log episodes` for the chronological episode details. These queries read local daily JSONL files directly and do not wait for or call the summary model. They do not include work since the most recent checkpoint.

A new agent request cancels the pending idle checkpoint. Related requests completed within the idle window are summarized as one episode. Shutdown capture is best effort because a killed process cannot finish a model request.

The summarizer returns `SKIP` when the episode contains no meaningful outcome. Skipped ranges still advance the session cursor, so they are not reconsidered later.

Switch, fork, reload, and quit shutdowns do not wait for the summary model. The extension displays a shutdown status, writes a redacted episode snapshot to `_pending`, advances the session cursor, and starts a detached Node worker. The worker runs from the home directory rather than the session working directory, so deleting a checkout after exit does not prevent the summary. Repository facts are marked unavailable if the recorded directory has disappeared.

A successful worker removes its pending snapshot. A failed snapshot remains queued and is retried in the background when a later Pi session starts. If summary-model credentials were not ready when shutdown began, the extension leaves the snapshot for that later retry rather than delaying exit to resolve credentials.

## Storage

Episode records are appended to daily JSONL files:

```text
~/.pi/agent/work-log/
  2026/
    08/
      2026-08-06.jsonl
  _state/
    <session-id>.json
  _pending/
    <episode-id>.json
```

The `_state` files store the last summarized session entry. Temporary `_pending` files hold shutdown work until a detached worker completes it. Both are separate from the daily records consumed by reporting jobs.

Each episode has this shape:

```json
{
  "id": "8d16cf19d6bf13f4c160",
  "startedAt": "2026-08-06T20:42:10.000Z",
  "endedAt": "2026-08-06T21:31:04.000Z",
  "generatedAt": "2026-08-06T21:31:06.000Z",
  "sessionId": "019fd86c-...",
  "cwd": "/Users/example/project",
  "remote": "github.com/example/project",
  "agentModel": "openai-codex/gpt-5.6-sol",
  "fromEntryId": "entry-a",
  "toEntryId": "entry-z",
  "accomplished": ["Added automatic work-episode capture."],
  "decisions": ["Daily aggregation remains a separate scheduled job."],
  "artifacts": ["commit 4ec7ae8"],
  "validation": ["Unit tests and extension loading passed."],
  "blockers": [],
  "next": []
}
```

The stable `id` is derived from the session and entry range. Retrying a checkpoint does not append the same episode twice.

## Reports

The command is exposed on the local `PATH` through `agent/bin/work-log-report`:

```bash
work-log-report today
work-log-report yesterday
work-log-report --since 2026-08-01 --until 2026-08-06
```

With no arguments, it reports today. The date range is inclusive. Markdown is written to standard output, so reports can be saved with shell redirection:

```bash
work-log-report yesterday > ~/work-reports/2026-08-05.md
```

The report groups episodes by their recorded Git remote or working directory, deduplicates identical category items, and lists the contributing session IDs and times. Missing daily files are treated as days with no recorded episodes. Malformed records stop the report with the file and line number.

`work-log-report` is deterministic. It reads only dated JSONL files beneath `~/.pi/agent/work-log/`; it ignores `_state`, makes no model or agent calls, performs no network requests, and does not inspect repositories or session files.

## Model configuration

The persistent `workLog` route in `~/.pi/agent/helper-models.json` selects the summary model. `PI_WORK_LOG_MODEL` temporarily overrides it:

```bash
export PI_WORK_LOG_MODEL="provider/model-id"
```

The route must name an available, authenticated model. Configuration errors do not fall back to the active model. See [`../../helper-models.md`](../../helper-models.md).

Change the idle interval with:

```bash
export PI_WORK_LOG_IDLE_MINUTES=30
```

Invalid or non-positive values use the 20-minute default.

## Privacy

Before sending evidence to the summary model, the extension redacts common credential formats, including bearer tokens, private keys, GitHub tokens, API keys, passwords, and AWS access-key IDs. The model is also instructed not to copy secrets or raw command output.

Pattern-based redaction is not a complete secret scanner. Episode records may contain repository paths, commit subjects, issue references, and short descriptions of private work. Pending shutdown transcripts are redacted, clipped to the same size limit as foreground summaries, stored with owner-only permissions, and deleted after successful processing. Model credentials are passed to the detached worker through a pipe and are not written to the pending file. The `agent/work-log/` runtime directory is excluded from this repository through `.gitignore`.

## Session commands

`/work-log` waits for active agent work to settle, then forces a checkpoint. Normal operation does not require this command.

`/work-log show` immediately displays a deduplicated roll-up of every persisted episode whose session ID matches the active session. Project metadata appears once when the session has one project; sessions containing multiple projects list all projects.

`/work-log episodes` displays the same records chronologically, preserving episode boundaries. It includes per-episode project metadata only when the session spans multiple projects.

Query output is shown in a temporary Markdown widget and is not written to the session history or sent to the model. The widget clears when the next agent request starts. Neither query forces a checkpoint, so unsummarized work in the current episode is not shown.

Run `/reload` after installing or changing the extension.

## Validation

Run the focused tests from the Pi configuration repository:

```bash
node --experimental-strip-types --test \
    agent/extensions/work-log/lib.test.ts \
    agent/extensions/work-log/shutdown-worker.test.mjs \
    agent/extensions/work-log/work-log-report.test.mjs
```
