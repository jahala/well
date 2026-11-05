// The shared spending ledger. Its rule lives in test/fixtures/ledger-vector.json, copied whole
// from the umbrella (test/fixtures/ledger-vector.pin): every step must get the decision the vector
// names, written to real files in a folder under WELL_TMP.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEvent, judgeMonth, readBreaches, readBudget, type EventKind, type Judged, type LedgerLine, type ReleaseWhy } from "../src/ledger.ts";

interface Step {
  owner_sets_cap_usd?: number;
  writes?: { cap_usd: number };
  tool: string;
  event: EventKind;
  key: string;
  usd: number;
  why?: ReleaseWhy;
  expect: string;
  because: string;
}
interface Month {
  because: string;
  today_cap_usd: number;
  lines: LedgerLine[];
  expect: Judged;
}
interface Vector {
  budget: string;
  cap_usd: number;
  day_usd: number;
  week_usd: number;
  period: string;
  steps: Step[];
  breaches: { after_steps: { today_cap_usd: number; expect: Judged; because: string }; months: Month[] };
}

const fixtures = path.join(import.meta.dirname, "fixtures");
const vector = JSON.parse(readFileSync(path.join(fixtures, "ledger-vector.json"), "utf8")) as Vector;
const scratchRoot = scratch();

function folder(budgets?: object): string {
  const dir = mkdtempSync(path.join(scratchRoot, "ledger-"));
  if (budgets) writeFileSync(path.join(dir, "budgets.json"), JSON.stringify(budgets));
  return dir;
}
function lines(dir: string, budget: string, period: string): LedgerLine[] {
  const file = path.join(dir, budget, `${period}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
}

test("the vector and the lock cases match their pin", () => {
  const pin = readFileSync(path.join(fixtures, "ledger-vector.pin"), "utf8");
  for (const name of ["ledger-vector.json", "ledger-lock.json"]) {
    const sha = createHash("sha256").update(readFileSync(path.join(fixtures, name))).digest("hex");
    assert.ok(pin.includes(sha), `${name} differs from the sha256 in ledger-vector.pin`);
  }
});

interface AcrossCase {
  because: string;
  cap_usd: number;
  day_usd: number;
  week_usd: number;
  lines: LedgerLine[];
  event: { at: string; tool: string; event: EventKind; key: string; usd: number; why?: ReleaseWhy };
  expect: string;
}

test("every across-months case gets the decision the vector names: a reservation stays open however old", (t) => {
  const cases = (vector as unknown as { across_months: { cases: AcrossCase[] } }).across_months.cases;
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const dir = folder({ [vector.budget]: { period: "month", cap_usd: c.cap_usd, day_usd: c.day_usd, week_usd: c.week_usd } });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, vector.budget));
    for (const line of c.lines) appendFileSync(path.join(dir, vector.budget, `${line.period}.jsonl`), `${JSON.stringify(line)}\n`);
    const got = appendEvent({ dir, budget: vector.budget, ...c.event });
    assert.equal(got.ok ? "allow" : `refuse:${got.reason}`, c.expect, c.because);
  }
});

interface LockCases {
  budget: string;
  cap_usd: number;
  event: { at: string; tool: string; event: EventKind; key: string; usd: number };
  cases: { because: string; lock_age_s: number | null; breaker_age_s: number | null; wait_ms: number; expect: "written" | "not written"; after: { lock: boolean; breaker: boolean } }[];
}

test("every lock case from the umbrella holds: a stale lock is broken only under the breaker", (t) => {
  const lock = JSON.parse(readFileSync(path.join(fixtures, "ledger-lock.json"), "utf8")) as LockCases;
  for (const c of lock.cases) {
    const dir = folder({ [lock.budget]: { period: "month", cap_usd: lock.cap_usd } });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, lock.budget));
    const file = path.join(dir, lock.budget, `${lock.event.at.slice(0, 7)}.jsonl`);
    const make = (made: string, ageS: number | null) => {
      if (ageS === null) return;
      mkdirSync(made);
      const then = new Date(Date.now() - ageS * 1000);
      utimesSync(made, then, then);
    };
    make(`${file}.lock`, c.lock_age_s);
    make(`${file}.lock.break`, c.breaker_age_s);
    const got = appendEvent({ dir, budget: lock.budget, ...lock.event, lockWaitMs: c.wait_ms });
    const written = existsSync(file) && readFileSync(file, "utf8").trim() !== "";
    assert.equal(written ? "written" : "not written", c.expect, c.because);
    assert.equal(got.ok, written, c.because);
    assert.deepEqual({ lock: existsSync(`${file}.lock`), breaker: existsSync(`${file}.lock.break`) }, c.after, c.because);
  }
});

/** The steps' budget: its cap, with the day and week limits the vector declares beside it. */
const stepsBudget = (capUsd: number) => ({ [vector.budget]: { period: "month", cap_usd: capUsd, day_usd: vector.day_usd, week_usd: vector.week_usd } });
const setCap = (dir: string, capUsd: number) => writeFileSync(path.join(dir, "budgets.json"), JSON.stringify(stepsBudget(capUsd)));

interface PacingCase {
  because: string;
  budget: { cap_usd: number; day_usd?: number; week_usd?: number };
  lines: LedgerLine[];
  event: { at: string; tool: string; event: EventKind; key: string; usd: number };
  expect: string;
}

test("every pacing case of the vector gets the decision it names: day and week limits inside the month", (t) => {
  const cases = (vector as unknown as { pacing: { cases: PacingCase[] } }).pacing.cases;
  assert.ok(cases.length > 0);
  for (const c of cases) {
    const dir = folder({ [vector.budget]: { period: "month", ...c.budget } });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, vector.budget));
    for (const line of c.lines) appendFileSync(path.join(dir, vector.budget, `${line.period}.jsonl`), `${JSON.stringify(line)}\n`);
    const got = appendEvent({ dir, budget: vector.budget, ...c.event });
    assert.equal(got.ok ? "allow" : `refuse:${got.reason}`, c.expect, c.because);
  }
});

test("every step of the vector gets the decision the vector names, and an allowed reserve writes the cap", (t) => {
  const dir = folder(stepsBudget(vector.cap_usd));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = `${vector.period}-15T12:00:00.000Z`;
  vector.steps.forEach((step, i) => {
    if (step.owner_sets_cap_usd !== undefined) setCap(dir, step.owner_sets_cap_usd);
    const before = lines(dir, vector.budget, vector.period).length;
    const why = step.why ?? (step.event === "release" ? "reconciled" : undefined);
    const got = appendEvent({ dir, budget: vector.budget, tool: step.tool, event: step.event, key: step.key, usd: step.usd, ...(why ? { why } : {}), at });
    const after = lines(dir, vector.budget, vector.period).length;
    assert.equal(got.ok ? "allow" : `refuse:${got.reason}`, step.expect, `step ${i + 1} (${step.because})`);
    assert.equal(after - before, got.ok ? 1 : 0, `step ${i + 1} appends exactly when allowed`);
    const written = got.ok ? lines(dir, vector.budget, vector.period).at(-1) : undefined;
    assert.equal(written?.cap_usd, step.writes?.cap_usd, `step ${i + 1} writes the cap the vector names, and only on a reserve`);
  });
  const month = lines(dir, vector.budget, vector.period);
  const { today_cap_usd, expect, because } = vector.breaches.after_steps;
  assert.deepEqual(judgeMonth(month, today_cap_usd), expect, because);
});

test("every month of the vector's breaches is judged as the vector names, from real files", (t) => {
  for (const month of vector.breaches.months) {
    const dir = folder({ [vector.budget]: { period: "month", cap_usd: month.today_cap_usd } });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const period = month.lines[0]?.period ?? "";
    mkdirSync(path.join(dir, vector.budget));
    writeFileSync(path.join(dir, vector.budget, `${period}.jsonl`), month.lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    assert.deepEqual(judgeMonth(month.lines, month.today_cap_usd), month.expect, month.because);
    const { spent_usd, cap_usd, cap_from, breach } = month.expect;
    const breaches = breach ? [{ budget: vector.budget, period, spent_usd, cap_usd, cap_from }] : [];
    assert.deepEqual(readBreaches({ dir }), { ok: !breach, periods: 1, breaches }, month.because);
  }
});

test("an amount the ledger cannot hold exactly is a fault, and nothing is written", (t) => {
  const dir = folder({ judge: { period: "month", cap_usd: 1 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const usd of [Infinity, Number.NaN, -0.1, 1_000_000.5, 2 ** 53]) {
    assert.throws(() => appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "e".repeat(64), usd, at: "2026-10-27T00:00:00.000Z" }), /amount/, `usd ${usd}`);
  }
  assert.deepEqual(lines(dir, "judge", "2026-10"), []);
});

test("amounts are rounded to the nearest millionth, never truncated", (t) => {
  // 0.000249 is 248.99999999999997 millionths as a float: rounded it is 249, truncated 248. Two of
  // them are 498 millionths, which passes a cap of 497; truncated they would be 496 and fit.
  const dir = folder({ judge: { period: "month", cap_usd: 0.000497, day_usd: 1, week_usd: 1 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = "2026-10-27T00:00:00.000Z";
  assert.deepEqual(appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "a".repeat(64), usd: 0.000249, at }), { ok: true });
  assert.deepEqual(appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "b".repeat(64), usd: 0.000249, at }), { ok: false, reason: "cap" });
});

test("the same request key in two budgets is two reservations, and closing one leaves the other open", (t) => {
  const dir = folder({ judge: { period: "month", cap_usd: 1, day_usd: 1, week_usd: 1 }, search: { period: "month", cap_usd: 1, day_usd: 1, week_usd: 1 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "c".repeat(64);
  const at = "2026-10-27T00:00:00.000Z";
  assert.deepEqual(appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key, usd: 0.1, at }), { ok: true });
  assert.deepEqual(appendEvent({ dir, budget: "search", tool: "a", event: "reserve", key, usd: 0.1, at }), { ok: true }, "a key open in judge does not block search");
  assert.deepEqual(appendEvent({ dir, budget: "judge", tool: "a", event: "settle", key, usd: 0.1, at }), { ok: true });
  assert.deepEqual(appendEvent({ dir, budget: "search", tool: "a", event: "reserve", key, usd: 0.1, at }), { ok: false, reason: "unsettled" }, "settling it in judge leaves it open in search");
});

test("with no budget for what it would spend, nothing is written and the event is refused", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const got = appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "a".repeat(64), usd: 0.01, at: "2026-10-27T00:00:00.000Z" });
  assert.deepEqual(got, { ok: false, reason: "no-budget" });
  assert.equal(readBudget(dir, "judge"), null);
  assert.equal(existsSync(path.join(dir, "judge")), false);
});

test("an open reservation from the month before still blocks the same key", (t) => {
  const dir = folder({ judge: { period: "month", cap_usd: 1 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = "b".repeat(64);
  assert.equal(appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key, usd: 0.1, at: "2026-09-30T23:59:00.000Z" }).ok, true);
  assert.deepEqual(appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key, usd: 0.1, at: "2026-10-01T00:01:00.000Z" }), { ok: false, reason: "unsettled" });
  assert.equal(appendEvent({ dir, budget: "judge", tool: "a", event: "settle", key, usd: 0.1, at: "2026-10-01T00:02:00.000Z" }).ok, true);
});

test("a stale lock is removed, and a live one makes the writer wait and then give up", (t) => {
  const dir = folder({ judge: { period: "month", cap_usd: 1 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "judge", "2026-10.jsonl.lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  assert.equal(appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "c".repeat(64), usd: 0.1, at: "2026-10-27T00:00:00.000Z" }).ok, true);
  assert.equal(existsSync(lock), false, "the lock is removed after the write");
  mkdirSync(lock);
  const got = appendEvent({ dir, budget: "judge", tool: "a", event: "reserve", key: "d".repeat(64), usd: 0.1, at: "2026-10-27T00:00:00.000Z", lockWaitMs: 100 });
  assert.deepEqual(got, { ok: false, reason: "locked" });
  assert.equal(existsSync(lock), true, "a live lock is not taken away from its holder");
});
