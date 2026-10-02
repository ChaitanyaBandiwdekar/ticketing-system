/** The books-balance proof for one show (db/migrations/0004_audit_fn.sql), from one snapshot. */
import type { Sql } from "../db/pool";
import type { AuditReport } from "./types";
import { isUuid } from "./ids";

/** null for an unknown show. */
export async function audit(sql: Sql, showId: string): Promise<AuditReport | null> {
  if (!isUuid(showId)) return null;
  const [row] = await sql<{ report: AuditReport | null }[]>`
    select fdfs_audit(${showId}::uuid) as report`;
  return row?.report ?? null;
}
