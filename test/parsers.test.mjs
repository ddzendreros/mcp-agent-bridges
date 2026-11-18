// Parser tests: feed each bridge an event stream with the structure its CLI emits (synthetic
// content) and check the summary the orchestrator gets. These parsers are what breaks when a CLI
// changes its output, so a CLI upgrade that changes the format should come with a new fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as opencode from "../packages/opencode-bridge/server.mjs";
import * as cursor from "../packages/cursor-bridge/server.mjs";
import * as antigravity from "../packages/antigravity-bridge/server.mjs";
import * as claude from "../packages/claude-bridge/server.mjs";
import * as codex from "../packages/codex-bridge/server.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8");
const states = (s) => s.commands.map((c) => c.state);

test("opencode: files, commands with exit codes, tokens, cost, answer", () => {
  const s = opencode.summarize(fixture("opencode"));
  assert.equal(s.sessionID, "ses_test1");
  assert.deepEqual(s.files, ["/work/app.py", "/work/tests/test_app.py"]);
  assert.deepEqual(states(s), ["failed", "ok"]);
  assert.match(s.commands[0].detail, /^exit 1 → FAILED/);
  assert.deepEqual(s.tokens, { input: 100, output: 25, cache_read: 300 });
  assert.equal(s.cost, 0.0125);
  assert.equal(s.errors.length, 0);
  assert.equal(s.finalText, "Fixed app.py and added 3 tests. All pass.");
});

test("cursor: files, failed / rejected / ok commands, model, result text", () => {
  const s = cursor.summarize(fixture("cursor"));
  assert.equal(s.sessionID, "cur-test-1");
  assert.equal(s.model, "Auto");
  assert.deepEqual(s.files, ["/work/app.py"]);
  assert.deepEqual(states(s), ["failed", "blocked", "ok"]);
  assert.deepEqual(s.tools, { read: 1, edit: 1 });
  assert.equal(s.finalText, "Fixed app.py. Tests pass.");
});

test("antigravity: a DONE command with a non-zero exit code is a failure", () => {
  const s = antigravity.summarize(fixture("antigravity"));
  assert.equal(s.conversationID, "agy-test-1");
  assert.equal(s.model, "test-model-flash");
  assert.deepEqual(s.files, ["/work/app.py"]);
  assert.deepEqual(s.tools, { write_file: 1, run_command: 3 });
  assert.deepEqual(states(s), ["failed", "blocked", "ok"]);
  assert.match(s.commands[0].detail, /^exit 1 → FAILED/);
  assert.equal(s.denied, true);
  assert.deepEqual(s.usage, { input: 100, output: 20, thinking: 7, cache_read: 300 });
  assert.equal(s.finalText, "Done: tests pass.");
});

test("claude: files, command permissions, tokens, cost and answer", () => {
  const s = claude.summarize(fixture("claude"));
  assert.equal(s.sessionID, "cl-test-1");
  assert.equal(s.model, "claude-test-model");
  assert.deepEqual(s.files, ["/work/app.py", "/work/tests/test_app.py"]);
  assert.deepEqual(s.tools, { Read: 1, Edit: 1, Write: 1, Bash: 3 });
  assert.deepEqual(states(s), ["failed", "blocked", "ok"]);
  assert.equal(s.commands[2].detail, "exit 0 → 3 passed in 0.02s", "Claude Code's cwd note is not the command output");
  assert.match(s.commands[0].detail, /^exit 1 → FAILED/);
  assert.deepEqual(s.tokens, { input: 100, output: 25, cache_read: 300 });
  assert.equal(s.cost, 0.0125);
  assert.equal(s.denied, true);
  assert.equal(s.finalText, "Fixed app.py and added tests. 3 passed.");
});

test("claude: strips host-session variables from the child environment", () => {
  const env = {
    CLAUDECODE: "1",
    ANTHROPIC_BASE_URL: "https://example.test",
    CLAUDE_CODE_X: "host",
    PATH: "bin",
    CLAUDE_BRIDGE_KEEP_ENV: "ANTHROPIC_BASE_URL",
  };
  assert.deepEqual(claude.childEnv(env), { ANTHROPIC_BASE_URL: "https://example.test", PATH: "bin" });
  const plain = { PATH: "bin", ANTHROPIC_API_KEY: "kept-without-host-marker" };
  assert.equal(claude.childEnv(plain), plain);
});

test("codex: completed items, shell unwrapping, tokens and final answer", () => {
  const s = codex.summarize(fixture("codex"));
  assert.equal(s.sessionID, "cx-test-1");
  assert.deepEqual(s.files, ["/work/app.py", "/work/tests/test_app.py"]);
  assert.deepEqual(s.tools, { edit: 1, shell: 3, "mcp:docs.search": 1 });
  assert.deepEqual(states(s), ["failed", "failed", "ok"]);
  assert.equal(s.commands[0].cmd, "python -m pytest -q");
  assert.equal(s.commands[0].detail, "could not run → CreateProcessAsUserW failed: 5 (Access is denied.)");
  assert.equal(s.commands[1].cmd, "python -m pytest -q");
  assert.match(s.commands[1].detail, /^exit 1 → FAILED/);
  assert.equal(s.commands[2].cmd, "python -m pytest -q");
  assert.deepEqual(s.tokens, { input: 1000, output: 200, cache_read: 600 });
  assert.equal(s.completed, true);
  assert.equal(s.finalText, "Fixed app.py and added tests. 3 passed.");
});

test("codex: failed turns retain the usage-limit error", () => {
  const s = codex.summarize(fixture("codex-failed"));
  assert.equal(s.sessionID, "cx-test-2");
  assert.equal(s.failed, true);
  assert.match(s.errors[0], /usage limit/);
  assert.equal(s.completed, false);
});

test("parsers ignore empty and invalid input", () => {
  for (const m of [opencode, cursor, antigravity, claude, codex]) {
    const s = m.summarize("\n\nnot json\n{}\n");
    assert.equal(s.files.length, 0);
    assert.equal(s.commands.length, 0);
  }
});
