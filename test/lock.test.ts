// The lock under contention: a writer died holding the lock, and many real writer processes reach
// its stale lock at the same instant. Only one may break it at a time, so the cap holds: never more
// reservations than the cap allows, every allowed reserve written, and no writer crashing after it
// wrote. Each child loads the library, then waits for a shared start instant so the writers meet.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

const ledger = path.join(import.meta.dirname, "..", "src", "ledger.ts");
const scratchRoot = scratch();
const WRITERS = 12;
const TRIALS = 20;

const child = `
const { appendEvent } = await import(${JSON.stringify(ledger)});
const [dir, key, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) {}
let decision;
try {
  decision = appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key, usd: 0.6, at: "2026-10-15T12:00:00.000Z" });
} catch (error) {
  process.stdout.write(String(error.message));
  process.exit(3);
}
process.exit(decision.ok ? 0 : 1);`;

function writer(dir: string, key: string, startAt: number): Promise<{ code: number | null; said: string }> {
  return new Promise((done) => {
    const ran = spawn(process.execPath, ["--input-type=module", "-e", child, dir, key, String(startAt)], { stdio: ["ignore", "pipe", "inherit"] });
    let said = "";
    ran.stdout.on("data", (chunk) => (said += chunk));
    ran.on("exit", (code) => done({ code, said }));
  });
}

test("many writers meeting at a stale lock never pass the cap, and none crashes after writing", async (t) => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const dir = mkdtempSync(path.join(scratchRoot, "lock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "budgets.json"), JSON.stringify({ judge: { period: "month", cap_usd: 1 } }));
    const lock = path.join(dir, "judge", "2026-10.jsonl.lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const startAt = Date.now() + 300;
    const outcomes = await Promise.all(Array.from({ length: WRITERS }, (_, i) => writer(dir, String(i).padStart(64, "0"), startAt)));
    const file = path.join(dir, "judge", "2026-10.jsonl");
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    assert.ok(lines <= 1, `trial ${trial + 1}: ${lines} reserves of $0.60 were written against a $1 cap`);
    assert.deepEqual(outcomes.filter((o) => o.code === 3).map((o) => o.said), [], `trial ${trial + 1}: no writer crashes`);
    assert.equal(outcomes.filter((o) => o.code === 0).length, lines, `trial ${trial + 1}: every allowed reserve is written`);
    assert.equal(existsSync(lock), false, `trial ${trial + 1}: the lock is released`);
  }
});
