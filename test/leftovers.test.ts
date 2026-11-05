// The runner's guard: what a run leaves behind is what the tree shows after the
// run that it did not show before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { leftovers } from "../scripts/leftovers.ts";

test("a line that appears after the run is left behind", () => {
  assert.deepEqual(leftovers(["!! node_modules/"], ["!! node_modules/", "?? stray.json"]), ["?? stray.json"]);
});

test("a tree the run did not change leaves nothing", () => {
  assert.deepEqual(leftovers([" M AGENTS.md", "?? notes/"], ["?? notes/", " M AGENTS.md"]), []);
});

test("a file the run removed is not counted as left behind", () => {
  assert.deepEqual(leftovers(["?? old.json"], []), []);
});
