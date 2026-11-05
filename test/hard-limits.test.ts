// Hard limits a file can break: no em dash in anything this repository wrote.
// The two assets tend2 copies beside a map are tend2's, so they are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const emDash = String.fromCodePoint(0x2014);
const vendored = new Set(["docs/tend2/loop.css", "docs/tend2/loop.js"]);

function ownFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  });
  return out.split("\0").filter((path) => path !== "" && !vendored.has(path));
}

test("no file this repository wrote carries an em dash", () => {
  const files = ownFiles();
  assert.ok(files.length > 0, "git listed no files");
  const offenders = files.filter((path) => readFileSync(path, "utf8").includes(emDash));
  assert.deepEqual(offenders, []);
});
