# Work log extension

This Pi extension records compact summaries of meaningful work while the session context is still available. The bundled `work-log-report` command formats those records for a day or date range. It does not read GitHub, Slack, Git, session transcripts, or any source outside the work log.

## Checkpoint behavior

The extension summarizes a work episode at these boundaries:

- 20 minutes after the agent becomes idle
- The next settled boundary after an episode has lasted two hours
- Before context compaction
- Before switching, forking, or navigating the session tree
- During normal session shutdown
- When the user runs `/work-log`

A new agent request cancels the pending idle checkpoint. Related requests completed within the idle window are summarized as one episode. Shutdown capture is best effort because a killed process cannot finish a model request.

The summarizer returns `SKIP` when the episode contains no meaningful outcome. Skipped ranges still advance the session cursor, so they are not reconsidered later.

## Storage

Episode records are appended to daily JSONL files:

```text
~/.pi/agent/work-log/
  2026/
    08/
      2026-08-06.jsonl
  _state/
    <session-id>.json
```

The `_state` files store the last summarized session entry. They are separate from the daily records consumed by reporting jobs.

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

The default summary model is `openai-codex/gpt-5.4-mini`. Override it with a fully qualified model ID:

```bash
export PI_WORK_LOG_MODEL="provider/model-id"
```

The extension does not fall back to the active agent model when the configured model is unavailable. This prevents an invalid configuration from silently using a more expensive model.

Change the idle interval with:

```bash
export PI_WORK_LOG_IDLE_MINUTES=30
```

Invalid or non-positive values use the 20-minute default.

## Privacy

Before sending evidence to the summary model, the extension redacts common credential formats, including bearer tokens, private keys, GitHub tokens, API keys, passwords, and AWS access-key IDs. The model is also instructed not to copy secrets or raw command output.

Pattern-based redaction is not a complete secret scanner. Episode records may contain repository paths, commit subjects, issue references, and short descriptions of private work. The `agent/work-log/` runtime directory is excluded from this repository through `.gitignore`.

## Manual checkpoint

`/work-log` waits for active agent work to settle, then forces a checkpoint. Normal operation does not require this command.

Run `/reload` after installing or changing the extension.

## Validation

Run the focused tests from the Pi configuration repository:

```bash
node --experimental-strip-types --test \
    agent/extensions/work-log/lib.test.ts \
    agent/extensions/work-log/work-log-report.test.mjs
```
