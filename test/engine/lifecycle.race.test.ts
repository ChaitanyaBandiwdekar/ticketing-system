/**
 * Lifecycle under concurrency: late actions on lapsed holds, confirm vs cancel, takeover vs
 * cancel vs sweeper, and a randomized stress with real (1s) hold expiry. Every engine call counts
 * contention retries; with the global lock order there must be none.
 */
import fc from "fast-check";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { RetryOptions } from "../../server/src/db/retry";
import { audit } from "../../server/src/engine/audit";
import { cancel, confirm, expireHolds } from "../../server/src/engine/lifecycle";
import { reserve } from "../../server/src/engine/reserve";
import { getShowSnapshot } from "../../server/src/engine/shows";
import type { LifecycleOutcome, Reservation, ReserveOutcome } from "../../server/src/engine/types";
import { uniq, useTestSql } from "../helpers/db";
import { invariantViolations, lapse, makeShow, seatRow } from "../helpers/engine";

const sql = useTestSql(20);

/** Counts contention retries across every engine call in a test. */
function retryCounter() {
  const seen: string[] = [];
  const opts: RetryOptions = { onRetry: (state) => seen.push(state) };
  return { opts, seen };
}

let keySeq = 0;
function hold(showId: string, userId: string, seats: string[], retry?: RetryOptions) {
  return reserve(sql, { showId, userId, seats, idempotencyKey: `k${keySeq++}` }, retry);
}

function created(o: ReserveOutcome): Reservation {
  if (o.outcome !== "created") throw new Error(`expected created, got ${JSON.stringify(o)}`);
  return o.reservation;
}

async function expectBooksBalance(showId: string) {
  const report = await audit(sql, showId);
  expect(report?.violations).toEqual([]);
  expect(report?.ok).toBe(true);
  expect(await invariantViolations(sql, showId)).toEqual([]);
  // Two independent derivations of the counts must agree. They are separate statements, so with
  // real expiry a hold can lapse in between: only compare when audits on both sides agree.
  for (let attempt = 0; ; attempt++) {
    const before = (await audit(sql, showId))!.counts;
    const snap = (await getShowSnapshot(sql, showId))!.counts;
    const after = (await audit(sql, showId))!.counts;
    if (JSON.stringify(before) === JSON.stringify(after) || attempt === 5) {
      expect(snap).toEqual(before);
      return;
    }
  }
}

describe("lifecycle races", () => {
  it("A's hold lapses, B re-books a seat, and A's late confirm/cancel leave B untouched", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const alice = uniq("alice");
    const bob = uniq("bob");
    const a = created(await hold(show.id, alice, ["A1", "A2"]));
    await lapse(sql, a.reservation_id);

    const b = created(await hold(show.id, bob, ["A2", "A3"])); // takes over A2
    const late = [
      await confirm(sql, { reservationId: a.reservation_id, userId: alice }),
      await cancel(sql, { reservationId: a.reservation_id, userId: alice }),
    ];
    expect(late.map((o) => o.outcome)).toEqual(["reservation_expired", "reservation_expired"]);

    const sweep = await expireHolds(sql);
    const mine = sweep.released.find((r) => r.show_id === show.id);
    expect(mine?.seats).toEqual(["A1"]); // only Alice's untaken seat

    const seats = await sql<{ label: string; status: string; reservation_id: string | null }[]>`
      select label, status, reservation_id from seats
       where show_id = ${show.id}::uuid and label in ('A1', 'A2', 'A3') order by id`;
    expect(seats).toEqual([
      { label: "A1", status: "available", reservation_id: null },
      { label: "A2", status: "held", reservation_id: b.reservation_id },
      { label: "A3", status: "held", reservation_id: b.reservation_id },
    ]);
    const [aRow] = await sql`select status from reservations where id = ${a.reservation_id}::uuid`;
    expect(aRow!.status).toBe("expired");
    expect((await confirm(sql, { reservationId: b.reservation_id, userId: bob })).outcome).toBe(
      "confirmed",
    );
    await expectBooksBalance(show.id);
  });

  it("confirm vs cancel on the same hold: cancel always wins the final state", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120, seats: seatRow("A", 120) });
    const { opts, seen } = retryCounter();
    const holds = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        hold(show.id, `cc-${show.id}-${i}`, [`A${2 * i + 1}`, `A${2 * i + 2}`]).then(created),
      ),
    );

    const results = await Promise.all(
      holds.map(async (h) => {
        const input = { reservationId: h.reservation_id, userId: h.user_id };
        const [c, x] = await Promise.all([confirm(sql, input, opts), cancel(sql, input, opts)]);
        return { c, x };
      }),
    );

    for (const { c, x } of results) {
      expect(x).toMatchObject({ outcome: "cancelled", changed: true });
      // Either confirm ran first (then cancel released a confirmed booking) or it lost.
      expect(["confirmed", "reservation_cancelled"]).toContain(c.outcome);
    }
    expect(seen).toEqual([]);
    expect((await getShowSnapshot(sql, show.id))!.counts.available).toBe(120);
    await expectBooksBalance(show.id);
  });

  it("takeovers, cancels, late confirms and the sweeper interleave without deadlocks", async () => {
    const { opts, seen } = retryCounter();
    const pairs = [
      ["D8", "D1"],
      ["D2", "D3"],
      ["D4", "D5"],
      ["D6", "D7"],
      ["D7", "D2"],
      ["D5", "D4"],
    ];
    for (let round = 0; round < 25; round++) {
      const show = await makeShow(sql, {
        holdTtlSeconds: 120,
        perUserLimit: 8,
        seats: seatRow("D", 8),
      });
      const live = created(await hold(show.id, uniq("a1"), ["D1", "D3", "D5", "D7"]));
      const stale = created(await hold(show.id, uniq("a2"), ["D2", "D4", "D6", "D8"]));
      await lapse(sql, stale.reservation_id);

      const grabbers = pairs.map(async (pair, i) => {
        const user = `${show.id}-g${i}`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const o = await hold(show.id, user, attempt % 2 ? [...pair].reverse() : pair, opts);
          if (o.outcome === "created") return o;
        }
        return null;
      });
      await Promise.all([
        cancel(sql, { reservationId: live.reservation_id, userId: live.user_id }, opts),
        confirm(sql, { reservationId: stale.reservation_id, userId: stale.user_id }, opts),
        expireHolds(sql, 500, opts),
        ...grabbers,
      ]);
      await expectBooksBalance(show.id);
    }
    expect(seen).toEqual([]);
  });
});

describe("lifecycle: randomized concurrent stress with real expiry", () => {
  type Op =
    | { kind: "reserve"; user: number; seats: number[] }
    | { kind: "confirm" | "cancel"; target: number; asOwner: boolean }
    | { kind: "sweep" };

  const SEATS = seatRow("L", 12);
  const USERS = 4;

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("reserve" as const),
        user: fc.integer({ min: 0, max: USERS - 1 }),
        seats: fc.uniqueArray(fc.integer({ min: 0, max: SEATS.length - 1 }), {
          minLength: 1,
          maxLength: 3,
        }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constantFrom("confirm" as const, "cancel" as const),
        target: fc.nat(),
        asOwner: fc.boolean(),
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("sweep" as const) }) },
  );

  it("keeps the books balanced and every outcome consistent with the final state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            ops: fc.array(opArb, { minLength: 1, maxLength: 25 }),
            pauseMs: fc.constantFrom(0, 300, 1100),
          }),
          { minLength: 2, maxLength: 4 },
        ),
        async (batches) => {
          const show = await makeShow(sql, { seats: SEATS, perUserLimit: 4, holdTtlSeconds: 1 });
          const users = Array.from({ length: USERS }, () => uniq("s"));
          const { opts, seen } = retryCounter();
          const known: Reservation[] = [];
          const results = new Map<string, LifecycleOutcome[]>();

          for (const { ops, pauseMs } of batches) {
            const snapshot = [...known];
            await Promise.all(
              ops.map(async (op) => {
                if (op.kind === "sweep") return expireHolds(sql, 500, opts);
                if (op.kind === "reserve") {
                  const o = await hold(
                    show.id,
                    users[op.user]!,
                    op.seats.map((i) => SEATS[i]!),
                    opts,
                  );
                  expect(["created", "seat_taken", "per_user_limit"]).toContain(o.outcome);
                  if (o.outcome === "created") known.push(o.reservation);
                  return o;
                }
                const target = snapshot[op.target % Math.max(snapshot.length, 1)];
                if (!target) return null;
                const userId = op.asOwner ? target.user_id : `${target.user_id}-intruder`;
                const input = { reservationId: target.reservation_id, userId };
                const o =
                  op.kind === "confirm"
                    ? await confirm(sql, input, opts)
                    : await cancel(sql, input, opts);
                if (!op.asOwner) expect(o).toEqual({ outcome: "forbidden" });
                const list = results.get(target.reservation_id) ?? [];
                list.push(o);
                results.set(target.reservation_id, list);
                return o;
              }),
            );
            await expectBooksBalance(show.id);
            if (pauseMs) await sleep(pauseMs);
          }

          // Final state must agree with what the calls reported.
          for (const [id, outcomes] of results) {
            const [row] = await sql<{ status: string }[]>`
              select fdfs_reservation_status(status, expires_at) as status
                from reservations where id = ${id}::uuid`;
            const did = (outcome: string) =>
              outcomes.some((o) => o.outcome === outcome && "changed" in o && o.changed);
            if (did("cancelled")) expect(row!.status).toBe("cancelled");
            else if (did("confirmed")) expect(row!.status).toBe("confirmed");
          }
          expect(seen).toEqual([]);
        },
      ),
      { numRuns: 12 },
    );
  });
});
