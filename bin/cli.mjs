#!/usr/bin/env node
// Entry point: `mcp-agent-bridges <opencode|cursor|antigravity>` starts that bridge on stdio.
const BRIDGES = { opencode: "opencode-bridge", cursor: "cursor-bridge", antigravity: "antigravity-bridge" };
const name = process.argv[2];
if (!BRIDGES[name]) {
  process.stderr.write(`usage: mcp-agent-bridges <${Object.keys(BRIDGES).join("|")}>\n`);
  process.exit(2);
}
const bridge = await import(new URL(`../packages/${BRIDGES[name]}/server.mjs`, import.meta.url));
bridge.main();
