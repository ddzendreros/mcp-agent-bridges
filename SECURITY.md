# Security policy

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** on this repository instead of opening a public issue.

Things to keep in mind when using the bridges:

- They run agent CLIs that can **edit files** in the `cwd` you pass, and (for OpenCode and Cursor, by default) **run commands** through those CLIs' own permission systems. Point them only at directories you are willing to let an agent change, ideally under version control.
- The Antigravity bridge only runs the exact commands you pass in `allow_commands`, for that call only.
- Log files under `~/.mcp-agent-bridges/logs/` may contain prompts, source code and account details. Set `*_BRIDGE_LOGS=off` to disable them.
