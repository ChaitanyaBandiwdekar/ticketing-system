import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reserve, reserveRequestHash } from "../../server/src/engine/reserve";
import { getShowSnapshot } from "../../server/src/engine/shows";
import type { ReserveOutcome } from "../../server/src/engine/types";
import { uniq, useTestSql } from "../helpers/db";
import { book, invariantViolations, makeShow, seatRow, tally } from "../helpers/engine";

const sql = useTestSql(20);

function created(o: ReserveOutcome) {
  if (o.outcome !== "created") throw new Error(`expected created, got ${JSON.stringify(o)}`);
  return o.reservation;
}

describe("reserve: single requests", () => {
  it("confirms instantly by default, charges price x seats, and flips the seats", async () => {
    const show = await makeShow(sql, { pricePaise: 25_000 });
    const user = uniq("u");
    const r = created(await book(sql, show.id, user, ["A3", "A1"]));

    expect(r).toMatchObject({
      show_id: show.id,
      user_id: user,
      seats: ["A1", "A3"], // seat order, not request order
      amount_paise: 50_000,
      status: "confirmed",
      expires_at: null,
    });
    const snap = await getShowSnapshot(sql, show.id);
    expect(snap!.counts).toEqual({
      total: 20,
      available: 18,
      held: 0,
      confirmed: 2,
      invariant_ok: true,
    });
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });

  it("replays the same key + same seat set (any order) with the original body", async () => {
    const show = await makeShow(sql);
    const user = uniq("u");
    const first = created(await book(sql, show.id, user, ["A1", "A2"], "k1"));
    const again = await book(sql, show.id, user, ["A2", "A1"], "k1");
    expect(again).toEqual({ outcome: "replayed", path: "fast", reservation: first });
  });

  it("refuses the same key for a different request", async () => {
    const show = await makeShow(sql);
    const other = await makeShow(sql);
    const user = uniq("u");
    created(await book(sql, show.id, user, ["A1"], "k1"));
    expect((await book(sql, show.id, user, ["A2"], "k1")).outcome).toBe("idempotency_key_reused");
    expect((await book(sql, other.id, user, ["A1"], "k1")).outcome).toBe("idempotency_key_reused");
    expect((await getShowSnapshot(sql, show.id))!.counts.confirmed).toBe(1);
  });

  it("scopes keys per user: another user's identical key books independently", async () => {
    const show = await makeShow(sql);
    const a = created(await book(sql, show.id, uniq("u"), ["A1"], "shared"));
    const b = created(await book(sql, show.id, uniq("u"), ["A2"], "shared"));
    expect(b.reservation_id).not.toBe(a.reservation_id);
  });

  it("is all-or-nothing: one taken seat declines the whole request", async () => {
    const show = await makeShow(sql);
    created(await book(sql, show.id, uniq("u"), ["A1"]));
    const res = await book(sql, show.id, uniq("u"), ["A2", "A1", "A3"]);
    expect(res).toEqual({ outcome: "seat_taken", path: "fast", unavailable_seats: ["A1"] });
    const snap = await getShowSnapshot(sql, show.id);
    expect(snap!.seats.slice(0, 3).map((s) => s.status)).toEqual([
      "confirmed",
      "available",
      "available",
    ]);
  });

  it("does not consume the key on a decline, so a corrected retry with it succeeds", async () => {
    const show = await makeShow(sql);
    created(await book(sql, show.id, uniq("u"), ["A1"]));
    const user = uniq("u");
    expect((await book(sql, show.id, user, ["A1"], "retry-key")).outcome).toBe("seat_taken");
    created(await book(sql, show.id, user, ["A2"], "retry-key"));
  });

  it("enforces the per-user limit across requests", async () => {
    const show = await makeShow(sql, { perUserLimit: 3 });
    const user = uniq("u");
    created(await book(sql, show.id, user, ["A1", "A2"]));
    expect(await book(sql, show.id, user, ["A3", "A4"])).toEqual({
      outcome: "per_user_limit",
      path: "fast",
      limit: 3,
      active: 2,
      requested: 2,
    });
    created(await book(sql, show.id, user, ["A3"]));
  });

  it("rejects malformed requests without touching the database state", async () => {
    const show = await makeShow(sql);
    const user = uniq("u");
    const outcome = async (seats: string[], showId = show.id) =>
      (await book(sql, showId, user, seats)).outcome;

    expect(await book(sql, show.id, user, ["A1", "Z9", "Q1"])).toMatchObject({
      outcome: "invalid",
      unknown_seats: ["Q1", "Z9"],
    });
    expect(await outcome([])).toBe("invalid");
    expect(await outcome(["A1", "A1"])).toBe("invalid");
    expect(await outcome(["A1"], "not-a-uuid")).toBe("show_not_found");
    expect(await outcome(["A1"], randomUUID())).toBe("show_not_found");
    expect((await getShowSnapshot(sql, show.id))!.counts.available).toBe(20);
  });

  it("validates the idempotency key length", async () => {
    const show = await makeShow(sql);
    const r = await reserve(sql, {
      showId: show.id,
      userId: uniq("u"),
      seats: ["A1"],
      idempotencyKey: "",
    });
    expect(r.outcome).toBe("invalid");
  });

  it("hashes the request as a seat set bound to the show", () => {
    const show = randomUUID();
    expect(reserveRequestHash(show, ["A1", "B2"])).toBe(reserveRequestHash(show, ["B2", "A1"]));
    expect(reserveRequestHash(show, ["A1"])).not.toBe(reserveRequestHash(show, ["A2"]));
    expect(reserveRequestHash(show, ["A1"])).not.toBe(reserveRequestHash(randomUUID(), ["A1"]));
  });
});

describe("reserve: hold mode", () => {
  /** Rewind a reservation's deadline into the past instead of sleeping through the TTL. */
  async function lapse(reservationId: string) {
    await sql.begin(async (tx) => {
      await tx`update seats set held_until = now() - interval '1 second'
               where reservation_id = ${reservationId}::uuid and status = 'held'`;
      await tx`update reservations set expires_at = now() - interval '1 second'
               where id = ${reservationId}::uuid`;
    });
  }

  it("creates a hold with a deadline when the show has a TTL", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const r = created(await book(sql, show.id, uniq("u"), ["A1"]));
    expect(r.status).toBe("held");
    const ttl = (Date.parse(r.expires_at!) - Date.parse(r.created_at)) / 1000;
    expect(ttl).toBeCloseTo(120, 0);
    expect((await getShowSnapshot(sql, show.id))!.counts.held).toBe(1);
  });

  it("treats a lapsed hold as free: it frees the user's quota and another user can take it", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120, perUserLimit: 1 });
    const alice = uniq("alice");
    const hold = created(await book(sql, show.id, alice, ["A1"], "alice-key"));
    expect((await book(sql, show.id, uniq("bob"), ["A1"])).outcome).toBe("seat_taken");

    await lapse(hold.reservation_id);

    // Replay reports the derived status before any sweeper has run.
    const replay = await book(sql, show.id, alice, ["A1"], "alice-key");
    expect(replay).toMatchObject({ outcome: "replayed", reservation: { status: "expired" } });

    const bob = created(await book(sql, show.id, uniq("bob"), ["A1"]));
    expect(bob.status).toBe("held");
    created(await book(sql, show.id, alice, ["A2"])); // quota was released by the lapse
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });
});

describe("reserve: under concurrency", () => {
  it("500 parallel requests for one seat -> exactly one winner, and losers mostly never lock", async () => {
    const show = await makeShow(sql);
    let retries = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 500 }, (_, i) =>
        book(sql, show.id, `storm-${show.id}-${i}`, ["A12"], undefined, () => retries++),
      ),
    );

    expect(tally(outcomes)).toEqual({ created: 1, seat_taken: 499 });
    // Only requests whose snapshot predates the winner's commit can reach the locked path, and
    // the pool (20) caps how many are in flight then. Everyone else declines lock-free.
    const lockedDeclines = outcomes.filter(
      (o) => o.outcome === "seat_taken" && o.path === "locked",
    ).length;
    expect(lockedDeclines).toBeLessThan(20);
    expect(retries).toBe(0);
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });

  it("one user firing 10 parallel single-seat requests at limit 4 gets exactly 4", async () => {
    const show = await makeShow(sql, { perUserLimit: 4 });
    const user = uniq("greedy");
    const outcomes = await Promise.all(
      seatRow("A", 10).map((seat) => book(sql, show.id, user, [seat])),
    );
    expect(tally(outcomes)).toEqual({ created: 4, per_user_limit: 6 });
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });

  it("the same key x50 in parallel -> one reservation and 49 replays, never seat_taken", async () => {
    const show = await makeShow(sql);
    const user = uniq("retrier");
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => book(sql, show.id, user, ["A5", "A6"], "same-key")),
    );
    expect(tally(outcomes)).toEqual({ created: 1, replayed: 49 });
    const ids = new Set(
      outcomes.map((o) =>
        o.outcome === "created" || o.outcome === "replayed" ? o.reservation.reservation_id : null,
      ),
    );
    expect(ids.size).toBe(1);
    expect((await getShowSnapshot(sql, show.id))!.counts.confirmed).toBe(2);
  });

  it("the same key with different seats in parallel -> one winner, the rest replay or are refused", async () => {
    const show = await makeShow(sql);
    const user = uniq("confused");
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        book(sql, show.id, user, i % 2 === 0 ? ["A1"] : ["A2"], "one-key"),
      ),
    );
    const t = tally(outcomes);
    expect(t.created).toBe(1);
    expect((t.replayed ?? 0) + (t.idempotency_key_reused ?? 0)).toBe(39);
    expect(t.seat_taken).toBeUndefined();
    expect((await getShowSnapshot(sql, show.id))!.counts.confirmed).toBe(1);
  });

  it("crossed multi-seat requests never deadlock", async () => {
    const seats = seatRow("C", 6);
    const show = await makeShow(sql, { seats });
    let retries = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 300 }, (_, i) => {
        const a = seats[i % 5]!;
        const b = seats[(i % 5) + 1]!;
        const pair = i % 2 === 0 ? [a, b] : [b, a]; // opposite orders on overlapping pairs
        return book(sql, show.id, `cross-${show.id}-${i}`, pair, undefined, () => retries++);
      }),
    );
    expect(retries).toBe(0);
    const winners = outcomes.filter((o) => o.outcome === "created");
    const sold = winners.flatMap((o) => (o.outcome === "created" ? o.reservation.seats : []));
    expect(new Set(sold).size).toBe(sold.length); // no seat sold twice
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(winners.length).toBeLessThanOrEqual(3);
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });
});

describe("invariant oracle", () => {
  it("actually reports corruption that the schema constraints alone would allow", async () => {
    const show = await makeShow(sql, { perUserLimit: 4 });
    const user = uniq("u");
    const r = created(await book(sql, show.id, user, ["A1", "A2", "A3"]));
    expect(await invariantViolations(sql, show.id)).toEqual([]);

    await sql`update reservations set amount_paise = 1 where id = ${r.reservation_id}::uuid`;
    await sql`update shows set per_user_limit = 2 where id = ${show.id}::uuid`;
    const problems = await invariantViolations(sql, show.id);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/amount 1 <> price x seats/);
    expect(problems.join("\n")).toMatch(/holds 3 seats over limit 2/);
  });
});
