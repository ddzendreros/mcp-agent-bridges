// Process handling: timeouts and cancellation must stop the agent CLI *and everything it started*,
// and a call must not hang because a leftover process keeps the output pipes open.
// Also checks the MCP side: cancellation, protocol negotiation, and that multi-line prompts reach
// cursor-agent (no real CLI needed: a fake one prints the arguments it receives).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../packages/opencode-bridge/server.mjs";

const IS_WIN = process.platform === "win32";
const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), "mab-"));

// A "CLI" that starts a grandchild sharing its stdout; the grandchild writes `marker` after `after` ms.
function spawner(dir, { after, parentLives }) {
  const script = join(dir, "parent.cjs"), marker = join(dir, "marker.txt");
  writeFileSync(script, `
    const { spawn } = require("child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), ${after})`)}], { stdio: "inherit" }).unref();
    console.log("started");
    ${parentLives ? "setTimeout(() => {}, 60000);" : ""}
  `);
  return { script, marker };
}

test("timeout kills the whole process tree and returns on time", async () => {
  const { script, marker } = spawner(tmp(), { after: 3000, parentLives: true });
  const t0 = Date.now();
  const r = await runProcess(process.execPath, [script], { timeoutMs: 800 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(took < 2500, `returned after ${took} ms`);
  await sleep(3500);
  assert.equal(existsSync(marker), false, "a grandchild kept running after the timeout");
});

test("cancellation (ctx) stops the tree", async () => {
  const { script, marker } = spawner(tmp(), { after: 3000, parentLives: true });
  const ctx = { cancelled: false, stops: new Set() };
  const p = runProcess(process.execPath, [script], { timeoutMs: 60000, ctx });
  await sleep(500);
  ctx.cancelled = true;
  for (const stop of ctx.stops) stop();
  const r = await p;
  assert.equal(r.cancelled, true);
  await sleep(3500);
  assert.equal(existsSync(marker), false);
});

test("a leftover process holding the pipes does not block the call", async () => {
  const { script } = spawner(tmp(), { after: 8000, parentLives: false });
  const t0 = Date.now();
  const r = await runProcess(process.execPath, [script], { timeoutMs: 60000 });
  assert.equal(r.code, 0);
  assert.match(r.out, /started/);
  assert.ok(Date.now() - t0 < 5000, "waited for the leftover process");
});

// ---- over MCP, with a fake cursor-agent ----
function fakeCursor(dir) {
  if (IS_WIN) {
    const p = join(dir, "cursor-agent.cmd");
    writeFileSync(p, [
      "@echo off",
      "echo ARGS=%*",
      'if "%FAKE_SLEEP%"=="" exit /b 0',
      "ping -n %FAKE_SLEEP% 127.0.0.1 >nul",
      'echo late> "%FAKE_MARKER%"',
      "",
    ].join("\r\n"));
    return p;
  }
  const p = join(dir, "cursor-agent");
  writeFileSync(p, ['#!/bin/sh', 'printf "ARGS=%s\\n" "$*"', '[ -z "$FAKE_SLEEP" ] && exit 0', 'sleep "$FAKE_SLEEP"', 'echo late > "$FAKE_MARKER"', ""].join("\n"));
  chmodSync(p, 0o755);
  return p;
}

function session(env) {
  const child = spawn(process.execPath, [CLI, "cursor"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const got = new Map(), waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      got.set(msg.id, msg);
      waiting.get(msg.id)?.(msg);
    }
  });
  const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const call = (id, method, params) => new Promise((res) => { waiting.set(id, res); write({ id, method, params }); });
  return { write, call, got, close: () => child.kill() };
}

test("initialize negotiates the protocol version", async () => {
  const s = session({ CURSOR_BRIDGE_LOGS: "off" });
  try {
    assert.equal((await s.call(1, "initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion, "2024-11-05");
    assert.equal((await s.call(2, "initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18");
  } finally { s.close(); }
});

test("notifications/cancelled stops the agent and sends no result", async () => {
  const dir = tmp(), marker = join(dir, "late.txt");
  const s = session({ CURSOR_AGENT_BIN: fakeCursor(dir), CURSOR_BRIDGE_LOGS: "off", FAKE_SLEEP: "4", FAKE_MARKER: marker });
  try {
    await s.call(1, "initialize", {});
    s.write({ id: 2, method: "tools/call", params: { name: "cursor_task", arguments: { prompt: "work", cwd: dir, fallback_models: [] } } });
    await sleep(700);
    s.write({ method: "notifications/cancelled", params: { requestId: 2, reason: "test" } });
    await s.call(3, "ping", {});
    await sleep(4500);
    assert.equal(s.got.has(2), false, "a cancelled request must not get a result");
    assert.equal(existsSync(marker), false, "the agent kept running after cancellation");
  } finally { s.close(); }
});

test("cursor: a multi-line prompt reaches the agent in full", async () => {
  const dir = tmp(), logs = join(dir, "logs");
  const s = session({ CURSOR_AGENT_BIN: fakeCursor(dir), CURSOR_BRIDGE_LOGS: logs });
  try {
    await s.call(1, "initialize", {});
    const res = await s.call(2, "tools/call", { name: "cursor_task", arguments: { prompt: "line one\nline TWO", cwd: dir, fallback_models: [] } });
    const text = res.result.content[0].text;
    const log = text.match(/^log: (.+)$/m)?.[1];
    assert.ok(log, text);
    const received = readFileSync(log, "utf8");
    assert.match(received, /line one/);
    assert.match(received, /line TWO/);
    // Through cmd.exe line breaks cannot survive; the report must say they were flattened.
    if (IS_WIN) assert.match(text, /line breaks were replaced/);
  } finally { s.close(); }
});
