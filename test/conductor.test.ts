// The conductor source reads the SDK's rate-limit events the Conductor app stores for its own
// sessions. Each check builds a database in Conductor's shape under WELL_TMP and reads it through
// the adapter: only the session, the time and the window fields come out, the file is never
// written, and a change to Conductor's schema is a named failure, never a silent empty read.
import { scratchRoot as scratch } from "./scratch.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConductorEvents } from "../src/conductor.ts";

const scratchRoot = scratch();
const from = Date.parse("2026-10-27T00:00:00Z");
const to = Date.parse("2026-10-28T00:00:00Z");

// A rate_limit_event as Conductor stored one on 2026-10-27, with its ids shortened.
const event = (session: string, fiveHour: number, weekly = 1793152800) =>
  JSON.stringify({
    eventId: "e-1",
    type: "agent",
    rawPayload: {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1793107800,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: 1793107800 }, seven_day: { utilization: 0.73, resetsAt: weekly } },
      },
      uuid: "u-1",
      session_id: session,
    },
    turnId: "t-1",
  });

function database(rows: [string, string][], columns = "session_id TEXT, session_index INTEGER, event_id TEXT, event_type TEXT, content TEXT, received_at TEXT, reverted_at TEXT"): { file: string; done: () => void } {
  const dir = mkdtempSync(path.join(scratchRoot, "conductor-"));
  const file = path.join(dir, "conductor.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_events (${columns})`);
  if (rows.length > 0) {
    const insert = db.prepare("INSERT INTO session_events (session_id, content, received_at) VALUES ('conductor-session', ?, ?)");
    for (const [content, at] of rows) insert.run(content, at);
  }
  db.close();
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("only the session, the time and the windows of each rate_limit_event come out, and nothing else", (t) => {
  const secret = "sk-made-up-message-text";
  const { file, done } = database([
    [event("claude-1", 0.03), "2026-10-27T08:42:03.537Z"],
    [JSON.stringify({ rawPayload: { type: "assistant", message: { content: [{ type: "text", text: secret }] }, session_id: "claude-1" } }), "2026-10-27T08:42:04.000Z"],
    [event("claude-1", 0.04), "2026-10-26T23:59:59.000Z"],
  ]);
  t.after(done);
  const got = readConductorEvents(file, from, to);
  assert.deepEqual(got, {
    ok: true,
    unreadable: 0,
    lines: [
      {
        at: "2026-10-27T08:42:03.537Z",
        provider: "claude",
        source: "conductor",
        session: "claude-1",
        five_hour: { used_percent: 3, resets_at: 1793107800 },
        seven_day: { used_percent: 73, resets_at: 1793152800 },
      },
    ],
  });
  assert.ok(!JSON.stringify(got).includes(secret), "no message content leaves the database");
});

test("a row whose content is not JSON is skipped and counted, never a crash or a silent loss", (t) => {
  const { file, done } = database([
    ["{not json at all", "2026-10-27T08:00:00.000Z"],
    [event("claude-1", 0.03), "2026-10-27T08:42:03.537Z"],
  ]);
  t.after(done);
  const got = readConductorEvents(file, from, to);
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.deepEqual(got.ok ? [got.lines.length, got.unreadable] : [], [1, 1]);
});

test("the database is opened read-only and is never written", (t) => {
  const { file, done } = database([[event("claude-1", 0.03), "2026-10-27T08:42:03.537Z"]]);
  t.after(done);
  const before = createHash("sha256").update(readFileSync(file)).digest("hex");
  const files = readdirSync(path.dirname(file));
  assert.equal(readConductorEvents(file, from, to).ok, true);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), before);
  assert.deepEqual(readdirSync(path.dirname(file)), files);
});

test("a missing database, table or field is a named failure, never an empty read", (t) => {
  const missing = readConductorEvents(path.join(scratchRoot, "no-such-conductor.db"), from, to);
  assert.deepEqual([missing.ok, !missing.ok && missing.error], [false, "conductor-missing"]);

  const renamed = mkdtempSync(path.join(scratchRoot, "conductor-"));
  t.after(() => rmSync(renamed, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(renamed, "conductor.db"));
  db.exec("CREATE TABLE other (x TEXT)");
  db.close();
  const table = readConductorEvents(path.join(renamed, "conductor.db"), from, to);
  assert.deepEqual([table.ok, !table.ok && table.error], [false, "conductor-schema"]);

  const noColumn = database([], "session_id TEXT, payload TEXT, received_at TEXT");
  t.after(noColumn.done);
  const column = readConductorEvents(noColumn.file, from, to);
  assert.deepEqual([column.ok, !column.ok && column.error], [false, "conductor-schema"]);

  const noWindows = database([[JSON.stringify({ rawPayload: { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: "claude-1" } }), "2026-10-27T08:00:00.000Z"]]);
  t.after(noWindows.done);
  const field = readConductorEvents(noWindows.file, from, to);
  assert.deepEqual([field.ok, !field.ok && field.error], [false, "conductor-schema"]);
  assert.match(!field.ok ? field.detail : "", /unifiedWindows/);
});
