# Pi iTerm2 integration

Uses native iTerm2 tabs, Program Status (OSC 7501) and notifications. Requires
iTerm2 3.7.5 or newer. It replaces the local `macos-notify.ts` and
`iterm2-session-tab.ts` extensions. No AppleScript fallback or workspace manager
is required.

## Status and attention

[OSC 7501](https://www.superlogical.com/rex/docs/build/program-status) reports:

- `working` during a parent agent run or manual compaction.
- `blocked` with `kind=question` while a `ctx.ui` interaction is open, including
  custom UI. Prompt events do not distinguish permission requests from questions.
- `idle` once the parent session settles or an idle interaction closes.

Each report includes `app=pi`. iTerm2 chooses the labels and colors. The extension
preserves its existing idle/completion behavior rather than emitting `done`.

Open **View → Toolbelt → Session Status** for sessions in one window, or
**Window → Cockpit** for the cross-window overview. Working and idle reports omit
`msg`; blocked reports include the prompt title as base64-encoded UTF-8. Custom UI
has no title in Pi's prompt events, so it uses `Custom interaction`.

The public `ui_prompt_start` and `ui_prompt_end` events cover select, confirm,
input, editor and custom UI. Pi emits one outer start/end pair for overlapping
interactions and emits the end on rejection as well as normal completion. This
integration does not modify dialog implementations.
Core-owned login screens do not go through these extension prompt events.
Manual compaction refreshes status after Pi clears its busy flag, including when
compaction fails or is cancelled; it does not send a turn-completion notification.

Attention notifications use iTerm2 OSC 9. Clicking a notification reveals the
originating tab. Completion notifications wait 750 ms and are suppressed when
new work, queued messages or active subagents remain. Notifications are limited
to one per two seconds. Input waits can notify during an active run or subagent
work. Status itself describes the parent session, not the subagent fleet.

The session name sets the tab title. Native status dots replace the old
whole-tab attention coloring; no terminal focus listener is installed.

OSC 7501 still expires transient records at shell prompts. Pi also emits OSC 133
prompt-start markers when redrawing its transcript, so the extension retains a
stdout observer for those exact markers without changing the original output.
It queues one microtask to write the current status after the synchronous render
finishes, avoiding insertion between chunks of a split escape sequence. iTerm2
3.7.5 preserves reports newer than a prompt during deferred cleanup, so no
redraw-repair timers, timed debounce or status polling are needed. Shutdown/reload
detaches the observer and cancels queued reassertion.
Removing it requires Pi to distinguish transcript markers from shell prompts.

Reassertions do not send OSC 9 notifications. iTerm2's own status-change
notification preferences apply independently and can produce additional alerts.

Run `/iterm2-test` to refresh status and send a test notification.

Only native interactive iTerm2 TTY sessions activate the integration. Herdr
sessions are excluded even if they inherit iTerm2 environment variables. RPC,
print and other terminals emit no escape sequences and start no timers.

## Session identity

The extension publishes these iTerm2 user variables:

- `pi_session_file`: exact saved conversation path.
- `pi_session_id`: conversation ID.
- `pi_session_name`: current display name.
- `pi_cwd`: project directory.

These are metadata for a future recovery integration, not a durable recorder or
automatic relaunch mechanism. Status and variables clear on normal shutdown,
reload and session replacement; abrupt process death cannot run that cleanup.

## iTerm2 process restoration

For an iTerm2 restart to preserve running processes, configure the prerequisites
in [iTerm2's restoration documentation](https://iterm2.com/documentation-restoration.html):

- Enable **Advanced → Enable session restoration**, then restart iTerm2.
- Select **General → Startup → Use system window restoration settings**.
- Disable macOS **Close windows when quitting an application**.
- Disable **Advanced → User-initiated quit (cmd-q) of iTerm2 will kill all running jobs**.

This preserves live processes across supported iTerm2 restarts, not machine
reboots. This extension does not change those preferences.

## Validation

From `~/.pi`:

```sh
node --test tests/iterm2.test.ts
npm run check:extensions
npm run test:rpc -- --extension agent/extensions/iterm2/index.ts --command /iterm2-test
```
