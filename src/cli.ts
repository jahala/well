#!/usr/bin/env node
// The command: a client in any language spends through the ledger by calling `well`, so the rule
// has one implementation (docs/tend2/command.tend2.html, docs/tend2/keys.tend2.html). Every call
// prints one JSON line and exits 0 when allowed, 1 when refused, 2 on a usage error, and 3 when the
// ledger folder or the Keychain could not be read or written. The line goes to standard output,
// except for `well run`, whose standard output is the child's: its line goes to standard error,
// and once the child has started, well exits with the child's code.
//
// This file is the edge: it reads the arguments, the clock, the home folder and the environment,
// and hands them to src/ledger.ts, src/keychain.ts and src/run.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { parseArgs } from "node:util";
import { appendEvent, MAX_USD, parseDollars, periodOf, readBreaches, readStatus, type ReleaseWhy } from "./ledger.ts";
import { parseItem, putSecret, setSecret, systemSecurity, type Item } from "./keychain.ts";
import { CHARGE_VARIABLE, runWithSecret, type RunRequest } from "./run.ts";
import { noteReading, readAccount, readingOf, statusText } from "./seats.ts";

const allFlags = ["dir", "budget", "tool", "key", "usd", "why", "at", "period", "estimate", "secret", "env", "keychain"] as const;
type Flag = (typeof allFlags)[number];

const shapes = {
  reserve: { required: ["budget", "tool", "key", "usd"], optional: ["dir"] },
  settle: { required: ["budget", "tool", "key", "usd"], optional: ["dir"] },
  release: { required: ["budget", "tool", "key", "why"], optional: ["dir"] },
  status: { required: ["budget"], optional: ["dir", "period"] },
  breaches: { required: [], optional: ["dir"] },
  run: { required: ["budget", "tool", "key", "estimate", "secret", "env"], optional: ["dir", "keychain"] },
  key: { required: [], optional: ["keychain"] },
} as const satisfies Record<string, { required: readonly Flag[]; optional: readonly Flag[] }>;

type Name = keyof typeof shapes;
const names = Object.keys(shapes) as Name[];
const whys: readonly ReleaseWhy[] = ["not-sent", "refused", "reconciled"];
const flags = Object.fromEntries(allFlags.map((flag) => [flag, { type: "string" as const }]));

type Command =
  | { name: "reserve" | "settle"; dir: string; budget: string; tool: string; key: string; usd: number; at: string }
  | { name: "release"; dir: string; budget: string; tool: string; key: string; why: ReleaseWhy; at: string }
  | { name: "status"; dir: string; budget: string; period: string; at: string }
  | { name: "breaches"; dir: string }
  | { name: "run"; request: RunRequest }
  | { name: "key set" | "key put"; item: Item; keychain?: string };

type Parsed = { ok: true; command: Command } | { ok: false; usage: string };

const usage = (message: string): Parsed => ({ ok: false, usage: message });

/** A moment in UTC, written as toISOString() writes it, on a day the calendar has. */
function isMoment(at: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(at)) return false;
  const date = new Date(at);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === at.slice(0, 19);
}

/** Reads the arguments into a command, or names what is wrong with them. Pure. */
function parse(argv: readonly string[], context: { now: string; home: string }): Parsed {
  const cut = argv.indexOf("--");
  const own = cut < 0 ? [...argv] : argv.slice(0, cut);
  const child = cut < 0 ? null : argv.slice(cut + 1);
  let values: Partial<Record<Flag, string>>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: own, options: flags, strict: true, allowPositionals: true }));
  } catch (error) {
    return usage((error as Error).message);
  }
  const [name, ...extra] = positionals;
  if (name === undefined) return usage(`name a command: ${names.join(", ")}`);
  if (!names.includes(name as Name)) return usage(`unknown command ${name}; use ${names.join(", ")}`);
  if (name !== "key" && extra.length > 0) return usage(`well ${name} takes flags only, not ${extra.join(" ")}`);
  if (name !== "run" && child !== null) return usage(`only well run takes a command after --`);
  const shape = shapes[name as Name];
  const allowed: readonly Flag[] = [...shape.required, ...shape.optional];
  for (const flag of Object.keys(values) as Flag[]) {
    if (!allowed.includes(flag)) return usage(`well ${name} does not take --${flag}`);
  }
  for (const flag of shape.required) {
    if (!values[flag]) return usage(`well ${name} needs --${flag}`);
  }
  if (values.dir === "") return usage("--dir must not be empty");
  const dir = values.dir ?? path.join(context.home, ".local", "share", "well");
  const keychain = values.keychain;
  if (keychain !== undefined && !/^\/[^\s"'\\]+$/.test(keychain)) {
    return usage("--keychain must be an absolute path with no space, quote or backslash");
  }
  // The money commands read the clock at the call and take no --at, so no caller can choose the
  // month it spends in; a test passes the moment through the library instead.
  const at = context.now;
  const budget = values.budget ?? "";
  const tool = values.tool ?? "";
  const key = values.key ?? "";

  if (name === "key") {
    const [verb, itemName, ...rest] = extra;
    if (verb !== "set" && verb !== "put") return usage("well key takes set or put: well key set <service/account>, well key put <service/account>");
    if (itemName === undefined) return usage(`well key ${verb} needs <service/account>`);
    if (rest.length > 0) return usage(`well key ${verb} takes one <service/account>, not ${extra.slice(1).join(" ")}`);
    const item = parseItem(itemName);
    if (!item) return usage("<service/account> must be two names joined by one slash, each of letters, digits, dot, dash, underscore or @");
    return { ok: true, command: { name: `key ${verb}`, item, ...(keychain ? { keychain } : {}) } };
  }
  if (name === "breaches") return { ok: true, command: { name, dir } };
  if (name === "status") {
    const period = values.period ?? periodOf(context.now);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return usage(`--period must be a month such as 2026-10, not ${period}`);
    return { ok: true, command: { name, dir, budget, period, at } };
  }
  if (!/^[0-9a-f]{64}$/.test(key)) return usage("--key must be the request's sha256 as 64 lowercase hex digits");
  if (name === "run") {
    const estimate = values.estimate ?? "";
    const estimateUsd = parseDollars(estimate);
    if (estimateUsd === null) return usage(`--estimate must be dollars as a plain decimal with at most six places, from 0 to ${MAX_USD}, such as 0.25`);
    const secret = parseItem(values.secret ?? "");
    if (!secret) return usage("--secret must be <service/account>: two names joined by one slash, each of letters, digits, dot, dash, underscore or @");
    const env = values.env ?? "";
    if (!/^[A-Z_][A-Z0-9_]*$/.test(env)) return usage("--env must be an environment variable name in capitals, such as ANTHROPIC_API_KEY");
    if (env === CHARGE_VARIABLE) return usage(`--env must not be ${CHARGE_VARIABLE}, which names the charge file`);
    const [command, ...args] = child ?? [];
    if (command === undefined) return usage("well run needs the command to run after --");
    const request: RunRequest = { dir, budget, tool, key, estimate: estimateUsd, secret, env, command, args, ...(keychain ? { keychain } : {}) };
    return { ok: true, command: { name, request } };
  }
  if (name === "release") {
    const why = values.why as ReleaseWhy;
    if (!whys.includes(why)) return usage(`--why must be one of ${whys.join(", ")}`);
    return { ok: true, command: { name, dir, budget, tool, key, why, at } };
  }
  const usd = values.usd ?? "";
  const usdValue = parseDollars(usd);
  if (usdValue === null) return usage(`--usd must be dollars as a plain decimal with at most six places, from 0 to ${MAX_USD}, such as 0.25`);
  return { ok: true, command: { name: name as "reserve" | "settle", dir, budget, tool, key, usd: usdValue, at } };
}

type Line = { ok: true; value: string } | { ok: false; reason: "more-than-one-line" | "interrupted" | "echo-not-off" };

/**
 * The shell that reads a secret from a terminal. It saves the terminal's settings and restores them
 * however it ends: Return, Ctrl-C, a hang-up or a kill. It turns echo off before it asks, and asks
 * only if echo did go off. After the line, it drains whatever else was pasted, so no further line can
 * run in the owner's shell, and says so by its exit code. The secret leaves it only on standard
 * output, by printf, a builtin, never in an argument.
 */
const READ_SECRET = [
  'saved=$(/bin/stty -g) || exit 3',
  "trap '/bin/stty \"$saved\"' EXIT",
  "trap 'exit 130' HUP INT TERM QUIT",
  "/bin/stty -echo || exit 3",
  'printf "%s" "$1" >&2',
  'IFS= read -r line || exit 1',
  "/bin/stty -icanon min 0 time 1",
  'extra=$(/bin/dd bs=65536 count=1 2>/dev/null | /usr/bin/wc -c)',
  'printf "\\n" >&2',
  '[ "$extra" -gt 0 ] && exit 4',
  'printf "%s" "$line"',
].join("\n");

/**
 * Reads the one line of a secret from standard input, never from an argument. On a terminal a shell
 * reads it with echo off (READ_SECRET); Ctrl-C ends the read, and well itself ignores it meanwhile so
 * the shell can restore the terminal. From a pipe it reads to the end, and more than one line is
 * refused.
 */
function readSecretLine(name: string): Line {
  if (!isatty(0)) {
    const line = /^([^\r\n]*)(\r?\n)?$/.exec(readFileSync(0, "utf8"));
    return line ? { ok: true, value: line[1] ?? "" } : { ok: false, reason: "more-than-one-line" };
  }
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    const read = spawnSync("/bin/sh", ["-c", READ_SECRET, "well", `Paste the secret for ${name}, then press Return: `], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
    if (read.signal || read.status === 130) return { ok: false, reason: "interrupted" };
    if (read.status === 3) return { ok: false, reason: "echo-not-off" };
    if (read.status === 4) return { ok: false, reason: "more-than-one-line" };
    return { ok: true, value: read.status === 0 ? (read.stdout ?? "") : "" };
  } finally {
    process.removeListener("SIGINT", ignore);
  }
}

/** How long status and breaches wait for the ledger's lock. */
const READ_LOCK_WAIT_MS = 2_000;

/** Carries out a command against the ledger folder and the Keychain, and says how to exit. */
function carryOut(command: Command): { exit: number; line: object } {
  switch (command.name) {
    // A read waits for the lock only briefly, since a writer holds it for milliseconds, and a read
    // the lock keeps out is a fault, exit 3: it could not read, which is neither a breach nor a
    // refusal.
    case "status": {
      const answer = readStatus({ ...command, lockWaitMs: READ_LOCK_WAIT_MS });
      return { exit: !answer.ok && answer.reason === "locked" ? 3 : answer.ok ? 0 : 1, line: answer };
    }
    case "breaches": {
      const answer = readBreaches({ ...command, lockWaitMs: READ_LOCK_WAIT_MS });
      return { exit: "reason" in answer ? 3 : answer.ok ? 0 : 1, line: answer };
    }
    case "key set":
    case "key put": {
      const name = `${command.item.service}/${command.item.account}`;
      let answer;
      if (command.name === "key set") answer = setSecret(command.item, command.keychain, systemSecurity);
      else {
        const line = readSecretLine(name);
        answer = line.ok ? putSecret(command.item, line.value, command.keychain, systemSecurity) : line;
      }
      return { exit: answer.ok ? 0 : 1, line: answer.ok ? { ok: true, secret: name } : answer };
    }
    case "run": {
      const { exit, report } = runWithSecret(command.request, { security: systemSecurity, now: () => new Date().toISOString(), scratch: tmpdir(), environment: process.env });
      return { exit, line: report };
    }
    default: {
      const answer = appendEvent({ ...command, event: command.name });
      return { exit: answer.ok ? 0 : 1, line: answer };
    }
  }
}

/**
 * `well seat note`, run by a Claude Code statusLine setting: it reads the statusLine JSON on
 * standard input, logs the reading, and prints the line the session shows. It never fails the
 * session, so every outcome, an error included, is one plain line and exit 0.
 */
function seatNote(argv: readonly string[], context: { now: string; home: string; configDir: string | undefined }): string {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], options: { dir: { type: "string" }, at: { type: "string" } }, strict: true, allowPositionals: true });
    if (positionals.join(" ") !== "seat note") return "well: use well seat note [--dir <folder>]";
    const at = values.at ?? context.now;
    if (!isMoment(at)) return "well: --at must be a moment in UTC";
    if (isatty(0)) return "well: seat note reads the statusLine JSON on standard input";
    // A parse error quotes the text around the fault, and the login config can hold a key, so
    // neither file's error text is ever shown: each has a fixed line of its own.
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      return "well: the statusLine input is not valid JSON";
    }
    let account: string | undefined;
    try {
      account = readAccount(context.configDir ? path.join(context.configDir, ".claude.json") : path.join(context.home, ".claude.json"));
    } catch {
      return "well: the login config could not be read";
    }
    const read = readingOf(input, at, account);
    if (!read.ok) return `well: ${read.reason}`;
    noteReading(values.dir || path.join(context.home, ".local", "share", "well"), read.reading);
    return statusText(read.reading);
  } catch (error) {
    // Only the fault's code is shown, never its message, which may quote a file.
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).name;
    return `well: seat note failed (${code})`;
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "seat") {
  process.stdout.write(`${seatNote(argv, { now: new Date().toISOString(), home: homedir(), configDir: process.env.CLAUDE_CONFIG_DIR || undefined })}\n`);
  process.exit(0);
}
const out = argv[0] === "run" ? process.stderr : process.stdout;
const parsed = parse(argv, { now: new Date().toISOString(), home: homedir() });
let outcome: { exit: number; line: object };
if (!parsed.ok) outcome = { exit: 2, line: parsed };
else {
  try {
    outcome = carryOut(parsed.command);
  } catch (error) {
    outcome = { exit: 3, line: { ok: false, error: (error as Error).message } };
  }
}
out.write(`${JSON.stringify(outcome.line)}\n`);
process.exitCode = outcome.exit;
