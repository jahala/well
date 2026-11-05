// The references every bed keeps (law §3, fit check F7): the core page within
// 150 lines, a one-line instruction file that imports it, the two documents,
// and every repository path they cite resolving in the tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { citedPaths } from "../scripts/cited-paths.ts";

const documents = ["AGENTS.md", "docs/architecture.md", "docs/engineering.md"];

test("the core page holds at most 150 lines", () => {
  const lines = readFileSync("AGENTS.md", "utf8").split("\n").length;
  assert.ok(lines <= 150, `AGENTS.md has ${lines} lines`);
});

test("the instruction file is one line that imports the core page", () => {
  assert.equal(readFileSync("CLAUDE.md", "utf8"), "@AGENTS.md\n");
});

test("the core page and the two documents exist", () => {
  for (const doc of documents) assert.ok(existsSync(doc), `${doc} is missing`);
});

test("every path the documents cite resolves in the tree", () => {
  const missing = documents.flatMap((doc) =>
    citedPaths(readFileSync(doc, "utf8"))
      .filter((path) => !existsSync(path))
      .map((path) => `${doc} cites ${path}`),
  );
  assert.deepEqual(missing, []);
});

test("a cited path is a backticked repository path, never another repository's", () => {
  const text = [
    "Read `AGENTS.md`, then `docs/tend2/well.tend2.html` and `src/`.",
    "Not paths: `trash`, `node:test`, `## Tried`, `kind: [\"repository\"]`,",
    "`jahala/plotplot:docs/ideas/well.md`, `docs/<name>.md`, `.ts`.",
  ].join("\n");
  assert.deepEqual(citedPaths(text), ["AGENTS.md", "docs/tend2/well.tend2.html", "src/"]);
});
