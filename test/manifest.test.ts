// garden.json declares well a bed of the garden: valid against the umbrella's manifest schema,
// copied whole as test/fixtures/manifest.schema.json with its pin, and every claim it makes is
// true of this tree: the command it names runs, its metric runs, and its install pin carries both.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("garden.json")) as {
  name: string;
  kind: string[];
  version: string;
  install: { git: { url: string; rev: string } };
  faces: { cli: string };
  metric: string;
};
const pkg = JSON.parse(read("package.json")) as { name: string; version: string; bin?: Record<string, string> };

test("the manifest schema matches its pin", () => {
  const pin = readFileSync(path.join(fixtures, "manifest.schema.pin"), "utf8");
  const sha = createHash("sha256").update(readFileSync(path.join(fixtures, "manifest.schema.json"))).digest("hex");
  assert.ok(pin.includes(sha), "manifest.schema.json differs from the sha256 in manifest.schema.pin");
});

test("garden.json is a bed's manifest, valid against the umbrella's schema", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const check = ajv.compile(JSON.parse(readFileSync(path.join(fixtures, "manifest.schema.json"), "utf8")) as object);
  assert.ok(check(manifest), JSON.stringify(check.errors, null, 2));
  assert.ok(!manifest.kind.includes("repository"), "a bed does not declare itself a planted repository");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
});

test("the command the manifest names is the package's bin, run by Node with no build step", () => {
  const bin = pkg.bin?.[manifest.faces.cli];
  assert.equal(bin, "src/cli.ts");
  assert.ok(read(bin).startsWith("#!/usr/bin/env node\n"), `${bin} starts with a shebang for Node`);
});

test("the metric command runs and reads zero breaches from an empty ledger folder", (t) => {
  const [face, ...args] = manifest.metric.split(" ");
  assert.equal(face, manifest.faces.cli);
  const dir = mkdtempSync(path.join(scratch(), "metric-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [path.join(root, "src", "cli.ts"), ...args, "--dir", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { ok: true, periods: 0, breaches: [] });
});

test("the install pin names a commit in this history that carries the command", () => {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const { url, rev } = manifest.install.git;
  assert.equal(url, "https://github.com/jahala/well.git");
  assert.equal(git("merge-base", "--is-ancestor", rev, "HEAD").status, 0, `${rev} is an ancestor of HEAD`);
  for (const file of ["src/cli.ts", "src/ledger.ts", "package.json"]) {
    assert.equal(git("cat-file", "-e", `${rev}:${file}`).status, 0, `${rev} carries ${file}`);
  }
  const pinned = JSON.parse(git("show", `${rev}:package.json`).stdout) as { bin?: Record<string, string> };
  assert.equal(pinned.bin?.[manifest.faces.cli], "src/cli.ts", `${rev} installs the command`);
});
