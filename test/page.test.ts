// The bed page (index.html) says what the tree says: its lede is the README's lead paragraph, one
// text kept in two places, and its proof band's version and counts are the tree's own. The test
// count is not held here: the band names the commit it was counted at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const page = read("index.html");

function figure(name: string): number {
  const found = page.match(new RegExp(`<dt>${name}</dt><dd>(\\d+)</dd>`));
  assert.ok(found, `the proof band has no ${name} figure`);
  return Number(found[1]);
}

test("the page's lede is the README's lead paragraph", () => {
  const lead = read("README.md").split("\n\n")[1];
  const lede = page.match(/<p class="lede">([\s\S]*?)<\/p>/);
  assert.ok(lede, "the page has no lede");
  assert.equal(lede[1], lead);
});

test("the proof band carries the package's version and its runtime dependencies", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string; dependencies?: Record<string, string> };
  assert.ok(page.includes(`well ${pkg.version}, as it ships`), `the proof band does not name version ${pkg.version}`);
  assert.equal(figure("runtime dependencies"), Object.keys(pkg.dependencies ?? {}).length);
});

test("the proof band counts the core page's invariants", () => {
  const section = read("AGENTS.md").split("## Invariants")[1]?.split("\n## ")[0] ?? "";
  const invariants = section.split("\n").filter((line) => /^\d+\. /.test(line)).length;
  assert.ok(invariants > 0, "AGENTS.md lists no invariants");
  assert.equal(figure("invariants"), invariants);
});
