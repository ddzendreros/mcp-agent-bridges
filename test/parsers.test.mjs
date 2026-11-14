// Parser tests: feed each bridge an event stream with the structure its CLI emits (synthetic
// content) and check the summary the orchestrator gets. These parsers are what breaks when a CLI
// changes its output, so a CLI upgrade that changes the format should come with a new fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as opencode from "../packages/opencode-bridge/server.mjs";
import * as cursor from "../packages/cursor-bridge/server.mjs";
import * as antigravity from "../packages/antigravity-bridge/server.mjs";

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

test("parsers ignore empty and invalid input", () => {
  for (const m of [opencode, cursor, antigravity]) {
    const s = m.summarize("\n\nnot json\n{}\n");
    assert.equal(s.files.length, 0);
    assert.equal(s.commands.length, 0);
  }
});
