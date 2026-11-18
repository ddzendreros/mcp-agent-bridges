# Changelog

## 1.2.0 — 2026-11-17

### Added
- `claude-bridge` and `codex-bridge`, exposing `claude_task` and `codex_task` with the same core parameters and report as the existing bridges.
- `setup`, which registers selected executors for any of the five orchestrators, backs up files before changing them, and writes an orchestrator guide containing only those executors. Codex registrations set `tool_timeout_sec = 1800`.
- `doctor`, which reports the installed agent CLIs and their versions.
- A nested-delegation guard using `MCP_AGENT_BRIDGES_DEPTH` and `MCP_AGENT_BRIDGES_MAX_DEPTH`.
- MCP tool annotations on every tool: `*_task` tools are marked destructive and not read-only; `*_models` tools are marked read-only and idempotent. All are open-world.

### Changed
- Any of Claude Code, Codex, OpenCode, Cursor or Antigravity can be the orchestrator while the others execute.
- Claude tasks use `acceptEdits` or read-only `plan`, with an exact command allow-list. Codex tasks use `workspace-write` or `read-only`, with no full-access mode.
- The shared process and MCP block is now identical across five bridges.

### Fixed
- Prompts for the new Claude and Codex bridges are sent on stdin, avoiding the Windows argv length limit and `cmd.exe` line-break handling.
- When started inside Claude Code, the Claude bridge removes inherited `CLAUDE*` and `ANTHROPIC_*` session variables unless named in `CLAUDE_BRIDGE_KEEP_ENV`; inheriting them made nested `claude -p` calls answer “Not logged in”.
- Codex command reports remove the CLI's shell wrapper and mark Windows sandbox shell-start failures as `could not run`.

## 1.1.0 — 2026-11-14

### Fixed
- **Timeouts left processes running.** On timeout only the agent CLI itself was killed; the processes it had started kept running (and could keep editing files), and the call could wait for them well past `timeout_s`. The bridges now stop the whole process tree and return on time.
- **Cursor lost the prompt on its `cmd.exe` fallback (Windows).** The bridge always adds a line break after its `Working directory` line, and `cmd.exe` cuts at the first one, so the agent received no task at all. The bridge now also finds Cursor's `node.exe` next to `CURSOR_AGENT_BIN`, and on the `cmd.exe` path replaces line breaks with spaces and says so in the report.
- **Antigravity marked failing commands as passed.** A finished `run_command` was always `✓`; the exit code is now read from its output, so failing tests show as `✗ (exit 1 → …)`.
- Cursor only falls back to another model on errors or stderr that say the model is unavailable, never because the agent's own answer mentions it. Antigravity no longer treats any `429` in a message as a rate limit.
- Antigravity listed the first 10 commands and the others the last 10; all now list the last 10 and say how many were left out.
- Version numbers now match across the package and the three servers.

### Added
- MCP `notifications/cancelled` stops the running agent; closing the client stops every running agent.
- `notifications/progress` every 15 s when the client sends a `progressToken`.
- Protocol version negotiation (`2025-06-18`, `2025-03-26`, `2024-11-05`).
- Tests for the event-stream parsers (fixtures), process-tree handling, cancellation, multi-line prompts, and a check that the code shared by the three bridges stays identical.

### Changed
- README: the permission defaults of OpenCode and Cursor are stated plainly, and the benchmark section no longer ranks the tools on quality it did not measure.

## 1.0.0 — 2026-11-14
First public release.

- `opencode-bridge`, `cursor-bridge` and `antigravity-bridge` with a shared core interface (`prompt`, `cwd`, `model`, `fallback_models`, `session_id`, `timeout_s`) and a shared report format.
- `npx github:ddzendreros/mcp-agent-bridges <bridge>` entry point.
- Configurable log folder (`*_BRIDGE_LOGS`, `off` to disable).
- Reproducible `inventory` benchmark with a hidden judge.
