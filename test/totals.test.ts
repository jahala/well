// The running totals: a decision folds only the lines written since the last one into a small
// state file, instead of rereading the whole month. These checks hold the totals equal to a full
// reread across random histories, with writers that never touch the state, torn lines, a lost
// state file and a line written to an older month; and they hold a decision's cost flat from a
// thousand lines to two hundred thousand.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { appendEvent, parseLedger, readTotals, tally, type EventKind, type LedgerLine } from "../src/ledger.ts";

const scratchRoot = scratch();

function folder(): string {
  const dir = mkdtempSync(path.join(scratchRoot, "totals-"));
  writeFileSync(path.join(dir, "budgets.json"), JSON.stringify({ judge: { period: "month", cap_usd: 1000 } }));
  mkdirSync(path.join(dir, "judge"));
  return dir;
}

/** The totals for a period, from a full reread of every month up to it. */
function fullReread(dir: string, period: string): { spent: number; open: [string, number][]; torn: number } {
  const names = readdirSync(path.join(dir, "judge")).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n) && n.slice(0, 7) <= period).sort();
  const reads = names.map((n) => parseLedger(readFileSync(path.join(dir, "judge", n), "utf8")));
  const current = names.at(-1)?.slice(0, 7) === period ? (reads.at(-1)?.lines ?? []) : [];
  const previous = (names.at(-1)?.slice(0, 7) === period ? reads.slice(0, -1) : reads).flatMap((r) => r.lines);
  const { spent, open } = tally({ current, previous });
  return { spent, open: [...open].sort(), torn: reads.reduce((n, r) => n + r.torn, 0) };
}

/** A small seeded generator, so a failing history can be replayed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("the running totals equal a full reread after every event of a random history", (t) => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const dir = folder();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const next = random(seed);
    const keys = Array.from({ length: 12 }, (_, i) => String(i).padStart(64, "k"));
    const months = ["2026-09", "2026-10", "2026-11"];
    let clock = Date.parse("2026-09-03T00:00:00.000Z");
    for (let step = 0; step < 240; step++) {
      clock += Math.floor(next() * 9 * 3600_000);
      const at = new Date(clock).toISOString();
      const period = at.slice(0, 7);
      if (!months.includes(period)) break;
      const roll = next();
      const k = keys[Math.floor(next() * keys.length)] ?? "";
      const file = path.join(dir, "judge", `${period}.jsonl`);
      if (roll < 0.08) {
        // A writer that never touches the state appends a whole line of its own.
        const event: EventKind = next() < 0.5 ? "reserve" : "settle";
        const line: LedgerLine = { at, budget: "judge", period, tool: "other", key: k, event, usd: 0.25 };
        const ends = existsSync(file) && !readFileSync(file, "utf8").endsWith("\n") && readFileSync(file, "utf8") !== "";
        appendFileSync(file, `${ends ? "\n" : ""}${JSON.stringify(line)}\n`);
      } else if (roll < 0.11) {
        // A writer died mid-append.
        appendFileSync(file, `{"at":"${at}","budget":"judge","event":"rese`);
      } else if (roll < 0.14) {
        // The state file is lost.
        rmSync(path.join(dir, "judge", "state.json"), { force: true });
      } else {
        const event: EventKind = roll < 0.6 ? "reserve" : roll < 0.85 ? "settle" : "release";
        appendEvent({ dir, budget: "judge", tool: "a", event, key: k, usd: Math.round(next() * 100) / 100, ...(event === "release" ? { why: "reconciled" } : {}), at });
      }
      const totals = readTotals(dir, "judge", period);
      assert.deepEqual({ spent: totals.spent, open: [...totals.open].sort(), torn: totals.torn }, fullReread(dir, period), `seed ${seed}, step ${step}`);
    }
  }
});

test("a line written to an older month after a newer one still leaves the totals equal to a full reread", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const k = "a".repeat(64);
  appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: k, usd: 1, at: "2026-09-20T00:00:00.000Z" });
  appendEvent({ dir, budget: "judge", tool: "a", event: "settle", key: k, usd: 1, at: "2026-11-02T00:00:00.000Z" });
  assert.deepEqual([...readTotals(dir, "judge", "2026-11").open], []);
  // A writer with a slow clock, that never touches the state, appends the same request to October
  // after November was folded. Read in order, November's settle closes it; folded out of order, it
  // would stay open.
  const line: LedgerLine = { at: "2026-10-31T23:00:00.000Z", budget: "judge", period: "2026-10", tool: "other", key: k, event: "reserve", usd: 2 };
  appendFileSync(path.join(dir, "judge", "2026-10.jsonl"), `${JSON.stringify(line)}\n`);
  const totals = readTotals(dir, "judge", "2026-11");
  assert.deepEqual({ spent: totals.spent, open: [...totals.open].sort(), torn: totals.torn }, fullReread(dir, "2026-11"));
});

test("a decision's cost stays flat from a thousand lines to two hundred thousand", (t) => {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const cost = (lines: number): number => {
    const dir = folder();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const body: string[] = [];
    for (let i = 0; i < lines; i++) {
      const key = String(Math.floor(i / 2)).padStart(64, "0");
      body.push(JSON.stringify({ at: "2026-11-02T10:00:00.000Z", budget: "judge", period: "2026-11", tool: "a", key, event: i % 2 ? "settle" : "reserve", usd: 0.001 }));
    }
    writeFileSync(path.join(dir, "judge", "2026-11.jsonl"), `${body.join("\n")}\n`);
    appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "f".repeat(64), usd: 0.001, at: "2026-11-04T12:00:00.000Z" });
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const started = performance.now();
      appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: `${i}`.padStart(64, "e"), usd: 0.001, at: "2026-11-04T12:00:01.000Z" });
      times.push(performance.now() - started);
    }
    return median(times);
  };
  const small = cost(1_000);
  const large = cost(200_000);
  assert.ok(large < small * 5 + 2, `a decision took ${large.toFixed(1)} ms at 200,000 lines against ${small.toFixed(1)} ms at 1,000`);
});
