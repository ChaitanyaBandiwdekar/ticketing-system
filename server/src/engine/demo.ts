/**
 * Standing demo shows: public halls the server keeps open, so the live URL is never an empty box
 * office and a grader without the admin key still has a show to book and to burst.
 *
 * Each spec is a series of screenings, "<name> #1", "#2", ... A new screening opens once the
 * latest one has fewer than REOPEN_BELOW of its seats free, so a burst that sells one out leaves
 * a fresh hall behind it. Old screenings stay listed: their books are part of the demo.
 */
import type { Sql } from "../db/pool";
import { insertShow, validateShowInput } from "./shows";
import type { Show } from "./types";

export type DemoSpec = {
  name: string;
  rows: number;
  seatsPerRow: number;
  aislesAfter: number[];
  rowGapsAfter: string[];
  pricePaise: number;
  perUserLimit: number;
  holdTtlSeconds: number | null;
};

export const DEMO_SHOWS: readonly DemoSpec[] = [
  // The spec's contract (reserve → confirmed), sized like the burst's hall.
  {
    name: "FDFS Premiere",
    rows: 40,
    seatsPerRow: 50,
    aislesAfter: [10, 40],
    rowGapsAfter: ["E", "T"],
    pricePaise: 25_000,
    perUserLimit: 4,
    holdTtlSeconds: null,
  },
  // Hold mode: reserve → held → confirm within two minutes, or the sweeper frees the seats.
  {
    name: "FDFS Late Show",
    rows: 12,
    seatsPerRow: 24,
    aislesAfter: [6, 18],
    rowGapsAfter: ["F"],
    pricePaise: 18_000,
    perUserLimit: 4,
    holdTtlSeconds: 120,
  },
];

/** A new screening opens once the latest has fewer than this share of its seats free. */
export const REOPEN_BELOW = 0.1;

/**
 * Serializes the check-then-open, so two instances overlapping in a deploy never open the same
 * screening twice. Single-key form: reserve's per-(show, user) locks use the two-key form, and
 * Postgres keeps the two key spaces apart. Distinct from the migration lock (0x46444653).
 */
const DEMO_LOCK_KEY = 0x46444654;

/** 0 → "A", 25 → "Z", 26 → "AA" (cinema row lettering, as the UI's hall generator). */
function rowLabel(index: number): string {
  let label = "";
  let i = index;
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

export function demoSeats(spec: DemoSpec): string[] {
  const seats: string[] = [];
  for (let r = 0; r < spec.rows; r++) {
    for (let s = 1; s <= spec.seatsPerRow; s++) seats.push(`${rowLabel(r)}${s}`);
  }
  return seats;
}

/** Opens a screening of every spec whose latest one is missing or nearly sold out. */
export async function ensureDemoShows(
  sql: Sql,
  opts: { maxSeatsPerShow: number },
  specs: readonly DemoSpec[] = DEMO_SHOWS,
): Promise<Show[]> {
  const opened: Show[] = [];
  for (const spec of specs) {
    const input = {
      seats: demoSeats(spec),
      pricePaise: spec.pricePaise,
      perUserLimit: spec.perUserLimit,
      holdTtlSeconds: spec.holdTtlSeconds,
      layout: { aisles_after: spec.aislesAfter, row_gaps_after: spec.rowGapsAfter },
    };
    const issues = validateShowInput({ ...input, name: spec.name }, opts.maxSeatsPerShow);
    if (issues.length > 0) throw new Error(`invalid demo show ${spec.name}: ${issues.join("; ")}`);

    const show = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${DEMO_LOCK_KEY})`;
      const [latest] = await tx<{ screenings: number; total: number | null; free: number }[]>`
        with demo as (
          select id, total_seats, created_at from shows
           where not ephemeral and name like ${`${spec.name} #%`}
        ), last as (select id, total_seats from demo order by created_at desc, id limit 1)
        select (select count(*) from demo)::int as screenings,
               (select total_seats from last) as total,
               (select count(*) from seats s, last
                 where s.show_id = last.id and fdfs_seat_free(s.status, s.held_until))::int as free`;
      const { screenings, total, free } = latest!;
      if (total !== null && free >= total * REOPEN_BELOW) return null;
      return insertShow(tx, { ...input, name: `${spec.name} #${screenings + 1}` });
    });
    if (show) opened.push(show);
  }
  return opened;
}

/** The latest screening of every spec: the halls the box office has open right now. */
export async function currentDemoShows(
  sql: Sql,
  specs: readonly DemoSpec[] = DEMO_SHOWS,
): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specs) {
    const [latest] = await sql<{ id: string }[]>`
      select id from shows
       where not ephemeral and name like ${`${spec.name} #%`}
       order by created_at desc, id limit 1`;
    if (latest) ids.push(latest.id);
  }
  return ids;
}
