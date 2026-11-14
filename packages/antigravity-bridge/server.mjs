#!/usr/bin/env node
// antigravity-bridge — MCP server (stdio, zero dependencies) that lets an orchestrating agent
// (e.g. Claude Code) delegate execution work to the Antigravity CLI (`agy -p`).
// The orchestrator plans and reviews; Antigravity executes. Returns a compact summary; the full
// event stream goes to a log file.
// Never uses --dangerously-skip-permissions: the default mode is accept-edits (file edits only),
// and commands run only when the caller allow-lists them exactly, for that one task.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const VERSION = "1.3.0";
const LOCAL = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const findExe = () =>
  process.env.AGY_BIN ||
  [join(LOCAL, "agy", "bin", "agy.exe"), join(homedir(), ".local", "bin", "agy")].find((p) => existsSync(p)) ||
  "agy";
const DEFAULT_MODEL = process.env.AGY_BRIDGE_MODEL || ""; // empty = Antigravity's own default
// Log directory; set AGY_BRIDGE_LOGS=off to disable logging entirely.
const LOG_DIR = process.env.AGY_BRIDGE_LOGS || join(homedir(), ".mcp-agent-bridges", "logs", "antigravity");
const MAX_TEXT = Number(process.env.AGY_BRIDGE_MAX_CHARS || 4000);
// Optional: other models of the same account to use if the requested one hits its usage limit.
const DEFAULT_FALLBACKS = (process.env.AGY_BRIDGE_FALLBACKS || "").split(",").map((s) => s.trim()).filter(Boolean);
// Usage limits (quota, rate limit) and temporary lack of server capacity (503).
const LIMIT = /RESOURCE_EXHAUSTED|quota reached|quota exceeded|rate limit|\b429\b|UNAVAILABLE \(code 503\)|no capacity available/i;

const INSTRUCTIONS = `antigravity-bridge: delegate execution work to the Antigravity CLI (agy).
Use it for mechanical, well-specified tasks: implementing an already-decided plan, refactors, tests, boilerplate, docs.
Do not use it for design decisions, hard debugging or security-sensitive changes.
Default mode is accept-edits: it can create/edit files but can NOT run commands, except the ones you pass EXACTLY in allow_commands
(e.g. ["python -m unittest discover -s tests -t ."]) — literal match only, no wildcards; allowed for that task only, never persisted.
The bridge prepends the rules and the workspace file list to the prompt, and if a command is blocked it resumes the conversation automatically (max_recoveries).
Flow: 1) plan; 2) call antigravity_task with a self-contained prompt (files, definition of done, what NOT to touch); 3) review and verify yourself (tests, diff); 4) for corrections pass session_id.
antigravity_models lists the models available to the account.`;

const TOOLS = [
  {
    name: "antigravity_task",
    description:
      "Run a task with the Antigravity CLI in headless mode (agy -p) in a directory and return a compact summary (final answer, files written, commands, tokens, session_id). Blocks until done.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained instruction." },
        cwd: { type: "string", description: "Absolute working directory (workspace)." },
        model: { type: "string", description: "Model (see antigravity_models). Default: AGY_BRIDGE_MODEL env, else Antigravity's default." },
        fallback_models: {
          type: "array", items: { type: "string" },
          description: "Models of the same account to use, in order, if the requested one hits a usage limit or has no server capacity (503). The conversation is resumed. Default: AGY_BRIDGE_FALLBACKS env, else none.",
        },
        session_id: { type: "string", description: "Continue a previous conversation (--conversation). Alias: conversation_id." },
        conversation_id: { type: "string", description: "Alias of session_id." },
        timeout_s: { type: "number", description: "Time limit in seconds (default 900)." },
        mode: { type: "string", enum: ["accept-edits", "plan"], description: "accept-edits (default: edits files, no commands) or plan (read-only)." },
        effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Reasoning effort. Optional." },
        allow_commands: {
          type: "array", items: { type: "string" },
          description: "EXACT commands it may run in this task (literal match, no wildcards), e.g. [\"python -m unittest discover -s tests -t .\"]. Default: none.",
        },
        max_recoveries: { type: "number", description: "How many times to resume the conversation after a blocked command (default 2, 0 = off, max 5)." },
        include_tree: { type: "boolean", description: "Include the workspace file list in the prompt (default true)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "antigravity_models",
    description: "List the models available in Antigravity CLI for the current account (also checks that the login works).",
    inputSchema: { type: "object", properties: {} },
  },
];

function run(args, cwd, timeoutMs) {
  return new Promise((res) => {
    // agy is a real executable: no shell, so newlines in the prompt arrive intact.
    const child = spawn(findExe(), args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

function summarize(raw) {
  const deltas = [], errors = [], files = new Set(), tools = {}, seenTool = new Set();
  const commands = []; // { cmd, state: ok | blocked | error }
  const usage = { input: 0, output: 0, thinking: 0, cache_read: 0 };
  let conversationID, model, result;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.event === "init") {
      conversationID ||= ev.conversation_id;
      model = ev.init?.model || model;
    }
    const su = ev.step_update;
    if (su) {
      conversationID ||= su.conversation_id;
      if (su.step_type === "tool" && su.tool_name && !seenTool.has(su.step_index)) {
        seenTool.add(su.step_index);
        tools[su.tool_name] = (tools[su.tool_name] || 0) + 1;
        const p = su.tool_info?.parameters?.Path || su.tool_info?.parameters?.TargetFile || su.tool_info?.parameters?.path;
        if (p && /write|edit|replace|create|delete|patch/i.test(su.tool_name)) files.add(p);
      }
      if (su.tool_name === "run_command" && (su.state === "DONE" || su.state === "ERROR")) {
        const cmd = su.tool_info?.parameters?.CommandLine || "?";
        const denied = su.state === "ERROR" && /permission check failed|denied/i.test(su.tool_info?.error?.message || "");
        commands.push({ cmd, state: denied ? "blocked" : su.state === "DONE" ? "ok" : "error" });
      }
      if (su.step_type === "agent_response" && su.text_delta) deltas.push(su.text_delta);
      if (su.state === "DONE" && su.usage) {
        usage.input += su.usage.input_tokens || 0;
        usage.output += su.usage.output_tokens || 0;
        usage.thinking += su.usage.thinking_tokens || 0;
        usage.cache_read += su.usage.cache_read_tokens || 0;
      }
      // Blocked commands are reported (and recovered) separately; they do not count as errors.
      if (su.state && /ERROR|FAIL|CANCEL/i.test(su.state) && su.tool_name !== "run_command") errors.push(`${su.step_type || "step"} ${su.state}${su.tool_name ? ` (${su.tool_name})` : ""}`);
    }
    if (ev.event === "result") {
      result = ev.result;
      conversationID ||= result?.conversation_id;
      if (result?.status && result.status !== "SUCCESS") errors.push(`result ${result.status}${result.error ? `: ${JSON.stringify(result.error).slice(0, 300)}` : ""}`);
    }
    if (ev.event === "error" || ev.error) errors.push(JSON.stringify(ev).slice(0, 400));
  }
  let finalText = (result?.response || deltas.join("")).trim();
  if (finalText.length > MAX_TEXT) finalText = "…[truncated]\n" + finalText.slice(-MAX_TEXT);
  const denied = (result?.denied_actions || []).length > 0 || commands.some((c) => c.state === "blocked");
  return { conversationID, model, finalText, errors, files: [...files], tools, usage, result, commands, denied };
}

// Compact list of workspace files so the agent does not need commands to explore it.
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".turbo", ".cache", ".idea", ".vscode", "coverage"]);
function listTree(root, max = 200) {
  const out = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > 6 || truncated) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.isDirectory() - b.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= max) { truncated = true; return; }
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
      else out.push(relative(root, p).replace(/\\/g, "/"));
    }
  };
  walk(root, 0);
  return { files: out, truncated };
}

function preamble(cwd, allow, includeTree) {
  const rules = [
    `Working directory: ${cwd}. Work only inside it.`,
    allow.length
      ? `Running commands: you may ONLY use run_command with these commands, copied LITERALLY (same spacing, no "cd", no chaining with && or ;):\n${allow.map((c) => `  - ${c}`).join("\n")}\nAny other command is blocked and will abort your turn.`
      : `Running commands: do NOT use run_command for anything (not to list files, not ls/dir/Get-ChildItem, not python): it is blocked and will abort your turn. Use only the read/list/write file tools.`,
  ];
  if (includeTree) {
    const t = listTree(cwd);
    if (t.files.length) rules.push(`Existing files${t.truncated ? " (truncated list)" : ""}:\n${t.files.map((f) => `  ${f}`).join("\n")}`);
    else rules.push("The directory is empty.");
  }
  return rules.join("\n\n");
}

function recoveryPrompt(blocked, allow) {
  return [
    `Your previous turn was interrupted because these commands were blocked: ${blocked.map((c) => `\`${c}\``).join(", ") || "(command)"}.`,
    allow.length
      ? `You may only run, literally: ${allow.map((c) => `\`${c}\``).join(", ")}. Do not try any other command.`
      : "You cannot run any command in this session.",
    "Continue the original task from where it stopped using only file tools; do not repeat the blocked command. When done, give the final answer that was requested.",
  ].join(" ");
}

async function antigravityTask(a) {
  if (!a.prompt) throw new Error("prompt is required");
  const cwd = resolve(a.cwd || process.cwd());
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const timeoutS = a.timeout_s || 900;
  const mode = a.mode === "plan" ? "plan" : "accept-edits";
  const model = a.model || DEFAULT_MODEL;
  const allow = Array.isArray(a.allow_commands) ? a.allow_commands.map((c) => String(c).trim()).filter(Boolean) : [];
  const maxRec = Number.isFinite(a.max_recoveries) ? Math.max(0, Math.min(5, a.max_recoveries)) : 2;
  const includeTree = a.include_tree !== false;
  const deadline = Date.now() + timeoutS * 1000;

  const fallbacks = (Array.isArray(a.fallback_models) ? a.fallback_models : DEFAULT_FALLBACKS).filter((m) => m && m !== model);
  const argsFor = (m) => {
    const b = ["--output-format", "stream-json", "--mode", mode];
    if (m) b.push("--model", m);
    if (a.effort) b.push("--effort", a.effort);
    // Permissions for this session only (agy --settings never writes them to settings.json).
    if (allow.length) b.push("--settings", JSON.stringify({ permissions: { allow: allow.map((c) => `command(${c})`) } }));
    return b;
  };

  const started = Date.now();
  const logs = [], files = new Set(), tools = {}, commands = [], errors = [], notes = [];
  const usage = { input: 0, output: 0, thinking: 0, cache_read: 0 };
  const firstPrompt = `${preamble(cwd, allow, includeTree)}\n\n---\n\n${a.prompt}`;
  let conv = a.session_id || a.conversation_id, prompt = firstPrompt, curModel = model, recoveries = 0, fbIdx = 0;
  let last, lastR;

  for (let attempt = 0; attempt < 8; attempt++) {
    const left = Math.floor((deadline - Date.now()) / 1000);
    if (left < 20) break;
    const args = [...argsFor(curModel), "--print-timeout", `${left}s`];
    if (conv) args.push("--conversation", conv);
    args.push("-p", prompt);
    // Extra margin over --print-timeout so agy can exit on its own before being killed.
    const r = await run(args, cwd, (left + 30) * 1000);
    const s = summarize(r.out);
    const log = writeLog(`${s.conversationID || "noconv"}${attempt ? `_try${attempt}` : ""}`, r);
    if (log) logs.push(log);
    s.files.forEach((f) => files.add(f));
    for (const [k, v] of Object.entries(s.tools)) tools[k] = (tools[k] || 0) + v;
    for (const k of Object.keys(usage)) usage[k] += s.usage[k];
    commands.push(...s.commands);
    last = s; lastR = r;
    conv = s.conversationID || conv;
    if (r.timedOut) { errors.push(...s.errors); break; }
    // Usage/capacity limit on this model → next configured fallback model, resuming the conversation if any.
    if (LIMIT.test(`${s.errors.join(" ")} ${r.err}`) && fbIdx < fallbacks.length) {
      const next = fallbacks[fbIdx++];
      notes.push(`attempts: "${curModel}" hit a usage/capacity limit → retried with "${next}"`);
      curModel = next;
      prompt = conv ? `The previous model became unavailable mid-task. Check the current state of the files and finish the original task without redoing what is already correct:\n\n${firstPrompt}` : firstPrompt;
      continue;
    }
    errors.push(...s.errors);
    if (r.code !== 0 || !s.denied || !conv || recoveries >= maxRec) break;
    recoveries++;
    prompt = recoveryPrompt(s.commands.filter((c) => c.state === "blocked").map((c) => c.cmd), allow);
  }

  const s = last, r = lastR;
  const ok = !!r && r.code === 0 && !r.timedOut && errors.length === 0 && s.result?.status === "SUCCESS" && !s.denied;
  const limitHit = !ok && LIMIT.test(errors.join(" "));
  const status = ok ? "ok" : r?.timedOut ? "timeout" : s?.denied ? "incomplete (command blocked)"
    : limitHit ? "usage or capacity limit reached (part of the work may be done: check files and commands)" : "error";
  const fmtCmds = commands.map((c) => `${c.state === "ok" ? "✓" : c.state === "blocked" ? "⛔" : "✗"} ${c.cmd}`);
  const lines = [
    `status: ${status} (exit ${r?.code ?? "-"}, ${Math.round((Date.now() - started) / 1000)}s${recoveries ? `, ${recoveries} recovery(ies) after blocked command` : ""})`,
    `session_id: ${conv || "-"}`,
    `model: ${s?.model || curModel || "(default)"} | mode: ${mode}${allow.length ? ` | allowed commands: ${allow.length}` : ""}`,
    ...notes,
    files.size ? `files_edited: ${[...files].join(", ")}` : null,
    Object.keys(tools).length ? `tools: ${Object.entries(tools).map(([k, v]) => `${k}×${v}`).join(", ")}` : null,
    fmtCmds.length ? `commands:\n  ${fmtCmds.slice(0, 10).join("\n  ")}` : null,
    usage.input || usage.output ? `tokens: in ${usage.input}, out ${usage.output}, thinking ${usage.thinking}, cache_read ${usage.cache_read}` : null,
    errors.length ? `errors: ${errors.slice(0, 5).join(" | ")}` : null,
    !ok && r?.err?.trim() ? `stderr: ${r.err.trim().slice(-600)}` : null,
    logs.length ? `log: ${logs.join(", ")}` : null,
    "--- final answer ---",
    s?.finalText || "(no text)",
  ].filter(Boolean);
  return { text: lines.join("\n"), isError: !ok };
}

async function antigravityModels() {
  const r = await run(["models"], process.cwd(), 90000);
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
        serverInfo: { name: "antigravity-bridge", version: VERSION },
        instructions: INSTRUCTIONS,
      } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const name = params?.name;
      const r = name === "antigravity_task" ? await antigravityTask(params.arguments || {})
        : name === "antigravity_models" ? await antigravityModels()
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
