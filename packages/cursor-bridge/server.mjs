#!/usr/bin/env node
// cursor-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// (e.g. Claude Code) delegate execution work to the Cursor CLI agent (`cursor-agent -p`).
// The orchestrator plans and reviews; Cursor executes. Returns a compact summary; the full
// event stream goes to a log file.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const VERSION = "1.2.0";
const IS_WIN = process.platform === "win32";
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
// Resolved on every call, so it works even if the CLI is installed after the server starts.
const findExe = () =>
  process.env.CURSOR_AGENT_BIN ||
  (IS_WIN
    ? [join(LOCAL, "cursor-agent", "cursor-agent.cmd"), join(LOCAL, "cursor-agent", "agent.cmd"), join(homedir(), ".local", "bin", "cursor-agent.cmd")]
    : [join(homedir(), ".local", "bin", "cursor-agent")]
  ).find((p) => existsSync(p)) ||
  "cursor-agent";
// Windows: latest install under %LOCALAPPDATA%\cursor-agent\versions\<YYYY.MM.DD-hash>\{node.exe,index.js}.
// Spawning it directly (no shell) keeps multi-line prompts intact; cmd.exe cuts them at the first newline.
function findDirect() {
  if (process.env.CURSOR_AGENT_BIN || !IS_WIN) return null;
  const vdir = join(LOCAL, "cursor-agent", "versions");
  if (!existsSync(vdir)) return null;
  const dirs = readdirSync(vdir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      const pa = a.split("-")[0].split(".").map(Number), pb = b.split("-")[0].split(".").map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  for (const d of dirs) {
    const node = join(vdir, d, "node.exe"), index = join(vdir, d, "index.js");
    if (existsSync(node) && existsSync(index)) return { node, index };
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
        timeout_s: { type: "number", description: "Time limit in seconds (default 900)." },
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

function run(args, cwd, timeoutMs) {
  const direct = findDirect();
  const EXE = findExe();
  const env = childEnv();
  return new Promise((res) => {
    // Prefer the bundled node.exe + index.js (no shell). Fallback: the .cmd through a shell (single-line prompts only).
    const isCmd = /\.(cmd|bat)$/i.test(EXE) || !/\.(exe)$/i.test(EXE);
    const q = (s) => (/[\s"&|<>^%]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    const child = direct
      ? spawn(direct.node, [direct.index, ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env })
      : isCmd && IS_WIN
      ? spawn(`${q(EXE)} ${args.map(q).join(" ")}`, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env })
      : spawn(EXE, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(t); res({ code: -1, out, err: err + String(e), timedOut }); });
    child.on("close", (code) => { clearTimeout(t); res({ code, out, err, timedOut }); });
  });
}

function writeLog(name, r) {
  if (LOG_DIR === "off") return null;
  mkdirSync(LOG_DIR, { recursive: true });
  const log = join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_${name}.jsonl`);
  writeFileSync(log, r.out + (r.err ? `\n#STDERR\n${r.err}` : ""));
  return log;
}

const lastLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 100) || "";

function summarize(raw) {
  const texts = [], errors = [], files = new Set(), tools = {};
  const commands = []; // { cmd, ok, detail }
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
        const tail = lastLine(r.success.interleavedOutput || r.success.stdout + r.success.stderr);
        commands.push({ cmd, ok: r.success.exitCode === 0, detail: `exit ${r.success.exitCode}${tail ? ` → ${tail}` : ""}` });
      } else if (r.failure) commands.push({ cmd, ok: false, detail: `exit ${r.failure.exitCode ?? "?"} → ${lastLine(r.failure.interleavedOutput || r.failure.stderr || r.failure.stdout)}` });
      else commands.push({ cmd, ok: false, detail: `could not run: ${JSON.stringify(r.spawnError || r.error || r.rejected || r).slice(0, 120)}` });
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
const MODEL_UNAVAILABLE = /unavailable on free|model (is )?(not available|unavailable)|not available on your plan|upgrade to (pro|a paid)|invalid model|unknown model/i;

async function cursorTask(a) {
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
    if (left < 20000 && i > 0) break;
    model = chain[i];
    r = await run(buildArgs(model), cwd, left);
    s = summarize(r.out);
    const log = writeLog(s.sessionID || "nosession", r);
    if (log) logs.push(log);
    const good = r.code === 0 && !r.timedOut && s.errors.length === 0 && !!s.result;
    const unavailable = !good && MODEL_UNAVAILABLE.test(`${s.errors.join(" ")} ${r.err} ${s.finalText}`);
    attempts.push(`${model}: ${good ? "ok" : unavailable ? "not available for this account" : r.timedOut ? "timeout" : "error"}`);
    // Only fall back when the model itself is unavailable; other errors are reported as-is.
    if (!unavailable) break;
  }

  const ok = r.code === 0 && !r.timedOut && s.errors.length === 0 && !!s.result;
  const cmds = s.commands.map((c) => `${c.ok ? "✓" : "✗"} ${c.cmd.replace(/\s+/g, " ").slice(0, 120)} (${c.detail})`);
  const lines = [
    `status: ${ok ? "ok" : r.timedOut ? "timeout" : "error"} (exit ${r.code}, ${Math.round((Date.now() - started) / 1000)}s)`,
    `session_id: ${s.sessionID || a.session_id || "-"}`,
    `model: ${s.model || model}`,
    attempts.length > 1 ? `attempts: ${attempts.join(" → ")}` : null,
    s.files.length ? `files_edited: ${s.files.join(", ")}` : null,
    Object.keys(s.tools).length ? `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    cmds.length ? `commands:\n  ${cmds.slice(-10).join("\n  ")}` : null,
    s.errors.length ? `errors: ${s.errors.slice(0, 5).join(" | ")}` : null,
    !ok && r.err.trim() ? `stderr: ${r.err.trim().slice(-800)}` : null,
    logs.length ? `log: ${logs.join(", ")}` : null,
    "--- final answer ---",
    s.finalText || "(no text)",
  ].filter(Boolean);
  return { text: lines.join("\n"), isError: !ok };
}

async function cursorModels() {
  const r = await run(["--list-models"], process.cwd(), 60000);
  const text = (r.out + (r.err ? `\n${r.err}` : "")).trim();
  return { text: text || `(no output, exit ${r.code})`, isError: r.code !== 0 };
}

// ---- JSON-RPC over stdio (newline-delimited messages) ----
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cursor-bridge", version: VERSION },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const name = params?.name;
      const r = name === "cursor_task" ? await cursorTask(params.arguments || {})
        : name === "cursor_models" ? await cursorModels()
        : (() => { throw new Error(`unknown tool: ${name}`); })();
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], isError: r.isError } });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not supported: ${method}` } });
  } catch (e) {
    if (method === "tools/call") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true } });
    else send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore invalid line */ }
  }
});
