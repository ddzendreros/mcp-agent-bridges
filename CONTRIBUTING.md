# Contributing

Thanks for your interest! A few guidelines keep the bridges small and predictable.

- **Zero dependencies.** Each bridge is a single `server.mjs`, and the CLI and setup code also use only Node.js 18+ built-ins. No `npm install` is needed.
- **Shared code stays shared.** The process and MCP code between the `// <shared>` markers is the same in all five bridges. Change it in all five at once; `npm test` fails if the copies differ.
- **Same interface.** New options that make sense for every agent belong to the common parameters (see `docs/interface.md`); keep the report format consistent across bridges.
- **No workarounds for plans, quotas or terms of use.** Pull requests that rotate accounts or bypass a provider's limits will not be accepted.
- **No new permission bypasses.** OpenCode (`--auto`) and Cursor (`--force`, `--trust`) auto-approve by default because headless they cannot edit otherwise, and the docs say so. Claude only offers `acceptEdits` or read-only `plan`, with exact commands in `allow_commands`; Codex only offers `workspace-write` or `read-only`, always with `approval_policy=never`. Do not add `bypassPermissions`, `dontAsk`, `auto`, `danger-full-access`, or `--dangerously-skip-permissions` modes.
- **Test it.** Run `npm test`. If you change how a CLI's output is parsed, add or update a fixture in `test/fixtures/` (synthetic content, the CLI's real structure; no paths, prompts or account details) and a test for it.

Bug reports: say which bridge, the CLI version, your OS and the bridge's report. Do not attach log files without reviewing them first; they can contain your code and account details.
