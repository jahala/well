// The shared spending ledger: one door for every paid call on a budget. The contract is
// jahala/plotplot:contracts/ledger.md, and its rule lives in the test vector, copied whole as
// test/fixtures/ledger-vector.json. tally() and decide() are pure; appendEvent(), readStatus()
// and readBreaches() do the I/O and take the folder, the moment and the tool as arguments.
//
// Files, in the ledger folder (default ~/.local/share/well):
//   budgets.json                    {"judge": {"period": "month", "cap_usd": 5}}, set by the owner
//   <budget>/<yyyy-mm>.jsonl        one event per line, append-only
//   <budget>/<yyyy-mm>.jsonl.lock   an empty directory, held only while one writer appends
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type EventKind = "reserve" | "settle" | "release";
export type ReleaseWhy = "not-sent" | "refused" | "reconciled";
export type Refusal = "unsettled" | "cap" | "cap-week" | "cap-day" | "no-reservation" | "no-budget" | "locked";
export type Decision = { ok: true } | { ok: false; reason: Refusal };

export interface LedgerLine {
  at: string;
  budget: string;
  period: string;
  tool: string;
  key: string;
  event: EventKind;
  usd: number;
  why?: ReleaseWhy;
  /** On a reserve: the cap the decision compared against. Lines written before reserves carried it lack it. */
  cap_usd?: number;
}

export interface Budget {
  period: "month";
  cap_usd: number;
  /** The most a budget may spend in the 24 hours before a reserve; derived from the cap when absent. */
  day_usd?: number;
  /** The most it may spend in the 7 days before a reserve; derived from the cap when absent. */
  week_usd?: number;
}

/** A budget's three limits, in millionths. */
export interface Limits {
  month: number;
  week: number;
  day: number;
}

/**
 * The limits a reserve must fit. A budget's own day_usd and week_usd win; without them a day is the
 * cap times 3/30 and a week the cap times 1.5/4, rounded down to the millionth: three times an even
 * day's share, and one and a half times an even week's (the umbrella's vector, `pacing`). Pure.
 */
export function limitsOf(budget: Budget): Limits {
  const month = micro(budget.cap_usd);
  return {
    month,
    week: budget.week_usd !== undefined ? micro(budget.week_usd) : Math.floor((month * 3) / 8),
    day: budget.day_usd !== undefined ? micro(budget.day_usd) : Math.floor((month * 3) / 30),
  };
}

const STALE_LOCK_MS = 60_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Dollars as whole millionths, so a sum of cents never fails on rounding. */
const micro = (usd: number): number => Math.round(usd * 1e6);

export const periodOf = (at: string): string => at.slice(0, 7);

/** The largest amount one event may carry: a million dollars, far below where millionths lose precision. */
export const MAX_USD = 1_000_000;

/**
 * Dollars written as a plain decimal with at most six places, the millionths the ledger counts, and
 * at most MAX_USD; null for anything else. The one check for an amount given as text, by the command
 * and by a child's charge file. Pure.
 */
export function parseDollars(text: string): number | null {
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(text)) return null;
  const usd = Number(text);
  return usd <= MAX_USD ? usd : null;
}

const holdable = (usd: number): boolean => Number.isFinite(usd) && usd >= 0 && usd <= MAX_USD;

const BUDGET_FIELDS = new Set(["period", "cap_usd", "day_usd", "week_usd"]);

/** What is wrong with a budgets file's text, or its budgets by name. Pure. */
export function parseBudgets(text: string): { ok: true; budgets: Map<string, Budget> } | { ok: false; problem: string } {
  let all: unknown;
  try {
    all = JSON.parse(text);
  } catch {
    return { ok: false, problem: "is not valid JSON" };
  }
  if (all === null || typeof all !== "object" || Array.isArray(all)) return { ok: false, problem: "must be an object of budgets by name" };
  const budgets = new Map<string, Budget>();
  for (const [name, entry] of Object.entries(all)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, problem: `${name} must be an object` };
    const unknown = Object.keys(entry).find((field) => !BUDGET_FIELDS.has(field));
    if (unknown !== undefined) return { ok: false, problem: `${name} has an unknown field ${unknown}` };
    const fields = entry as Record<string, unknown>;
    if (fields.period !== "month") return { ok: false, problem: `${name}.period must be "month"` };
    const budget: Budget = { period: "month", cap_usd: 0 };
    for (const field of ["cap_usd", "day_usd", "week_usd"] as const) {
      const value = fields[field];
      if (value === undefined && field !== "cap_usd") continue;
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, problem: `${name}.${field} must be a number` };
      if (value < 0) return { ok: false, problem: `${name}.${field} must be a number of dollars at least 0` };
      budget[field] = value;
    }
    budgets.set(name, budget);
  }
  return { ok: true, budgets };
}

/**
 * Every budget the owner set, by name; empty when there is no budgets file. A file that is not
 * exactly the owner's shape is a fault, never a missing budget, so a broken file never reads as a
 * refusal: it throws, and the command turns that into exit 3 with the fault named.
 */
export function readBudgets(dir: string): Map<string, Budget> {
  const file = path.join(dir, "budgets.json");
  if (!existsSync(file)) return new Map();
  const parsed = parseBudgets(readFileSync(file, "utf8"));
  if (!parsed.ok) throw new Error(`budgets.json ${parsed.problem}`);
  return parsed.budgets;
}

/** The budget the owner set, or null when there is none. */
export function readBudget(dir: string, budget: string): Budget | null {
  return readBudgets(dir).get(budget) ?? null;
}

export interface Lines {
  current: readonly LedgerLine[];
  previous: readonly LedgerLine[];
}

/**
 * What a period's lines add up to, in millionths: spent is every settle this period, and open
 * holds each reservation with no later settle or release for its key, in this period or any
 * before it. Pure.
 */
export function tally(lines: Lines): Totals {
  const open = new Map<string, number>();
  const recent: Record<string, number> = {};
  for (const line of [...lines.previous, ...lines.current]) {
    if (line.event === "reserve") open.set(line.key, micro(line.usd));
    else open.delete(line.key);
    if (line.event === "settle") recent[minuteOf(line.at)] = (recent[minuteOf(line.at)] ?? 0) + micro(line.usd);
  }
  const spent = lines.current.filter((l) => l.event === "settle").reduce((n, l) => n + micro(l.usd), 0);
  return { spent, open, recent };
}

const sum = (values: Iterable<number>): number => [...values].reduce((n, v) => n + v, 0);

/** Decides one event against this period's lines and the period before. Pure. */
export interface Totals {
  /** Settled this period, in millionths. */
  spent: number;
  /** Every open reservation, by key, in millionths. */
  open: Map<string, number>;
  /** Settled per minute, by the minute's index since 1970, for the day and the week. */
  recent: Readonly<Record<string, number>>;
}

const DAY_MINUTES = 1_440;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const minuteOf = (at: string | number): number => Math.floor((typeof at === "number" ? at : Date.parse(at)) / 60_000);

/**
 * Settled in the window of whole minutes up to and including a moment's minute, in millionths. The
 * umbrella's contract counts windows by the minute, so a client keeps one sum per minute instead of
 * every settle: the judge ledger's 68,945 settles of one week fell in 608 minutes. Pure.
 */
export function settledWithin(recent: Totals["recent"], at: string, minutes: number): number {
  const last = minuteOf(at);
  let total = 0;
  for (const [minute, usd] of Object.entries(recent)) {
    const m = Number(minute);
    if (m > last - minutes && m <= last) total += usd;
  }
  return total;
}

/**
 * Decides one event against what the ledger adds up to (tally() or readTotals()). A reserve must fit
 * the month, the week and the day: spent in each, plus every open reservation, plus its estimate.
 * Refused, it names the first it misses, in that order. Pure.
 */
export function decide(totals: Totals, event: { event: EventKind; key: string; usd: number; at: string }, limits: Limits): Decision {
  const { spent, open, recent } = totals;
  if (event.event === "reserve") {
    if (open.has(event.key)) return { ok: false, reason: "unsettled" };
    const held = sum(open.values()) + micro(event.usd);
    if (spent + held > limits.month) return { ok: false, reason: "cap" };
    if (settledWithin(recent, event.at, WEEK_MINUTES) + held > limits.week) return { ok: false, reason: "cap-week" };
    if (settledWithin(recent, event.at, DAY_MINUTES) + held > limits.day) return { ok: false, reason: "cap-day" };
    return { ok: true };
  }
  return open.has(event.key) ? { ok: true } : { ok: false, reason: "no-reservation" };
}

/**
 * A ledger file's events, and how many of its lines are not events. A writer that died mid-append
 * leaves a torn last line; it never returned an answer, so its caller never sent the call, and the
 * line is skipped and counted, never rewritten. Pure over the file's text.
 */
export function parseLedger(text: string): { lines: LedgerLine[]; torn: number } {
  const lines: LedgerLine[] = [];
  let torn = 0;
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      torn += 1;
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { event?: unknown }).event === "string") lines.push(parsed as LedgerLine);
    else torn += 1;
  }
  return { lines, torn };
}

function readLedger(file: string): { lines: LedgerLine[]; torn: number } {
  return existsSync(file) ? parseLedger(readFileSync(file, "utf8")) : { lines: [], torn: 0 };
}

function readLines(file: string): LedgerLine[] {
  return readLedger(file).lines;
}

/** True when a file's last byte is not a newline, as a torn last line leaves it. */
function endsMidLine(file: string): boolean {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  if (size === 0) return false;
  const fd = openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** How long ago a lock directory was made, or null when it is gone. */
function ageOf(dir: string): number | null {
  try {
    return Date.now() - statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Removes a lock older than a minute, which belongs to a writer that died. Only one waiter may break
 * it at a time: it must first take a second lock, the breaker, and checks the lock's age again under
 * it. Without the breaker, a waiter that saw the old lock could remove the fresh one another writer
 * had just taken, and two writers would decide at once. False when another waiter is breaking.
 */
function breakStale(lock: string): boolean {
  const breaker = `${lock}.break`;
  try {
    mkdirSync(breaker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = ageOf(breaker);
    if (age !== null && age > STALE_LOCK_MS) {
      try {
        rmdirSync(breaker);
      } catch {
        // Another waiter removed the dead breaker first.
      }
    }
    return false;
  }
  try {
    const age = ageOf(lock);
    if (age !== null && age > STALE_LOCK_MS) {
      try {
        rmdirSync(lock);
      } catch {
        // Its holder released it at the last moment.
      }
    }
    return true;
  } finally {
    rmdirSync(breaker);
  }
}

/** Takes the lock as a directory, breaking one older than a minute. False after lockWaitMs. */
function takeLock(lock: string, lockWaitMs: number): boolean {
  const until = Date.now() + lockWaitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const age = ageOf(lock);
    if (age !== null && age > STALE_LOCK_MS && breakStale(lock)) continue;
    if (Date.now() >= until) return false;
    Atomics.wait(pause, 0, 0, age !== null && age > STALE_LOCK_MS ? 2 : 25);
  }
}

/**
 * Runs work while holding the lock beside a ledger file, or returns null after lockWaitMs. A lock
 * that is gone when the work is done was broken by another writer, so another decision may have
 * been made at the same time; that is a named fault, never a silent success.
 */
export function underLock<T>(file: string, lockWaitMs: number, work: () => T): T | null {
  const lock = `${file}.lock`;
  if (!takeLock(lock, lockWaitMs)) return null;
  try {
    return work();
  } finally {
    try {
      rmdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`the lock on ${path.basename(file)} was broken while this writer held it; what it wrote stands, but another writer may have decided at the same time`);
    }
  }
}

const ledgerFile = (dir: string, budget: string, period: string): string => path.join(dir, budget, `${period}.jsonl`);

/**
 * The running totals, kept in `<budget>/state.json` so a decision folds in only the lines
 * written since the last one, instead of rereading every month. The state is derived from the
 * ledger and nothing else: for each month file it records how many bytes it has folded, and it
 * holds what those bytes add up to. A writer that never touches it is still counted, because the
 * next decision folds whatever follows the recorded position. When the state is missing or cannot
 * be read, or a month older than the newest one grew, or a file shrank, it is rebuilt from the
 * whole ledger, which gives the same totals. Only bytes up to the last newline are folded; a
 * trailing partial line is read each time, until a writer completes or terminates it.
 */
const STATE_VERSION = 3;

interface State {
  version: typeof STATE_VERSION;
  files: Record<string, number>;
  spent: Record<string, number>;
  open: Record<string, number>;
  /** Settled per minute, for the eight days before the newest settle. */
  recent: Record<string, number>;
  torn: number;
}

const emptyState = (): State => ({ version: STATE_VERSION, files: {}, spent: {}, open: {}, recent: {}, torn: 0 });

/** Keeps the minutes the day and the week can still reach: eight days before the newest settle. */
function prune(recent: Record<string, number>): Record<string, number> {
  const minutes = Object.keys(recent).map(Number);
  const newest = minutes.length > 0 ? Math.max(...minutes) : 0;
  return Object.fromEntries(Object.entries(recent).filter(([minute]) => Number(minute) > newest - WEEK_MINUTES - DAY_MINUTES));
}
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

function loadState(file: string): State {
  if (!existsSync(file)) return emptyState();
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as State;
    if (state.version === STATE_VERSION && state.files && state.spent && state.open && state.recent && typeof state.torn === "number") return state;
  } catch {
    // An unreadable state is rebuilt from the ledger below.
  }
  return emptyState();
}

/** Applies one month's whole lines to the totals, in the order they were written. */
function applyLines(state: Pick<State, "spent" | "open" | "recent">, period: string, lines: readonly LedgerLine[]): void {
  for (const line of lines) {
    if (line.event === "reserve") state.open[line.key] = micro(line.usd);
    else delete state.open[line.key];
    if (line.event === "settle") {
      state.spent[period] = (state.spent[period] ?? 0) + micro(line.usd);
      const minute = minuteOf(line.at);
      state.recent[minute] = (state.recent[minute] ?? 0) + micro(line.usd);
    }
  }
}

/** Reads the bytes of a file from an offset to its end. */
function readFrom(file: string, offset: number, size: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(size - offset);
    readSync(fd, bytes, 0, bytes.length, offset);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Folds every month file into the state; false when the state must be rebuilt from the start. */
function fold(state: State, folder: string, names: readonly string[]): boolean {
  const newest = Object.keys(state.files).sort().at(-1);
  for (const name of names) {
    const file = path.join(folder, name);
    const size = statSync(file).size;
    const done = state.files[name] ?? 0;
    if (size < done) return false;
    if (size === done) continue;
    if (newest !== undefined && name < newest) return false;
    const bytes = readFrom(file, done, size);
    const cut = bytes.lastIndexOf(0x0a);
    if (cut < 0) continue;
    const { lines, torn } = parseLedger(bytes.subarray(0, cut + 1).toString("utf8"));
    applyLines(state, name.slice(0, 7), lines);
    state.torn += torn;
    state.files[name] = done + cut + 1;
  }
  state.recent = prune(state.recent);
  return true;
}

/**
 * What a budget's ledger adds up to for a period: spent in it, every open reservation of any age,
 * and the lines that are not events. Call it under the ledger's lock: it updates the state file.
 */
export function readTotals(dir: string, budget: string, period: string): Totals & { torn: number } {
  const folder = path.join(dir, budget);
  const names = existsSync(folder) ? readdirSync(folder).filter((name) => MONTH_FILE.test(name)).sort() : [];
  const upTo = names.filter((name) => name.slice(0, 7) <= period);
  // A period older than the newest month is read whole, as the ledger stood then.
  if (upTo.length < names.length) {
    const reads = upTo.map((name) => ({ period: name.slice(0, 7), ...readLedger(path.join(folder, name)) }));
    const totals = emptyState();
    for (const read of reads) applyLines(totals, read.period, read.lines);
    return { spent: totals.spent[period] ?? 0, open: new Map(Object.entries(totals.open)), recent: totals.recent, torn: reads.reduce((n, r) => n + r.torn, 0) };
  }
  const stateFile = path.join(folder, "state.json");
  let state = loadState(stateFile);
  if (!fold(state, folder, names)) {
    state = emptyState();
    fold(state, folder, names);
  }
  if (names.length > 0) {
    // One writer at a time holds the lock, so one temporary name is enough and none piles up.
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, stateFile);
  }
  // A trailing partial line is not folded; it is read each time, as a full reread would read it.
  const result = { spent: { ...state.spent }, open: { ...state.open }, recent: { ...state.recent } };
  let torn = state.torn;
  for (const name of names) {
    const file = path.join(folder, name);
    const size = statSync(file).size;
    const done = state.files[name] ?? 0;
    if (size === done) continue;
    const tail = parseLedger(readFrom(file, done, size).toString("utf8"));
    applyLines(result, name.slice(0, 7), tail.lines);
    torn += tail.torn;
  }
  return { spent: result.spent[period] ?? 0, open: new Map(Object.entries(result.open)), recent: result.recent, torn };
}

export interface AppendRequest {
  dir: string;
  budget: string;
  tool: string;
  event: EventKind;
  key: string;
  usd?: number;
  why?: ReleaseWhy;
  at: string;
  lockWaitMs?: number;
}

/** Writes one event if the rule allows it, under the lock. */
export function appendEvent(request: AppendRequest): Decision {
  const { dir, budget, tool, event, key, why, at, lockWaitMs = 30_000 } = request;
  const amount = event === "release" ? 0 : Number(request.usd ?? 0);
  if (!holdable(amount)) throw new Error(`an amount of ${amount} dollars cannot be held in the ledger; it must be from 0 to ${MAX_USD}`);
  const set = readBudget(dir, budget);
  if (!set) return { ok: false, reason: "no-budget" };
  const period = periodOf(at);
  const file = ledgerFile(dir, budget, period);
  mkdirSync(path.dirname(file), { recursive: true });
  const decision = underLock(file, lockWaitMs, (): Decision => {
    const usd = amount;
    const decision = decide(readTotals(dir, budget, period), { event, key, usd, at }, limitsOf(set));
    if (!decision.ok) return decision;
    const line: LedgerLine = { at, budget, period, tool, key, event, usd };
    if (event === "release" && why) line.why = why;
    if (event === "reserve") line.cap_usd = set.cap_usd;
    // After a torn last line, the event starts on a line of its own, so it is never glued to the
    // fragment; the fragment itself is left as it was.
    appendFileSync(file, `${endsMidLine(file) ? "\n" : ""}${JSON.stringify(line)}\n`);
    readTotals(dir, budget, period);
    return { ok: true };
  });
  return decision ?? { ok: false, reason: "locked" };
}

export type Status =
  | {
      ok: true;
      budget: string;
      period: string;
      spent_usd: number;
      held_usd: number;
      cap_usd: number;
      day: { spent_usd: number; limit_usd: number };
      week: { spent_usd: number; limit_usd: number };
      torn_lines?: number;
    }
  | { ok: false; reason: "no-budget" | "locked" };

/**
 * A budget's spent, held and cap for one period, read under the lock so no half-written line is
 * read. A budget nobody has spent on yet is zero, and reading it writes nothing.
 */
export function readStatus(request: { dir: string; budget: string; period: string; at: string; lockWaitMs?: number }): Status {
  const { dir, budget, period, at, lockWaitMs = 30_000 } = request;
  const set = readBudget(dir, budget);
  if (!set) return { ok: false, reason: "no-budget" };
  const totals = existsSync(path.join(dir, budget))
    ? underLock(ledgerFile(dir, budget, period), lockWaitMs, () => readTotals(dir, budget, period))
    : { spent: 0, open: new Map<string, number>(), recent: {}, torn: 0 };
  if (!totals) return { ok: false, reason: "locked" };
  const limits = limitsOf(set);
  const status = {
    ok: true as const,
    budget,
    period,
    spent_usd: totals.spent / 1e6,
    held_usd: sum(totals.open.values()) / 1e6,
    cap_usd: set.cap_usd,
    day: { spent_usd: settledWithin(totals.recent, at, DAY_MINUTES) / 1e6, limit_usd: limits.day / 1e6 },
    week: { spent_usd: settledWithin(totals.recent, at, WEEK_MINUTES) / 1e6, limit_usd: limits.week / 1e6 },
  };
  // A torn line is shown only when there is one, so a person sees it and can look.
  return totals.torn > 0 ? { ...status, torn_lines: totals.torn } : status;
}

export interface Judged {
  spent_usd: number;
  cap_usd: number;
  cap_from: "ledger" | "budgets";
  breach: boolean;
}

/**
 * Judges one month's lines: it breaches when its settled spend passes the highest cap its reserve
 * lines carry. A month whose reserves carry none, written before reserves carried the cap, is
 * judged against today's cap, and the answer says so. Pure.
 */
export function judgeMonth(lines: readonly LedgerLine[], todayCapUsd: number): Judged {
  const caps = lines.filter((l) => l.event === "reserve" && l.cap_usd !== undefined).map((l) => micro(l.cap_usd ?? 0));
  const cap = caps.length > 0 ? Math.max(...caps) : micro(todayCapUsd);
  const { spent } = tally({ current: lines, previous: [] });
  return { spent_usd: spent / 1e6, cap_usd: cap / 1e6, cap_from: caps.length > 0 ? "ledger" : "budgets", breach: spent > cap };
}

export interface Breach {
  budget: string;
  period: string;
  spent_usd: number;
  cap_usd: number;
  cap_from: "ledger" | "budgets";
}

export type Breaches = { ok: boolean; periods: number; breaches: Breach[] } | { ok: false; reason: "locked" };

/**
 * Every period of every budget that breached, by judgeMonth(), which must never happen; ok is
 * true when none did. A charge may exceed its estimate, so a settle can pass the cap that its
 * reservation fit under.
 */
export function readBreaches(request: { dir: string; lockWaitMs?: number }): Breaches {
  const { dir, lockWaitMs = 30_000 } = request;
  const breaches: Breach[] = [];
  let periods = 0;
  for (const [budget, set] of [...readBudgets(dir)].sort(([a], [b]) => a.localeCompare(b))) {
    const folder = path.join(dir, budget);
    if (!existsSync(folder)) continue;
    const names = readdirSync(folder).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of names) {
      const period = name.slice(0, 7);
      const file = ledgerFile(dir, budget, period);
      const judged = underLock(file, lockWaitMs, () => judgeMonth(readLines(file), set.cap_usd));
      if (judged === null) return { ok: false, reason: "locked" };
      periods += 1;
      const { spent_usd, cap_usd, cap_from, breach } = judged;
      if (breach) breaches.push({ budget, period, spent_usd, cap_usd, cap_from });
    }
  }
  return { ok: breaches.length === 0, periods, breaches };
}
