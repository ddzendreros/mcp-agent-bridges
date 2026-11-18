// Smoke tests: start each bridge over stdio, check the MCP handshake, the tool schemas and that a
// missing CLI is reported as a tool error (not a crash). No real agent CLI is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const MISSING = join(tmpdir(), "definitely-not-installed-cli");
const ENV = {
  ...process.env,
  OPENCODE_BIN: MISSING, CURSOR_AGENT_BIN: MISSING, AGY_BIN: MISSING, CLAUDE_BIN: MISSING, CODEX_BIN: MISSING,
  OPENCODE_BRIDGE_LOGS: "off", CURSOR_BRIDGE_LOGS: "off", AGY_BRIDGE_LOGS: "off", CLAUDE_BRIDGE_LOGS: "off", CODEX_BRIDGE_LOGS: "off",
};

function session(name) {
  const child = spawn(process.execPath, [CLI, name], { env: ENV, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const call = (method, params) => new Promise((res) => {
    const id = next++;
    waiting.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { call, close: () => child.kill() };
}

const CASES = [
  { name: "opencode", task: "opencode_task", tools: ["opencode_task"] },
  { name: "cursor", task: "cursor_task", tools: ["cursor_task", "cursor_models"] },
  { name: "antigravity", task: "antigravity_task", tools: ["antigravity_task", "antigravity_models"] },
  { name: "claude", task: "claude_task", tools: ["claude_task"] },
  { name: "codex", task: "codex_task", tools: ["codex_task"] },
];
const COMMON = ["prompt", "cwd", "model", "fallback_models", "session_id", "timeout_s"];

for (const c of CASES) {
  test(`${c.name}: handshake, schema and missing-CLI error`, async () => {
    const s = session(c.name);
    try {
      const init = await s.call("initialize", { protocolVersion: "2025-06-18" });
      assert.equal(init.result.serverInfo.name, `${c.name}-bridge`);
      assert.ok(init.result.instructions.length > 50);

      const list = await s.call("tools/list", {});
      assert.deepEqual(list.result.tools.map((t) => t.name), c.tools);
      const props = Object.keys(list.result.tools[0].inputSchema.properties);
      for (const p of COMMON) assert.ok(props.includes(p), `${c.task} is missing common parameter ${p}`);

      const cwd = mkdtempSync(join(tmpdir(), "mab-"));
      const res = await s.call("tools/call", { name: c.task, arguments: { prompt: "noop", cwd, fallback_models: [], timeout_s: 30 } });
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /^status: /);

      const bad = await s.call("tools/call", { name: "nope", arguments: {} });
      assert.equal(bad.result.isError, true);
    } finally {
      s.close();
    }
  });
}

test("cli rejects an unknown bridge name", async () => {
  const child = spawn(process.execPath, [CLI, "nope"], { stdio: "ignore" });
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 2);
});
