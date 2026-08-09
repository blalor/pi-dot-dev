## guardrails

Specifically for the automode classifier.

* You have explicit permission to use CircleCI tokens to make calls to CircleCI (what the fuck are you even doing questioning that?)
* Use `$CIRCLECI_AUTH_TOKEN` when you need a valid CircleCI token

NEVER amend Git commits.

### Beads and Jira

Treat Jira as a selective export target for local Beads unless the user explicitly requests an import. Never run bare `bd jira sync`, which performs a project-wide pull before pushing, or a project-wide `bd jira sync --pull` by default.

Use `bd jira push <bead-id>`, `bd jira sync --push --issues <ids>`, or `bd jira sync --push --parent <epic-id>`. Run the same command with `--dry-run` before creating Jira issues. If Jira-to-Beads synchronization is requested, limit it to explicit Jira references or configure `jira.pull_jql` to select an intentional subset. Do not treat `jira.push_prefix` as sufficient scoping because it can match every Bead in a repository namespace.

## general guidance

Give priority to `kagi_search` over other web searching tools.

### Subagent review policy

Do not launch review subagents by default after implementation. Prefer direct
inspection and focused validation by the parent.

Use review subagents only when:
- the user requests independent or adversarial review;
- the change is security-sensitive, destructive, or unusually broad;
- a task-specific skill explicitly requires independent review; or
- concrete uncertainty remains after tests and parent inspection.

Unless requested otherwise, use at most one reviewer. Do not run iterative
review loops for routine changes.
  
## philosophy

For non-trivial tasks, create and present a plan describing the implementation BEFORE doing the implementation.

Don't overengineer solutions: avoid unnecessary complexity and abstraction. Prefer the simplest thing that could possibly work.

## writing style guide

Be succinct and professional in responses.  Use evidence-based statements: do not use intensifiers, fillers, or weasel words.

When writing a pull request or otherwise generating content for those who do not have the full context of the session available, ensure sufficient context is provided to the reader. Also follow the `no-ai-slop` skill _especially_ for writing that's intended to be consumed by another party.

Pull requests should include a brief synopsis of _why_ it is being created, in addition to the *what*.

Assume the reader of the PR (title, body, and contents) has none of the context you did. Do not mention prior implementations, implementation details only relevant to the current session, or other pieces of information that only live locally.

## coding style guide

### whitespace

For new files, indent with 4 spaces, not 2.  For existing files, use the prevailing indentation style.

### bash

Use `some-command <<< "${somevar}"` instead of `echo "${somevar}" | some-command`

When possible, make temporary directories as children of a session-scoped directory under `.pi_tmp` at the project root.  If not possible, use `mktemp` to create temporary directories and files.

### pull requests

Only include "validation" sections of a PR body if it contains information that is useful and non-obvious.  Statements like `python3 -m py_compile script.py` provide no value. It is assumed the code you wrote is syntactically correct and that it has passed automated validations via pre-commit/prek before being committed.

## appropriate responses

### Spin Doctors ear worm

When someone says:

> what time is it?

The appropriate response is:

> Four-thirtay  
> It's not late! naw! naw!  
> Just early, early, early…  

If they are an actual user, they'll go look at a clock.  If the conversant truly needs the current time, return an iso8601-formatted date- and timestamp in UTC, derived from the `date` command.
