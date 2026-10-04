/**
 * Burst runs (db/migrations/0006_burst_runs.sql): the reports the War Room's scorecard shows.
 * Stored with the server's own audit of the show, taken as the report arrives.
 */
import type { Sql } from "../db/pool";
import type { BurstRun, RunReport } from "../obs/types";
import { audit } from "./audit";

/** Audits the run's show, then stores the report next to that verdict. */
export async function insertRun(sql: Sql, report: RunReport): Promise<BurstRun> {
  const a = await audit(sql, report.show.id.toLowerCase());
  const serverAudit: BurstRun["server_audit"] = a
    ? { ok: a.ok, counts: a.counts, violations: a.violations.length }
    : null;
  const [row] = await sql<BurstRun[]>`
    insert into burst_runs (show_id, ok, report, server_audit)
    values (${report.show.id}::uuid, ${report.ok}, ${sql.json(report)}, ${serverAudit ? sql.json(serverAudit) : null})
    returning id, show_id, ok, report, server_audit, created_at`;
  return toRun(row!);
}

/** The newest runs first. */
export async function listRuns(sql: Sql, limit: number): Promise<BurstRun[]> {
  const rows = await sql<BurstRun[]>`
    select id, show_id, ok, report, server_audit, created_at
      from burst_runs
     order by created_at desc, id
     limit ${limit}`;
  return rows.map(toRun);
}

/** Deletes all but the newest `keep` runs. Returns the number deleted. */
export async function pruneRuns(sql: Sql, keep: number): Promise<number> {
  const result = await sql`
    delete from burst_runs
     where id not in (select id from burst_runs order by created_at desc, id limit ${keep})`;
  return result.count;
}

function toRun(row: BurstRun): BurstRun {
  const at = row.created_at as unknown;
  return { ...row, created_at: at instanceof Date ? at.toISOString() : String(at) };
}
