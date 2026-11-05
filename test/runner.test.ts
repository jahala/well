// The runner's guard on itself: scripts/test.ts fails a run that leaves a file behind, and names
// the file, so a test that forgets to clean up is caught on the run that introduced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

test("a run that leaves a file behind fails, and names the file", (t) => {
  // The inner run must not inherit NODE_TEST_CONTEXT, which node --test sets for its own children
  // and which changes how a nested node --test runs.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const ran = spawnSync(process.execPath, ["scripts/test.ts", "test/fixtures/leaks.fixture.ts"], { cwd: root, encoding: "utf8", env });
  const left = ran.stderr.split("\n").map((line) => line.trim()).filter((line) => line.endsWith("left-behind"));
  // The inner run keeps its scratch folder to show what was left; this test removes it.
  t.after(() => left.forEach((file) => rmSync(path.dirname(file), { recursive: true, force: true })));
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(ran.stderr, /The run left files behind/);
  assert.equal(left.length, 1, ran.stderr);
});
