# Tool interface

Every bridge exposes one `*_task` tool with the same core parameters and the same report format, plus a `*_models` tool where the CLI can list models.

## Common parameters

| Parameter | Type | Meaning |
|---|---|---|
| `prompt` | string, **required** | Self-contained instruction: goal, files, definition of done, verification, what not to touch |
| `cwd` | string | Absolute working directory |
| `model` | string | Model for this call (overrides the default) |
| `fallback_models` | string[] | Models to try next, in order, when the bridge's fallback condition is met (`[]` disables) |
| `session_id` | string | Continue a previous session for follow-ups and corrections |
| `timeout_s` | number | Time limit for the whole call (default 900) |

### When `fallback_models` kicks in

| Bridge | Condition | Default list |
|---|---|---|
| opencode | the model errors or exits without doing anything (not on timeout) | none |
| cursor | the model is not available on your plan | `["auto"]` |
| antigravity | the model hits a usage limit (`RESOURCE_EXHAUSTED`, 429) or the server has no capacity (503) | none |

The same session is continued, and the next model is told to check the current state of the files before carrying on. Fallbacks only switch between models your own account already has access to.

## Bridge-specific parameters

| Bridge | Parameter | Meaning |
|---|---|---|
| opencode | `agent` | OpenCode agent (`build`, `plan`, ...) |
| opencode | `files` | Files to attach to the message |
| opencode | `auto_approve` | Auto-approve non-denied permissions (default `true`) |
| cursor | `mode` | `agent` (default), `plan` or `ask` (read-only) |
| cursor | `force` | Allow commands/writes without confirmation (default `true`) |
| antigravity | `mode` | `accept-edits` (default) or `plan` (read-only) |
| antigravity | `effort` | `low` ... `max` |
| antigravity | `allow_commands` | Exact commands the agent may run, for this task only (literal match, never persisted) |
| antigravity | `max_recoveries` | Resume the conversation this many times after a blocked command (default 2) |
| antigravity | `include_tree` | Add the workspace file list to the prompt (default `true`) |
| antigravity | `conversation_id` | Alias of `session_id` |

## Report format

```text
status: ok (exit 0, 34s)
session_id: 3f2a9c1e-...
model: Auto
attempts: claude-opus-5-5-high: not available for this account → auto: ok (only when a fallback ran)
files_edited: /abs/path/inventario.py, /abs/path/tests/test_nuevo.py
tools: read×4, edit×2, shell×1
commands:
  ✓ python -m unittest discover -s tests -t . (exit 0 → OK)
tokens: in 15050, out 2560, cache_read 24960                             (when the CLI reports them)
cost_usd: 0.0000                                                         (opencode)
errors: ...                                                              (only on failure)
log: ~/.mcp-agent-bridges/logs/cursor/2026-11-14T15-53-39-535Z_....jsonl
--- final answer ---
<the agent's last message, truncated to *_MAX_CHARS>
```

`status` is `ok`, `error` or `timeout`, and for Antigravity also `incomplete (command blocked)` or `usage or capacity limit reached`. Commands are marked `✓` (exit 0), `✗` (non-zero exit or could not run) or `⛔` (blocked by permissions); the report lists the **last 10** and says how many earlier ones it left out. The MCP result's `isError` is `true` whenever `status` is not `ok`. Cursor adds a `note:` line when the prompt had to go through `cmd.exe` and its line breaks were flattened.

The report is a summary built by the bridge from the CLI's event stream. Always verify the actual result (diff, tests) before trusting it.

## Timeouts, cancellation and progress

- `timeout_s` covers the whole call, fallbacks included. When it runs out, the bridge stops the agent CLI **and every process it started** (`taskkill /T` on Windows, the process group elsewhere) and reports `timeout`.
- The bridges honour MCP `notifications/cancelled`: the agent and its processes are stopped and, as the spec asks, no result is sent for that request.
- When the client closes the connection (stdin ends, or the bridge gets SIGTERM/SIGINT), every running agent is stopped before the bridge exits.
- If the call carries a `progressToken`, the bridge sends a `notifications/progress` every 15 s with the seconds elapsed, so clients that reset their timeout on progress do not give up on long tasks.
- Supported MCP protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. An unknown version requested by the client gets the newest one.
