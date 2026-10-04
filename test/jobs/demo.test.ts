import { describe, expect, it, vi } from "vitest";
import {
  currentDemoShows,
  DEMO_SHOWS,
  demoSeats,
  ensureDemoShows,
  REOPEN_BELOW,
  type DemoSpec,
} from "../../server/src/engine/demo";
import { getShowSnapshot, listShows, validateShowInput } from "../../server/src/engine/shows";
import { createDemoShows } from "../../server/src/jobs/demo";
import { uniq, useTestSql } from "../helpers/db";
import { book, makeShow, tally } from "../helpers/engine";

const sql = useTestSql(20);
const opts = { maxSeatsPerShow: 20_000 };

/** A small spec with a unique name, so each test has its own series of screenings. */
function spec(overrides: Partial<DemoSpec> = {}): DemoSpec {
  return {
    name: uniq("Demo"),
    rows: 2,
    seatsPerRow: 10,
    aislesAfter: [5],
    rowGapsAfter: [],
    pricePaise: 10_000,
    perUserLimit: 4,
    holdTtlSeconds: null,
    ...overrides,
  };
}

async function screenings(name: string) {
  const shows = await listShows(sql, { limit: 500 });
  return shows.filter((s) => s.name.startsWith(`${name} #`));
}

/** Books `count` seats of the show, four per user (the limit). */
async function sell(showId: string, seats: string[]) {
  const outcomes = await Promise.all(
    Array.from({ length: Math.ceil(seats.length / 4) }, (_, i) =>
      book(sql, showId, uniq("buyer"), seats.slice(i * 4, i * 4 + 4)),
    ),
  );
  expect(tally(outcomes)).toEqual({ created: outcomes.length });
}

describe("demo shows", () => {
  it("every built-in spec is a show the API accepts, in the burst's row lettering", () => {
    for (const s of DEMO_SHOWS) {
      const seats = demoSeats(s);
      expect(seats).toHaveLength(s.rows * s.seatsPerRow);
      expect(
        validateShowInput(
          {
            name: `${s.name} #1`,
            seats,
            pricePaise: s.pricePaise,
            perUserLimit: s.perUserLimit,
            holdTtlSeconds: s.holdTtlSeconds,
            layout: { aisles_after: s.aislesAfter, row_gaps_after: s.rowGapsAfter },
          },
          opts.maxSeatsPerShow,
        ),
      ).toEqual([]);
    }
    expect(demoSeats(DEMO_SHOWS[0]!).slice(0, 2)).toEqual(["A1", "A2"]);
    expect(demoSeats(DEMO_SHOWS[0]!).at(-1)).toBe("AN50");
  });

  it("opens screening #1 once, as a public show with the spec's hall and rules", async () => {
    const s = spec({ holdTtlSeconds: 90 });
    const [opened] = await ensureDemoShows(sql, opts, [s]);
    expect(opened).toMatchObject({
      name: `${s.name} #1`,
      total_seats: 20,
      ephemeral: false,
      hold_ttl_seconds: 90,
      per_user_limit: 4,
      layout: { aisles_after: [5], row_gaps_after: [] },
    });
    expect(await ensureDemoShows(sql, opts, [s])).toEqual([]);
    expect(await screenings(s.name)).toHaveLength(1);
    const snap = await getShowSnapshot(sql, opened!.id);
    expect(snap!.counts).toMatchObject({ total: 20, available: 20, invariant_ok: true });
  });

  it(`opens the next screening once fewer than ${REOPEN_BELOW * 100}% of seats are free`, async () => {
    const s = spec();
    const [first] = await ensureDemoShows(sql, opts, [s]);
    const seats = demoSeats(s);

    await sell(first!.id, seats.slice(0, 18)); // 2 of 20 free: exactly 10%, still open
    expect(await ensureDemoShows(sql, opts, [s])).toEqual([]);

    await sell(first!.id, seats.slice(18, 19)); // 1 free: under 10%
    const [second] = await ensureDemoShows(sql, opts, [s]);
    expect(await currentDemoShows(sql, [s])).toEqual([second!.id]);
    expect(second!.name).toBe(`${s.name} #2`);
    expect(await ensureDemoShows(sql, opts, [s])).toEqual([]);

    // The sold screening stays listed with its books intact.
    const listed = await screenings(s.name);
    expect(listed.map((x) => x.name)).toEqual([`${s.name} #2`, `${s.name} #1`]);
    expect(listed[1]!.counts).toMatchObject({ confirmed: 19, available: 1, invariant_ok: true });
  });

  it("ignores ephemeral shows with a demo name", async () => {
    const s = spec();
    await makeShow(sql, { name: `${s.name} #1`, ephemeral: true });
    const [opened] = await ensureDemoShows(sql, opts, [s]);
    expect(opened!.name).toBe(`${s.name} #1`);
    expect(opened!.ephemeral).toBe(false);
  });

  it("instances racing at boot open exactly one screening", async () => {
    const s = spec();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureDemoShows(sql, opts, [s])),
    );
    expect(results.flat()).toHaveLength(1);
    expect(await screenings(s.name)).toHaveLength(1);
  });

  it("refuses a spec the API would refuse, before touching the database", async () => {
    const s = spec({ pricePaise: 0 });
    await expect(ensureDemoShows(sql, opts, [s])).rejects.toThrow(/invalid demo show/);
    expect(await screenings(s.name)).toHaveLength(0);
  });

  it("the job logs each show it opens and reports the open screenings", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const job = createDemoShows(sql, opts, log);
    expect(job.current()).toEqual([]);
    await job.tick();
    // The built-in specs: opened by this tick or already open from an earlier run.
    for (const s of DEMO_SHOWS) expect(await screenings(s.name)).not.toHaveLength(0);
    // The latest screening of each spec (listShows is newest first).
    const latest = await Promise.all(
      DEMO_SHOWS.map(async (s) => (await screenings(s.name))[0]!.id),
    );
    expect(job.current()).toEqual(latest);
    for (const [fields, msg] of log.info.mock.calls) {
      expect(msg).toBe("demo show opened");
      expect(fields).toMatchObject({ job: "demo_shows" });
    }
    await job.tick();
    expect(log.info.mock.calls.length).toBeLessThanOrEqual(DEMO_SHOWS.length);
  });
});
