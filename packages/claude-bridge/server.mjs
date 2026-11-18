#!/usr/bin/env node
// claude-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// delegate execution work to Claude Code (`claude -p`). The orchestrator plans and reviews;
// Claude executes with file edits and only the exact commands allow-listed for this task.
// Returns a compact summary; the full event stream goes to a log file.
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
// Resolved on every call, so installing Claude Code does not require restarting the bridge.
const findExe = () =>
  process.env.CLAUDE_BIN ||
  [
    IS_WIN ? join(homedir(), ".local", "bin", "claude.exe") : null,
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
  ].filter(Boolean).find((p) => existsSync(p)) ||
  "claude";
const DEFAULT_MODEL = process.env.CLAUDE_BRIDGE_MODEL || ""; // empty = Claude Code's own default
// Log directory; set CLAUDE_BRIDGE_LOGS=off to disable logging entirely.
const LOG_DIR = process.env.CLAUDE_BRIDGE_LOGS || join(homedir(), ".mcp-agent-bridges", "logs", "claude");
const MAX_TEXT = Number(process.env.CLAUDE_BRIDGE_MAX_CHARS || 4000);
const DEFAULT_FALLBACKS = (process.env.CLAUDE_BRIDGE_FALLBACKS || "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = /usage limit|rate.?limit|too many requests|overloaded|\b529\b|quota|model.{0,40}(not found|not available|unavailable|does not exist)|invalid model/i;

const INSTRUCTIONS = `claude-bridge: delegate execution work to Claude Code (another coding agent).
Use it for mechanical, well-specified tasks: implementing an already-decided plan, refactors, tests, boilerplate, docs.
Do not use it for design decisions, hard debugging or security-sensitive changes.
Default mode is acceptEdits: it can create/edit files but can only run commands passed EXACTLY in allow_commands, for that task only.
By default the delegate gets no MCP servers, and nested delegation is forbidden. Set use_mcp only when the task specifically requires the delegate's configured MCP servers.
Flow: 1) plan; 2) call claude_task with a self-contained prompt (files, definition of done, what NOT to touch); 3) review and verify yourself (tests, diff); 4) for corrections pass session_id.`;

const TOOLS = [
  {
    name: "claude_task",
    description:
      "Run a task with Claude Code in print mode in a directory and return a compact summary (final answer, files written, commands, tokens, cost, session_id). Blocks until done.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained instruction." },
        cwd: { type: "string", description: "Absolute working directory (workspace)." },
        model: { type: "string", description: "Claude model alias or full id. Default: CLAUDE_BRIDGE_MODEL env, else Claude Code's default." },
        fallback_models: {
          type: "array", items: { type: "string" },
          description: "Models to try in order if the requested model hits a usage/capacity limit or is unavailable. The same session is resumed. Default: CLAUDE_BRIDGE_FALLBACKS env, else none.",
        },
        session_id: { type: "string", description: "Continue a previous session (--resume)." },
        timeout_s: { type: "number", description: "Time limit in seconds for the whole call (default 900). The agent and everything it started is stopped when it runs out." },
        mode: { type: "string", enum: ["acceptEdits", "plan"], description: "acceptEdits (default: edits files, only allow-listed commands) or plan (read-only)." },
        allow_commands: {
          type: "array", items: { type: "string" },
          description: "EXACT commands it may run in this task (literal match, no wildcards), e.g. [\"python -m unittest\"]. Default: none.",
        },
        use_mcp: { type: "boolean", description: "Allow the delegate to load its configured MCP servers (default false). Nested delegation is still blocked by the bridge depth guard." },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

// Claude Code refuses to start a nested session when it inherits its host session markers. Strip
// provider variables only in that case, with an explicit escape hatch for custom API endpoints.
function childEnv(env) {
  const entries = Object.entries(env);
  const get = (name) => entries.find(([k]) => k.toUpperCase() === name)?.[1];
  if (get("CLAUDECODE") === undefined && get("CLAUDE_CODE_ENTRYPOINT") === undefined) return env;
  const keep = new Set(String(get("CLAUDE_BRIDGE_KEEP_ENV") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  return Object.fromEntries(entries.filter(([k]) => {
    const name = k.toUpperCase();
    return keep.has(name) || (!name.startsWith("CLAUDE") && !name.startsWith("ANTHROPIC_"));
  }));
}

// Denials can be emitted after the assistant asks for a tool but before or after its tool_result,
// so parse the stream first and resolve command states only after collecting every denied id.
function summarize(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON CLI output */ }
  }
  const deniedIDs = new Set();
  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "permission_denied" && ev.tool_use_id) deniedIDs.add(ev.tool_use_id);
    if (ev.type === "result") for (const d of ev.permission_denials || []) if (d.tool_use_id) deniedIDs.add(d.tool_use_id);
  }

  const texts = [], errors = [], files = new Set(), tools = {}, calls = new Map(), commands = [];
  let sessionID, model, tokens, cost, result;
  for (const ev of events) {
    sessionID ||= ev.session_id;
    if (ev.type === "system" && ev.subtype === "init") model = ev.model || model;
    if (ev.type === "assistant") {
      for (const c of ev.message?.content || []) {
        if (c.type === "text" && c.text) texts.push(c.text);
        if (c.type !== "tool_use" || !c.name) continue;
        tools[c.name] = (tools[c.name] || 0) + 1;
        if (c.id) calls.set(c.id, { name: c.name, input: c.input || {} });
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) {
          const p = c.input?.file_path || c.input?.notebook_path;
          if (p) files.add(p);
        }
      }
    }
    if (ev.type === "user") {
      for (const c of ev.message?.content || []) {
        if (c.type !== "tool_result") continue;
        const call = calls.get(c.tool_use_id);
        if (!call || !/^(Bash|PowerShell)$/i.test(call.name)) continue;
        const content = Array.isArray(c.content) ? c.content.map((x) => x?.text || "").join("\n") : String(c.content || "");
        const match = content.match(/^Exit code\s+(-?\d+)\s*(?:\r?\n|$)/i);
        // Claude Code appends "Shell cwd was reset to ..." after commands; it is not the command's output.
        const body = (match ? content.slice(match[0].length) : content).replace(/^Shell cwd was reset to .*$/gm, "");
        const tail = lastLine(body);
        if (deniedIDs.has(c.tool_use_id)) commands.push({ cmd: call.input.command || "?", state: "blocked", detail: "not allowed" });
        else if (c.is_error) commands.push({ cmd: call.input.command || "?", state: "failed", detail: `exit ${match?.[1] ?? "?"} → ${tail}` });
        else commands.push({ cmd: call.input.command || "?", state: "ok", detail: `exit 0 → ${tail}` });
      }
    }
    if (ev.type === "result") {
      result = ev;
      if (ev.is_error || ev.subtype !== "success") errors.push(`result ${ev.subtype}: ${String(ev.result || "").slice(0, 300)}`);
      if (ev.usage) tokens = { input: ev.usage.input_tokens || 0, output: ev.usage.output_tokens || 0, cache_read: ev.usage.cache_read_input_tokens || 0 };
      if (typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
    }
    if (ev.type === "error") errors.push(JSON.stringify(ev).slice(0, 400));
  }
  let finalText = String(result?.result || texts.join("\n")).trim();
  if (finalText.length > MAX_TEXT) finalText = "…[truncated]\n" + finalText.slice(-MAX_TEXT);
  return { sessionID, model, finalText, errors, files: [...files], tools, tokens, cost, result, commands, denied: deniedIDs.size > 0 };
}

function preamble(cwd, allow) {
  return [
    `Working directory: ${cwd}. Work only inside it.`,
    allow.length
      ? `Running commands: you may ONLY use Bash with these commands, copied LITERALLY (same spacing, no "cd", no chaining with && or ;):\n${allow.map((c) => `  - ${c}`).join("\n")}\nAny other command is blocked.`
      : `Running commands: do NOT use Bash or PowerShell for anything (not to list files, not ls/dir, not python): it is blocked. Use only the read, search and edit file tools.`,
    "Do not delegate this task to other agents.",
  ].join("\n\n");
}

// The prompt (rules included) goes on stdin even through a Windows launcher, avoiding argv limits
// and cmd.exe cutting at line breaks. Only the small, single-line flags need shell quoting.
function run(args, cwd, env, input, timeoutMs, ctx) {
  const exe = findExe();
  if (IS_WIN && /\.(?:cmd|bat)$/i.test(exe)) {
    const q = (s) => (/[\s"&|<>^%!()]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    return runProcess(`${q(exe)} ${args.map(q).join(" ")}`, [], { cwd, env, shell: true, input, timeoutMs, ctx });
  }
  return runProcess(exe, args, { cwd, env, input, timeoutMs, ctx });
}

async function claudeTask(a, ctx) {
  if (!a.prompt) throw new Error("prompt is required");
  const cwd = resolve(a.cwd || process.cwd());
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const mode = a.mode === "plan" ? "plan" : "acceptEdits";
  const allow = Array.isArray(a.allow_commands) ? a.allow_commands.map((c) => String(c).trim()).filter(Boolean) : [];
  const primary = a.model || DEFAULT_MODEL;
  const fallbacks = (Array.isArray(a.fallback_models) ? a.fallback_models : DEFAULT_FALLBACKS).filter((m) => m && m !== primary);
  const chain = [primary, ...fallbacks];
  const rules = preamble(cwd, allow);
  const argsFor = (model, sessionID) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode];
    if (model) args.push("--model", model);
    if (sessionID) args.push("--resume", sessionID);
    for (const cmd of allow) args.push("--allowedTools", `Bash(${cmd})`);
    if (!a.use_mcp) args.push("--strict-mcp-config");
    return args;
  };

  const started = Date.now(), deadline = started + (a.timeout_s || 900) * 1000;
  const logs = [], attempts = [];
  const firstPrompt = `${rules}\n\n---\n\n${a.prompt}`;
  let r, s, model, sessionID = a.session_id, prompt = firstPrompt;
  for (let i = 0; i < chain.length; i++) {
    const left = deadline - Date.now();
    if (ctx?.cancelled || (i > 0 && left < MIN_RETRY_MS)) break;
    model = chain[i];
    r = await run(argsFor(model, sessionID), cwd, childEnv(process.env), prompt, left, ctx);
    s = summarize(r.out);
    const log = writeLog(LOG_DIR, s.sessionID || "nosession", r);
    if (log) logs.push(log);
    const good = r.code === 0 && !r.timedOut && !!s.result && !s.result.is_error && s.result.subtype === "success";
    const unavailable = !good && !r.timedOut && LIMIT.test(`${s.errors.join(" ")} ${s.result?.is_error ? s.result.result || "" : ""} ${r.err}`);
    attempts.push(`${model || "(default)"}: ${good ? "ok" : unavailable ? "usage/capacity/model unavailable" : r.timedOut ? "timeout" : "error"}`);
    if (good || r.timedOut || r.cancelled || !unavailable) break;
    sessionID = s.sessionID || sessionID;
    prompt = `The previous model became unavailable mid-task. Check the current state of the files and finish the original task without redoing what is already correct:\n\n${firstPrompt}`;
  }

  const ok = !!r && r.code === 0 && !r.timedOut && !!s.result && !s.result.is_error && s.result.subtype === "success";
  const blocked = s?.commands.filter((c) => c.state === "blocked").length || 0;
  const lines = [
    `status: ${ok ? "ok" : r?.timedOut ? "timeout (the agent and its processes were stopped)" : "error"} (exit ${r?.code ?? "-"}, ${Math.round((Date.now() - started) / 1000)}s)`,
    `session_id: ${s?.sessionID || sessionID || "-"}`,
    `model: ${s?.model || model || "(default)"} | mode: ${mode} | allowed commands: ${allow.length}`,
    attempts.length > 1 ? `attempts: ${attempts.join(" → ")}` : null,
    s?.files.length ? `files_edited: ${s.files.join(", ")}` : null,
    s && Object.keys(s.tools).length ? `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    s ? fmtCommands(s.commands) : null,
    s?.tokens ? `tokens: in ${s.tokens.input}, out ${s.tokens.output}, cache_read ${s.tokens.cache_read}` : null,
    s?.cost != null ? `cost_usd: ${s.cost.toFixed(4)}` : null,
    s?.errors.length ? `errors: ${s.errors.slice(0, 5).join(" | ")}` : null,
    !ok && r?.err?.trim() ? `stderr: ${r.err.trim().slice(-800)}` : null,
    logs.length ? `log: ${logs.join(", ")}` : null,
    blocked ? `note: ${blocked} command(s) were blocked by permissions; check that the task is complete` : null,
    "--- final answer ---",
    s?.finalText || "(no text)",
  ].filter(Boolean);
  return { text: lines.join("\n"), isError: !ok };
}

export { VERSION, summarize, runProcess, childEnv };
export function main() {
  serve({
    name: "claude-bridge", version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS,
    call: (name, args, ctx) => {
      if (name === "claude_task") return claudeTask(args, ctx);
      throw new Error(`unknown tool: ${name}`);
    },
  });
}
if (isMain(import.meta.url)) main();
