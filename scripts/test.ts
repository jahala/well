// Runs the suite, or the test files named, then fails if the run left anything behind
// (docs/engineering.md).
// Tests make temporary files only under WELL_TMP, a directory this run creates
// and removes; it must be empty when the suite ends. The working tree's status,
// ignored files included, must be the same after the run as before it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leftovers } from "./leftovers.ts";

function treeStatus(): string[] {
  const result = spawnSync("git", ["status", "--porcelain", "--ignored"], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`git status failed: ${result.stderr}`);
    process.exit(1);
  }
  return result.stdout.split("\n").filter((line) => line !== "");
}

const before = treeStatus();
const scratch = mkdtempSync(join(tmpdir(), "well-run-"));

// Arguments name the test files and pass flags to node --test; with none, the whole suite runs. So
// one file runs under the same guard: node scripts/test.ts --test-reporter=tap test/ledger.test.ts
const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("-"));
const files = args.filter((arg) => !arg.startsWith("-"));
const suite = spawnSync(process.execPath, ["--test", ...flags, ...(files.length > 0 ? files : ["test/**/*.test.ts"])], {
  stdio: "inherit",
  env: { ...process.env, WELL_TMP: scratch },
});

const leftInScratch = readdirSync(scratch);
const leftInTree = leftovers(before, treeStatus());

if (leftInScratch.length === 0) rmdirSync(scratch);

if (leftInScratch.length > 0 || leftInTree.length > 0) {
  process.stderr.write("The run left files behind:\n");
  for (const name of leftInScratch) process.stderr.write(`  ${join(scratch, name)}\n`);
  for (const line of leftInTree) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}

process.exit(suite.status ?? 1);
