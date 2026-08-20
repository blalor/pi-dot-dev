#!/usr/bin/env bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: fork-current-herdr-session.sh [--focus] [--allow-intercom] [label]

Fork the Pi session in the current Herdr pane into a new Herdr tab.

Options:
    --focus          Focus the new tab after creating it.
    --allow-intercom Keep the intercom tool enabled in the fork.
    -h, --help       Show this help.
EOF
}

focus=false
allow_intercom=false
label=""

while (($# > 0)); do
    case "$1" in
        --focus)
            focus=true
            ;;
        --allow-intercom)
            allow_intercom=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --*)
            printf 'Unknown option: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
        *)
            if [[ -n "$label" ]]; then
                printf 'Only one label may be supplied.\n' >&2
                usage >&2
                exit 2
            fi
            label=$1
            ;;
    esac
    shift
done

for command in herdr pi jq; do
    if ! command -v "$command" >/dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$command" >&2
        exit 1
    fi
done

if [[ -z "$label" ]]; then
    label="pi-fork-$(date -u +%Y%m%d-%H%M%S)"
fi

if ! current=$(herdr pane current --current); then
    printf 'Could not inspect the current Herdr pane.\n' >&2
    exit 1
fi

# Newer Herdr responses may omit agent_session from pane current. Prefer pane
# metadata when present, then fall back to the environment exported to Pi.
workspace=$(jq -er '.result.pane.workspace_id // empty' <<< "$current" 2>/dev/null || true)
cwd=$(jq -er '.result.pane.cwd // empty' <<< "$current" 2>/dev/null || true)
session_file=$(jq -er '.result.pane.agent_session.value // empty' <<< "$current" 2>/dev/null || true)
agent_kind=$(jq -er '.result.pane.agent_session.agent // .result.pane.agent // empty' <<< "$current" 2>/dev/null || true)

workspace=${workspace:-${HERDR_WORKSPACE_ID:-}}
cwd=${cwd:-${PWD:-}}
session_file=${session_file:-${PI_SESSION_FILE:-}}
agent_kind=${agent_kind:-pi}

if [[ -z "$workspace" ]]; then
    printf 'Could not determine the Herdr workspace from pane metadata or HERDR_WORKSPACE_ID.\n' >&2
    exit 1
fi

if [[ -z "$cwd" || ! -d "$cwd" ]]; then
    printf 'Could not determine a valid checkout from pane metadata or PWD: %s\n' "$cwd" >&2
    exit 1
fi

if [[ "$agent_kind" != "pi" ]]; then
    printf 'The current Herdr pane is not running Pi; detected: %s\n' "$agent_kind" >&2
    exit 1
fi

if [[ -z "$session_file" ]]; then
    printf 'Could not determine the Pi session file from pane metadata or PI_SESSION_FILE.\n' >&2
    exit 1
fi

if [[ ! -f "$session_file" ]]; then
    printf 'Current Pi session file does not exist: %s\n' "$session_file" >&2
    exit 1
fi

if ! agents_json=$(herdr agent list); then
    printf 'Could not list Herdr agents; label uniqueness was not checked.\n' >&2
    exit 1
fi

if ! jq -e '.result.agents | type == "array"' <<< "$agents_json" >/dev/null; then
    printf 'Herdr returned an unexpected agent-list response.\n' >&2
    exit 1
fi

if jq -e --arg label "$label" \
    '.result.agents[] | select(.name == $label)' <<< "$agents_json" >/dev/null; then
    printf 'A Herdr agent already uses label %s. Choose another label.\n' "$label" >&2
    exit 1
fi

focus_flag=--no-focus
if [[ "$focus" == true ]]; then
    focus_flag=--focus
fi

if ! tab_json=$(herdr tab create \
    --workspace "$workspace" \
    --cwd "$cwd" \
    --label "$label" \
    "$focus_flag"); then
    printf 'Could not create the Herdr tab.\n' >&2
    exit 1
fi

if ! tab_ids=$(jq -er \
    '[.result.root_pane.pane_id, .result.tab.tab_id] | @tsv' <<< "$tab_json"); then
    printf 'Herdr created a tab but returned an unexpected response. The tab was preserved.\n' >&2
    printf 'Inspect it with: herdr tab list\n' >&2
    printf 'Raw response: %s\n' "$tab_json" >&2
    exit 1
fi

IFS=$'\t' read -r pane_id tab_id <<< "$tab_ids"

pi_args=(--fork "$session_file" --name "$label")
if [[ "$allow_intercom" != true ]]; then
    pi_args+=(--exclude-tools intercom)
fi

start_output=""
start_delays=(0.25 0.5 1 2 2 2 2 2)
max_start_attempts=$((${#start_delays[@]} + 1))
for ((attempt = 1; attempt <= max_start_attempts; attempt += 1)); do
    if start_output=$(herdr agent start "$label" \
        --kind pi \
        --pane "$pane_id" \
        --timeout 60000 \
        -- "${pi_args[@]}" 2>&1); then
        if ! agent_json=$(herdr agent get "$label"); then
            printf 'Pi started, but Herdr could not verify agent %s.\n' "$label" >&2
            printf 'Tab: %s; pane: %s\n' "$tab_id" "$pane_id" >&2
            printf 'Inspect it with: herdr agent get %q\n' "$label" >&2
            exit 1
        fi

        agent_state=$(jq -er '.result.agent.agent_status // empty' <<< "$agent_json" 2>/dev/null || true)
        fork_session=$(jq -er '.result.agent.agent_session.value // empty' <<< "$agent_json" 2>/dev/null || true)
        if [[ -z "$agent_state" ]]; then
            printf 'Pi started, but Herdr returned an unexpected agent response.\n' >&2
            printf 'Tab: %s; pane: %s\n' "$tab_id" "$pane_id" >&2
            printf 'Raw response: %s\n' "$agent_json" >&2
            exit 1
        fi

        jq -n \
            --arg label "$label" \
            --arg state "$agent_state" \
            --arg workspace "$workspace" \
            --arg tab "$tab_id" \
            --arg pane "$pane_id" \
            --arg cwd "$cwd" \
            --arg sourceSession "$session_file" \
            --arg forkSession "$fork_session" \
            --argjson intercomToolEnabled "$allow_intercom" \
            '{
                label: $label,
                state: $state,
                workspace: $workspace,
                tab: $tab,
                pane: $pane,
                cwd: $cwd,
                sourceSession: $sourceSession,
                forkSession: $forkSession,
                checkoutShared: true,
                intercomToolEnabled: $intercomToolEnabled
            }'
        exit 0
    fi

    if ! grep -q 'agent_pane_busy' <<< "$start_output" || ((attempt == max_start_attempts)); then
        break
    fi

    sleep "${start_delays[attempt - 1]}"
done

printf '%s\n' "$start_output" >&2
printf 'The Herdr tab was preserved after Pi startup failed.\n' >&2
printf 'Recovery command:\n' >&2
printf 'herdr agent start %q --kind pi --pane %q --timeout 60000 -- --fork %q --name %q' \
    "$label" "$pane_id" "$session_file" "$label" >&2
if [[ "$allow_intercom" != true ]]; then
    printf ' --exclude-tools intercom' >&2
fi
printf '\n' >&2
printf 'Tab: %s; pane: %s\n' "$tab_id" "$pane_id" >&2
exit 1
