#!/usr/bin/env node
// cursor-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// (e.g. Claude Code) delegate execution work to the Cursor CLI agent (`cursor-agent -p`).
// The orchestrator plans and reviews; Cursor executes. Returns a compact summary; the full
// event stream goes to a log file.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// <shared> ---------------------------------------------------------------------------------------
// Process handling and MCP over stdio. This block is identical in the three bridges so each one
// stays a single file; test/shared.test.mjs fails if the copies drift apart.
const IS_WIN = process.platform === "win32";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]; // newest first
const MIN_RETRY_MS = 20000; // do not start a fallback attempt with less time than this left
const MARK = { ok: "✓", failed: "✗", blocked: "⛔" };
const lastLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 100) || "";

// Stop a process and everything it started. child.kill() alone leaves grandchildren running
// (and holding our pipes open, so "close" never fires) on every OS.
function killTree(child) {
  if (!child.pid) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  const signal = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 3000).unref();
}

// Run one CLI call. Always resolves: on exit, on timeout and on cancellation (ctx), killing the
// whole process tree in the last two cases.
function runProcess(cmd, args, { cwd, env = process.env, shell = false, timeoutMs = 900000, ctx } = {}) {
  return new Promise((res) => {
    let out = "", err = "", timedOut = false, settled = false, grace;
    const child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, detached: !IS_WIN, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      ctx?.stops.delete(stop);
      child.stdout?.destroy();
      child.stderr?.destroy();
      res({ code, out, err: err + extra, timedOut, cancelled: !!ctx?.cancelled });
    };
    const stop = () => { killTree(child); grace ??= setTimeout(() => finish(child.exitCode), 5000); };
    ctx?.stops.add(stop);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutMs));
    // If the CLI exits but something it started keeps our pipes open, do not wait for it.
    child.on("exit", (code) => { grace ??= setTimeout(() => finish(code), 2000); });
    child.on("error", (e) => finish(-1, String(e)));
    child.on("close", (code) => finish(code));
  });
}

function writeLog(dir, name, r) {
  if (!dir || dir === "off") return null;
  try {
    mkdirSync(dir, { recursive: true });
    const log = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}.jsonl`);
    writeFileSync(log, r.out + (r.err ? `\n#STDERR\n${r.err}` : ""));
    return log;
  } catch {
    return null; // a log that cannot be written must not fail the task
  }
}

// commands: [{ cmd, state: "ok" | "failed" | "blocked", detail? }] → report lines (the last 10).
function fmtCommands(commands, max = 10) {
  if (!commands.length) return null;
  const shown = commands.slice(-max).map((c) => `${MARK[c.state] || MARK.failed} ${String(c.cmd).replace(/\s+/g, " ").slice(0, 120)}${c.detail ? ` (${c.detail})` : ""}`);
  const skipped = commands.length - shown.length;
  return `commands:${skipped ? `\n  … ${skipped} earlier command(s) not shown` : ""}\n  ${shown.join("\n  ")}`;
}

// Minimal MCP server over stdio (newline-delimited JSON-RPC): tools, ping, progress, cancellation.
function serve({ name, version, instructions, tools, call }) {
  const running = new Map(); // request id → ctx
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const cancel = (ctx) => {
    if (!ctx || ctx.cancelled) return;
    ctx.cancelled = true;
    for (const stop of [...ctx.stops]) stop();
  };
  async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined || id === null) {
      if (method === "notifications/cancelled") cancel(running.get(params?.requestId));
      return;
    }
    try {
      if (method === "initialize") {
        const protocolVersion = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
        return reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version }, instructions });
      }
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools });
      if (method === "tools/call") {
        const ctx = { cancelled: false, stops: new Set() };
        running.set(id, ctx);
        const token = params?._meta?.progressToken, started = Date.now();
        const beat = token === undefined ? null : setInterval(() => {
          const s = Math.round((Date.now() - started) / 1000);
          send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: s, message: `running for ${s}s` } });
        }, 15000);
        try {
          const r = await call(params?.name, params?.arguments || {}, ctx);
          if (!ctx.cancelled) reply(id, { content: [{ type: "text", text: r.text }], isError: r.isError });
        } catch (e) {
          if (!ctx.cancelled) reply(id, { content: [{ type: "text", text: String(e?.message || e) }], isError: true });
        } finally {
          clearInterval(beat);
          running.delete(id);
        }
        return;
      }
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${method}` } });
    } catch (e) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e) } });
    }
  }
  // When the client goes away, stop every agent still running instead of leaving it orphaned.
  const shutdown = () => {
    for (const ctx of running.values()) cancel(ctx);
    process.exit(0);
  };
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; /* ignore invalid line */ }
      handle(msg);
    }
  });
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// True when this file is the script node was started with (not when imported by bin/cli.mjs or tests).
function isMain(url) {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}
// </shared> --------------------------------------------------------------------------------------

const VERSION = "1.1.0";
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
// Resolved on every call, so it works even if the CLI is installed after the server starts.
const findExe = () =>
  process.env.CURSOR_AGENT_BIN ||
  (IS_WIN
    ? [join(LOCAL, "cursor-agent", "cursor-agent.cmd"), join(LOCAL, "cursor-agent", "agent.cmd"), join(homedir(), ".local", "bin", "cursor-agent.cmd")]
    : [join(homedir(), ".local", "bin", "cursor-agent")]
  ).find((p) => existsSync(p)) ||
  "cursor-agent";

// Windows: the .cmd launcher runs <install>\versions\<version>\{node.exe,index.js} through cmd.exe
// and PowerShell, which cut the prompt at the first line break. Find that node.exe + index.js and
// spawn it directly (no shell) so the prompt arrives intact. Looks next to CURSOR_AGENT_BIN when it
// is set (a launcher in its install folder), otherwise in the default install folder.
const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;
function findDirect(exe) {
  if (!IS_WIN || /\.exe$/i.test(exe)) return null;
  const bin = process.env.CURSOR_AGENT_BIN;
  for (const root of [bin ? dirname(bin) : join(LOCAL, "cursor-agent")]) {
    const here = { node: join(root, "node.exe"), index: join(root, "index.js") };
    if (existsSync(here.node) && existsSync(here.index)) return here;
    const vdir = join(root, "versions");
    if (!existsSync(vdir)) continue;
    let dirs;
    try { dirs = readdirSync(vdir, { withFileTypes: true }); } catch { continue; }
    const key = (name) => name.match(VERSION_DIR).slice(1, 7).map((n) => (n === undefined ? -1 : Number(n)));
    const sorted = dirs
      .filter((d) => d.isDirectory() && VERSION_DIR.test(d.name))
      .map((d) => ({ name: d.name, k: key(d.name) }))
      .sort((a, b) => { for (let i = 0; i < 6; i++) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i]; return 0; });
    for (const { name } of sorted) {
      const node = join(vdir, name, "node.exe"), index = join(vdir, name, "index.js");
      if (existsSync(node) && existsSync(index)) return { node, index };
    }
  }
  return null;
}
const DEFAULT_MODEL = process.env.CURSOR_BRIDGE_MODEL || ""; // empty = "auto"
// Log directory; set CURSOR_BRIDGE_LOGS=off to disable logging entirely.
const LOG_DIR = process.env.CURSOR_BRIDGE_LOGS || join(homedir(), ".mcp-agent-bridges", "logs", "cursor");
const MAX_TEXT = Number(process.env.CURSOR_BRIDGE_MAX_CHARS || 4000);
// Models tried in order when the requested model is not available for the account's plan.
const DEFAULT_FALLBACKS = (process.env.CURSOR_BRIDGE_FALLBACKS || "auto").split(",").map((s) => s.trim()).filter(Boolean);

const INSTRUCTIONS = `cursor-bridge: delegate execution work to the Cursor CLI agent (cursor-agent).
Use it for mechanical, well-specified tasks: implementing an already-decided plan, refactors, tests, boilerplate, docs.
Do not use it for design decisions, hard debugging or security-sensitive changes.
By default it runs with --force and --trust, so it can edit files and run commands in cwd without asking: point it only at directories under version control.
Flow: 1) plan; 2) call cursor_task with a self-contained prompt (files, definition of done, verification, what NOT to touch); 3) review with git diff / tests; 4) for corrections pass session_id.
cursor_models lists the models available to the account.`;

const TOOLS = [
  {
    name: "cursor_task",
    description:
      "Run a task with cursor-agent in headless mode (-p) in a directory and return a compact summary (final answer, files written, commands run, session_id). Blocks until done.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained instruction." },
        cwd: { type: "string", description: "Absolute working directory (workspace)." },
        model: { type: "string", description: "Cursor model (see cursor_models). Default: auto." },
        fallback_models: {
          type: "array", items: { type: "string" },
          description: "Models to try in order if the requested model is not available for the account's plan. Default: CURSOR_BRIDGE_FALLBACKS env, else [\"auto\"]. [] = no fallback.",
        },
        session_id: { type: "string", description: "Continue a previous chat (--resume)." },
        timeout_s: { type: "number", description: "Time limit in seconds for the whole call (default 900). The agent and everything it started is stopped when it runs out." },
        mode: { type: "string", enum: ["agent", "plan", "ask"], description: "agent (default, edits), plan or ask (read-only)." },
        force: { type: "boolean", description: "Allow commands/writes without confirmation (default true; without it the agent cannot edit headless)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "cursor_models",
    description: "List the models available in Cursor CLI for the current account (also checks that the login works).",
    inputSchema: { type: "object", properties: {} },
  },
];

// On Windows cursor-agent only accepts a bash.exe whose path looks like Git Bash, and looks for it on PATH.
// The system PATH often only has Git\cmd (no bash.exe), so the agent fails with "Can't find Bash" and cannot
// run any command. Prepend the Git Bash folder to PATH for the child process only.
function childEnv() {
  const env = { ...process.env, CURSOR_INVOKED_AS: "cursor-agent.cmd" };
  if (!IS_WIN) return env;
  const candidates = [
    process.env.CURSOR_BRIDGE_GIT_BASH_DIR,
    join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin"),
    join(LOCAL, "Programs", "Git", "bin"),
  ].filter(Boolean);
  const dir = candidates.find((d) => existsSync(join(d, "bash.exe")));
  if (!dir) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "Path";
  const parts = (env[key] || "").split(";");
  if (!parts.some((p) => p.replace(/[\\/]+$/, "").toLowerCase() === dir.toLowerCase())) env[key] = [dir, ...parts].join(";");
  return env;
}

// Start cursor-agent. Returns the run result plus `flattened` when the prompt had to go through
// cmd.exe (no direct install found), which cannot carry line breaks: they are replaced by spaces
// so the whole prompt still arrives instead of only its first line.
async function run(args, cwd, timeoutMs, ctx) {
  const exe = findExe();
  const direct = findDirect(exe);
  const env = childEnv();
  if (direct) return runProcess(direct.node, [direct.index, ...args], { cwd, env, timeoutMs, ctx });
  if (IS_WIN && !/\.exe$/i.test(exe)) {
    const q = (s) => (/[\s"&|<>^%!()]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    const flat = args.map((s) => String(s).replace(/\s*\r?\n\s*/g, " "));
    const flattened = flat.some((s, i) => s !== args[i]);
    const r = await runProcess(`${q(exe)} ${flat.map(q).join(" ")}`, [], { cwd, env, shell: true, timeoutMs, ctx });
    return { ...r, flattened };
  }
  return runProcess(exe, args, { cwd, env, timeoutMs, ctx });
}

function summarize(raw) {
  const texts = [], errors = [], files = new Set(), tools = {};
  const commands = []; // { cmd, state, detail }
  let sessionID, model, result;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    sessionID ||= ev.session_id;
    if (ev.type === "system" && ev.model) model = ev.model;
    if (ev.type === "assistant") {
      for (const c of ev.message?.content || []) if (c.type === "text" && c.text) texts.push(c.text);
    }
    if (ev.type === "tool_call" && ev.subtype === "started" && ev.tool_call) {
      const key = Object.keys(ev.tool_call)[0];
      const name = key === "function" ? ev.tool_call.function?.name || "function" : key.replace(/ToolCall$/, "");
      tools[name] = (tools[name] || 0) + 1;
      const p = ev.tool_call[key]?.args?.path;
      if (p && /write|edit|delete|patch/i.test(key)) files.add(p);
    }
    if (ev.type === "tool_call" && ev.subtype === "completed" && ev.tool_call?.shellToolCall) {
      const sh = ev.tool_call.shellToolCall, r = sh.result || {};
      const cmd = sh.args?.command || "?";
      if (r.success) {
        const tail = lastLine(r.success.interleavedOutput || `${r.success.stdout || ""}${r.success.stderr || ""}`);
        commands.push({ cmd, state: r.success.exitCode === 0 ? "ok" : "failed", detail: `exit ${r.success.exitCode}${tail ? ` → ${tail}` : ""}` });
      } else if (r.failure) commands.push({ cmd, state: "failed", detail: `exit ${r.failure.exitCode ?? "?"} → ${lastLine(r.failure.interleavedOutput || r.failure.stderr || r.failure.stdout)}` });
      else if (r.rejected) commands.push({ cmd, state: "blocked", detail: "rejected" });
      else commands.push({ cmd, state: "failed", detail: `could not run: ${JSON.stringify(r.spawnError || r.error || r).slice(0, 120)}` });
    }
    if (ev.type === "result") {
      result = ev;
      if (ev.is_error) errors.push(String(ev.result || "error").slice(0, 400));
    }
    if (ev.type === "error") errors.push(JSON.stringify(ev).slice(0, 400));
  }
  let finalText = (result?.result || texts.join("\n")).trim();
  if (finalText.length > MAX_TEXT) finalText = "…[truncated]\n" + finalText.slice(-MAX_TEXT);
  return { sessionID, model, finalText, errors, files: [...files], tools, result, commands };
}

// Errors meaning the requested model is not available for the account (e.g. on the Free plan).
// Matched against errors and stderr only, never against the agent's own answer.
const MODEL_UNAVAILABLE = /unavailable on free|model (is )?(not available|unavailable)|not available on your plan|upgrade to (pro|a paid)|invalid model|unknown model/i;

async function cursorTask(a, ctx) {
  if (!a.prompt) throw new Error("prompt is required");
  const cwd = resolve(a.cwd || process.cwd());
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const buildArgs = (model) => {
    const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", cwd];
    if (a.force !== false) args.push("--force");
    if (model) args.push("--model", model);
    if (a.mode && a.mode !== "agent") args.push("--mode", a.mode);
    if (a.session_id) args.push("--resume", a.session_id);
    args.push(`Working directory: ${cwd}. Work only inside it.\n\n${a.prompt}`);
    return args;
  };
  const requested = a.model || DEFAULT_MODEL || "auto";
  const fallbacks = (Array.isArray(a.fallback_models) ? a.fallback_models : DEFAULT_FALLBACKS).filter((m) => m && m !== requested);
  const chain = [requested, ...fallbacks];

  const started = Date.now();
  const deadline = started + (a.timeout_s || 900) * 1000;
  let model, r, s;
  const logs = [], attempts = [];
  for (let i = 0; i < chain.length; i++) {
    const left = deadline - Date.now();
    if (ctx?.cancelled || (i > 0 && left < MIN_RETRY_MS)) break;
    model = chain[i];
    r = await run(buildArgs(model), cwd, left, ctx);
    s = summarize(r.out);
    const log = writeLog(LOG_DIR, s.sessionID || "nosession", r);
    if (log) logs.push(log);
    const good = r.code === 0 && !r.timedOut && s.errors.length === 0 && !!s.result;
    const unavailable = !good && !r.timedOut && MODEL_UNAVAILABLE.test(`${s.errors.join(" ")} ${r.err}`);
    attempts.push(`${model}: ${good ? "ok" : unavailable ? "not available for this account" : r.timedOut ? "timeout" : "error"}`);
    // Only fall back when the model itself is unavailable; other errors are reported as-is.
    if (!unavailable || r.cancelled) break;
  }

  const ok = r.code === 0 && !r.timedOut && s.errors.length === 0 && !!s.result;
  const lines = [
    `status: ${ok ? "ok" : r.timedOut ? "timeout (the agent and its processes were stopped)" : "error"} (exit ${r.code}, ${Math.round((Date.now() - started) / 1000)}s)`,
    `session_id: ${s.sessionID || a.session_id || "-"}`,
    `model: ${s.model || model}`,
    attempts.length > 1 ? `attempts: ${attempts.join(" → ")}` : null,
    r.flattened ? "note: no direct cursor-agent install was found, so the prompt went through cmd.exe and its line breaks were replaced by spaces (see CURSOR_AGENT_BIN in docs/configuration.md)" : null,
    s.files.length ? `files_edited: ${s.files.join(", ")}` : null,
    Object.keys(s.tools).length ? `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    fmtCommands(s.commands),
    s.errors.length ? `errors: ${s.errors.slice(0, 5).join(" | ")}` : null,
    !ok && r.err.trim() ? `stderr: ${r.err.trim().slice(-800)}` : null,
    logs.length ? `log: ${logs.join(", ")}` : null,
    "--- final answer ---",
    s.finalText || "(no text)",
  ].filter(Boolean);
  return { text: lines.join("\n"), isError: !ok };
}

async function cursorModels(ctx) {
  const r = await run(["--list-models"], process.cwd(), 60000, ctx);
  const text = (r.out + (r.err ? `\n${r.err}` : "")).trim();
  return { text: text || `(no output, exit ${r.code})`, isError: r.code !== 0 };
}

export { VERSION, summarize, runProcess };
export function main() {
  serve({
    name: "cursor-bridge", version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS,
    call: (name, args, ctx) => {
      if (name === "cursor_task") return cursorTask(args, ctx);
      if (name === "cursor_models") return cursorModels(ctx);
      throw new Error(`unknown tool: ${name}`);
    },
  });
}
if (isMain(import.meta.url)) main();
