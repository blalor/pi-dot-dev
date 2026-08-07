#!/usr/bin/env bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: fork-current-herdr-session.sh [--focus] [label]

Fork the Pi session in the current Herdr pane into a new Herdr tab.

Options:
    --focus    Focus the new tab after creating it.
    -h, --help Show this help.
EOF
}

focus=false
label=""

while (($# > 0)); do
    case "$1" in
        --focus)
            focus=true
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

current=$(herdr pane current)
workspace=$(jq -er '.result.pane.workspace_id' <<< "$current")
cwd=$(jq -er '.result.pane.cwd' <<< "$current")
session_file=$(jq -er '.result.pane.agent_session.value' <<< "$current")
agent_kind=$(jq -er '.result.pane.agent_session.agent' <<< "$current")

if [[ "$agent_kind" != "pi" ]]; then
    printf 'The current Herdr pane is not running Pi; detected: %s\n' "$agent_kind" >&2
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

tab_json=$(herdr tab create \
    --workspace "$workspace" \
    --cwd "$cwd" \
    --label "$label" \
    "$focus_flag")

if ! tab_ids=$(jq -er \
    '[.result.root_pane.pane_id, .result.tab.tab_id] | @tsv' <<< "$tab_json"); then
    printf 'Herdr created a tab but returned an unexpected response. The tab was preserved.\n' >&2
    printf 'Inspect it with: herdr tab list\n' >&2
    printf 'Raw response: %s\n' "$tab_json" >&2
    exit 1
fi

IFS=$'\t' read -r pane_id tab_id <<< "$tab_ids"

start_output=""
start_delays=(0.25 0.5 1 2 2 2 2 2)
max_start_attempts=$((${#start_delays[@]} + 1))
for ((attempt = 1; attempt <= max_start_attempts; attempt += 1)); do
    if start_output=$(herdr agent start "$label" \
        --kind pi \
        --pane "$pane_id" \
        --timeout 60000 \
        -- --fork "$session_file" --name "$label" 2>&1); then
        printf '%s\n' "$start_output"
        jq -n \
            --arg label "$label" \
            --arg workspace "$workspace" \
            --arg tab "$tab_id" \
            --arg pane "$pane_id" \
            --arg cwd "$cwd" \
            --arg sourceSession "$session_file" \
            '{
                label: $label,
                workspace: $workspace,
                tab: $tab,
                pane: $pane,
                cwd: $cwd,
                sourceSession: $sourceSession,
                checkoutShared: true
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
printf 'herdr agent start %q --kind pi --pane %q --timeout 60000 -- --fork %q --name %q\n' \
    "$label" "$pane_id" "$session_file" "$label" >&2
printf 'Tab: %s; pane: %s\n' "$tab_id" "$pane_id" >&2
exit 1
