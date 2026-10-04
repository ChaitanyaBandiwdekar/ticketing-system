/**
 * Housekeeping the janitor runs: removing old ephemeral (burst/simulator) shows and expiring
 * idempotency keys. Both stay inside the global lock order, so they can run during a stampede.
 */
import type { Sql } from "../db/pool";

/**
 * Deletes ephemeral shows older than `olderThanHours`, at most `limit` per call, one transaction
 * each. The order is forced by the foreign keys and the global lock order: lock the show's seats
 * (sorted by id, like every other writer) → delete seats → delete reservations (idempotency
 * keys cascade) → delete the show. reservations.show_id has no FK by design, which is why the
 * reservations are deleted explicitly. A reserve racing this sees its seats vanish and answers
 * show_not_found. Returns the deleted show ids.
 */
export async function purgeEphemeralShows(
  sql: Sql,
  olderThanHours: number,
  limit = 20,
): Promise<string[]> {
  const due = await sql<{ id: string }[]>`
    select id from shows
     where ephemeral and created_at < now() - make_interval(hours => ${olderThanHours}::int)
     order by created_at
     limit ${limit}`;
  const deleted: string[] = [];
  for (const { id } of due) {
    await sql.begin(async (tx) => {
      await tx`select id from seats where show_id = ${id}::uuid order by id for update`;
      await tx`delete from seats where show_id = ${id}::uuid`;
      await tx`delete from reservations where show_id = ${id}::uuid`;
      await tx`delete from shows where id = ${id}::uuid`;
    });
    deleted.push(id);
  }
  return deleted;
}

/**
 * Deletes idempotency keys older than `olderThanHours` (keys are retry protection, not an
 * archive: 24h, like Stripe), in batches so no single statement holds many row locks. A retry
 * arriving after its key expired is treated as a new request. Returns the number deleted.
 */
export async function purgeIdempotencyKeys(
  sql: Sql,
  olderThanHours: number,
  batch = 5_000,
  maxRounds = 20,
): Promise<number> {
  let total = 0;
  for (let round = 0; round < maxRounds; round++) {
    const result = await sql`
      delete from idempotency_keys
       where (user_id, key) in (
         select user_id, key from idempotency_keys
          where created_at < now() - make_interval(hours => ${olderThanHours}::int)
          limit ${batch})`;
    total += result.count;
    if (result.count < batch) break;
  }
  return total;
}
