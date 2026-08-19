# Reminders todos

This extension connects Pi to the macOS Reminders list named `mmm, pi`.

## Commands

```text
/todo <todo text>
```

`/todo` creates the reminder immediately. Pi dispatches extension commands while the agent is processing, and this handler does not wait for the agent to become idle.

The first add creates the `mmm, pi` list if it does not exist. Each reminder stores the canonical Git project, working directory, Pi session ID and name, session file, and creation time in its notes.

## Agent tool

The `reminders_todos` tool supports:

- `add`: create a context-linked reminder from natural-language requests.
- `search`: search incomplete reminders for the current project by default. `scope: "all"` also searches unlinked and other-project reminders. Results from the current session rank ahead of other reminders from the same project.

macOS may ask for Automation permission the first time Pi accesses Reminders. Allow the terminal or application running Pi to control Reminders.
