#!/usr/bin/env python3
"""Launch a named Pi peer or conversation fork in the calling iTerm2 window."""

import argparse
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile


# Pass data through argv, never interpolate it into AppleScript source or type
# commands into a shell whose readiness is unknown.
APPLESCRIPT = '''on run argv
    set sourceID to item 1 of argv
    set launchCommand to item 2 of argv
    set peerLabel to item 3 of argv
    set focusPeer to item 4 of argv
    tell application "iTerm2"
        set sourceWindow to missing value
        repeat with candidateWindow in windows
            repeat with candidateTab in tabs of candidateWindow
                repeat with candidateSession in sessions of candidateTab
                    if unique ID of candidateSession is sourceID then
                        set sourceWindow to window id (id of candidateWindow)
                    end if
                end repeat
            end repeat
        end repeat
        if sourceWindow is missing value then error "Calling iTerm2 session not found; no tab created."
        set previousTab to current tab of sourceWindow
        tell sourceWindow
            set peerTab to create tab with default profile command launchCommand
        end tell
        set peerSession to current session of peerTab
        -- Capture identifiers before optional cosmetic operations can fail.
        set launchIDs to (id of sourceWindow as text) & linefeed & (unique ID of peerSession)
        try
            set name of peerSession to peerLabel
            if focusPeer is "true" then
                select sourceWindow
                select peerTab
                activate
            else
                select previousTab
            end if
        end try
        return launchIDs
    end tell
end run
'''


def prepare(args):
    cwd = Path(args.cwd).expanduser().resolve()
    if not cwd.is_dir():
        raise ValueError(f"Checkout directory does not exist: {cwd}")
    source_id = os.environ.get("ITERM_SESSION_ID", "").rsplit(":", 1)[-1]
    if not source_id:
        raise ValueError("ITERM_SESSION_ID is unset; run from the source iTerm2 Pi session.")
    pi = shutil.which("pi")
    if not pi:
        raise ValueError("Required command not found: pi")
    label = args.label or datetime.datetime.now(datetime.timezone.utc).strftime("pi-peer-%Y%m%d-%H%M%S-%f")
    if not label.strip():
        raise ValueError("Label must not be blank.")
    pi_args = [pi, "--name", label]
    source_session = None
    if args.fork_current:
        session = os.environ.get("PI_SESSION_FILE")
        if not session or not Path(session).is_file():
            raise ValueError("PI_SESSION_FILE must identify the current persistent Pi session.")
        source_session = str(Path(session).resolve())
        pi_args += ["--fork", source_session]
        if not args.allow_intercom:
            pi_args += ["--exclude-tools", "intercom"]
    elif args.allow_intercom:
        raise ValueError("--allow-intercom applies only to --fork-current.")
    if args.prompt_file:
        prompt = Path(args.prompt_file).expanduser().read_text()
        if not prompt.strip():
            raise ValueError("Prompt file must not be empty.")
        # A leading @ is a Pi file argument even after --. Prefix a newline so
        # arbitrary prompt text stays a message, including leading @ and -.
        pi_args += ["--", "\n" + prompt]
    # Launch a fresh shell rather than inheriting stale parent Pi/Herdr metadata.
    # Keep the terminal available for recovery if cd or Pi startup fails.
    command = f"cd -- {shlex.quote(str(cwd))} && {shlex.join(pi_args)}"
    shell_script = command + '; pi_exit_code=$?; printf "\\nPi exited (%s). Recovery shell follows.\\n" "$pi_exit_code"; exec /bin/zsh -l'
    return source_id, shell_script, {
        "label": label,
        "cwd": str(cwd),
        "sourceSession": source_session,
        "checkoutShared": args.fork_current,
        "intercomToolEnabled": not args.fork_current or args.allow_intercom,
        "recoveryCommand": command,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--label")
    parser.add_argument("--prompt-file")
    parser.add_argument("--fork-current", action="store_true")
    parser.add_argument("--allow-intercom", action="store_true")
    parser.add_argument("--focus", action="store_true")
    args = parser.parse_args(argv)
    try:
        source_id, shell_script, result = prepare(args)
        # iTerm2's command tokenizer is not a POSIX shell. Keep prompt text and
        # shell quoting out of that parser. The private script unlinks itself
        # when zsh opens it; on a launch failure retain it for recovery.
        with tempfile.NamedTemporaryFile(mode="w", prefix="pi-iterm-", suffix=".zsh", delete=False) as script:
            script.write('rm -f -- "$0"\n' + shell_script + "\n")
            script_path = script.name
        escaped_path = script_path.replace("\\", "\\\\").replace('"', '\\"')
        command = '/bin/zsh -l "' + escaped_path + '"'
        response = subprocess.run(
            ["osascript", "-", source_id, command, result["label"], str(args.focus).lower()],
            input=APPLESCRIPT, text=True, capture_output=True, check=True,
        )
        window, session = response.stdout.strip().splitlines()
        result.update(window=window, terminalSession=session, state="command-submitted")
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"iTerm2 launch failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        if "script_path" in locals():
            print(f"Launch script (if not yet consumed): {script_path}", file=sys.stderr)
        print("If a tab was created, preserve it. Do not blindly retry and create a duplicate.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
