#!/usr/bin/env node
// codex-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// delegate execution work to the OpenAI Codex CLI (`codex exec`). The orchestrator plans and
// reviews; Codex executes inside its own workspace-write or read-only sandbox. Returns a compact
// summary; the full event stream goes to a log file.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// <shared> ---------------------------------------------------------------------------------------
// Process handling and MCP over stdio. This block is identical in every bridge so each one
// stays a single file; test/shared.test.mjs fails if the copies drift apart.
const IS_WIN = process.platform === "win32";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]; // newest first
const DEPTH = Number(process.env.MCP_AGENT_BRIDGES_DEPTH) || 0;
const MAX_DEPTH = Number(process.env.MCP_AGENT_BRIDGES_MAX_DEPTH) || 1;
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
function runProcess(cmd, args, { cwd, env = process.env, shell = false, input, timeoutMs = 900000, ctx } = {}) {
  return new Promise((res) => {
    let out = "", err = "", timedOut = false, settled = false, grace;
    const childEnv = { ...env, MCP_AGENT_BRIDGES_DEPTH: String(DEPTH + 1) };
    const child = spawn(cmd, args, { cwd, env: childEnv, shell, windowsHide: true, detached: !IS_WIN, stdio: [typeof input === "string" ? "pipe" : "ignore", "pipe", "pipe"] });
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
    if (typeof input === "string") {
      child.stdin.on("error", (e) => { if (e.code !== "EPIPE") err += String(e); });
      child.stdin.end(input);
    }
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
        if (DEPTH >= MAX_DEPTH) {
          const text = `nested delegation blocked: this bridge was started by an agent that is itself a delegate (MCP_AGENT_BRIDGES_DEPTH=${DEPTH}, max ${MAX_DEPTH}). The orchestrator should do this itself or delegate it directly.`;
          return reply(id, { content: [{ type: "text", text }], isError: true });
        }
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

const VERSION = "1.2.0";
const DEFAULT_MODEL = process.env.CODEX_BRIDGE_MODEL || ""; // empty = Codex's own default
// Log directory; set CODEX_BRIDGE_LOGS=off to disable logging entirely.
const LOG_DIR = process.env.CODEX_BRIDGE_LOGS || join(homedir(), ".mcp-agent-bridges", "logs", "codex");
const MAX_TEXT = Number(process.env.CODEX_BRIDGE_MAX_CHARS || 4000);
const DEFAULT_FALLBACKS = (process.env.CODEX_BRIDGE_FALLBACKS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = /usage limit|rate.?limit|too many requests|quota|\b429\b|overloaded|capacity|model.{0,40}(not found|not supported|not available|unavailable|does not exist)|unsupported model/i;

const INSTRUCTIONS = `codex-bridge: delegate execution work to the OpenAI Codex CLI (codex exec).
Use it for mechanical, well-specified tasks: implementing an already-decided plan, refactors, tests, boilerplate, docs.
Do not use it for design decisions, hard debugging or security-sensitive changes.
Default sandbox is workspace-write; use read-only for analysis and planning. Approval policy is always never, with no full-access or permission-bypass option.
Flow: 1) plan; 2) call codex_task with a self-contained prompt (files, definition of done, verification, what NOT to touch); 3) review with git diff / tests; 4) for corrections pass session_id.
This bridge runs the Codex CLI as an executor; it is unrelated to the official codex mcp-server.`;

const TOOLS = [
  {
    name: "codex_task",
    description:
      "Run a task with Codex CLI in a directory and return a compact summary (final answer, files written, commands, tokens, session_id). Blocks until done.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained instruction." },
        cwd: { type: "string", description: "Absolute working directory (workspace)." },
        model: { type: "string", description: "Codex model. Default: CODEX_BRIDGE_MODEL env, else Codex's own default." },
        fallback_models: {
          type: "array", items: { type: "string" },
          description: "Models to try in order if the requested model hits a usage/capacity limit or is unavailable. The same thread is resumed. Default: CODEX_BRIDGE_FALLBACKS env, else none.",
        },
        session_id: { type: "string", description: "Continue a previous Codex thread (exec resume)." },
        timeout_s: { type: "number", description: "Time limit in seconds for the whole call (default 900). The agent and everything it started is stopped when it runs out." },
        sandbox: { type: "string", enum: ["workspace-write", "read-only"], description: "workspace-write (default) or read-only." },
        effort: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh"], description: "Model reasoning effort. Optional." },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

// Resolve on every call. On Windows prefer the installed JS entry point so prompts and flags do
// not pass through npm's cmd.exe launcher.
function findExe() {
  if (process.env.CODEX_BIN) return { exe: process.env.CODEX_BIN, prefix: [] };
  const npmJS = process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (IS_WIN && npmJS && existsSync(npmJS)) return { exe: process.execPath, prefix: [npmJS] };
  const exe = [join(homedir(), ".local", "bin", "codex"), "/usr/local/bin/codex", "/opt/homebrew/bin/codex"].find((p) => existsSync(p)) || "codex";
  return { exe, prefix: [] };
}

// Codex wraps commands in the platform shell. Reports are easier to verify when they show the
// script the agent intended instead of the shell executable and its invocation flags.
function unwrapShell(command) {
  const m = String(command || "").match(/^\s*(?:"([^"]+)"|(\S+))\s+(-Command|\/c|-lc|-c)\s+(['"])([\s\S]*)\4\s*$/i);
  if (!m) return String(command || "");
  const exe = (m[1] || m[2]).replace(/\\/g, "/").split("/").pop().toLowerCase();
  const flag = m[3].toLowerCase();
  const powershell = /^(?:pwsh|powershell)(?:\.exe)?$/.test(exe) && flag === "-command";
  const cmd = /^cmd(?:\.exe)?$/.test(exe) && flag === "/c";
  const posix = /^(?:bash|sh|zsh)(?:\.exe)?$/.test(exe) && (flag === "-lc" || flag === "-c");
  return powershell || cmd || posix ? m[5] : String(command || "");
}

// Tolerant parser for the JSONL stream of `codex exec --json`.
function summarize(raw) {
  const texts = [], errors = [], files = new Set(), tools = {}, commands = [];
  let sessionID, tokens, completed = false, failed = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "thread.started") sessionID ||= ev.thread_id;
    if (ev.type === "item.completed" && ev.item) {
      const item = ev.item;
      let tool;
      if (item.type === "command_execution") tool = "shell";
      else if (item.type === "file_change") tool = "edit";
      else if (item.type === "mcp_tool_call") tool = `mcp:${item.server}.${item.tool}`;
      else if (item.type === "web_search") tool = "web_search";
      else if (item.type !== "agent_message" && item.type !== "reasoning") tool = item.type;
      if (tool) tools[tool] = (tools[tool] || 0) + 1;

      if (item.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
      if (item.type === "file_change") for (const c of item.changes || []) if (c.path) files.add(c.path);
      if (item.type === "command_execution") {
        const cmd = unwrapShell(item.command), tail = lastLine(item.aggregated_output);
        // Codex's Windows sandbox sometimes cannot start the shell at all (exit -1 or none); say so
        // plainly instead of quoting the tail of its long diagnostic line.
        const noStart = String(item.aggregated_output || "").match(/^Failed to create (?:unified )?exec process:?\s*([^|\r\n]*)/i);
        if (item.status === "declined") commands.push({ cmd, state: "blocked", detail: "declined" });
        else if (noStart) commands.push({ cmd, state: "failed", detail: `could not run → ${noStart[1].trim().slice(0, 100)}` });
        else if (item.exit_code === 0) commands.push({ cmd, state: "ok", detail: `exit 0 → ${tail}` });
        else if (typeof item.exit_code === "number") commands.push({ cmd, state: "failed", detail: `exit ${item.exit_code} → ${tail}` });
        else if (item.status === "failed") commands.push({ cmd, state: "failed", detail: `could not run → ${tail}` });
      }
    }
    if (ev.type === "turn.completed") {
      completed = true;
      const u = ev.usage || {};
      tokens ||= { input: 0, output: 0, cache_read: 0 };
      tokens.input += u.input_tokens || 0;
      tokens.output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
      tokens.cache_read += u.cached_input_tokens || 0;
    }
    if (ev.type === "error") errors.push(String(ev.message || "error"));
    if (ev.type === "turn.failed") {
      const message = ev.error?.message || "error";
      errors.push(`turn failed: ${message}`);
      failed = true;
    }
  }
  let finalText = texts.at(-1) || "";
  if (finalText.length > MAX_TEXT) finalText = "…[truncated]\n" + finalText.slice(-MAX_TEXT);
  return { sessionID, finalText, errors, files: [...files], tools, tokens, commands, completed, failed };
}

function preamble(cwd) {
  return `Working directory: ${cwd}. Work only inside it.\n\nDo not delegate this task to other agents.`;
}

// The prompt goes on stdin even through a Windows launcher, avoiding argv limits and cmd.exe
// cutting at line breaks. Only the small, single-line flags need shell quoting.
function run(args, cwd, input, timeoutMs, ctx) {
  const { exe, prefix } = findExe();
  const all = [...prefix, ...args];
  if (IS_WIN && /\.(?:cmd|bat)$/i.test(exe)) {
    const q = (s) => (/[\s"&|<>^%!()]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    return runProcess(`${q(exe)} ${all.map(q).join(" ")}`, [], { cwd, shell: true, input, timeoutMs, ctx });
  }
  return runProcess(exe, all, { cwd, input, timeoutMs, ctx });
}

async function codexTask(a, ctx) {
  if (!a.prompt) throw new Error("prompt is required");
  const cwd = resolve(a.cwd || process.cwd());
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const sandbox = a.sandbox === "read-only" ? "read-only" : "workspace-write";
  const primary = a.model || DEFAULT_MODEL;
  const fallbacks = (Array.isArray(a.fallback_models) ? a.fallback_models : DEFAULT_FALLBACKS).filter((m) => m && m !== primary);
  const chain = [primary, ...fallbacks];
  const rules = preamble(cwd);
  const argsFor = (model, sessionID) => {
    const args = ["exec"];
    if (sessionID) args.push("resume");
    args.push("--json", "--skip-git-repo-check", "-c", `sandbox_mode=${sandbox}`, "-c", "approval_policy=never");
    if (model) args.push("-m", model);
    if (a.effort) args.push("-c", `model_reasoning_effort=${a.effort}`);
    if (sessionID) args.push(sessionID);
    args.push("-");
    return args;
  };

  const started = Date.now(), deadline = started + (a.timeout_s || 900) * 1000;
  const logs = [], attempts = [];
  let r, s, model, sessionID = a.session_id, taskPrompt = a.prompt;
  for (let i = 0; i < chain.length; i++) {
    const left = deadline - Date.now();
    if (ctx?.cancelled || (i > 0 && left < MIN_RETRY_MS)) break;
    model = chain[i];
    const prompt = `${rules}\n\n---\n\n${taskPrompt}`;
    r = await run(argsFor(model, sessionID), cwd, prompt, left, ctx);
    s = summarize(r.out);
    const log = writeLog(LOG_DIR, s.sessionID || "nosession", r);
    if (log) logs.push(log);
    const good = r.code === 0 && !r.timedOut && s.completed && !s.failed && s.errors.length === 0;
    const unavailable = !good && !r.timedOut && LIMIT.test(`${s.errors.join(" ")} ${r.err}`);
    attempts.push(`${model || "(default)"}: ${good ? "ok" : unavailable ? "usage/capacity/model unavailable" : r.timedOut ? "timeout" : "error"}`);
    if (good || r.timedOut || r.cancelled || !unavailable) break;
    sessionID = s.sessionID || sessionID;
    taskPrompt = `The previous model became unavailable mid-task. Check the current state of the files and finish the original task without redoing what is already correct:\n\n${a.prompt}`;
  }

  const ok = !!r && r.code === 0 && !r.timedOut && s.completed && !s.failed && s.errors.length === 0;
  const couldNotRun = s?.commands.filter((c) => c.detail?.startsWith("could not run")).length || 0;
  const lines = [
    `status: ${ok ? "ok" : r?.timedOut ? "timeout (the agent and its processes were stopped)" : "error"} (exit ${r?.code ?? "-"}, ${Math.round((Date.now() - started) / 1000)}s)`,
    `session_id: ${s?.sessionID || sessionID || "-"}`,
    `model: ${model || "(default)"} | sandbox: ${sandbox}`,
    attempts.length > 1 ? `attempts: ${attempts.join(" → ")}` : null,
    s?.files.length ? `files_edited: ${s.files.join(", ")}` : null,
    s && Object.keys(s.tools).length ? `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    s ? fmtCommands(s.commands) : null,
    s?.tokens ? `tokens: in ${s.tokens.input}, out ${s.tokens.output}, cache_read ${s.tokens.cache_read}` : null,
    s?.errors.length ? `errors: ${s.errors.slice(0, 5).join(" | ")}` : null,
    !ok && r?.err?.trim() ? `stderr: ${r.err.trim().slice(-800)}` : null,
    logs.length ? `log: ${logs.join(", ")}` : null,
    couldNotRun ? `note: ${couldNotRun} command(s) could not start (Codex sandbox); check that the task is complete` : null,
    "--- final answer ---",
    s?.finalText || "(no text)",
  ].filter(Boolean);
  return { text: lines.join("\n"), isError: !ok };
}

export { VERSION, summarize, runProcess };
export function main() {
  serve({
    name: "codex-bridge", version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS,
    call: (name, args, ctx) => {
      if (name === "codex_task") return codexTask(args, ctx);
      throw new Error(`unknown tool: ${name}`);
    },
  });
}
if (isMain(import.meta.url)) main();
