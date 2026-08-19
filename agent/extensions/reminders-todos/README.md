# Reminders todos

This extension connects Pi to the macOS Reminders list named `mmm, pi`.

## Commands

```text
/todo <todo text>
```

`/todo` creates the reminder immediately. Pi dispatches extension commands while the agent is processing, and this handler does not wait for the agent to become idle.

A trailing date phrase sets the due date and is removed from the reminder title:

```text
/todo submit expenses friday morning
/todo check the deployment tomorrow at 3pm
/todo prepare the agenda 2026-08-14 at 09:30
```

Supported dates are `today`, `tomorrow`, `tonight`, weekdays with optional `this` or `next`, and ISO dates. Supported times are explicit clock times plus `morning` (09:00), `afternoon` (13:00), `evening` (18:00), `night` (20:00), `noon`, and `midnight`. A date without a time defaults to 09:00. Bare weekdays mean the next occurrence; `next friday` means the Friday after that occurrence.

The first add creates the `mmm, pi` list if it does not exist. Each reminder stores the canonical Git project, working directory, Pi session ID and name, session file, and creation time in its notes.

## Agent tool

The `reminders_todos` tool supports:

- `add`: create a context-linked reminder and parse the same trailing date phrases as `/todo`.
- `search`: search incomplete reminders for the current project by default. `scope: "all"` also searches unlinked and other-project reminders. Results from the current session rank ahead of other reminders from the same project.

macOS may ask for Automation permission the first time Pi accesses Reminders. Allow the terminal or application running Pi to control Reminders.
