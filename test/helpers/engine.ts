import { randomUUID } from "node:crypto";
import type { Sql } from "../../server/src/db/pool";
import { reserve, type ReserveInput } from "../../server/src/engine/reserve";
import { createShow, getShowSnapshot, type CreateShowInput } from "../../server/src/engine/shows";
import type { ReserveOutcome, Show } from "../../server/src/engine/types";
import { uniq } from "./db";

/** Seat labels "A1".."A<n>" (or any row letter). */
export function seatRow(row: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${row}${i + 1}`);
}

export async function makeShow(
  sql: Sql,
  overrides: Partial<CreateShowInput> & { seats?: string[] } = {},
): Promise<Show> {
  return createShow(
    sql,
    {
      name: uniq("show"),
      seats: overrides.seats ?? seatRow("A", 20),
      pricePaise: 25_000,
      perUserLimit: 4,
      ...overrides,
    },
    { maxSeatsPerShow: 20_000 },
  );
}

/** reserve() with a fresh idempotency key unless one is given. */
export function book(
  sql: Sql,
  showId: string,
  userId: string,
  seats: string[],
  key: string = randomUUID(),
  onRetry?: (state: string) => void,
): Promise<ReserveOutcome> {
  const input: ReserveInput = { showId, userId, seats, idempotencyKey: key };
  return reserve(sql, input, { onRetry });
}

export function tally(outcomes: ReserveOutcome[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const o of outcomes) t[o.outcome] = (t[o.outcome] ?? 0) + 1;
  return t;
}

/**
 * Test-side oracle for the show's invariants, independent of the engine's own code paths:
 * - seat list and counts reconcile (available + held + confirmed == total)
 * - every taken seat belongs to an active reservation of the same show and user, in the
 *   matching state (held seat <-> live hold, confirmed seat <-> confirmed reservation)
 * - every active reservation owns exactly its listed seats, and amount == price x seats
 * - no user holds more active seats than the show's limit
 * Returns human-readable violations; [] means healthy.
 */
export async function invariantViolations(sql: Sql, showId: string): Promise<string[]> {
  const violations: string[] = [];
  const snap = await getShowSnapshot(sql, showId);
  if (!snap) return [`show ${showId} not found`];
  if (!snap.counts.invariant_ok)
    violations.push(`counts do not reconcile: ${JSON.stringify(snap.counts)}`);

  const rows = await sql<{ problem: string }[]>`
    with sh as (select * from shows where id = ${showId}),
    taken as (
      select s.* from seats s where s.show_id = ${showId} and not fdfs_seat_free(s.status, s.held_until)
    ),
    active as (
      select r.*, fdfs_reservation_status(r.status, r.expires_at) as eff
        from reservations r
       where r.show_id = ${showId}
         and fdfs_reservation_status(r.status, r.expires_at) in ('held', 'confirmed')
    )
    select 'seat ' || t.label || ' taken without a matching active reservation' as problem
      from taken t
     where not exists (
       select 1 from active a
        where a.id = t.reservation_id and a.user_id = t.user_id and a.eff = t.status
          and t.label = any (a.seat_labels))
    union all
    select 'reservation ' || a.id || ' owns ' || coalesce(n.cnt, 0) || ' of '
           || cardinality(a.seat_labels) || ' seats'
      from active a
      left join lateral (
        select count(*) as cnt from taken t
         where t.reservation_id = a.id and t.label = any (a.seat_labels)) n on true
     where coalesce(n.cnt, 0) <> cardinality(a.seat_labels)
    union all
    select 'reservation ' || r.id || ' amount ' || r.amount_paise || ' <> price x seats'
      from reservations r, sh
     where r.show_id = ${showId} and r.amount_paise <> sh.price_paise * cardinality(r.seat_labels)
    union all
    select 'user ' || t.user_id || ' holds ' || count(*) || ' seats over limit ' || max(sh.per_user_limit)
      from taken t, sh
     group by t.user_id
    having count(*) > max(sh.per_user_limit)`;
  violations.push(...rows.map((r) => r.problem));
  return violations;
}

/**
 * Rewinds a hold's deadline into the past instead of sleeping through its TTL. Locks seats in id
 * order, then the reservation (the engine's lock order), so it is safe to run amid concurrent calls.
 */
export async function lapse(sql: Sql, reservationId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update seats set held_until = now() - interval '1 second'
       where id in (select id from seats
                     where reservation_id = ${reservationId}::uuid and status = 'held'
                     order by id for update)`;
    await tx`
      update reservations set expires_at = now() - interval '1 second'
       where id = ${reservationId}::uuid and status = 'held'`;
  });
}
