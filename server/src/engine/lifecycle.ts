/**
 * Confirm / cancel / expire — TS faces of db/migrations/0003_lifecycle_fns.sql. Each call is one
 * SQL round trip (its own transaction), retried on transient contention like reserve.
 */
import type { Sql } from "../db/pool";
import { withContentionRetry, type RetryOptions } from "../db/retry";
import type { ExpireHoldsResult, LifecycleOutcome, Reservation } from "./types";
import { isUuid } from "./ids";

export type LifecycleInput = {
  reservationId: string;
  /** Identity from the verified token — never from the request body. */
  userId: string;
};

async function callLifecycle(
  sql: Sql,
  fn: "fdfs_confirm" | "fdfs_cancel",
  input: LifecycleInput,
  retry: RetryOptions,
): Promise<LifecycleOutcome> {
  if (!isUuid(input.reservationId)) return { outcome: "not_found" };
  return withContentionRetry(async () => {
    const [row] = await sql.unsafe<{ result: LifecycleOutcome }[]>(
      `select ${fn}($1::uuid, $2) as result`,
      [input.reservationId, input.userId],
    );
    return row!.result;
  }, retry);
}

/** Turns a live hold into a confirmed booking. Idempotent. */
export function confirm(
  sql: Sql,
  input: LifecycleInput,
  retry: RetryOptions = {},
): Promise<LifecycleOutcome> {
  return callLifecycle(sql, "fdfs_confirm", input, retry);
}

/** Owner cancel of a live hold or a confirmed booking; releases its seats. Idempotent. */
export function cancel(
  sql: Sql,
  input: LifecycleInput,
  retry: RetryOptions = {},
): Promise<LifecycleOutcome> {
  return callLifecycle(sql, "fdfs_cancel", input, retry);
}

/** One sweeper tick: release lapsed held seats and finalize lapsed holds, up to `batch` each. */
export async function expireHolds(
  sql: Sql,
  batch = 500,
  retry: RetryOptions = {},
): Promise<ExpireHoldsResult> {
  return withContentionRetry(async () => {
    const [row] = await sql<{ result: ExpireHoldsResult }[]>`
      select fdfs_expire_holds(${batch}::int) as result`;
    return row!.result;
  }, retry);
}

/** A user's reservations (newest first), optionally for one show, with effective statuses. */
export async function listReservations(
  sql: Sql,
  userId: string,
  opts: { showId?: string; limit?: number } = {},
): Promise<Reservation[]> {
  if (opts.showId !== undefined && !isUuid(opts.showId)) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await sql<{ r: Reservation }[]>`
    select fdfs_reservation_json(r) as r
      from reservations r
     where r.user_id = ${userId}
       and (${opts.showId ?? null}::uuid is null or r.show_id = ${opts.showId ?? null}::uuid)
     order by r.created_at desc, r.id
     limit ${limit}`;
  return rows.map((row) => row.r);
}
