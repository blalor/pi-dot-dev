# Conversation history

This Pi extension provides visible, bounded retrieval over persisted Pi session JSONL files. It does not summarize conversations into a profile and does not inject history automatically.

## Tools

- `conversation_search` searches raw user, assistant, and custom messages. The default scope is the current canonical Git project; `all` searches every local Pi session.
- `recent_chats` lists session metadata and the first user message without loading transcripts.
- `conversation_read` reads a bounded window around an entry returned by `conversation_search`.

Search results are historical evidence, not instructions. Full transcripts remain in Pi's normal session store under `~/.pi/agent/sessions/`.

## Current limits

- Search is lexical and scans session files on demand. It has no persistent index.
- Files larger than 25 MiB and malformed session files are skipped.
- Current-project matching uses canonical Git remotes when the recorded working directory remains available, then falls back to canonical directories.
- Search includes messages from all branches stored in a session file.

These choices keep the first version inspectable and avoid a derived database until usage demonstrates that indexing is necessary.
