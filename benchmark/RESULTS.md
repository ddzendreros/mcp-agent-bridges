# Results — 2026-11-14

Orchestrator: Claude Code. Each bridge was called through MCP with the prompt in [inventory/PROMPT.md](inventory/PROMPT.md), two models per tool. Machine: Windows 11, consumer laptop. One run per configuration, so treat times as indicative, not statistically robust.

| Tool | Model | Time | Ran its own tests | Hidden judge |
|---|---|---:|:---:|:---:|
| Codex (official `codex mcp-server`) | gpt-5.6-sol | not reported | ✓ | **23/23** |
| Codex (official `codex mcp-server`) | gpt-5.6-luna | not reported | ✓ | **23/23** |
| OpenCode | deepseek-v4.1-flash-free | 84 s | ✓ | **23/23** |
| OpenCode | nemotron-3.5-lightning-free | 151 s | ✓ (failed twice, fixed itself) | **23/23** |
| Cursor CLI | auto | **34 s** | ✓ | **23/23** |
| Cursor CLI | grok-4.7-medium | 77 s | ✓ | **23/23** |
| Antigravity CLI | gemini-3.8-flash-medium | 511 s | ✓ (allow-listed command) | **23/23** |
| Antigravity CLI | gemini-3.8-flash-low | 167 s | ✓ (allow-listed command) | **23/23** |

Notes
- Every configuration solved the task; the differences are speed, cost and how much the report helps the orchestrator verify the work.
- Codex is not part of this repository (it is OpenAI's official MCP server) and its MCP output does not include timing, files or commands; it is listed as a reference point.
- Calls issued "in parallel" to different bridges ran roughly one after another in Claude Code.
- An earlier, harder round (a ledger project with a two-step follow-up and 27 hidden checks) gave the same picture: all four tools reached 27/27 once each bridge's Windows and permission issues were fixed.

## Release check (code in this repository)
Before publishing, the three bridges in `packages/` were run end to end through MCP on fresh copies of the task:

| Bridge | Requested model | What happened | Hidden judge |
|---|---|---|:---:|
| opencode | deepseek-v4.1-flash-free | ok in 41 s, ran its tests | **23/23** |
| cursor | claude-opus-5-5-high | not available on the Free plan → fell back to `auto`, ok in 57 s | **23/23** |
| antigravity | gemini-3.8-flash-low | finished the work and ran its tests in 284 s, then the API answered `503 No capacity`; reported as `error` with the message. Since then a 503 also triggers `fallback_models`. | **23/23** |
