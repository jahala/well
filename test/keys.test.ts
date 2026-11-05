// Keys: well is the only thing that reads a secret. Every check runs against a throwaway keychain
// in a folder under WELL_TMP, created through `security -i` so it never joins the owner's search
// list, and deleted after. A made-up secret is searched for in everything well prints, every file
// it leaves, and the arguments of every process alive while the child runs.
import { scratchRoot as scratch } from "./scratch.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { putSecret, readSecret, setSecret, systemSecurity, type Security } from "../src/keychain.ts";
import { runWithSecret } from "../src/run.ts";
import type { LedgerLine } from "../src/ledger.ts";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const scratchRoot = scratch();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const requestKey = (c: string): string => c.repeat(64);

interface Place {
  /** The ledger folder, with a judge budget of $1. */
  dir: string;
  /** A throwaway keychain, unlocked. */
  kc: string;
  /** What the child writes: the sha256 of the secret it saw, and every process's arguments. */
  out: string;
  /** The temporary folder well's own scratch files go to. */
  tmp: string;
}

function place(t: TestContext, capUsd = 1): Place {
  const root = mkdtempSync(path.join(scratchRoot, "keys-"));
  const [dir, out, tmp] = ["ledger", "out", "tmp"].map((name) => path.join(root, name)) as [string, string, string];
  for (const folder of [dir, out, tmp]) mkdirSync(folder);
  // The keys checks are not about pacing, so only the month binds: the day and week limits are the cap.
  writeFileSync(path.join(dir, "budgets.json"), JSON.stringify({ judge: { period: "month", cap_usd: capUsd, day_usd: capUsd, week_usd: capUsd } }));
  const kc = path.join(root, "test.keychain-db");
  const made = spawnSync("/usr/bin/security", ["-i"], { input: `create-keychain -p ${randomBytes(16).toString("hex")} ${kc}\n`, encoding: "utf8" });
  assert.equal(made.status, 0, "a throwaway keychain is created");
  t.after(() => {
    spawnSync("/usr/bin/security", ["delete-keychain", kc]);
    rmSync(root, { recursive: true, force: true });
  });
  return { dir, kc, out, tmp };
}

/** Stores a value the test chose, through standard input, so it never sits in an argument. */
function store(kc: string, item: string, value: string): void {
  const [service, account] = item.split("/");
  const stored = spawnSync("/usr/bin/security", ["-i"], { input: `add-generic-password -s ${service} -a ${account} -w "${value}" ${kc}\n`, encoding: "utf8" });
  assert.equal(stored.status, 0, stored.stdout + stored.stderr);
}

function lookup(kc: string, item: string): { status: number | null; value: string } {
  const [service, account] = item.split("/");
  const found = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service ?? "", "-a", account ?? "", "-w", kc], { encoding: "utf8" });
  return { status: found.status, value: found.stdout.replace(/\n$/, "") };
}

function ledger(dir: string): LedgerLine[] {
  const folder = path.join(dir, "judge");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(path.join(folder, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as LedgerLine);
}

/** Every file under a folder, with its text. */
function texts(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(folder, { recursive: true, encoding: "utf8" })) {
    const file = path.join(folder, name);
    try {
      found.set(file, readFileSync(file, "utf8"));
    } catch {
      // A folder, not a file.
    }
  }
  return found;
}

// The child: records the sha256 of the secret it was given, then every process's arguments, then
// reports its charge (or nothing, for "none") and exits with the code it is told.
const child = [
  "const fs = require('node:fs');",
  "const { createHash } = require('node:crypto');",
  "const { execFileSync } = require('node:child_process');",
  "const [out, charge, code] = process.argv.slice(1);",
  "fs.writeFileSync(out + '/seen', createHash('sha256').update(process.env.JUDGE_KEY ?? '').digest('hex'));",
  "fs.writeFileSync(out + '/ps', execFileSync('ps', ['-axww', '-o', 'args='], { encoding: 'utf8' }));",
  "if (charge !== 'none') fs.writeFileSync(process.env.WELL_CHARGE, charge);",
  "process.exit(Number(code));",
].join("\n");

interface Ran {
  exit: number | null;
  stdout: string;
  stderr: string;
  report: Record<string, unknown>;
}

function wellRun(p: Place, opts: { key?: string; estimate?: string; secret?: string; charge?: string; code?: number } = {}): Ran {
  const args = [
    "run", "--dir", p.dir, "--keychain", p.kc, "--budget", "judge", "--tool", "test",
    "--key", opts.key ?? requestKey("a"), "--estimate", opts.estimate ?? "0.02",
    "--secret", opts.secret ?? "well-test/judge", "--env", "JUDGE_KEY",
    "--", process.execPath, "-e", child, p.out, opts.charge ?? "0.018", String(opts.code ?? 0),
  ];
  const ran = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: p.tmp } });
  const lines = ran.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `well run writes one report line on stderr: ${ran.stderr}`);
  return { exit: ran.status, stdout: ran.stdout, stderr: ran.stderr, report: JSON.parse(lines[0] ?? "") as Record<string, unknown> };
}

/** Runs well and reads its one line: on stderr for run, whose stdout is the child's, else on stdout. */
function well(args: string[], tmp?: string): { exit: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const ran = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...(tmp ? { TMPDIR: tmp } : {}) } });
  const [line, quiet] = args[0] === "run" ? [ran.stderr, ran.stdout] : [ran.stdout, ran.stderr];
  assert.match(line, /^[^\n]+\n$/, `well ${args.join(" ")} printed one line`);
  assert.equal(quiet, "", `well ${args.join(" ")} printed nothing else`);
  return { exit: ran.status, stdout: ran.stdout, stderr: ran.stderr, out: JSON.parse(line) as Record<string, unknown> };
}

test("key set stores a generated secret that reads back non-empty, prints it nowhere, and never replaces one", (t) => {
  const p = place(t);
  const set = well(["key", "set", "well-test/generated", "--keychain", p.kc]);
  assert.equal(set.exit, 0, set.stdout);
  assert.deepEqual(set.out, { ok: true, secret: "well-test/generated" });
  const stored = lookup(p.kc, "well-test/generated");
  assert.equal(stored.status, 0);
  assert.ok(stored.value.length >= 32, "the generated secret is at least 32 characters");
  assert.ok(!set.stdout.includes(stored.value) && !set.stderr.includes(stored.value), "the secret is not printed");
  const again = well(["key", "set", "well-test/generated", "--keychain", p.kc]);
  assert.equal(again.exit, 1);
  assert.deepEqual(again.out, { ok: false, reason: "exists" });
  assert.equal(lookup(p.kc, "well-test/generated").value, stored.value, "an existing secret is never replaced");
});

/** Runs well with its standard input fed from a string, as a pipe. */
function wellWithInput(args: string[], input: string): { exit: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const ran = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input });
  assert.match(ran.stdout, /^[^\n]+\n$/, `well ${args.join(" ")} printed one line`);
  return { exit: ran.status, stdout: ran.stdout, stderr: ran.stderr, out: JSON.parse(ran.stdout) as Record<string, unknown> };
}

// A terminal for well: runs the command on a pseudo-terminal, waits for the prompt, types the line
// this helper reads on its own standard input, and prints everything the terminal showed.
const terminal = [
  "import os, pty, select, sys",
  "line = sys.stdin.buffer.read()",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "    os.execv(sys.argv[1], sys.argv[1:])",
  "shown, typed = b'', False",
  "while True:",
  "    ready, _, _ = select.select([fd], [], [], 20)",
  "    if not ready:",
  "        break",
  "    try:",
  "        chunk = os.read(fd, 4096)",
  "    except OSError:",
  "        break",
  "    if not chunk:",
  "        break",
  "    shown += chunk",
  "    if not typed and b'then press Return' in shown:",
  "        os.write(fd, line)",
  "        typed = True",
  "_, status = os.waitpid(pid, 0)",
  "sys.stdout.buffer.write(shown)",
  "sys.exit(os.waitstatus_to_exitcode(status))",
].join("\n");

test("key put stores the one line on standard input, reads it back equal, and prints it nowhere", (t) => {
  const p = place(t);
  const secret = `sk-made-up-${randomBytes(16).toString("hex")}`;
  const put = wellWithInput(["key", "put", "api.example.com/judge", "--keychain", p.kc], `${secret}\n`);
  assert.equal(put.exit, 0, put.stdout);
  assert.deepEqual(put.out, { ok: true, secret: "api.example.com/judge" });
  assert.equal(lookup(p.kc, "api.example.com/judge").value, secret);
  assert.ok(!put.stdout.includes(secret) && !put.stderr.includes(secret), "the secret is not printed");
  const again = wellWithInput(["key", "put", "api.example.com/judge", "--keychain", p.kc], "sk-other\n");
  assert.deepEqual([again.exit, again.out], [1, { ok: false, reason: "exists" }]);
  assert.equal(lookup(p.kc, "api.example.com/judge").value, secret, "an existing secret is never replaced");
});

test("key put on a terminal reads with echo off, so the terminal never shows the secret", (t) => {
  const p = place(t);
  const secret = `sk-typed-${randomBytes(16).toString("hex")}`;
  const ran = spawnSync("/usr/bin/python3", ["-c", terminal, process.execPath, cli, "key", "put", "api.example.com/typed", "--keychain", p.kc], { input: `${secret}\n`, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.ok(ran.stdout.includes("then press Return"), "well asked for the secret");
  assert.ok(ran.stdout.includes('{"ok":true,"secret":"api.example.com/typed"}'), ran.stdout);
  assert.ok(!ran.stdout.includes(secret), "the terminal never showed the secret");
  assert.equal(lookup(p.kc, "api.example.com/typed").value, secret);
});

test("key put on a terminal refuses a paste of more than one line, and leaves nothing pending to run", { timeout: 60_000 }, (t) => {
  const p = place(t);
  const secret = `sk-pasted-${randomBytes(8).toString("hex")}`;
  // After well exits, whatever is still pending on the terminal would run in the owner's shell. Here
  // the shell reads the terminal raw, waiting half a second at most, and shows what it found.
  const after = `${process.execPath} ${cli} key put api.example.com/pasted --keychain ${p.kc}; /bin/stty -icanon min 0 time 5; printf 'pending:[%s]\\n' "$(dd bs=4096 count=1 2>/dev/null)"`;
  const ran = spawnSync("/usr/bin/python3", ["-c", terminal, "/bin/sh", "-c", after], { input: `${secret}\necho second-line-ran\n`, encoding: "utf8", timeout: 50_000 });
  assert.ok(ran.stdout.includes('{"ok":false,"reason":"more-than-one-line"}'), ran.stdout);
  assert.ok(ran.stdout.includes("pending:[]"), `nothing was left pending: ${ran.stdout}`);
  assert.ok(!ran.stdout.includes(secret), "the terminal never showed the secret");
  assert.notEqual(lookup(p.kc, "api.example.com/pasted").status, 0, "nothing is stored");
});

test("key put on a terminal turns echo back on when the read is interrupted", { timeout: 60_000 }, (t) => {
  const p = place(t);
  const after = `${process.execPath} ${cli} key put api.example.com/cancelled --keychain ${p.kc}; /bin/stty -a`;
  const ran = spawnSync("/usr/bin/python3", ["-c", terminal, "/bin/sh", "-c", after], { input: "\u0003", encoding: "utf8", timeout: 50_000 });
  assert.ok(ran.stdout.includes('{"ok":false,"reason":"interrupted"}'), ran.stdout);
  const flags = ran.stdout.split("\n").find((line) => line.includes("lflags")) ?? "";
  assert.match(flags, /(^|\s)echo(\s|$)/, `echo is on again: ${flags}`);
  assert.notEqual(lookup(p.kc, "api.example.com/cancelled").status, 0);
});

test("key put refuses an empty line, more than one line, and a secret it cannot store safely, and stores nothing", (t) => {
  const p = place(t);
  const cases: [string, string, string][] = [
    ["empty", "\n", "empty-secret"],
    ["nothing", "", "empty-secret"],
    ["two", "sk-one\nsk-two\n", "more-than-one-line"],
    ["space", "sk-has space\n", "unstorable"],
    ["quote", 'sk-has"quote\n', "unstorable"],
    ["backslash", "sk-has\\slash\n", "unstorable"],
  ];
  for (const [account, input, reason] of cases) {
    const put = wellWithInput(["key", "put", `well-test/${account}`, "--keychain", p.kc], input);
    assert.deepEqual([put.exit, put.out], [1, { ok: false, reason }], `input ${JSON.stringify(input)}`);
    assert.notEqual(lookup(p.kc, `well-test/${account}`).status, 0, `nothing is stored for ${JSON.stringify(input)}`);
  }
  assert.deepEqual(putSecret({ service: "well-test", account: "newline" }, "sk-a\nadd-generic-password -s x -a y -w z", p.kc, systemSecurity), { ok: false, reason: "unstorable" });
  assert.notEqual(lookup(p.kc, "x/y").status, 0, "a newline cannot smuggle a second command into security -i");
});

test("key set refuses a store that reads back empty, and removes the empty item", (t) => {
  const p = place(t);
  // The store goes through the real Keychain, but its value is emptied on the way, as piping a
  // value into `security add-generic-password -w` does.
  const emptying: Security = (args, input) => systemSecurity(args, input?.replace(/ -w \S+ /, ' -w "" '));
  assert.deepEqual(setSecret({ service: "well-test", account: "emptied" }, p.kc, emptying), { ok: false, reason: "empty-secret" });
  assert.notEqual(lookup(p.kc, "well-test/emptied").status, 0, "the empty item is removed");
});

test("the secret passes to security only on standard input, never in an argument", (t) => {
  const p = place(t);
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const recording: Security = (args, input) => {
    calls.push({ args, input });
    return systemSecurity(args, input);
  };
  assert.deepEqual(setSecret({ service: "well-test", account: "recorded" }, p.kc, recording), { ok: true });
  const value = lookup(p.kc, "well-test/recorded").value;
  assert.ok(calls.some((call) => call.input?.includes(value)), "the store sends the secret on standard input");
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes(value))), "no argument carries the secret");
  const read = readSecret({ service: "well-test", account: "recorded" }, p.kc, recording);
  assert.deepEqual(read, { ok: true, value });
  const given = `sk-given-${randomBytes(8).toString("hex")}`;
  assert.deepEqual(putSecret({ service: "well-test", account: "given" }, given, p.kc, recording), { ok: true });
  assert.ok(calls.some((call) => call.input?.includes(given)), "the put sends the secret on standard input");
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes(value) || arg.includes(given))), "no argument carries either secret");
});

test("run hands the secret to the child in the named variable only, and it appears nowhere else", (t) => {
  const p = place(t);
  const secret = `made-up-${randomBytes(16).toString("hex")}`;
  store(p.kc, "well-test/judge", secret);
  const ran = wellRun(p);
  assert.equal(ran.exit, 0, ran.stderr);
  assert.deepEqual(ran.report, { ok: true, exit: 0, event: "settle", usd: 0.018 });
  assert.equal(readFileSync(path.join(p.out, "seen"), "utf8"), sha(secret), "the child saw the secret in JUDGE_KEY");
  assert.ok(readFileSync(path.join(p.out, "ps"), "utf8").includes("well-test/judge"), "the snapshot of arguments includes well's own");
  const everywhere = [ran.stdout, ran.stderr, ...texts(p.dir).values(), ...texts(p.out).values(), ...texts(p.tmp).values()];
  assert.ok(everywhere.every((text) => !text.includes(secret)), "the secret is in no output, file or process argument");
  assert.deepEqual(readdirSync(p.tmp), [], "well removes its own scratch folder");
  assert.deepEqual(
    ledger(p.dir).map((l) => [l.event, l.usd, l.tool]),
    [["reserve", 0.02, "test"], ["settle", 0.018, "test"]],
  );
});

test("a refused reservation means the child never starts and the secret is never read", (t) => {
  const p = place(t, 0.01);
  store(p.kc, "well-test/judge", "made-up-refused");
  const ran = wellRun(p);
  assert.equal(ran.exit, 1);
  assert.deepEqual(ran.report, { ok: false, reason: "cap" });
  assert.equal(existsSync(path.join(p.out, "seen")), false, "the child never started");
  assert.deepEqual(ledger(p.dir), []);
  const calls: readonly string[][] = [];
  const counting: Security = (args, input) => {
    (calls as string[][]).push([...args]);
    return systemSecurity(args, input);
  };
  const outcome = runWithSecret(
    { dir: p.dir, keychain: p.kc, budget: "judge", tool: "test", key: requestKey("b"), estimate: 0.02, secret: { service: "well-test", account: "judge" }, env: "JUDGE_KEY", command: process.execPath, args: ["-e", child, p.out, "0.01", "0"] },
    { security: counting, now: () => new Date().toISOString(), scratch: p.tmp, environment: process.env },
  );
  assert.deepEqual(outcome, { exit: 1, report: { ok: false, reason: "cap" } });
  assert.deepEqual(calls, [], "the Keychain is never asked");
  assert.equal(existsSync(path.join(p.out, "seen")), false);
});

test("a call whose reservation is still open is never run again", (t) => {
  const p = place(t);
  store(p.kc, "well-test/judge", "made-up-open");
  const first = wellRun(p, { charge: "none" });
  assert.equal(first.exit, 0);
  assert.deepEqual(first.report, { ok: false, exit: 0, reason: "unreported" });
  rmSync(path.join(p.out, "seen"));
  const second = wellRun(p);
  assert.equal(second.exit, 1);
  assert.deepEqual(second.report, { ok: false, reason: "unsettled" });
  assert.equal(existsSync(path.join(p.out, "seen")), false, "the child never started");
  assert.deepEqual(ledger(p.dir).map((l) => l.event), ["reserve"]);
});

test("run settles, releases or leaves open by what the child reports, and exits with the child's code", (t) => {
  const p = place(t);
  store(p.kc, "well-test/judge", "made-up-reports");
  const cases: [string, number, Record<string, unknown>, string[]][] = [
    ["not-sent", 7, { ok: true, exit: 7, event: "release", why: "not-sent" }, ["reserve", "release"]],
    ["refused", 1, { ok: true, exit: 1, event: "release", why: "refused" }, ["reserve", "release"]],
    ["0.05", 0, { ok: true, exit: 0, event: "settle", usd: 0.05 }, ["reserve", "settle"]],
    ["lots", 0, { ok: false, exit: 0, reason: "bad-charge" }, ["reserve"]],
    [`1${"0".repeat(400)}`, 0, { ok: false, exit: 0, reason: "bad-charge" }, ["reserve"]],
    ["0.0000004", 0, { ok: false, exit: 0, reason: "bad-charge" }, ["reserve"]],
  ];
  cases.forEach(([charge, code, report, events], i) => {
    const ran = wellRun(p, { key: requestKey(String(i)), charge, code });
    assert.equal(ran.exit, code, `the child's exit code ${code} is well's`);
    assert.deepEqual(ran.report, report, `the child reported ${charge}`);
    assert.deepEqual(ledger(p.dir).filter((l) => l.key === requestKey(String(i))).map((l) => l.event), events);
    const release = ledger(p.dir).find((l) => l.key === requestKey(String(i)) && l.event === "release");
    if (release) assert.equal(release.why, charge);
  });
  assert.deepEqual(readdirSync(p.tmp), []);
});

test("a secret that is missing or empty is refused, the child never starts, and the reservation is released", (t) => {
  const p = place(t);
  store(p.kc, "well-test/empty", "");
  for (const [secret, reason, key] of [["well-test/empty", "empty-secret", "c"], ["well-test/missing", "no-secret", "d"]] as const) {
    const ran = wellRun(p, { secret, key: requestKey(key) });
    assert.equal(ran.exit, 1);
    assert.deepEqual(ran.report, { ok: false, reason });
    assert.equal(existsSync(path.join(p.out, "seen")), false, "the child never started");
    const lines = ledger(p.dir).filter((l) => l.key === requestKey(key));
    assert.deepEqual(lines.map((l) => [l.event, l.why]), [["reserve", undefined], ["release", "not-sent"]]);
  }
});

test("a release that cannot be written is reported, so the caller knows the reservation stays open", (t) => {
  const p = place(t);
  // The Keychain is asked between the reserve and the release; another writer holds the ledger's
  // lock meanwhile, so the release as not sent cannot be written.
  const lock = path.join(p.dir, "judge", `${new Date().toISOString().slice(0, 7)}.jsonl.lock`);
  const busy: Security = () => {
    mkdirSync(lock);
    return { status: 44, stdout: "" };
  };
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  const outcome = runWithSecret(
    { dir: p.dir, keychain: p.kc, budget: "judge", tool: "test", key: requestKey("g"), estimate: 0.02, secret: { service: "well-test", account: "judge" }, env: "JUDGE_KEY", command: process.execPath, args: ["-e", child, p.out, "0.01", "0"] },
    { security: busy, now: () => new Date().toISOString(), scratch: p.tmp, environment: process.env, lockWaitMs: 100 },
  );
  assert.deepEqual(outcome, { exit: 1, report: { ok: false, reason: "no-secret", left_open: "locked" } });
  assert.deepEqual(ledger(p.dir).map((l) => l.event), ["reserve"], "the reservation is still open, as the report says");
});

test("a Keychain that cannot be asked refuses the call, and the reservation is released as not sent", (t) => {
  const p = place(t);
  const unreachable: Security = () => ({ status: null, stdout: "" });
  const outcome = runWithSecret(
    { dir: p.dir, keychain: p.kc, budget: "judge", tool: "test", key: requestKey("f"), estimate: 0.02, secret: { service: "well-test", account: "judge" }, env: "JUDGE_KEY", command: process.execPath, args: ["-e", child, p.out, "0.01", "0"] },
    { security: unreachable, now: () => new Date().toISOString(), scratch: p.tmp, environment: process.env },
  );
  assert.deepEqual(outcome, { exit: 1, report: { ok: false, reason: "keychain" } });
  assert.equal(existsSync(path.join(p.out, "seen")), false, "the child never started");
  assert.deepEqual(ledger(p.dir).map((l) => [l.event, l.why]), [["reserve", undefined], ["release", "not-sent"]]);
});

test("a command that cannot start releases its reservation as not sent", (t) => {
  const p = place(t);
  store(p.kc, "well-test/judge", "made-up-nostart");
  const args = ["run", "--dir", p.dir, "--keychain", p.kc, "--budget", "judge", "--tool", "test", "--key", requestKey("e"), "--estimate", "0.02", "--secret", "well-test/judge", "--env", "JUDGE_KEY", "--", path.join(p.out, "no-such-command")];
  const ran = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: p.tmp } });
  assert.equal(ran.status, 1);
  assert.equal(ran.stdout, "");
  const report = JSON.parse(ran.stderr) as Record<string, unknown>;
  assert.equal(report.ok, false);
  assert.equal(report.reason, "not-started");
  assert.deepEqual(ledger(p.dir).map((l) => [l.event, l.why]), [["reserve", undefined], ["release", "not-sent"]]);
  assert.deepEqual(readdirSync(p.tmp), []);
});

test("a usage error in run or key set exits 2, names what is wrong, and writes nothing", (t) => {
  const p = place(t);
  const run = ["run", "--dir", p.dir, "--keychain", p.kc, "--budget", "judge", "--tool", "test", "--key", requestKey("a"), "--estimate", "0.02", "--secret", "well-test/judge", "--env", "JUDGE_KEY"];
  const without = (flag: string) => {
    const i = run.indexOf(flag);
    return [...run.slice(0, i), ...run.slice(i + 2)];
  };
  const wrong: string[][] = [
    run,
    [...run, "--"],
    [...without("--secret"), "--", "true"],
    [...without("--env"), "--", "true"],
    [...without("--estimate"), "--", "true"],
    [...without("--key"), "--", "true"],
    [...run, "--usd", "0.1", "--", "true"],
    [...run.map((a) => (a === "well-test/judge" ? "noslash" : a)), "--", "true"],
    [...run.map((a) => (a === "well-test/judge" ? "well test/judge" : a)), "--", "true"],
    [...run.map((a) => (a === "JUDGE_KEY" ? "judge_key" : a)), "--", "true"],
    [...run.map((a) => (a === "JUDGE_KEY" ? "WELL_CHARGE" : a)), "--", "true"],
    [...run.map((a) => (a === "0.02" ? "-1" : a)), "--", "true"],
    [...run.map((a) => (a === p.kc ? "relative.keychain-db" : a)), "--", "true"],
    [...run.map((a) => (a === p.kc ? "/tmp/a b.keychain-db" : a)), "--", "true"],
    ["key"],
    ["key", "get", "well-test/judge"],
    ["key", "set"],
    ["key", "set", "noslash"],
    ["key", "set", "well-test/judge", "extra"],
    ["key", "set", "well-test/judge", "--budget", "judge"],
    ["key", "put"],
    ["key", "put", "noslash"],
    ["key", "put", "well-test/judge", "extra"],
    ["key", "put", "well-test/judge", "--usd", "1"],
  ];
  for (const args of wrong) {
    const { exit, out } = well(args, p.tmp);
    assert.equal(exit, 2, `well ${args.join(" ")} exits 2`);
    assert.equal(out.ok, false);
    assert.equal(typeof out.usage, "string", `well ${args.join(" ")} names what is wrong`);
  }
  assert.deepEqual(ledger(p.dir), []);
  assert.deepEqual(readdirSync(p.tmp), []);
  assert.equal(existsSync(path.join(p.out, "seen")), false);
});
