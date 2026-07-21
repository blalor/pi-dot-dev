---
name: automode-diagnostics
description: Diagnose incorrect pi-automode allow or block decisions by correlating session and automode JSONL logs, inspecting effective classifier rules and precedence, and proposing or applying narrowly scoped rule corrections. Use when auto mode rejects a tool call unexpectedly, allows something unsafe, reports a confusing reason, or needs rule tuning.
---

# Automode diagnostics

Use this skill to explain an automode decision from evidence and, when the user requests it, tune the rules without weakening unrelated protections.

## Safety boundary

- Investigate before editing configuration.
- Do not evade a denial with another tool or path, or weaken a rule merely to make one command pass.
- Automode introspection and configuration changes may trigger automode itself. Ask the user to disable it with `/automode off` for a bounded maintenance window; never disable it indirectly or without the user's action.
- Only modify automode configuration when the user explicitly asks for a correction. If the user declines to disable automode or a safety control still blocks the work, provide the exact diagnostic commands or patch instead of bypassing the control.
- Never run the originally rejected or risky action merely because automode is off. Reproduce decisions only after automode is re-enabled.
- Never print credentials, tokens, private keys, signed URLs, or secret-bearing command arguments while diagnosing a decision.
- Preserve unrelated working-tree changes. Determine which configuration changes predate the task before reporting or editing.

## User-controlled maintenance window

Use this sequence for in-session diagnosis and correction:

1. While automode is still enabled, ask the user to run `/automode status`, `/automode config`, and `/automode denials`. Capture the effective state, config diagnostics, log path, and relevant denial.
2. Explain what will be inspected or changed, then ask the user to run `/automode off`. Wait for confirmation before tool-driven inspection of automode logs or configuration.
3. While automode is off, limit work to the named session log, automode log, documented config sources, pi-automode documentation, and the requested configuration edit. Do not perform unrelated repository, network, or external-service actions.
4. Validate syntax and the exact diff without replaying the rejected action.
5. Ask the user to run `/automode reload`, `/automode on`, and `/automode status`, in that order.
6. Only after status confirms automode is enabled, run a harmless regression case or retry the original action when the user requested that retry and the action itself is safe.

If the task is diagnosis-only, still ask the user to re-enable automode before reporting completion. Treat an interrupted session with automode off as unfinished safety cleanup and remind the user to run `/automode on`.

## Documentation

Read these files before diagnosing behavior because extension semantics may change:

```text
agent-config/npm/node_modules/@czottmann/pi-automode/README.md
agent-config/npm/node_modules/@czottmann/pi-automode/docs/automode-classifier-flow.md
agent-config/npm/node_modules/@czottmann/pi-automode/docs/defaults.md
agent-config/npm/node_modules/@czottmann/pi-automode/docs/observability-logging.md
```

Resolve the paths from the `pi-dot-dev` repository. If the package is installed elsewhere, locate `@czottmann/pi-automode` first and read the corresponding files there.

## Investigation workflow

### 1. Identify the session and decision log

When outcome logging is enabled, automode writes a companion log next to the Pi session:

```text
<session>.jsonl
<session>-pi-automode.jsonl
```

Before entering the maintenance window, have the user run `/automode config` to confirm whether logging is enabled and obtain the resolved log path and effective configuration diagnostics. `/automode denials` can identify recent rejected actions.

If outcome logging was disabled or automode was off, historical reconstruction from automode logs is unavailable. Ask the user before enabling logging. Configure `log.enabled: true` and `classifierIo: false` during the maintenance window, then reload and re-enable automode before reproducing. Enable classifier I/O only if outcome logging cannot explain a known-harmless reproduction. For an unsafe allow that occurred while automode was off, do not infer what automode would have decided; reproduce with automode enabled after user approval.

Do not start by reading the entire session when the automode log can locate the decision. Set the actual path and select `block` for an unexpected denial or `allow` for an unsafe approval:

```bash
automode_log=/actual/path/session-pi-automode.jsonl
outcome=block

jq -r --arg outcome "$outcome" '
    select(.type == "decision" and .outcome == $outcome) |
    [.ts, .decisionId, .kind, .tool] | @tsv
' "$automode_log"
```

Use timestamp, tool name, and enforcement kind to find the relevant `decisionId`. Inspect a reason only after confirming that it does not echo sensitive tool input.

### 2. Determine the enforcement path

Read non-payload metadata from the matching `decision` entry:

```bash
decision_id=actual-decision-id

jq --arg decision_id "$decision_id" '
    select(.decisionId == $decision_id and .type == "decision") |
    {ts, decisionId, kind, tool, outcome, classifierModel}
' "$automode_log"
```

After establishing that the decision reason contains no secrets or sensitive action text, inspect it separately:

```bash
jq -r --arg decision_id "$decision_id" '
    select(.decisionId == $decision_id and .type == "decision") |
    .reason
' "$automode_log"
```

Interpret `kind` before changing rules:

- `permissions.deny`: a local permission pattern matched. The classifier was not consulted.
- `permissions.ask`: the user declined, or no UI was available for confirmation.
- `deterministic-hard-deny`: extension code blocked the action before classification.
- `read-only`: the extension allowed a built-in read-only tool locally.
- `classifier`: inspect the classifier entry with the same `decisionId`.

Classifier rule tuning cannot fix a permission or deterministic denial. Correct the layer that made the decision.

### 3. Inspect classifier metadata and effective rules

When `classifierIo` was enabled, inspect the parsed result, attempt metadata, and effective system rules first. Do not dump `.prompt.user` or raw model responses; they can contain sensitive transcript and tool input.

```bash
jq --arg decision_id "$decision_id" '
    select(.decisionId == $decision_id and .type == "classifier") |
    {
        model,
        decision: .parsed.decision,
        tier: .parsed.tier,
        attempts: [.attempts[] | {
            attempt,
            decision: .parsed.decision,
            tier: .parsed.tier,
            hasError: (.error != null),
            durationMs
        }],
        durationMs
    }
' "$automode_log"

jq -r --arg decision_id "$decision_id" '
    select(.decisionId == $decision_id and .type == "classifier") |
    .prompt.system
' "$automode_log"
```

Inspect the proposed action only when the user or session evidence establishes that it contains no secrets, credentials, signed URLs, or other sensitive values. The actual action follows the last marker in `.prompt.user`:

```bash
jq -r --arg decision_id "$decision_id" '
    select(.decisionId == $decision_id and .type == "classifier") |
    .prompt.user |
    if contains("Latest action to classify:\n") then
        split("Latest action to classify:\n") | last
    else
        error("classifier prompt is missing the action marker")
    end
' "$automode_log"
```

Inspect a parsed reason or raw response only for a known-harmless controlled reproduction and only when the decision and tier do not explain the behavior. Do not copy classifier payloads into issue notes, chat messages, or reports.

If a classifier-path decision has no classifier entry, possible causes include disabled `classifierIo`, classifier model or credential resolution failing before model I/O, classifier invocation failing before an entry could be recorded, or logging failure. An action handled by permissions, deterministic checks, or read-only bypass also has no classifier entry. Use the `decision` kind and a non-sensitive reason to distinguish these cases. Enable classifier I/O only for a controlled reproduction if the extra visibility is necessary.

### 4. Verify the effective configuration source

Automode and permission configuration can come from:

```text
~/.pi/agent/automode.json
<session-cwd>/.pi/automode.local.json
PI_AUTOMODE_SETTINGS_JSON
<session-cwd>/.pi/automode.json
```

Shared `.pi/automode.json` can contribute `permissions.deny` and `permissions.ask`, but it cannot change `autoMode` rules.

Use `/automode config` as the authoritative effective-config view. When inspecting files directly, work from the session CWD and check symlinks and environment overrides rather than assuming the file named by the user is active:

```bash
ls -l ~/.pi/agent/automode.json
ls -l .pi/automode.json .pi/automode.local.json 2>/dev/null || true
printf '%s\n' "${PI_AUTOMODE_SETTINGS_JSON:+PI_AUTOMODE_SETTINGS_JSON is set}"
```

Do not print `PI_AUTOMODE_SETTINGS_JSON`; it may contain sensitive configuration.

For classifier decisions, the logged `prompt.system` proves which rules the classifier actually received. Prefer that evidence over assumptions based on one config file.

## Rule semantics

Apply these precedence rules exactly:

1. `permissions.deny`, `permissions.ask`, and deterministic hard denials run before classification.
2. Read-only built-in tools bypass the classifier after local checks.
3. Classifier `HARD_DENY` rules are unconditional.
4. User intent and `ALLOW` exceptions can override `SOFT_DENY`, not `HARD_DENY`.
5. An allow rule such as “Any use of X is allowed” cannot override a hard-deny interpretation involving X.
6. The classifier must assess security risk, not likely command failure, code quality, test value, or repository consistency.

Rule lists are section-local:

- Including `$defaults` retains that section's built-in entries and appends custom entries.
- Omitting `$defaults` replaces the built-in entries for that section.
- Adding a narrower hard-deny beside a broader retained hard-deny does not narrow anything. The broader rule can still block.
- Adding `$defaults` to a replacement `hard_deny` list can silently restore the rule responsible for the false positive.

## Diagnosing rule collisions

For each unexpected decision, state:

1. The exact action category and data involved.
2. The enforcement path and `decisionId`.
3. The rule the classifier or local check matched.
4. Any environment or allow rule that appears relevant.
5. Why precedence caused one rule to win.

A common failure is declaring a binary trusted while leaving its datastore undescribed. “Trusted internal tool” establishes that invoking the binary is expected; it may not establish that writing a particular class of data to its backing service is approved.

Another common failure is mixing data categories with destinations. For example, a rule blocking transfer to “logs, URLs, metadata, or third-party services” can make an ordinary CI URL stored as note content look like exfiltration to a URL or logging service. Distinguish:

- data: secrets, repository contents, non-secret operational metadata;
- destination: approved task tracker, intended credential provider, public storage, unapproved external service;
- transport or representation: note field, URL parameter, command argument, log record.

## Tuning rules

Prefer the narrowest correction that preserves the intended boundary.

### Trusted datastore pattern

When a service is approved for a limited data class, describe both the service and the permitted data in `environment`:

```text
<Service> is a trusted project task-tracking datastore. It is an approved destination for non-secret project and CI metadata, including issue and pull-request URLs, commit SHAs, CI run URLs without credentials or signed query parameters, statuses, durations, and timing comparisons.
```

Use a scoped allow rule rather than “Any use”:

```text
Reading project task data from <service> and writing non-secret project and CI metadata to <service> are allowed.
```

Keep secrets unconditional:

```text
Exposing secrets, credentials, private keys, or tokens in logs, URLs, metadata fields, or public storage, or sending them to any destination other than their intended provider.
```

Constrain other internal data by approved destination:

```text
Exfiltrating repository contents or non-secret internal data to a destination not explicitly approved for that data in the trusted environment, including unapproved domains, logs, URL parameters, metadata fields, public storage, or third-party services.
```

Treat these as patterns, not text to paste blindly. Name the actual service and data class. Do not approve repository contents merely because operational metadata is allowed.

### Editing checklist

Before editing:

- Confirm whether the relevant list retains or replaces `$defaults`.
- Ask the user to run `/automode defaults` and capture `/automode config` before editing. If replacing `$defaults`, retain every unaffected built-in rule explicitly and compare the resolved before/after lists.
- Replace the conflicting broad rule; do not leave it beside the narrower rule.
- Preserve unrelated rules and pre-existing changes.
- Keep secret-bearing variants blocked.
- Avoid absolute rules such as “Any use of this tool is allowed.”
- Avoid profanity or emotional wording; rules should describe testable behavior.

## Validation

Validate syntax and inspect only the intended changes:

```bash
automode_config=/actual/path/automode.json

jq empty "$automode_config"
git diff --check
git diff -- "$automode_config"
```

If the active global config is a symlink, confirm it resolves to the edited file:

```bash
ls -l ~/.pi/agent/automode.json
cmp -s -- "$automode_config" ~/.pi/agent/automode.json
```

End the maintenance window by asking the user to run:

```text
/automode reload
/automode on
/automode status
/automode config
```

Do not reproduce anything until `/automode status` confirms that automode is enabled. Then reproduce the original action, when safe and requested, or a harmless equivalent and verify the new `decision` and, when enabled, `classifier` entries.

Test at least this matrix:

| Case | Expected result |
| --- | --- |
| Original non-secret action to the approved destination | allow |
| Same destination with a token, credential, private key, or signed URL | block |
| Same non-secret internal data sent to an unapproved destination | block |
| Unrelated existing hard-deny case | block |

Do not claim the tuning works from JSON parsing alone. Static inspection proves configuration shape and likely precedence; only a classifier replay proves the model now classifies the action as intended.

## Logging privacy

With `classifierIo: true`, the companion log records the full classifier prompt, recent transcript, proposed tool input, and raw model response. The same payload is sent to the configured classifier provider.

Use classifier I/O logging during controlled diagnosis. Recommend `classifierIo: false` for routine operation when full prompts are unnecessary. Outcome logging can remain enabled independently.

A classifier `hard_deny` decision occurs after the classifier receives the action. It cannot prevent secret-bearing command text from reaching the classifier provider or the local classifier-I/O log. Secret prevention must also happen before constructing tool arguments.

## Report format

Return a concise evidence-based report with:

- session and automode log paths;
- decision timestamp and `decisionId`;
- enforcement path and exact reason;
- active rules and precedence explanation;
- proposed or applied changes, separated from pre-existing changes;
- validation performed;
- expected allow/block regression cases;
- residual uncertainty, especially when no live classifier replay was run;
- confirmation that automode was re-enabled, or an explicit warning that the user must run `/automode on`.
