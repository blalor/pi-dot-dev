#!/usr/bin/env bash

set -euo pipefail

project_root=$(git rev-parse --show-toplevel)
temporary_root="$project_root/.pi_tmp"
mkdir -p "$temporary_root"
test_directory=$(mktemp -d "$temporary_root/herdr-session-fork-test.XXXXXX")
trap 'rm -rf "$test_directory"' EXIT

fake_bin="$test_directory/bin"
mkdir -p "$fake_bin"
session_file="$test_directory/source-session.jsonl"
: > "$session_file"

cat > "$fake_bin/herdr" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_INVOCATIONS_FILE"

case "$1 $2" in
    "pane current")
        jq -n \
            --arg cwd "$FAKE_CWD" \
            --arg session "$FAKE_SESSION_FILE" \
            '{result:{pane:{workspace_id:"workspace-1",cwd:$cwd,agent_session:{value:$session,agent:"pi"}}}}'
        ;;
    "agent list")
        printf '%s\n' '{"result":{"agents":[]}}'
        ;;
    "tab create")
        printf '%s\n' '{"result":{"root_pane":{"pane_id":"pane-1"},"tab":{"tab_id":"tab-1"}}}'
        ;;
    "agent start")
        attempts=0
        if [[ -f "$FAKE_ATTEMPTS_FILE" ]]; then
            attempts=$(<"$FAKE_ATTEMPTS_FILE")
        fi
        attempts=$((attempts + 1))
        printf '%s\n' "$attempts" > "$FAKE_ATTEMPTS_FILE"
        if ((attempts < FAKE_READY_ATTEMPT)); then
            printf '%s\n' 'agent_pane_busy: pane is not at an interactive shell' >&2
            exit 1
        fi
        printf '%s\n' 'agent started'
        ;;
    "agent get")
        jq -n \
            --arg session "$FAKE_FORK_SESSION_FILE" \
            '{result:{agent:{agent_status:"idle",agent_session:{value:$session}}}}'
        ;;
    *)
        printf 'Unexpected fake herdr invocation: %s\n' "$*" >&2
        exit 1
        ;;
esac
EOF

cat > "$fake_bin/pi" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$fake_bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$FAKE_SLEEPS_FILE"
EOF

chmod +x "$fake_bin/herdr" "$fake_bin/pi" "$fake_bin/sleep"

export PATH="$fake_bin:$PATH"
export FAKE_CWD="$project_root"
export FAKE_SESSION_FILE="$session_file"
export FAKE_ATTEMPTS_FILE="$test_directory/attempts"
export FAKE_SLEEPS_FILE="$test_directory/sleeps"
export FAKE_INVOCATIONS_FILE="$test_directory/invocations"
export FAKE_FORK_SESSION_FILE="$test_directory/fork-session.jsonl"
export FAKE_READY_ATTEMPT=7
: > "$FAKE_FORK_SESSION_FILE"

output=$("$(dirname "$0")/fork-current-herdr-session.sh" test-fork)

[[ $(<"$FAKE_ATTEMPTS_FILE") == 7 ]]
[[ $(<"$FAKE_SLEEPS_FILE") == $'0.25\n0.5\n1\n2\n2\n2' ]]
grep -Fxq 'pane current --current' "$FAKE_INVOCATIONS_FILE"
grep -Fq -- '-- --fork' "$FAKE_INVOCATIONS_FILE"
grep -Fq -- '--exclude-tools intercom' "$FAKE_INVOCATIONS_FILE"
jq -e '
    .label == "test-fork" and
    .workspace == "workspace-1" and
    .tab == "tab-1" and
    .pane == "pane-1" and
    .checkoutShared == true and
    .intercomToolEnabled == false
' <<< "$output" >/dev/null

: > "$FAKE_INVOCATIONS_FILE"
output=$("$(dirname "$0")/fork-current-herdr-session.sh" --allow-intercom test-fork-with-intercom)

if grep -Fq -- '--exclude-tools intercom' "$FAKE_INVOCATIONS_FILE"; then
    printf '%s\n' 'intercom exclusion was passed despite --allow-intercom' >&2
    exit 1
fi
jq -e '.label == "test-fork-with-intercom" and .intercomToolEnabled == true' <<< "$output" >/dev/null

printf '%s\n' 'herdr session fork tests passed'
