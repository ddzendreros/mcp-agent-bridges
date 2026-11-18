// Each bridge stays a single file, so the process/MCP plumbing is copied into all of them. This test
// keeps the copies identical and the versions in step with package.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BRIDGES = [
  "opencode",
  "cursor",
  "antigravity",
  "claude",
  "codex",
];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const block = (src) => src.match(/\/\/ <shared>[\s\S]*?\/\/ <\/shared>/)?.[0];

test("the <shared> block is identical in every bridge", () => {
  const blocks = BRIDGES.map((b) => block(read(`packages/${b}-bridge/server.mjs`)));
  for (const [i, b] of blocks.entries()) assert.ok(b, `${BRIDGES[i]}: no <shared> block`);
  for (let i = 1; i < blocks.length; i++) assert.equal(blocks[i], blocks[0], `${BRIDGES[i]} differs from ${BRIDGES[0]}`);
});

test("every bridge reports the package version", async () => {
  const { version } = JSON.parse(read("package.json"));
  for (const b of BRIDGES) {
    const m = await import(`../packages/${b}-bridge/server.mjs`);
    assert.equal(m.VERSION, version, `${b}-bridge`);
  }
});
