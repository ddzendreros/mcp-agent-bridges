# Configuration

## Requirements

- **Node.js 18+** (the bridges have no npm dependencies).
- The CLI for the orchestrator and each executor you select, **installed and logged in** by you:
  - Claude Code → `claude`
  - Codex CLI → `codex`
  - OpenCode → `opencode` ([opencode.ai](https://opencode.ai))
  - Cursor CLI → `cursor-agent` ([cursor.com/cli](https://cursor.com/cli))
  - Antigravity CLI → `agy`
- On Windows, for Cursor: Git for Windows. The bridge puts Git Bash on the child process's `PATH`, which `cursor-agent` needs to run shell commands.

## Setup

`setup` lets any of the five agents orchestrate the others. It is a dry run unless you add `--write`:

```bash
npx -y github:ddzendreros/mcp-agent-bridges#v1.2.0 setup --orchestrator codex --executors antigravity,opencode
npx -y github:ddzendreros/mcp-agent-bridges#v1.2.0 setup --orchestrator codex --executors antigravity,opencode --write
```

The `#v1.2.0` tag must exist; it is created as part of the release. A dry run prints every command and file it would change. With `--write`, setup continues after a failed step and reports each result.

| Option | Meaning |
|---|---|
| `--executors all` | Select every agent except the orchestrator |
| `--source npx\|local` | Bridge command to register. The default is `local` in a clone and `npx` otherwise; `npx` is pinned to the release tag. On Windows, setup registers it as `cmd /c npx` |
| `--no-guide` | Do not write the orchestrator guide |
| `--guide-file <path>` | Write or update the marked guide section in this file instead of the default destination |

If the orchestrator is also named as an executor, setup skips it and prints a note.

### What setup changes

| Orchestrator | Server registration | Guide destination |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude/skills/delegate-coding-tasks/SKILL.md` |
| Codex | `codex mcp add`, then `tool_timeout_sec = 1800` in each server table in `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md` |
| OpenCode | `opencode mcp add --global` | `$XDG_CONFIG_HOME/opencode/AGENTS.md` or `~/.config/opencode/AGENTS.md` |
| Cursor | merges the server into `~/.cursor/mcp.json` | no global file; use `--guide-file <project>/AGENTS.md` |
| Antigravity | `agy mcp add` | `~/.gemini/GEMINI.md` |

The guide is rendered from `templates/orchestrator-guide.md` with only the selected executors. In `AGENTS.md`, `GEMINI.md` or a custom guide file, setup manages only the block between `<!-- mcp-agent-bridges:start -->` and `<!-- mcp-agent-bridges:end -->`. It will not overwrite a Claude skill file it did not generate. Existing files are backed up to `.bak-<timestamp>` before a change; unchanged files are not rewritten.

Registered MCP server names are `claude`, `codex-bridge`, `opencode`, `cursor` and `antigravity`. The Codex bridge uses `codex-bridge` so it does not clash with the official `codex mcp-server`, commonly registered as `codex`.

### Codex tool approval

When Codex is the orchestrator, it asks for approval for each MCP tool call. A non-interactive `codex exec` with `approval_policy=never` rejects those calls unless that server's table opts in:

```toml
[mcp_servers.antigravity]
default_tools_approval_mode = "approve"
```

Setup does **not** add this line because it removes a permission prompt. Add it only if that is the behavior you want. Setup does set `tool_timeout_sec = 1800`, because delegated tasks can take up to 15 minutes.

## Orchestrator guide and manual configuration

To use a clone, run setup from its root with `--source local`. For manual Claude Code configuration, see [`examples/claude.json.example`](../examples/claude.json.example). Any MCP client that speaks stdio can run a bridge with either:

```text
node /path/to/mcp-agent-bridges/packages/<agent>-bridge/server.mjs
npx -y github:ddzendreros/mcp-agent-bridges#v1.2.0 <agent>
```

On Windows, wrap the second form as `cmd /c npx ...` in clients that cannot start `npx.cmd` directly.

Codex can be an executor through this repo's `codex-bridge`, which exposes `codex_task` and the common report, or through the official server:

```bash
claude mcp add codex --scope user -- codex mcp-server
```

The official server is unchanged: pass `model` on each call because it ignores `-c model=...`, and use `sandbox: "workspace-write"` with `approval-policy: "never"` for unattended edits.

After adding or updating a server, restart the client or reconnect the server. Run `mcp-agent-bridges doctor` to see which agent CLIs are installed and their versions.

## Environment variables

All are optional.

| Variable | Bridge | Default | Meaning |
|---|---|---|---|
| `CLAUDE_BIN` | claude | auto-detected, else `claude` | Path to the Claude executable |
| `CLAUDE_BRIDGE_MODEL` | claude | Claude's default | Default model |
| `CLAUDE_BRIDGE_FALLBACKS` | claude | none | Comma-separated fallback models for usage, overload or model-availability errors |
| `CLAUDE_BRIDGE_LOGS` | claude | `~/.mcp-agent-bridges/logs/claude` | Log folder, or `off` |
| `CLAUDE_BRIDGE_MAX_CHARS` | claude | `4000` | Max characters of the final answer returned |
| `CLAUDE_BRIDGE_KEEP_ENV` | claude | none | Comma-separated `CLAUDE*` or `ANTHROPIC_*` variable names to keep when the bridge runs inside Claude Code |
| `CODEX_BIN` | codex | auto-detected, else `codex` | Path to the Codex executable |
| `CODEX_BRIDGE_MODEL` | codex | Codex's default | Default model |
| `CODEX_BRIDGE_FALLBACKS` | codex | none | Comma-separated fallback models for usage, capacity or model-availability errors |
| `CODEX_BRIDGE_LOGS` | codex | `~/.mcp-agent-bridges/logs/codex` | Log folder, or `off` |
| `CODEX_BRIDGE_MAX_CHARS` | codex | `4000` | Max characters of the final answer returned |
| `OPENCODE_BIN` | opencode | auto-detected, else `opencode` | Path to the OpenCode executable |
| `OPENCODE_BRIDGE_MODEL` | opencode | OpenCode's default | Default `provider/model` |
| `OPENCODE_BRIDGE_FALLBACKS` | opencode | none | Comma-separated fallback models |
| `OPENCODE_BRIDGE_LOGS` | opencode | `~/.mcp-agent-bridges/logs/opencode` | Log folder, or `off` |
| `OPENCODE_BRIDGE_MAX_CHARS` | opencode | `4000` | Max characters of the final answer returned |
| `CURSOR_AGENT_BIN` | cursor | auto-detected, else `cursor-agent` | Path to `cursor-agent`. On Windows, point it to the launcher in the install folder so the bridge can start Cursor's `node.exe` directly; another launcher uses `cmd.exe` and flattens line breaks |
| `CURSOR_BRIDGE_MODEL` | cursor | `auto` | Default model |
| `CURSOR_BRIDGE_FALLBACKS` | cursor | `auto` | Fallbacks when a model is not available on your plan |
| `CURSOR_BRIDGE_GIT_BASH_DIR` | cursor | auto-detected | Folder containing Git Bash's `bash.exe` on Windows |
| `CURSOR_BRIDGE_LOGS` | cursor | `~/.mcp-agent-bridges/logs/cursor` | Log folder, or `off` |
| `CURSOR_BRIDGE_MAX_CHARS` | cursor | `4000` | Max characters of the final answer returned |
| `AGY_BIN` | antigravity | auto-detected, else `agy` | Path to the Antigravity CLI |
| `AGY_BRIDGE_MODEL` | antigravity | Antigravity's default | Default model |
| `AGY_BRIDGE_FALLBACKS` | antigravity | none | Comma-separated models to use after a usage or capacity error |
| `AGY_BRIDGE_LOGS` | antigravity | `~/.mcp-agent-bridges/logs/antigravity` | Log folder, or `off` |
| `AGY_BRIDGE_MAX_CHARS` | antigravity | `4000` | Max characters of the final answer returned |
| `MCP_AGENT_BRIDGES_DEPTH` | all | `0` | Delegation depth, set by the bridges for the CLI they start, not by users |
| `MCP_AGENT_BRIDGES_MAX_DEPTH` | all | `1` | Maximum depth allowed for `tools/call` |

Set bridge variables in the `env` block of the server entry or with the MCP client's environment options.

When the Claude bridge itself runs inside Claude Code (`CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT` is set), it removes inherited variables whose names start with `CLAUDE` or `ANTHROPIC_`, case-insensitively. Without that cleanup, nested `claude -p` answered “Not logged in” in testing. `CLAUDE_BRIDGE_KEEP_ENV` keeps named exceptions such as a custom `ANTHROPIC_BASE_URL`. Without either marker, the child environment is unchanged.

## Prompts and nested delegation

The Claude and Codex bridges send prompts on stdin, so long prompts do not hit the Windows argv limit and line breaks do not pass through `cmd.exe`.

Every bridge increments `MCP_AGENT_BRIDGES_DEPTH` for the agent CLI it starts. A bridge started at or above `MCP_AGENT_BRIDGES_MAX_DEPTH` refuses `tools/call`; initialization and `tools/list` still work. This guard depends on the executor passing its environment to its MCP servers. Every task prompt also tells the delegate not to delegate, and Claude receives no MCP servers unless `use_mcp: true` removes its default `--strict-mcp-config`.

## Logs and privacy

Each task writes the agent's full event stream to the log folder. Those files can contain prompts, paths, source code and account details. They stay on your machine; set `*_LOGS=off` if you do not want them, and never commit them (this repo's `.gitignore` excludes `logs/` and `*.jsonl`).
