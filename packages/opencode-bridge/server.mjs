#!/usr/bin/env node
// opencode-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// (e.g. Claude Code) delegate execution work to the OpenCode CLI (`opencode run`).
// The orchestrator plans and reviews; OpenCode does the typing. Only a compact summary is
// returned to keep the orchestrator's context small; the full event stream goes to a log file.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
const lastLine = (s) => String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 100) || "";

const INSTRUCTIONS = `opencode-bridge: delegate execution work to OpenCode (another coding agent, often with cheaper or free models).
Use it for mechanical, well-specified tasks: implementing an already-decided plan, repetitive refactors, tests, boilerplate, renames, simple migrations, docs.
Do not use it for design decisions, hard debugging or security-sensitive changes; keep those yourself.
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
        timeout_s: { type: "number", description: "Time limit in seconds (default 900)." },
        agent: { type: "string", description: "OpenCode agent (build, plan, ...). Optional." },
        files: { type: "array", items: { type: "string" }, description: "Files to attach to the message." },
        auto_approve: { type: "boolean", description: "Auto-approve non-denied permissions (default true; without it OpenCode cannot edit in non-interactive mode)." },
      },
      required: ["prompt"],
    },
  },
];

function runOpencode(args, cwd, timeoutMs) {
  return new Promise((res) => {
    const child = spawn(EXE, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

// Tolerant parser for the JSONL stream of `opencode run --format json`.
function summarize(raw) {
  const texts = [], errors = [], files = new Set(), tools = {};
  const commands = []; // { cmd, ok, detail }
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
        commands.push({ cmd: input.command, ok: st.status === "completed" && (exit === undefined || exit === 0), detail: `exit ${exit ?? "?"}${lastLine(outText) ? ` → ${lastLine(outText)}` : ""}` });
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

async function opencodeTask(a) {
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
    if (left < 30000 && i > 0) break;
    model = chain[i];
    r = await runOpencode(buildArgs(model, sessionID, prompt), cwd, left);
    s = summarize(r.out);
    const log = writeLog(s.sessionID || "nosession", r);
    if (log) logs.push(log);
    const did = s.finalText || Object.keys(s.tools).length;
    const good = r.code === 0 && !r.timedOut && s.errors.length === 0 && did;
    attempts.push(`${model || "(default)"}: ${good ? "ok" : r.timedOut ? "timeout" : !did ? "exited without doing anything" : "error"}`);
    // No fallback after a timeout (the time budget is spent) or on success.
    if (good || r.timedOut) break;
    sessionID = s.sessionID || sessionID;
    if (sessionID) prompt = `The previous attempt with another model failed or was cut off. Check the current state of the files and finish the original task:\n\n${firstPrompt}`;
  }

  const ok = r.code === 0 && !r.timedOut && s.errors.length === 0 && !!(s.finalText || Object.keys(s.tools).length);
  const cmds = s.commands.map((c) => `${c.ok ? "✓" : "✗"} ${c.cmd.replace(/\s+/g, " ").slice(0, 120)} (${c.detail})`);
  const lines = [
    `status: ${ok ? "ok" : r.timedOut ? "timeout" : "error"} (exit ${r.code}, ${Math.round((Date.now() - started) / 1000)}s)`,
    `session_id: ${s.sessionID || sessionID || "-"}`,
    `model: ${model || "(default)"}`,
    attempts.length > 1 ? `attempts: ${attempts.join(" → ")}` : null,
    s.files.length ? `files_edited: ${s.files.join(", ")}` : null,
    Object.keys(s.tools).length ? `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    cmds.length ? `commands:\n  ${cmds.slice(-10).join("\n  ")}` : null,
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
        serverInfo: { name: "opencode-bridge", version: VERSION },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      if (params?.name !== "opencode_task") throw new Error(`unknown tool: ${params?.name}`);
      const r = await opencodeTask(params.arguments || {});
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
