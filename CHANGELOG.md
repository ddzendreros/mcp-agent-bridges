# Changelog

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
