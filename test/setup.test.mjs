// Setup tests exercise the pure plan and a cursor-based end-to-end apply without real agent CLIs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_TIMEOUT_SEC, plan, renderGuide, setTomlKey, upsertSection } from "../bin/setup.mjs";

const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "mab-setup-"));

function runCLI(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("plan: codex registers npx executors and writes its AGENTS.md", () => {
  const home = tmp();
  const steps = plan({
    orchestrator: "codex", executors: "antigravity,opencode", source: "npx",
    platform: "linux", version: "1.2.0", home, env: {},
  });
  assert.deepEqual(steps.filter((s) => s.kind === "run").map((s) => s.cmd), [
    ["codex", "mcp", "add", "antigravity", "--", "npx", "-y", "github:ddzendreros/mcp-agent-bridges#v1.2.0", "antigravity"],
    ["codex", "mcp", "add", "opencode", "--", "npx", "-y", "github:ddzendreros/mcp-agent-bridges#v1.2.0", "opencode"],
  ]);
  assert.deepEqual(steps.slice(0, 4).map((s) => s.kind), ["run", "toml", "run", "toml"]);
  assert.deepEqual(steps.filter((s) => s.kind === "toml").map((s) => ({ file: s.file, table: s.table, key: s.key, value: s.value })), [
    { file: join(home, ".codex", "config.toml"), table: "mcp_servers.antigravity", key: "tool_timeout_sec", value: TOOL_TIMEOUT_SEC },
    { file: join(home, ".codex", "config.toml"), table: "mcp_servers.opencode", key: "tool_timeout_sec", value: TOOL_TIMEOUT_SEC },
  ]);
  const guide = steps.find((s) => s.kind === "section");
  assert.equal(guide.file, join(home, ".codex", "AGENTS.md"));

  const codexHome = join(home, "custom-codex");
  const custom = plan({ orchestrator: "codex", executors: "claude", source: "local", home, env: { CODEX_HOME: codexHome }, noGuide: true });
  assert.equal(custom.find((s) => s.kind === "toml").file, join(codexHome, "config.toml"));
});

test("plan: npx is wrapped with cmd on Windows", () => {
  const steps = plan({
    orchestrator: "codex", executors: "opencode", source: "npx",
    platform: "win32", version: "1.2.0", home: tmp(), env: {}, noGuide: true,
  });
  assert.deepEqual(steps[0].cmd, [
    "codex", "mcp", "add", "opencode", "--", "cmd", "/c", "npx", "-y",
    "github:ddzendreros/mcp-agent-bridges#v1.2.0", "opencode",
  ]);
});

test("plan: cursor JSON, orchestrator skipping, all expansion and validation", () => {
  const home = tmp();
  const explicit = plan({ orchestrator: "cursor", executors: "cursor,claude", source: "local", home, noGuide: true });
  assert.match(explicit.find((s) => s.kind === "note").text, /skipped as an executor/);
  const json = explicit.find((s) => s.kind === "json");
  assert.equal(json.file, join(home, ".cursor", "mcp.json"));
  assert.equal(json.key, "claude");

  const all = plan({ orchestrator: "cursor", executors: "all", source: "local", home, noGuide: true });
  assert.equal(all.filter((s) => s.kind === "json").length, 4);
  assert.throws(() => plan({ orchestrator: "cursor", executors: "unknown", home }), /Valid agents/);
});

test("upsertSection is idempotent and preserves text outside the markers", () => {
  const once = upsertSection("project rules\n", "delegate guide");
  const twice = upsertSection(once, "delegate guide");
  assert.equal(twice, once);
  assert.match(twice, /^project rules/m);
  assert.equal((twice.match(/mcp-agent-bridges:start/g) || []).length, 1);
});

test("renderGuide includes only the selected executor rows", () => {
  const guide = renderGuide(["codex"]);
  assert.match(guide, /codex_task/);
  assert.doesNotMatch(guide, /cursor_task/);
  assert.doesNotMatch(guide, /\{\{/);
});

test("setTomlKey inserts, replaces and is idempotent", () => {
  const input = "title = \"setup\"\n\n[mcp_servers.codex-bridge]\ncommand = \"node\"\n";
  const inserted = setTomlKey(input, "mcp_servers.codex-bridge", "tool_timeout_sec", TOOL_TIMEOUT_SEC);
  assert.equal(inserted, "title = \"setup\"\n\n[mcp_servers.codex-bridge]\ntool_timeout_sec = 1800\ncommand = \"node\"\n");
  assert.equal(setTomlKey(inserted, "mcp_servers.codex-bridge", "tool_timeout_sec", TOOL_TIMEOUT_SEC), inserted);
  assert.equal(
    setTomlKey("[mcp_servers.codex-bridge]\ntool_timeout_sec = 20 # old\n", "mcp_servers.codex-bridge", "tool_timeout_sec", TOOL_TIMEOUT_SEC),
    "[mcp_servers.codex-bridge]\ntool_timeout_sec = 1800 # old\n",
  );
});

test("setTomlKey handles quoted tables, CRLF and stops before subtables", () => {
  const input = " [ mcp_servers.\"codex-bridge\" ] \r\ncommand = \"node\"\r\n[mcp_servers.codex-bridge.env]\r\ntool_timeout_sec = 20\r\n";
  const result = setTomlKey(input, "mcp_servers.codex-bridge", "tool_timeout_sec", TOOL_TIMEOUT_SEC);
  assert.equal(result, " [ mcp_servers.\"codex-bridge\" ] \r\ntool_timeout_sec = 1800\r\ncommand = \"node\"\r\n[mcp_servers.codex-bridge.env]\r\ntool_timeout_sec = 20\r\n");
  assert.doesNotMatch(result, /(?<!\r)\n/);
  assert.throws(
    () => setTomlKey("[mcp_servers.other]\n", "mcp_servers.codex-bridge", "tool_timeout_sec", TOOL_TIMEOUT_SEC),
    /table \[mcp_servers\.codex-bridge\] not found in config\.toml: was the server registered\?/,
  );
});

test("CLI dry run writes nothing; apply merges cursor JSON and upserts one guide section", async () => {
  const dir = tmp(), home = join(dir, "home"), guide = join(dir, "AGENTS.md");
  const cursorDir = join(home, ".cursor"), mcp = join(cursorDir, "mcp.json");
  mkdirSync(cursorDir, { recursive: true });
  const original = { mcpServers: { existing: { command: "keep", args: ["yes"] } } };
  writeFileSync(mcp, JSON.stringify(original, null, 2) + "\n");
  const args = ["setup", "--orchestrator", "cursor", "--executors", "claude,codex", "--source", "local", "--guide-file", guide, "--home", home];

  const dry = await runCLI(args);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /Dry run: nothing was changed/);
  assert.deepEqual(JSON.parse(readFileSync(mcp, "utf8")), original);
  assert.equal(existsSync(guide), false);
  assert.equal(readdirSync(cursorDir).some((f) => f.startsWith("mcp.json.bak-")), false);

  const first = await runCLI([...args, "--write"]);
  assert.equal(first.code, 0, first.out + first.err);
  const configured = JSON.parse(readFileSync(mcp, "utf8")).mcpServers;
  assert.deepEqual(configured.existing, original.mcpServers.existing);
  assert.ok(configured.claude);
  assert.ok(configured["codex-bridge"]);
  assert.ok(readdirSync(cursorDir).some((f) => f.startsWith("mcp.json.bak-")));
  assert.equal((readFileSync(guide, "utf8").match(/mcp-agent-bridges:start/g) || []).length, 1);

  const second = await runCLI([...args, "--write"]);
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal((readFileSync(guide, "utf8").match(/mcp-agent-bridges:start/g) || []).length, 1);
});

test("CLI help succeeds and bad setup agents exit 2", async () => {
  const help = await runCLI(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /mcp-agent-bridges setup/);
  const bad = await runCLI(["setup", "--orchestrator", "bad", "--executors", "claude", "--home", tmp()]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Valid agents/);
});
