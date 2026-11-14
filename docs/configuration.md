# Configuration

## Requirements
- **Node.js 18+** (the bridges have no npm dependencies).
- The agent CLI you want to delegate to, **installed and logged in** by you:
  - OpenCode → `opencode` ([opencode.ai](https://opencode.ai))
  - Cursor → `cursor-agent` ([cursor.com/cli](https://cursor.com/cli))
  - Antigravity → `agy` (Antigravity CLI)
- On Windows, for Cursor: Git for Windows. The bridge puts Git Bash on the child process's `PATH`, which `cursor-agent` needs to run shell commands.

## Registering the servers

### Option A — `npx` from GitHub (no clone)
```bash
claude mcp add opencode    --scope user -- npx -y github:ddzendreros/mcp-agent-bridges opencode
claude mcp add cursor      --scope user -- npx -y github:ddzendreros/mcp-agent-bridges cursor
claude mcp add antigravity --scope user -- npx -y github:ddzendreros/mcp-agent-bridges antigravity
```

### Option B — clone (fastest start-up, works offline)
```bash
git clone https://github.com/ddzendreros/mcp-agent-bridges.git
claude mcp add opencode --scope user -- node /path/to/mcp-agent-bridges/packages/opencode-bridge/server.mjs
```
Replace `/path/to/` with the folder you cloned into, and repeat for `cursor-bridge` and `antigravity-bridge`.

### Option C — edit the config by hand
`--scope user` writes to `~/.claude.json` (`%USERPROFILE%\.claude.json` on Windows), under `mcpServers`. See [`examples/claude.json.example`](../examples/claude.json.example). Any MCP client that speaks stdio can use the same entries.

### Codex (not part of this repo)
Codex ships its own official MCP server. Install the Codex CLI, log in, then:
```bash
claude mcp add codex --scope user -- codex mcp-server
```
Two things we learned: `codex mcp-server` ignores `-c model=...`, so pass `model` on each `codex` tool call; and use `sandbox: "workspace-write"` with `approval-policy: "never"` for unattended edits.

After adding or updating a server, restart the client (or reconnect the server) so it loads the new code.

## Environment variables

All are optional.

| Variable | Bridge | Default | Meaning |
|---|---|---|---|
| `OPENCODE_BIN` | opencode | auto-detected, else `opencode` | Path to the OpenCode executable |
| `OPENCODE_BRIDGE_MODEL` | opencode | OpenCode's default | Default `provider/model` |
| `OPENCODE_BRIDGE_FALLBACKS` | opencode | none | Comma-separated fallback models |
| `OPENCODE_BRIDGE_LOGS` | opencode | `~/.mcp-agent-bridges/logs/opencode` | Log folder, or `off` |
| `OPENCODE_BRIDGE_MAX_CHARS` | opencode | `4000` | Max characters of the final answer returned |
| `CURSOR_AGENT_BIN` | cursor | auto-detected, else `cursor-agent` | Path to `cursor-agent` |
| `CURSOR_BRIDGE_MODEL` | cursor | `auto` | Default model |
| `CURSOR_BRIDGE_FALLBACKS` | cursor | `auto` | Fallbacks when a model is not available on your plan |
| `CURSOR_BRIDGE_GIT_BASH_DIR` | cursor | auto-detected | Folder that holds Git Bash's `bash.exe` (Windows) |
| `CURSOR_BRIDGE_LOGS` | cursor | `~/.mcp-agent-bridges/logs/cursor` | Log folder, or `off` |
| `CURSOR_BRIDGE_MAX_CHARS` | cursor | `4000` | Max characters of the final answer returned |
| `AGY_BIN` | antigravity | auto-detected, else `agy` | Path to the Antigravity CLI |
| `AGY_BRIDGE_MODEL` | antigravity | Antigravity's default | Default model |
| `AGY_BRIDGE_FALLBACKS` | antigravity | none | Comma-separated models of your account to use when one hits its usage limit |
| `AGY_BRIDGE_LOGS` | antigravity | `~/.mcp-agent-bridges/logs/antigravity` | Log folder, or `off` |
| `AGY_BRIDGE_MAX_CHARS` | antigravity | `4000` | Max characters of the final answer returned |

Set them in the `env` block of the server entry, or with `claude mcp add ... -e NAME=value`.

## Logs and privacy
Each task writes the agent's full event stream to the log folder. Those files can contain your prompts, file paths, source code and account details. They stay on your machine; set `*_LOGS=off` if you do not want them, and never commit them (this repo's `.gitignore` excludes `logs/` and `*.jsonl`).
