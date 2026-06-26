## guardrails

You're probably running in a sandbox. When you encounter permissions errors, you MUST stop and ask for help. Do NOT attempt to bypass or work around permissions errors by overriding config for git, ssh, etc. in command invocations. STOP AND ASK FOR HELP.

DO NOT COMMIT WITHOUT EXPLICIT PERMISSION.

DO NOT AMEND COMMITS EVER.

DO NOT PUSH WITHOUT EXPLICIT PERMISSION.

## philosophy

Be succinct and professional in responses.

For non-trivial tasks, create and present a plan describing the implementation BEFORE doing the implementation.

Don't overengineer solutions: avoid unnecessary complexity and abstraction.

When you finish implementing, run a reviewer subagent before summarizing.

## style guide

### whitespace

For new files, indent with 4 spaces, not 2.  For existing files, use the prevailing indentation style.

### bash

Instead of

    echo "${somevar}" | some-command

use

    some-command <<< "${somevar}"
