# Tool interface

Each bridge exposes one `*_task` tool with the same core parameters and report format. Cursor and Antigravity also expose `cursor_models` and `antigravity_models`; the other CLIs do not provide a model-list command.

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
| claude | usage limit, overload, or model unavailable | none |
| codex | usage limit, capacity error, or model unavailable | none |
| opencode | the model errors or exits without doing anything (not on timeout) | none |
| cursor | the model is not available on your plan | `["auto"]` |
| antigravity | usage limit or no server capacity | none |

The same session is resumed, and the next model is told to inspect the current files before carrying on. Fallbacks do not run after timeout or cancellation and only switch between models your account can use.

## Bridge-specific parameters

| Bridge | Parameter | Meaning |
|---|---|---|
| claude | `mode` | `acceptEdits` (default) or `plan` (read-only) |
| claude | `allow_commands` | Exact commands allowed for this task. Each becomes `--allowedTools "Bash(<cmd>)"`; other commands are denied and Claude continues |
| claude | `use_mcp` | Give the delegate its configured MCP servers. Default `false` runs with `--strict-mcp-config` and no MCP servers |
| codex | `sandbox` | `workspace-write` (default) or `read-only`; there is no full-access option |
| codex | `effort` | `minimal`, `low`, `medium`, `high` or `xhigh` |
| opencode | `agent` | OpenCode agent (`build`, `plan`, ...) |
| opencode | `files` | Files to attach to the message |
| opencode | `auto_approve` | Auto-approve non-denied permissions (default `true`) |
| cursor | `mode` | `agent` (default), `plan` or `ask` (read-only) |
| cursor | `force` | Allow commands and writes without confirmation (default `true`) |
| antigravity | `mode` | `accept-edits` (default) or `plan` (read-only) |
| antigravity | `effort` | `low` ... `max` |
| antigravity | `allow_commands` | Exact commands the agent may run for this task (literal match, never persisted) |
| antigravity | `max_recoveries` | Resume the conversation this many times after a blocked command (default 2) |
| antigravity | `include_tree` | Add the workspace file list to the prompt (default `true`) |
| antigravity | `conversation_id` | Alias of `session_id` |

The Codex bridge always runs `codex exec --json` with `approval_policy=never`; follow-ups use `codex exec resume <session_id>`. Its sandbox governs commands. The Claude and Codex bridges send the prompt on stdin instead of argv.

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
cost_usd: 0.0000                                                         (when the CLI reports it)
errors: ...                                                              (only on failure)
log: ~/.mcp-agent-bridges/logs/cursor/2026-11-14T15-53-39-535Z_....jsonl
--- final answer ---
<the agent's last message, truncated to *_MAX_CHARS>
```

`status` is `ok`, `error` or `timeout`; Antigravity can also report `incomplete (command blocked)` or `usage or capacity limit reached`. Commands are `✓` (exit 0), `✗` (non-zero exit or could not run) or `⛔` (blocked by permissions). The report lists the last 10 commands and says how many earlier ones it omitted. The MCP result's `isError` is `true` whenever `status` is not `ok`.

Claude keeps working when a command is denied, so blocked commands do not by themselves make the result an error; a `note:` says how many were blocked. Codex removes its added PowerShell, cmd or POSIX-shell wrapper when it reports a command. If the Windows sandbox cannot start PowerShell, the attempt is `✗ ... could not run` and a note asks the orchestrator to check completeness. Cursor adds a note when its prompt had to go through `cmd.exe` and line breaks were flattened.

The report is a summary parsed from the CLI's event stream. Always verify the actual diff and tests.

## Timeouts, cancellation and progress

- `timeout_s` covers the whole bridge call, including fallbacks. When it expires, the bridge stops the agent CLI and every process it started (`taskkill /T` on Windows, the process group elsewhere) and reports `timeout`.
- The MCP client can have its own tool-call timeout. Setup writes `tool_timeout_sec = 1800` for Codex because its configured value is enforced: a measured 20-second setting cut off a 75-second call. OpenCode completed a 130-second MCP call as a client. Multi-minute limits for Claude Code, Cursor and Antigravity as clients were not measured here; Claude Code did complete Antigravity benchmark tasks of about 8.5 minutes.
- The bridges honor MCP `notifications/cancelled`: the agent and its processes are stopped and no result is sent for that request.
- When the client closes the connection or the bridge gets SIGTERM/SIGINT, running agents are stopped before exit.
- With a `progressToken`, the bridge sends `notifications/progress` every 15 seconds.
- Supported MCP protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. An unknown requested version gets the newest one.

## Nested delegation

Every bridge sets `MCP_AGENT_BRIDGES_DEPTH` to the next depth for the CLI it starts. A bridge started with depth greater than or equal to `MCP_AGENT_BRIDGES_MAX_DEPTH` (default 1) refuses `tools/call`; initialization and `tools/list` still work.

This guard only works when the executor passes its environment to its MCP servers. Each task prompt also tells the delegate not to delegate, and the Claude executor receives no MCP servers unless `use_mcp: true`.
