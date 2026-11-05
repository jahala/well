// well seat note: the command a Claude Code statusLine setting runs. It reads the statusLine JSON
// on standard input, appends the window reading to a day's log when it changed, and prints a short
// status line. It must never fail the session: every outcome prints one plain line and exits 0.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");
const scratchRoot = scratch();

// The statusLine input as an umbel worker stored it on 2026-10-21, cut to the fields well reads
// plus two it ignores.
const payload = (session: string, fiveHour: number, sevenDay = 14) => ({
  session_id: session,
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  version: "2.1.306",
  workspace: { current_dir: "/tmp/project" },
  rate_limits: {
    five_hour: { used_percentage: fiveHour, resets_at: 1792625400 },
    seven_day: { used_percentage: sevenDay, resets_at: 1793152800 },
  },
});

function folder(): string {
  return mkdtempSync(path.join(scratchRoot, "seat-note-"));
}

/**
 * Runs seat note with the test's own folder as the home, so the owner's real login is never read.
 * A login config is written there only by the tests that need one.
 */
function note(dir: string, input: string, extra: string[] = [], env: Record<string, string> = {}): { exit: number | null; line: string; ms: number } {
  const started = Date.now();
  const { CLAUDE_CONFIG_DIR: _, ...inherited } = process.env;
  const ran = spawnSync(process.execPath, [cli, "seat", "note", "--dir", dir, "--at", "2026-10-21T20:19:00.000Z", ...extra], {
    input,
    encoding: "utf8",
    env: { ...inherited, HOME: dir, TZ: "UTC", ...env },
  });
  assert.equal(ran.stderr, "", "seat note writes nothing to stderr");
  assert.match(ran.stdout, /^[^\n]+\n$/, "seat note prints one line");
  return { exit: ran.status, line: ran.stdout.trimEnd(), ms: Date.now() - started };
}

function log(dir: string): Record<string, unknown>[] {
  const file = path.join(dir, "seats", "claude", "2026-10-21.jsonl");
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

test("seat note writes the reading from the statusLine input and prints a short status line", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { exit, line } = note(dir, JSON.stringify(payload("s-1", 16)));
  assert.equal(exit, 0);
  assert.equal(line, "5h 16% (resets 23:30) · 7d 14%");
  assert.deepEqual(log(dir), [
    {
      at: "2026-10-21T20:19:00.000Z",
      provider: "claude",
      session: "s-1",
      model: "claude-opus-5-5",
      five_hour: { used_percent: 16, resets_at: 1792625400 },
      seven_day: { used_percent: 14, resets_at: 1793152800 },
    },
  ]);
});

const login = (folder: string, account: string) =>
  writeFileSync(path.join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: "owner@example.com" }, numStartups: 3 }));

test("every reading records the account the login names at that moment, and never its email", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  login(dir, "acc-a");
  note(dir, JSON.stringify(payload("s-1", 16)));
  login(dir, "acc-b");
  note(dir, JSON.stringify(payload("s-1", 16)));
  note(dir, JSON.stringify(payload("s-1", 16)));
  assert.deepEqual(log(dir).map((l) => [l.session, l.account]), [["s-1", "acc-a"], ["s-1", "acc-b"]], "a switch of login is a new reading");
  assert.ok(!readFileSync(path.join(dir, "seats", "claude", "2026-10-21.jsonl"), "utf8").includes("owner@example.com"));
});

test("CLAUDE_CONFIG_DIR names the login a session uses", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  login(dir, "acc-home");
  const other = path.join(dir, "other-config");
  mkdirSync(other);
  login(other, "acc-other");
  note(dir, JSON.stringify(payload("s-1", 16)), [], { CLAUDE_CONFIG_DIR: other });
  assert.deepEqual(log(dir).map((l) => l.account), ["acc-other"]);
});

test("seat note appends only when a session's reading changes, and every session writes its own", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  note(dir, JSON.stringify(payload("s-1", 16)));
  note(dir, JSON.stringify(payload("s-1", 16)));
  note(dir, JSON.stringify(payload("s-1", 17)));
  note(dir, JSON.stringify(payload("s-2", 17)));
  note(dir, JSON.stringify(payload("s-1", 17)));
  assert.deepEqual(
    log(dir).map((l) => [l.session, (l.five_hour as { used_percent: number }).used_percent]),
    [["s-1", 16], ["s-1", 17], ["s-2", 17]],
  );
});

test("a session with no window reading is recorded once, and its status line says so", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = JSON.stringify({ session_id: "s-api", model: { id: "deepseek-chat" } });
  const first = note(dir, bare);
  note(dir, bare);
  assert.deepEqual([first.exit, first.line], [0, "no window reading"]);
  assert.deepEqual(log(dir), [{ at: "2026-10-21T20:19:00.000Z", provider: "claude", session: "s-api", model: "deepseek-chat" }]);
});

test("any error prints a plain line, exits 0 and writes nothing", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, "not-a-folder");
  writeFileSync(blocked, "");
  const cases: [string, string, string[]][] = [
    [dir, "{not json", []],
    [dir, "", []],
    [dir, "[1, 2]", []],
    [dir, JSON.stringify({ rate_limits: {} }), []],
    [blocked, JSON.stringify(payload("s-1", 16)), []],
    [dir, JSON.stringify(payload("s-1", 16)), ["--colour", "red"]],
  ];
  for (const [where, input, extra] of cases) {
    const { exit, line } = note(where, input, extra);
    assert.equal(exit, 0, `input ${JSON.stringify(input)} exits 0`);
    assert.match(line, /^well: /, `input ${JSON.stringify(input)} prints a plain line naming well`);
  }
  assert.deepEqual(readdirSync(dir), ["not-a-folder"]);
});

test("a corrupt login config or statusLine input never shows its text on the status line", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, ".claude.json"), '{"primaryApiKey": sk-made-up-config-key, "oauthAccount": {}}');
  const config = note(dir, JSON.stringify(payload("s-1", 16)));
  assert.equal(config.exit, 0);
  assert.match(config.line, /^well: /);
  assert.ok(!/sk-|made-up|config-key|primaryApiKey/.test(config.line), `the line names no part of the config: ${config.line}`);
  writeFileSync(path.join(dir, ".claude.json"), "{}");
  const input = note(dir, '{"session_id": "s-1", "secret": sk-made-up-input-key}');
  assert.match(input.line, /^well: /);
  assert.ok(!/sk-|made-up|input-key/.test(input.line), `the line names no part of the input: ${input.line}`);
  assert.deepEqual(log(dir), []);
});

test("a torn last line in the seat log is skipped, and the next reading starts a line of its own", (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  note(dir, JSON.stringify(payload("s-1", 16)));
  const file = path.join(dir, "seats", "claude", "2026-10-21.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf8")}{"at":"2026-10-21T20:18:00.000Z","provider":"cla`);
  assert.equal(note(dir, JSON.stringify(payload("s-1", 17))).line, "5h 17% (resets 23:30) · 7d 14%");
  assert.deepEqual(log(dir).map((l) => (l.five_hour as { used_percent: number }).used_percent), [16, 17], "both whole readings are read, and the fragment is skipped");
});

test("a held lock costs the session no wait: the line is printed and the reading skipped", { timeout: 30_000 }, (t) => {
  const dir = folder();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "seats", "claude", "2026-10-21.jsonl.lock"), { recursive: true });
  const { exit, line, ms } = note(dir, JSON.stringify(payload("s-1", 16)));
  assert.equal(exit, 0);
  assert.equal(line, "5h 16% (resets 23:30) · 7d 14%");
  assert.deepEqual(log(dir), []);
});
