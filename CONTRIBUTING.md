# Contributing

Thanks for your interest! A few guidelines keep the bridges small and predictable.

- **Zero dependencies.** Each bridge is a single `server.mjs` that runs on Node.js 18+ with no `npm install`.
- **Same interface.** New options that make sense for every agent belong to the common parameters (see `docs/interface.md`); keep the report format consistent across bridges.
- **No workarounds for plans, quotas or terms of use.** Pull requests that rotate accounts or bypass a provider's limits will not be accepted.
- **Safe by default.** Do not add flags that skip the agent's permission system by default.
- **Test it.** Run `npm test`. If you change how a CLI's output is parsed, include a short sample of that output in the PR description (with paths, prompts and account details removed).

Bug reports: say which bridge, the CLI version, your OS and the bridge's report. Do not attach log files without reviewing them first; they can contain your code and account details.
