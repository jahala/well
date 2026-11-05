// Seat readings (docs/tend2/seats.tend2.html): what Claude Code's statusLine input says of the
// account's usage windows, kept as a log. Each reading is the provider's own percent
// of a window and its reset time; well never turns tokens into a percent.
//
// A seat belongs to one account, and the statusLine input names none. Every session on a machine
// uses the login its config names, and a running session follows a change of login, so each
// reading records the account the config names at the reading's moment: its accountUuid, never
// its email.
//
// Files, in the ledger folder (default ~/.local/share/well):
//   seats/claude/<yyyy-mm-dd>.jsonl   one line each time a session's reading changes, kept
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { underLock } from "./ledger.ts";

export interface Window {
  used_percent: number;
  resets_at: number;
}

export interface Reading {
  at: string;
  provider: "claude";
  /** The login's accountUuid at the reading's moment; absent when no login config names one. */
  account?: string;
  session: string;
  model?: string;
  five_hour?: Window;
  seven_day?: Window;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function windowOf(value: unknown): Window | undefined {
  const w = record(value);
  const pct = w?.used_percentage;
  const resets = w?.resets_at;
  if (typeof pct !== "number" || !Number.isFinite(pct) || typeof resets !== "number" || !Number.isFinite(resets)) return undefined;
  return { used_percent: pct, resets_at: resets };
}

/** The account a Claude Code login config names, from the file's text; undefined when it names none. Pure. */
export function accountIn(configText: string): string | undefined {
  const account = record(record(JSON.parse(configText))?.oauthAccount)?.accountUuid;
  return typeof account === "string" && account !== "" ? account : undefined;
}

/** The account the login config at this path names now, or undefined when there is no config. */
export function readAccount(configFile: string): string | undefined {
  return existsSync(configFile) ? accountIn(readFileSync(configFile, "utf8")) : undefined;
}

/** The reading in one statusLine input, or a reason it holds none. Pure. */
export function readingOf(input: unknown, at: string, account?: string): { ok: true; reading: Reading } | { ok: false; reason: string } {
  const body = record(input);
  if (!body) return { ok: false, reason: "the statusLine input is not a JSON object" };
  const session = body.session_id;
  if (typeof session !== "string" || session === "") return { ok: false, reason: "the statusLine input names no session" };
  const model = record(body.model)?.id;
  const limits = record(body.rate_limits);
  const fiveHour = windowOf(limits?.five_hour);
  const sevenDay = windowOf(limits?.seven_day);
  return {
    ok: true,
    reading: {
      at,
      provider: "claude",
      ...(account ? { account } : {}),
      session,
      ...(typeof model === "string" ? { model } : {}),
      ...(fiveHour ? { five_hour: fiveHour } : {}),
      ...(sevenDay ? { seven_day: sevenDay } : {}),
    },
  };
}

/** The status line a session shows: each window's percent, and when the five-hour one resets. */
export function statusText(reading: Reading): string {
  const parts: string[] = [];
  if (reading.five_hour) {
    const resets = new Date(reading.five_hour.resets_at * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    parts.push(`5h ${Math.round(reading.five_hour.used_percent)}% (resets ${resets})`);
  }
  if (reading.seven_day) parts.push(`7d ${Math.round(reading.seven_day.used_percent)}%`);
  return parts.length > 0 ? parts.join(" · ") : "no window reading";
}

/** One seat log line as a reading, or none when a writer that died left it torn. Pure. */
export function readingLine(line: string): Reading[] {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && typeof (parsed as { session?: unknown }).session === "string" ? [parsed as Reading] : [];
  } catch {
    return [];
  }
}

const sameReading = (a: Reading, b: Reading): boolean =>
  JSON.stringify([a.account, a.model, a.five_hour, a.seven_day]) === JSON.stringify([b.account, b.model, b.five_hour, b.seven_day]);

/**
 * Appends the reading to its day's log unless the session's last line that day says the same.
 * The lock is waited for only briefly, because a statusLine must never hold up a session.
 */
export function noteReading(dir: string, reading: Reading, lockWaitMs = 200): "written" | "unchanged" | "locked" {
  const file = path.join(dir, "seats", reading.provider, `${reading.at.slice(0, 10)}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  const outcome = underLock(file, lockWaitMs, () => {
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    const last = lines.flatMap(readingLine).findLast((line) => line.session === reading.session);
    if (last && sameReading(last, reading)) return "unchanged" as const;
    const torn = lines.length > 0 && !readFileSync(file, "utf8").endsWith("\n");
    appendFileSync(file, `${torn ? "\n" : ""}${JSON.stringify(reading)}\n`);
    return "written" as const;
  });
  return outcome ?? "locked";
}
