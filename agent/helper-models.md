# Helper model routing

`helper-models.json` persistently selects models used by extensions that make their own model calls:

```json
{
    "memory": "provider/model-id",
    "workLog": "provider/model-id",
    "recap": "provider/model-id"
}
```

Each value must be a fully qualified model from Pi's model registry. Model IDs may contain additional slashes. The configured provider must have working authentication.

Environment variables temporarily override the corresponding persistent value:

- `PI_MEMORY_MODEL`
- `PI_WORK_LOG_MODEL`
- `PI_RECAP_MODEL`

There is no active-model fallback. Missing, malformed, unavailable, or unauthenticated routes produce an explicit extension error, which prevents a helper task from silently using a more expensive model.

The friction-log extension does not make model calls.

Run `/reload` after editing `helper-models.json` so session-started background helpers resolve the new route. The recap command reads the file each time it runs.
