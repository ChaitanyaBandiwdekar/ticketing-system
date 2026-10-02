/** Show creation and the one-snapshot read that the seat map and the invariant badge rely on. */
import type { Sql } from "../db/pool";
import { isUuid } from "./ids";
import type { SeatCounts, SeatStatus, Show, ShowSnapshot } from "./types";

export type CreateShowInput = {
  name: string;
  seats: string[];
  pricePaise: number;
  perUserLimit: number;
  holdTtlSeconds?: number | null;
  ephemeral?: boolean;
};

export class ShowValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid show: ${issues.join("; ")}`);
    this.name = "ShowValidationError";
  }
}

const SEAT_LABEL = /^[A-Za-z0-9-]{1,16}$/;
const MAX_PRICE_PAISE = 10_000_000; // ₹1,00,000 per seat keeps every amount a safe JS integer.

export function validateShowInput(input: CreateShowInput, maxSeatsPerShow: number): string[] {
  const issues: string[] = [];
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) issues.push("name must be 1-200 characters");
  if (input.seats.length === 0) issues.push("seats must not be empty");
  if (input.seats.length > maxSeatsPerShow) {
    issues.push(`a show may have at most ${maxSeatsPerShow} seats`);
  }
  const bad = input.seats.filter((s) => !SEAT_LABEL.test(s));
  if (bad.length > 0) {
    issues.push(`invalid seat labels (1-16 of A-Z a-z 0-9 -): ${bad.slice(0, 5).join(", ")}`);
  }
  if (new Set(input.seats).size !== input.seats.length) issues.push("seat labels must be unique");
  if (
    !Number.isInteger(input.pricePaise) ||
    input.pricePaise < 1 ||
    input.pricePaise > MAX_PRICE_PAISE
  ) {
    issues.push(`price_paise must be an integer between 1 and ${MAX_PRICE_PAISE}`);
  }
  if (!Number.isInteger(input.perUserLimit) || input.perUserLimit < 1 || input.perUserLimit > 100) {
    issues.push("per_user_limit must be an integer between 1 and 100");
  }
  const ttl = input.holdTtlSeconds;
  if (ttl != null && (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600)) {
    issues.push("hold_ttl_seconds must be an integer between 1 and 3600");
  }
  return issues;
}

const SHOW_COLUMNS = `id, name, price_paise::float8 as price_paise, per_user_limit, hold_ttl_seconds,
  total_seats, ephemeral, created_at`;

/** Creates the show and every seat (available) in one transaction. Seat ids follow input order. */
export async function createShow(
  sql: Sql,
  input: CreateShowInput,
  opts: { maxSeatsPerShow: number },
): Promise<Show> {
  const issues = validateShowInput(input, opts.maxSeatsPerShow);
  if (issues.length > 0) throw new ShowValidationError(issues);

  return sql.begin(async (tx) => {
    const [show] = await tx.unsafe<Show[]>(
      `insert into shows (name, price_paise, per_user_limit, hold_ttl_seconds, total_seats, ephemeral)
       values ($1, $2, $3, $4, $5, $6)
       returning ${SHOW_COLUMNS}`,
      [
        input.name.trim(),
        input.pricePaise,
        input.perUserLimit,
        input.holdTtlSeconds ?? null,
        input.seats.length,
        input.ephemeral ?? false,
      ],
    );
    await tx`
      insert into seats (show_id, label)
      select ${show!.id}::uuid, label
        from unnest(${input.seats}::text[]) with ordinality as t(label, ord)
       order by ord`;
    return normalizeShow(show!);
  });
}

/**
 * The show, its effective per-seat states and the counts, all from ONE statement — so the seat
 * list and the counts come from the same snapshot and always reconcile with each other.
 */
export async function getShowSnapshot(sql: Sql, showId: string): Promise<ShowSnapshot | null> {
  if (!isUuid(showId)) return null;
  const [row] = await sql.unsafe<
    (Show & { seat_list: { label: string; status: SeatStatus }[] | null })[]
  >(
    `select ${SHOW_COLUMNS},
            (select jsonb_agg(jsonb_build_object(
                      'label', s.label,
                      'status', case when fdfs_seat_free(s.status, s.held_until) then 'available'
                                     else s.status end)
                    order by s.id)
               from seats s where s.show_id = shows.id) as seat_list
       from shows
      where id = $1`,
    [showId],
  );
  if (!row) return null;
  const { seat_list, ...show } = row;
  const seats = seat_list ?? [];
  const counts = { available: 0, held: 0, confirmed: 0 };
  for (const s of seats) counts[s.status]++;
  return {
    show: normalizeShow(show),
    seats,
    counts: {
      total: show.total_seats,
      ...counts,
      invariant_ok:
        seats.length === show.total_seats &&
        counts.available + counts.held + counts.confirmed === show.total_seats,
    },
  };
}

export type ShowSummary = Show & { counts: SeatCounts };

/** Newest shows first, each with its effective counts (one statement, one snapshot). */
export async function listShows(
  sql: Sql,
  opts: { includeEphemeral?: boolean; limit?: number } = {},
): Promise<ShowSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await sql.unsafe<(Show & { available: number; held: number; confirmed: number })[]>(
    `select ${SHOW_COLUMNS}, c.available, c.held, c.confirmed
       from shows
       cross join lateral (
         select count(*) filter (where fdfs_seat_free(s.status, s.held_until))::int as available,
                count(*) filter (where s.status = 'held'
                                   and not fdfs_seat_free(s.status, s.held_until))::int as held,
                count(*) filter (where s.status = 'confirmed')::int as confirmed
           from seats s where s.show_id = shows.id) c
      where $1::boolean or not ephemeral
      order by created_at desc, id
      limit $2`,
    [opts.includeEphemeral ?? false, limit],
  );
  return rows.map(({ available, held, confirmed, ...show }) => ({
    ...normalizeShow(show),
    counts: {
      total: show.total_seats,
      available,
      held,
      confirmed,
      invariant_ok: available + held + confirmed === show.total_seats,
    },
  }));
}

function normalizeShow(show: Show): Show {
  return {
    ...show,
    created_at: new Date(show.created_at).toISOString(),
  };
}
