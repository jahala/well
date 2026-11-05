// The command: a client in any language spends through the ledger by calling `well`. Each check
// runs src/cli.ts as a child process against real files in a folder under WELL_TMP, and compares
// its answers with the library's, step by step through the umbrella's vector.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendEvent, type EventKind, type LedgerLine, type ReleaseWhy } from "../src/ledger.ts";

interface Step {
  owner_sets_cap_usd?: number;
  tool: string;
  event: EventKind;
  key: string;
  usd: number;
  why?: ReleaseWhy;
  expect: string;
  because: string;
}
interface Vector {
  budget: string;
  cap_usd: number;
  day_usd: number;
  week_usd: number;
  period: string;
  steps: Step[];
}

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const vector = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "ledger-vector.json"), "utf8")) as Vector;
const scratchRoot = scratch();
const key = (c: string): string => c.repeat(64);

/** The steps' budget: its cap, with the day and week limits the vector declares beside it. */
const stepsBudget = (capUsd: number) => ({ [vector.budget]: { period: "month", cap_usd: capUsd, day_usd: vector.day_usd, week_usd: vector.week_usd } });
const setCap = (dir: string, capUsd: number) => writeFileSync(path.join(dir, "budgets.json"), JSON.stringify(stepsBudget(capUsd)));

/** A budget for a check that is not about pacing: its day and week limits are its cap, so only the month binds. */
const unpaced = (capUsd: number) => ({ period: "month", cap_usd: capUsd, day_usd: capUsd, week_usd: capUsd });

/** What status shows of the day and the week when nothing was settled in them. */
const quiet = (limitUsd: number) => ({ day: { spent_usd: 0, limit_usd: limitUsd }, week: { spent_usd: 0, limit_usd: limitUsd } });

function folder(budgets?: object): string {
  const dir = mkdtempSync(path.join(scratchRoot, "command-"));
  if (budgets) writeFileSync(path.join(dir, "budgets.json"), JSON.stringify(budgets));
  return dir;
}

/** Runs the command and holds it to its one promise about output: one JSON line, nothing on stderr. */
function well(args: string[]): { exit: number | null; out: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(run.stderr, "", `well ${args.join(" ")} wrote to stderr`);
  assert.match(run.stdout, /^[^\n]+\n$/, `well ${args.join(" ")} printed one line`);
  return { exit: run.status, out: JSON.parse(run.stdout) as Record<string, unknown> };
}

// The money commands read the clock themselves, so history in another month is written
// through the library, which takes the moment as an argument, and the command acts in the present.
const thisMonth = (): string => new Date().toISOString().slice(0, 7);

/** Writes an event through the library at a chosen moment, and insists it was allowed. */
function history(dir: string, budget: string, event: "reserve" | "settle", k: string, usd: number, at: string): void {
  assert.deepEqual(appendEvent({ dir, budget, tool: "a", event, key: key(k), usd, at }), { ok: true });
}

/** Every line of a budget's ledger, in every month, without the moment it was written. */
function linesWithoutMoment(dir: string, budget: string): Omit<LedgerLine, "at" | "period">[] {
  const folderOf = path.join(dir, budget);
  if (!existsSync(folderOf)) return [];
  return readdirSync(folderOf)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readFileSync(path.join(folderOf, name), "utf8").split("\n").filter(Boolean))
    .map((l) => {
      const { at: _at, period: _period, ...rest } = JSON.parse(l) as LedgerLine;
      return rest;
    });
}

function eventArgs(dir: string, step: Step): string[] {
  const args = [step.event, "--dir", dir, "--budget", vector.budget, "--tool", step.tool, "--key", step.key];
  return step.event === "release" ? [...args, "--why", step.why ?? "reconciled"] : [...args, "--usd", String(step.usd)];
}

function ledgerText(dir: string, budget: string, period: string): string {
  try {
    return readFileSync(path.join(dir, budget, `${period}.jsonl`), "utf8");
  } catch {
    return "";
  }
}

/** Spent and held, summed straight from the ledger's lines in millionths. */
function sums(lines: LedgerLine[], period: string): { spent_usd: number; held_usd: number } {
  const open = new Map<string, number>();
  let spent = 0;
  for (const line of lines) {
    const usd = Math.round(line.usd * 1e6);
    if (line.event === "reserve") open.set(line.key, usd);
    else open.delete(line.key);
    if (line.event === "settle" && line.period === period) spent += usd;
  }
  const held = [...open.values()].reduce((n, v) => n + v, 0);
  return { spent_usd: spent / 1e6, held_usd: held / 1e6 };
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

test("the command answers every step of the vector as the library does, and writes the same ledger", (t) => {
  const budgets = stepsBudget(vector.cap_usd);
  const byLibrary = folder(budgets);
  const byCommand = folder(budgets);
  t.after(() => [byLibrary, byCommand].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  vector.steps.forEach((step, i) => {
    if (step.owner_sets_cap_usd !== undefined) [byLibrary, byCommand].forEach((dir) => setCap(dir, step.owner_sets_cap_usd ?? 0));
    const why = step.why ?? (step.event === "release" ? "reconciled" : undefined);
    const library = appendEvent({ dir: byLibrary, budget: vector.budget, tool: step.tool, event: step.event, key: step.key, usd: step.usd, ...(why ? { why } : {}), at: new Date().toISOString() });
    const { exit, out } = well(eventArgs(byCommand, step));
    assert.deepEqual(out, library, `step ${i + 1} (${step.because})`);
    assert.equal(exit, library.ok ? 0 : 1, `step ${i + 1} exits 0 when allowed and 1 when refused`);
    assert.equal(library.ok ? "allow" : `refuse:${library.reason}`, step.expect, `step ${i + 1} (${step.because})`);
  });
  assert.deepEqual(linesWithoutMoment(byCommand, vector.budget), linesWithoutMoment(byLibrary, vector.budget));
});

test("status sums match the ledger after every step of the vector", (t) => {
  const dir = folder(stepsBudget(vector.cap_usd));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const period = thisMonth();
  const status = ["status", "--dir", dir, "--budget", vector.budget, "--period", period];
  let cap = vector.cap_usd;
  vector.steps.forEach((step, i) => {
    if (step.owner_sets_cap_usd !== undefined) setCap(dir, (cap = step.owner_sets_cap_usd));
    well(eventArgs(dir, step));
    const lines = ledgerText(dir, vector.budget, period).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
    const { exit, out } = well(status);
    assert.equal(exit, 0);
    const { spent_usd, held_usd } = sums(lines, period);
    const windows = { day: { spent_usd, limit_usd: vector.day_usd }, week: { spent_usd, limit_usd: vector.week_usd } };
    assert.deepEqual(out, { ok: true, budget: vector.budget, period, spent_usd, held_usd, cap_usd: cap, ...windows }, `after step ${i + 1}`);
  });
  const settledToday = { spent_usd: 1.38 };
  assert.deepEqual(well(status).out, { ok: true, budget: "judge", period, spent_usd: 1.38, held_usd: 0, cap_usd: 1, day: { ...settledToday, limit_usd: vector.day_usd }, week: { ...settledToday, limit_usd: vector.week_usd } });
});

test("status holds a reservation still open from the month before, and counts only this month as spent", (t) => {
  const dir = folder({ judge: unpaced(5) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  history(dir, "judge", "reserve", "a", 0.4, "2026-09-30T23:00:00.000Z");
  history(dir, "judge", "settle", "a", 0.4, "2026-09-30T23:01:00.000Z");
  history(dir, "judge", "reserve", "b", 0.25, "2026-09-30T23:02:00.000Z");
  const { out } = well(["status", "--dir", dir, "--budget", "judge", "--period", "2026-10"]);
  assert.deepEqual(out, { ok: true, budget: "judge", period: "2026-10", spent_usd: 0, held_usd: 0.25, cap_usd: 5, ...quiet(5) });
});

test("status of a budget nobody has spent on yet is zero and writes nothing", (t) => {
  const dir = folder({ judge: unpaced(5) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { exit, out } = well(["status", "--dir", dir, "--budget", "judge", "--period", "2026-10"]);
  assert.equal(exit, 0);
  assert.deepEqual(out, { ok: true, budget: "judge", period: "2026-10", spent_usd: 0, held_usd: 0, cap_usd: 5, ...quiet(5) });
  assert.deepEqual(files(dir), ["budgets.json"]);
});

test("with no budget, every command refuses with exit 1 and writes nothing", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const args of [
    ["reserve", "--usd", "0.1"],
    ["settle", "--usd", "0.1"],
    ["release", "--why", "not-sent"],
  ]) {
    const { exit, out } = well([...args, "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("a")]);
    assert.equal(exit, 1);
    assert.deepEqual(out, { ok: false, reason: "no-budget" });
  }
  const { exit, out } = well(["status", "--dir", dir, "--budget", "judge"]);
  assert.equal(exit, 1);
  assert.deepEqual(out, { ok: false, reason: "no-budget" });
  assert.deepEqual(files(dir), []);
});

test("a ledger folder the command cannot read exits 3 with the error, and writes nothing", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "budgets.json"), "{not json");
  const { exit, out } = well(["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("a"), "--usd", "0.1"]);
  assert.equal(exit, 3);
  assert.equal(out.ok, false);
  assert.equal(typeof out.error, "string");
  assert.deepEqual(files(dir), ["budgets.json"]);
});

test("a budgets file that is not exactly the owner's shape exits 3, names the fault, and writes nothing", (t) => {
  const cases: [string, RegExp][] = [
    ["[]", /must be an object/],
    ['{"judge": 5}', /judge must be an object/],
    ['{"judge": {"period": "year", "cap_usd": 50}}', /judge\.period must be "month"/],
    ['{"judge": {"cap_usd": 5}}', /judge\.period must be "month"/],
    ['{"judge": {"period": "month", "cap_usd": "5"}}', /judge\.cap_usd must be a number/],
    ['{"judge": {"period": "month", "cap_usd": true}}', /judge\.cap_usd must be a number/],
    ['{"judge": {"period": "month", "cap_usd": null}}', /judge\.cap_usd must be a number/],
    ['{"judge": {"period": "month"}}', /judge\.cap_usd must be a number/],
    ['{"judge": {"period": "month", "cap_usd": -1}}', /judge\.cap_usd must be a number of dollars at least 0/],
    ['{"judge": {"period": "month", "cap_usd": 5, "hour_usd": 1}}', /judge has an unknown field hour_usd/],
    ['{"judge": {"period": "month", "cap_usd": 5, "day_usd": "1"}}', /judge\.day_usd must be a number/],
    ['{"judge": {"period": "month", "cap_usd": 5, "week_usd": -1}}', /judge\.week_usd must be a number of dollars at least 0/],
    ['{"judge": {"period": "month", "cap_usd": 5}, "search": {"period": "week", "cap_usd": 2}}', /search\.period must be "month"/],
  ];
  for (const [budgets, named] of cases) {
    const dir = folder();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, "budgets.json"), budgets);
    for (const args of [
      ["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("a"), "--usd", "0.1"],
      ["status", "--dir", dir, "--budget", "judge"],
      ["breaches", "--dir", dir],
    ]) {
      const { exit, out } = well(args);
      assert.equal(exit, 3, `${budgets}: well ${args[0]} exits 3`);
      assert.equal(out.ok, false);
      assert.match(String(out.error), named, `${budgets}: well ${args[0]} names the fault`);
    }
    assert.deepEqual(files(dir), ["budgets.json"], `${budgets}: nothing is written`);
  }
});

test("an amount is allowed down to a millionth and up to the ceiling", (t) => {
  const dir = folder({ judge: unpaced(2_000_000) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(well(["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("a"), "--usd", "0.000001"]), { exit: 0, out: { ok: true } });
  assert.deepEqual(well(["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("b"), "--usd", "1000000"]), { exit: 0, out: { ok: true } });
  assert.deepEqual(well(["status", "--dir", dir, "--budget", "judge", "--period", new Date().toISOString().slice(0, 7)]).out.held_usd, 1000000.000001);
});

test("a last line torn by a writer that died is skipped, counted, and never glued to the next event", (t) => {
  const dir = folder({ judge: unpaced(5) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const month = thisMonth();
  const now = new Date().toISOString();
  history(dir, "judge", "reserve", "a", 0.4, now);
  history(dir, "judge", "settle", "a", 0.4, now);
  history(dir, "judge", "reserve", "b", 0.25, now);
  const file = path.join(dir, "judge", `${month}.jsonl`);
  writeFileSync(file, `${readFileSync(file, "utf8")}{"at":"${now}","budget":"judge","period":"${month}","tool":"a","key":"${key("c")}","event":"rese`);
  const status = ["status", "--dir", dir, "--budget", "judge", "--period", month];
  assert.deepEqual(well(status).out, { ok: true, budget: "judge", period: month, spent_usd: 0.4, held_usd: 0.25, cap_usd: 5, day: { spent_usd: 0.4, limit_usd: 5 }, week: { spent_usd: 0.4, limit_usd: 5 }, torn_lines: 1 });
  assert.deepEqual(well(["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("d"), "--usd", "0.1"]), { exit: 0, out: { ok: true } });
  assert.deepEqual(well(["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("e"), "--usd", "0.1"]), { exit: 0, out: { ok: true } });
  const lines = readFileSync(file, "utf8").split("\n");
  assert.ok(lines.at(-2)?.endsWith('"usd":0.1,"cap_usd":5}') && lines.at(-3)?.endsWith('"usd":0.1,"cap_usd":5}'), "each new event is a whole line of its own");
  assert.ok(lines.some((l) => l.endsWith('"event":"rese')), "the torn fragment is kept as it was, never rewritten");
  assert.deepEqual(well(status).out, { ok: true, budget: "judge", period: month, spent_usd: 0.4, held_usd: 0.45, cap_usd: 5, day: { spent_usd: 0.4, limit_usd: 5 }, week: { spent_usd: 0.4, limit_usd: 5 }, torn_lines: 1 });
  assert.deepEqual(well(["breaches", "--dir", dir]).out, { ok: true, periods: 1, breaches: [] });
});

test("a budget's own day and week limits are read, and win over the ones derived from its cap", (t) => {
  // A budget with limits of its own: judge $20 a month, $4 a day, $10 a week.
  const dir = folder({ judge: { period: "month", cap_usd: 20, day_usd: 4, week_usd: 10 }, search: { period: "month", cap_usd: 5 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reserve = (budget: string, k: string, usd: string) => well(["reserve", "--dir", dir, "--budget", budget, "--tool", "a", "--key", key(k), "--usd", usd]);
  assert.deepEqual(reserve("judge", "a", "3.5"), { exit: 0, out: { ok: true } }, "3.50 fits the $4 day, though a derived day would be $2");
  assert.deepEqual(reserve("judge", "b", "0.6"), { exit: 1, out: { ok: false, reason: "cap-day" } }, "3.50 held + 0.60 passes the $4 day");
  assert.deepEqual(reserve("search", "c", "0.5"), { exit: 0, out: { ok: true } }, "search has no limits of its own: a day is $5 times 3/30, $0.50");
  assert.deepEqual(reserve("search", "d", "0.000001"), { exit: 1, out: { ok: false, reason: "cap-day" } });
  const status = well(["status", "--dir", dir, "--budget", "judge", "--period", thisMonth()]);
  assert.deepEqual(status.out, {
    ok: true, budget: "judge", period: thisMonth(), spent_usd: 0, held_usd: 3.5, cap_usd: 20,
    day: { spent_usd: 0, limit_usd: 4 }, week: { spent_usd: 0, limit_usd: 10 },
  });
  const derived = well(["status", "--dir", dir, "--budget", "search", "--period", thisMonth()]);
  assert.deepEqual([derived.out.day, derived.out.week], [{ spent_usd: 0, limit_usd: 0.5 }, { spent_usd: 0, limit_usd: 1.875 }]);
});

test("a read the lock keeps out exits 3, locked, so it is never mistaken for a breach or a refusal", (t) => {
  const dir = folder({ judge: unpaced(5) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  history(dir, "judge", "reserve", "a", 0.1, new Date().toISOString());
  const lock = path.join(dir, "judge", `${thisMonth()}.jsonl.lock`);
  mkdirSync(lock);
  for (const args of [["status", "--dir", dir, "--budget", "judge"], ["breaches", "--dir", dir]]) {
    const started = Date.now();
    const { exit, out } = well(args);
    assert.deepEqual([exit, out], [3, { ok: false, reason: "locked" }], `well ${args[0]}`);
    assert.ok(Date.now() - started < 20_000, `well ${args[0]} gave up waiting within the read's wait`);
  }
});

test("a usage error exits 2, names what is wrong, and writes nothing", (t) => {
  const dir = folder({ judge: unpaced(5) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = ["--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("a")];
  const wrong: string[][] = [
    [],
    ["spend", ...base, "--usd", "0.1"],
    ["reserve", "settle", ...base, "--usd", "0.1"],
    ["reserve", ...base],
    ["reserve", "--dir", dir, "--tool", "a", "--key", key("a"), "--usd", "0.1"],
    ["reserve", "--dir", dir, "--budget", "judge", "--key", key("a"), "--usd", "0.1"],
    ["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--usd", "0.1"],
    ["reserve", ...base, "--usd", "abc"],
    ["reserve", ...base, "--usd", "-0.1"],
    ["reserve", ...base, "--usd", "1e-3"],
    ["reserve", ...base, "--usd", `1${"0".repeat(400)}`],
    ["settle", ...base, "--usd", `1${"0".repeat(400)}`],
    ["reserve", ...base, "--usd", "0.0000004"],
    ["reserve", ...base, "--usd", "1000000.000001"],
    ["reserve", ...base, "--usd", ""],
    ["reserve", ...base, "--usd", "0.1", "--why", "not-sent"],
    ["reserve", ...base, "--usd", "0.1", "--colour", "red"],
    ["reserve", ...base, "--usd"],
    ["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", "ABC", "--usd", "0.1"],
    ["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("A"), "--usd", "0.1"],
    ["reserve", ...base, "--usd", "0.1", "--at", "2099-01-01T00:00:00.000Z"],
    ["settle", ...base, "--usd", "0.1", "--at", "2099-01-01T00:00:00.000Z"],
    ["release", ...base, "--why", "not-sent", "--at", "2099-01-01T00:00:00.000Z"],
    ["reserve", ...base, "--usd", "0.1", "--period", "2026-10"],
    ["settle", ...base],
    ["release", ...base],
    ["release", ...base, "--why", "forgot"],
    ["release", ...base, "--why", "not-sent", "--usd", "0"],
    ["status", "--dir", dir],
    ["status", "--dir", dir, "--budget", "judge", "--period", "2026-13"],
    ["status", "--dir", dir, "--budget", "judge", "--period", "202610"],
    ["status", "--dir", dir, "--budget", "judge", "--tool", "a"],
    ["breaches", "--dir", dir, "--budget", "judge"],
    ["breaches", "--dir", dir, "extra"],
  ];
  for (const args of wrong) {
    const { exit, out } = well(args);
    assert.equal(exit, 2, `well ${args.join(" ")} exits 2`);
    assert.equal(out.ok, false);
    assert.equal(typeof out.usage, "string", `well ${args.join(" ")} names what is wrong`);
    assert.ok(String(out.usage).length > 0);
  }
  assert.deepEqual(files(dir), ["budgets.json"]);
});

test("the money commands take no --at, so no caller can choose the month it spends in", (t) => {
  const dir = folder({ judge: unpaced(1) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  history(dir, "judge", "reserve", "a", 1, new Date().toISOString());
  for (const args of [
    ["reserve", "--usd", "0.5", "--key", key("b")],
    ["reserve", "--usd", "0.5", "--key", key("a")],
    ["settle", "--usd", "0.5", "--key", key("a")],
    ["release", "--why", "reconciled", "--key", key("a")],
  ]) {
    const { exit, out } = well([...args, "--dir", dir, "--budget", "judge", "--tool", "a", "--at", "2099-01-01T00:00:00.000Z"]);
    assert.equal(exit, 2, `well ${args[0]} --at is a usage error`);
    assert.match(String(out.usage), /does not take --at/);
  }
  assert.deepEqual(readdirSync(path.join(dir, "judge")).filter((name) => name.endsWith(".jsonl")), [`${thisMonth()}.jsonl`], "nothing is written in another month");
});

test("the moment written is the system clock at the call", (t) => {
  const dir = folder({ judge: unpaced(5) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = Date.now();
  const { exit } = well(["reserve", "--dir", dir, "--budget", "judge", "--tool", "a", "--key", key("a"), "--usd", "0.1"]);
  const after = Date.now();
  assert.equal(exit, 0);
  const [period] = readdirSync(path.join(dir, "judge")).filter((name) => name.endsWith(".jsonl"));
  const line = JSON.parse(readFileSync(path.join(dir, "judge", period ?? ""), "utf8")) as LedgerLine;
  const at = Date.parse(line.at);
  assert.ok(at >= before && at <= after, `${line.at} lies between the call's start and end`);
  assert.equal(`${line.period}.jsonl`, period);
});

test("breaches names every month whose settled spend passed its cap, and exits 1 when there is one", (t) => {
  const dir = folder({ judge: unpaced(1), search: unpaced(2) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  history(dir, "judge", "reserve", "a", 0.9, "2026-09-10T00:00:00.000Z");
  history(dir, "judge", "settle", "a", 0.9, "2026-09-10T00:01:00.000Z");
  history(dir, "judge", "reserve", "b", 0.9, "2026-10-10T00:00:00.000Z");
  history(dir, "judge", "settle", "b", 1.2, "2026-10-10T00:01:00.000Z");
  history(dir, "search", "reserve", "c", 2, "2026-10-11T00:00:00.000Z");
  history(dir, "search", "settle", "c", 2, "2026-10-11T00:01:00.000Z");
  const { exit, out } = well(["breaches", "--dir", dir]);
  assert.equal(exit, 1);
  assert.deepEqual(out, { ok: false, periods: 3, breaches: [{ budget: "judge", period: "2026-10", spent_usd: 1.2, cap_usd: 1, cap_from: "ledger" }] });
});

test("breaches is zero, with exit 0, when every month stayed within the cap it was spent under", (t) => {
  const dir = folder({ judge: unpaced(1) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const step of vector.steps) {
    if (step.owner_sets_cap_usd !== undefined) setCap(dir, step.owner_sets_cap_usd);
    well(eventArgs(dir, step));
  }
  assert.deepEqual(well(["breaches", "--dir", dir]), { exit: 0, out: { ok: true, periods: 1, breaches: [] } });
  const empty = folder();
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(well(["breaches", "--dir", empty]), { exit: 0, out: { ok: true, periods: 0, breaches: [] } });
});
