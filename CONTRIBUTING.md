# Contributing

Thanks for your interest! A few guidelines keep the bridges small and predictable.

- **Zero dependencies.** Each bridge is a single `server.mjs` that runs on Node.js 18+ with no `npm install`.
- **Shared code stays shared.** The process and MCP code between the `// <shared>` markers is the same in the three bridges. Change it in all three at once; `npm test` fails if the copies differ.
- **Same interface.** New options that make sense for every agent belong to the common parameters (see `docs/interface.md`); keep the report format consistent across bridges.
- **No workarounds for plans, quotas or terms of use.** Pull requests that rotate accounts or bypass a provider's limits will not be accepted.
- **No new permission bypasses.** OpenCode (`--auto`) and Cursor (`--force`, `--trust`) auto-approve by default because headless they cannot edit otherwise, and the docs say so. Do not add further flags that skip an agent's permission system by default, and never `--dangerously-skip-permissions` for Antigravity.
- **Test it.** Run `npm test`. If you change how a CLI's output is parsed, add or update a fixture in `test/fixtures/` (synthetic content, the CLI's real structure; no paths, prompts or account details) and a test for it.

Bug reports: say which bridge, the CLI version, your OS and the bridge's report. Do not attach log files without reviewing them first; they can contain your code and account details.
