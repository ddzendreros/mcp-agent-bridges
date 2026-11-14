# Changelog

## 1.0.0 — 2026-11-14
First public release.

- `opencode-bridge`, `cursor-bridge` and `antigravity-bridge` with a shared core interface (`prompt`, `cwd`, `model`, `fallback_models`, `session_id`, `timeout_s`) and a shared report format.
- `npx github:ddzendreros/mcp-agent-bridges <bridge>` entry point.
- Configurable log folder (`*_BRIDGE_LOGS`, `off` to disable).
- Reproducible `inventory` benchmark with a hidden judge.
