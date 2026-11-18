#!/usr/bin/env node
// opencode-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// (e.g. Claude Code) delegate execution work to the OpenCode CLI (`opencode run`).
// The orchestrator plans and reviews; OpenCode does the typing. Only a compact summary is
// returned to keep the orchestrator's context small; the full event stream goes to a log file.
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
const EXE =
  process.env.OPENCODE_BIN ||
  [join(process.env.APPDATA || "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")].find((p) => existsSync(p)) ||
  "opencode";
const DEFAULT_MODEL = process.env.OPENCODE_BRIDGE_MODEL || ""; // empty = OpenCode's own default
// Log directory; set OPENCODE_BRIDGE_LOGS=off to disable logging entirely.
const LOG_DIR = process.env.OPENCODE_BRIDGE_LOGS || join(homedir(), ".mcp-agent-bridges", "logs", "opencode");
const MAX_TEXT = Number(process.env.OPENCODE_BRIDGE_MAX_CHARS || 4000);
// Models tried in order when the requested one errors or exits without doing anything.
const DEFAULT_FALLBACKS = (process.env.OPENCODE_BRIDGE_FALLBACKS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const INSTRUCTIONS = `opencode-bridge: delegate execution work to OpenCode (another coding agent, often with cheaper or free models).
Use it for mechanical, well-specified tasks: implementing an already-decided plan, repetitive refactors, tests, boilerplate, renames, simple migrations, docs.
Do not use it for design decisions, hard debugging or security-sensitive changes; keep those yourself.
By default OpenCode auto-approves its non-denied permissions (auto_approve), so it can edit files and run commands in cwd: point it only at directories under version control.
Flow: 1) plan; 2) call opencode_task with a self-contained prompt (exact files, definition of done, verification command, what NOT to touch); 3) review the result with git diff / tests — do not trust the summary alone; 4) for corrections pass session_id to continue the same session instead of repeating context.
The result is intentionally compact; the full log path is included if you really need it.`;

const TOOLS = [
  {
    name: "opencode_task",
    description:
      "Run a task with the OpenCode agent in a directory and return a compact summary (final answer, files edited, commands run, errors, session_id). Blocks until done.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained instruction: goal, files, definition of done, verification, constraints." },
        cwd: { type: "string", description: "Absolute working directory (defaults to the server's cwd)." },
        model: { type: "string", description: "provider/model, e.g. opencode/deepseek-v4.1-flash-free. Optional." },
        fallback_models: {
          type: "array", items: { type: "string" },
          description: "Models to try in order if the main one errors or exits without doing anything (not on timeout). The same session is continued. Default: OPENCODE_BRIDGE_FALLBACKS env, else none.",
        },
        session_id: { type: "string", description: "Continue a previous session (for corrections)." },
        timeout_s: { type: "number", description: "Time limit in seconds for the whole call (default 900). The agent and everything it started is stopped when it runs out." },
        agent: { type: "string", description: "OpenCode agent (build, plan, ...). Optional." },
        files: { type: "array", items: { type: "string" }, description: "Files to attach to the message." },
        auto_approve: { type: "boolean", description: "Auto-approve non-denied permissions (default true; without it OpenCode cannot edit in non-interactive mode)." },
      },
      required: ["prompt"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

// Tolerant parser for the JSONL stream of `opencode run --format json`.
function summarize(raw) {
  const texts = [], errors = [], files = new Set(), tools = {};
  const commands = []; // { cmd, state, detail }
  let sessionID, tokens, cost;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    sessionID ||= ev.sessionID || ev.part?.sessionID;
    const part = ev.part || ev;
    const type = ev.type || part.type;
    if (type === "error" || ev.error) errors.push(ev.error?.message || JSON.stringify(ev.error || ev).slice(0, 300));
    if ((type === "text" || part.type === "text") && typeof part.text === "string") texts.push(part.text);
    const toolName = part.tool || part.name || (type?.startsWith?.("tool") ? type : undefined);
    if (toolName && (type?.includes?.("tool") || part.type === "tool")) {
      tools[toolName] = (tools[toolName] || 0) + 1;
      const input = part.state?.input || part.input || {};
      const fp = input.filePath || input.file_path || input.path;
      if (fp && /write|edit|patch/i.test(toolName)) files.add(fp);
      const st = part.state || {};
      if (/^(bash|shell)$/i.test(toolName) && (st.status === "completed" || st.status === "error") && input.command) {
        const md = st.metadata || {};
        const exit = md.metadata?.exit ?? md.exit;
        const outText = (md.content || []).map((c) => c.text || "").join("\n") || st.output || st.error || "";
        const ok = st.status === "completed" && (exit === undefined || exit === 0);
        commands.push({ cmd: input.command, state: ok ? "ok" : "failed", detail: `exit ${exit ?? "?"}${lastLine(outText) ? ` → ${lastLine(outText)}` : ""}` });
      }
    }
    const tk = part.tokens || ev.tokens;
    if (tk) {
      tokens ||= { input: 0, output: 0, cache_read: 0 };
      tokens.input += tk.input || 0;
      tokens.output += (tk.output || 0) + (tk.reasoning || 0);
      tokens.cache_read += tk.cache?.read || 0;
    }
    if (typeof (part.cost ?? ev.cost) === "number") cost = (cost || 0) + (part.cost ?? ev.cost);
  }
  let finalText = texts.join("\n").trim();
  if (finalText.length > MAX_TEXT) finalText = "…[truncated]\n" + finalText.slice(-MAX_TEXT);
  return { sessionID, finalText, errors, files: [...files], tools, tokens, cost, commands };
}

async function opencodeTask(a, ctx) {
  if (!a.prompt) throw new Error("prompt is required");
  const cwd = resolve(a.cwd || process.cwd());
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  // --standalone: private server whose cwd is the requested cwd. With the shared background
  // service, OpenCode v2 resolves relative paths against the directory the service started in.
  const buildArgs = (model, sessionID, prompt) => {
    const args = ["run", "--standalone", "--format", "json"];
    if (a.auto_approve !== false) args.push("--auto");
    if (model) args.push("-m", model);
    if (a.agent) args.push("--agent", a.agent);
    if (sessionID) args.push("-s", sessionID);
    for (const f of a.files || []) args.push("-f", f);
    args.push("--", prompt);
    return args;
  };
  const firstPrompt = `Working directory: ${cwd}. Work only inside it and use absolute paths.\n\n${a.prompt}`;
  const primary = a.model || DEFAULT_MODEL;
  const fallbacks = (Array.isArray(a.fallback_models) ? a.fallback_models : DEFAULT_FALLBACKS).filter((m) => m && m !== primary);
  const chain = [primary, ...fallbacks];

  const started = Date.now();
  const deadline = started + (a.timeout_s || 900) * 1000;
  const logs = [], attempts = [];
  let r, s, model, sessionID = a.session_id, prompt = firstPrompt;
  for (let i = 0; i < chain.length; i++) {
    const left = deadline - Date.now();
    if (ctx?.cancelled || (i > 0 && left < MIN_RETRY_MS)) break;
    model = chain[i];
    r = await runProcess(EXE, buildArgs(model, sessionID, prompt), { cwd, timeoutMs: left, ctx });
    s = summarize(r.out);
    const log = writeLog(LOG_DIR, s.sessionID || "nosession", r);
    if (log) logs.push(log);
    const did = s.finalText || Object.keys(s.tools).length;
    const good = r.code === 0 && !r.timedOut && s.errors.length === 0 && did;
    attempts.push(`${model || "(default)"}: ${good ? "ok" : r.timedOut ? "timeout" : !did ? "exited without doing anything" : "error"}`);
    // No fallback after a timeout or cancellation (the time budget is spent) or on success.
    if (good || r.timedOut || r.cancelled) break;
    sessionID = s.sessionID || sessionID;
    if (sessionID) prompt = `The previous attempt with another model failed or was cut off. Check the current state of the files and finish the original task:\n\n${firstPrompt}`;
  }

  const ok = r.code === 0 && !r.timedOut && s.errors.length === 0 && !!(s.finalText || Object.keys(s.tools).length);
  const lines = [
    `status: ${ok ? "ok" : r.timedOut ? "timeout (the agent and its processes were stopped)" : "error"} (exit ${r.code}, ${Math.round((Date.now() - started) / 1000)}s)`,
    `session_id: ${s.sessionID || sessionID || "-"}`,
    `model: ${model || "(default)"}`,
    attempts.length > 1 ? `attempts: ${attempts.join(" → ")}` : null,
    s.files.length ? `files_edited: ${s.files.join(", ")}` : null,
    Object.keys(s.tools).length ? `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    fmtCommands(s.commands),
    s.tokens ? `tokens: in ${s.tokens.input}, out ${s.tokens.output}, cache_read ${s.tokens.cache_read}` : null,
    s.cost != null ? `cost_usd: ${s.cost.toFixed(4)}` : null,
    s.errors.length ? `errors: ${s.errors.slice(0, 5).join(" | ")}` : null,
    !ok && r.err.trim() ? `stderr: ${r.err.trim().slice(-800)}` : null,
    logs.length ? `log: ${logs.join(", ")}` : null,
    "--- final answer ---",
    s.finalText || "(no text)",
  ].filter(Boolean);
  return { text: lines.join("\n"), isError: !ok };
}

export { VERSION, summarize, runProcess };
export function main() {
  serve({
    name: "opencode-bridge", version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS,
    call: (name, args, ctx) => {
      if (name === "opencode_task") return opencodeTask(args, ctx);
      throw new Error(`unknown tool: ${name}`);
    },
  });
}
if (isMain(import.meta.url)) main();
