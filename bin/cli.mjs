#!/usr/bin/env node
// Entry point for bridge servers plus setup and diagnostics.
const BRIDGES = { opencode: "opencode-bridge", cursor: "cursor-bridge", antigravity: "antigravity-bridge", claude: "claude-bridge", codex: "codex-bridge" };
const usage = `usage:
  mcp-agent-bridges <claude|codex|opencode|cursor|antigravity>
  mcp-agent-bridges setup --orchestrator <agent> --executors <a,b,...|all> [--write] [--source npx|local] [--no-guide] [--guide-file <path>] [--home <dir>]
  mcp-agent-bridges doctor
  mcp-agent-bridges --help | -h
`;
const name = process.argv[2];
if (name === "--help" || name === "-h") {
  process.stdout.write(usage);
} else if (name === "setup") {
  const { setupMain } = await import("./setup.mjs");
  process.exitCode = await setupMain(process.argv.slice(3));
} else if (name === "doctor") {
  const { doctor } = await import("./setup.mjs");
  process.exitCode = await doctor();
} else if (BRIDGES[name]) {
  const bridge = await import(new URL(`../packages/${BRIDGES[name]}/server.mjs`, import.meta.url));
  bridge.main();
} else {
  process.stderr.write(usage);
  process.exitCode = 2;
}
