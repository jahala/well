// The layer rules in AGENTS.md, held by a test: only the command reads the clock, the
// environment, the home folder and the temporary folder, and each module imports only the layers it
// may depend on. A rule written only in prose drifts; this one fails the run that breaks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const src = path.join(import.meta.dirname, "..", "src");
const modules = readdirSync(src).filter((name) => name.endsWith(".ts")).sort();
const text = (name: string): string => readFileSync(path.join(src, name), "utf8");

/** Reads of the world a function would otherwise take as an argument. */
const edgeReads = /process\.env|Date\.now\(|new Date\(\)|homedir\(|tmpdir\(/g;

/**
 * The reads allowed outside the command, each with its reason. The lock's age is the wall clock
 * against a directory's mtime, which only the moment of reading can give; nothing it decides is
 * about money.
 */
const allowed: Record<string, Record<string, number>> = {
  "ledger.ts": { "Date.now(": 3 },
};

test("only the command reads the clock, the environment, the home folder and the temporary folder", () => {
  const found = Object.fromEntries(
    modules
      .filter((name) => name !== "cli.ts")
      .map((name) => {
        const counts: Record<string, number> = {};
        for (const [read] of text(name).matchAll(edgeReads)) counts[read] = (counts[read] ?? 0) + 1;
        return [name, counts] as const;
      })
      .filter(([, counts]) => Object.keys(counts).length > 0),
  );
  assert.deepEqual(found, allowed);
});

/** The layers each module may import, from AGENTS.md's shape. */
const mayImport: Record<string, string[]> = {
  "ledger.ts": [],
  "keychain.ts": [],
  "seats.ts": ["ledger"],
  "conductor.ts": ["seats"],
  "run.ts": ["keychain", "ledger"],
  "cli.ts": ["keychain", "ledger", "run", "seats"],
};

test("each module imports only the layers it may depend on, and every module has a place in the shape", () => {
  assert.deepEqual(modules, Object.keys(mayImport).sort(), "a new module gets its line in AGENTS.md's shape and here");
  for (const name of modules) {
    const imports = [...text(name).matchAll(/from "\.\/([a-z-]+)\.ts"/g)].map((m) => m[1] ?? "");
    assert.deepEqual([...new Set(imports)].sort(), mayImport[name], `${name} imports`);
  }
});
