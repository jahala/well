// well run: one paid call with its secret (docs/tend2/keys.tend2.html). It reserves the estimate,
// reads the secret only once the reservation is allowed, starts the child with the secret in one
// environment variable, and closes the reservation by what the child reports.
//
// The child reports through a file whose path is in WELL_CHARGE: dollars charged as a plain
// decimal, such as 0.018, to settle; `not-sent` or `refused` to release. Its standard output and
// error are the caller's, and an exit code cannot carry dollars, so a file any language or shell
// can write is the simplest channel that cannot mix with the child's own output. A child that
// reports nothing leaves the reservation open, because the call may already have been charged.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { appendEvent, parseDollars, type Decision, type EventKind, type ReleaseWhy } from "./ledger.ts";
import { readSecret, type Item, type Security } from "./keychain.ts";

export const CHARGE_VARIABLE = "WELL_CHARGE";

export interface RunRequest {
  dir: string;
  keychain?: string;
  budget: string;
  tool: string;
  key: string;
  estimate: number;
  secret: Item;
  /** The environment variable the child finds the secret in. */
  env: string;
  command: string;
  args: readonly string[];
}

export interface RunDeps {
  security: Security;
  now: () => string;
  /** The folder well makes its own scratch folder in, for the charge file. */
  scratch: string;
  /** The environment the child starts from, before the secret and WELL_CHARGE are added. */
  environment: NodeJS.ProcessEnv;
  /** How long a write waits for the ledger's lock; the ledger's own default when absent. */
  lockWaitMs?: number;
}

export interface RunOutcome {
  exit: number;
  report: Record<string, unknown>;
}

type Report = { event: "settle"; usd: number } | { event: "release"; why: ReleaseWhy } | { reason: "unreported" | "bad-charge" };

/** What the child wrote to its charge file. */
function readReport(file: string): Report {
  if (!existsSync(file)) return { reason: "unreported" };
  const text = readFileSync(file, "utf8").trim();
  if (text === "") return { reason: "unreported" };
  if (text === "not-sent" || text === "refused") return { event: "release", why: text };
  const usd = parseDollars(text);
  if (usd !== null) return { event: "settle", usd };
  return { reason: "bad-charge" };
}

export function runWithSecret(request: RunRequest, deps: RunDeps): RunOutcome {
  const { dir, budget, tool, key } = request;
  const write = (event: EventKind, extra: { usd?: number; why?: ReleaseWhy }): Decision =>
    appendEvent({ dir, budget, tool, key, event, ...extra, at: deps.now(), ...(deps.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}) });
  // A release that cannot be written leaves the reservation open, and the report says so, so the
  // caller knows the request stays blocked until a person reconciles it.
  const release = (report: Record<string, unknown>): Record<string, unknown> => {
    const released = write("release", { why: "not-sent" });
    return released.ok ? report : { ...report, left_open: released.reason };
  };

  const held = write("reserve", { usd: request.estimate });
  if (!held.ok) return { exit: 1, report: held };
  const secret = readSecret(request.secret, request.keychain, deps.security);
  if (!secret.ok) return { exit: 1, report: release({ ...secret }) };

  const folder = mkdtempSync(path.join(deps.scratch, "well-run-"));
  try {
    const charge = path.join(folder, "charge");
    const env = { ...deps.environment, [request.env]: secret.value, [CHARGE_VARIABLE]: charge };
    const ran = spawnSync(request.command, [...request.args], { stdio: "inherit", env });
    if (ran.error) return { exit: 1, report: release({ ok: false, reason: "not-started", error: ran.error.message }) };
    const exit = ran.status ?? 128 + (ran.signal ? constants.signals[ran.signal] : 0);
    const report = readReport(charge);
    if ("reason" in report) return { exit, report: { ok: false, exit, reason: report.reason } };
    const closed = report.event === "settle" ? write("settle", { usd: report.usd }) : write("release", { why: report.why });
    if (!closed.ok) return { exit, report: { ok: false, exit, reason: closed.reason } };
    return { exit, report: { ok: true, exit, ...report } };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
