// The conductor source: the SDK's rate-limit events the Conductor app stores for its own Claude
// sessions, which run no statusLine (docs/architecture.md). It reads Conductor's own database,
// whose schema is not well's and may change.
//
// Terms: the database is opened read-only and never written; only
// each event's Claude session id, its time and its rate_limit_info windows are selected, never
// message content or any other column; and a missing table or field is a named failure, never a
// silent empty read.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Window } from "./seats.ts";

export interface ConductorLine {
  at: string;
  provider: "claude";
  source: "conductor";
  session: string;
  five_hour?: Window;
  seven_day?: Window;
}

export type ConductorRead =
  | { ok: true; lines: ConductorLine[]; unreadable: number }
  | { ok: false; error: "conductor-missing" | "conductor-schema"; detail: string };

const schema = (detail: string): ConductorRead => ({ ok: false, error: "conductor-schema", detail });

/** One window as Conductor stores it, utilization from 0 to 1, as the provider's percent. */
function windowOf(value: unknown): Window | null | "bad" {
  if (value === undefined || value === null) return null;
  const w = value as { utilization?: unknown; resetsAt?: unknown };
  if (typeof w.utilization !== "number" || typeof w.resetsAt !== "number") return "bad";
  return { used_percent: Math.round(w.utilization * 100 * 10_000) / 10_000, resets_at: w.resetsAt };
}

/** Every rate_limit_event Conductor stored in [from, to), oldest first. */
export function readConductorEvents(file: string, from: number, to: number): ConductorRead {
  if (!existsSync(file)) return { ok: false, error: "conductor-missing", detail: `no Conductor database at ${file}` };
  const db = new DatabaseSync(`${pathToFileURL(file).href}?mode=ro`, { readOnly: true });
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('session_events')").all().map((row) => String(row.name));
    if (columns.length === 0) return schema("Conductor's database has no table session_events");
    for (const column of ["content", "received_at"]) {
      if (!columns.includes(column)) return schema(`Conductor's session_events has no column ${column}`);
    }
    const rows = db
      .prepare(
        `SELECT received_at AS at,
                json_extract(content, '$.rawPayload.session_id') AS session,
                json_extract(content, '$.rawPayload.rate_limit_info.unifiedWindows') AS windows
           FROM session_events
          WHERE json_valid(content)
            AND json_extract(content, '$.rawPayload.type') = 'rate_limit_event'
            AND received_at >= ? AND received_at < ?
          ORDER BY received_at`,
      )
      .all(new Date(from).toISOString(), new Date(to).toISOString());
    // A row whose content is not JSON cannot be read at all; it is skipped and counted, so one bad
    // row never stops the read and is never lost in silence.
    const unreadable = Number(
      db.prepare("SELECT count(*) AS n FROM session_events WHERE NOT json_valid(content) AND received_at >= ? AND received_at < ?").get(new Date(from).toISOString(), new Date(to).toISOString())?.n ?? 0,
    );
    const lines: ConductorLine[] = [];
    for (const row of rows) {
      if (typeof row.session !== "string" || typeof row.at !== "string") return schema("a rate_limit_event has no rawPayload.session_id or received_at");
      if (typeof row.windows !== "string") return schema("a rate_limit_event has no rate_limit_info.unifiedWindows");
      const windows = JSON.parse(row.windows) as { five_hour?: unknown; seven_day?: unknown };
      const fiveHour = windowOf(windows.five_hour);
      const sevenDay = windowOf(windows.seven_day);
      if (fiveHour === "bad" || sevenDay === "bad") return schema("a rate_limit_event window has no utilization or resetsAt");
      lines.push({
        at: row.at,
        provider: "claude",
        source: "conductor",
        session: row.session,
        ...(fiveHour ? { five_hour: fiveHour } : {}),
        ...(sevenDay ? { seven_day: sevenDay } : {}),
      });
    }
    return { ok: true, lines, unreadable };
  } finally {
    db.close();
  }
}
