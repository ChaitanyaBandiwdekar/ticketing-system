/**
 * Randomized stress: fast-check generates batches of concurrent reserve calls (overlapping seats,
 * shared and reused idempotency keys, users pushing their limit) and after every batch we check
 * the database invariants AND a model of what the outcomes are allowed to be.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Reservation, ReserveOutcome } from "../../server/src/engine/types";
import { uniq, useTestSql } from "../helpers/db";
import { book, invariantViolations, makeShow, seatRow } from "../helpers/engine";

const sql = useTestSql(20);

const SEATS = seatRow("S", 10);
const USERS = 5;
const KEYS_PER_USER = 4;
const LIMIT = 3;

type Req = { user: number; seats: number[]; key: number };

const reqArb: fc.Arbitrary<Req> = fc.record({
  user: fc.integer({ min: 0, max: USERS - 1 }),
  seats: fc.uniqueArray(fc.integer({ min: 0, max: SEATS.length - 1 }), {
    minLength: 1,
    maxLength: 3,
  }),
  key: fc.integer({ min: 0, max: KEYS_PER_USER - 1 }),
});

const scenarioArb = fc.record({
  holdTtl: fc.constantFrom(null, 300),
  batches: fc.array(fc.array(reqArb, { minLength: 1, maxLength: 30 }), {
    minLength: 1,
    maxLength: 4,
  }),
});

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

describe("reserve: randomized concurrent stress", () => {
  it("keeps every invariant and only produces outcomes the model allows", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ holdTtl, batches }) => {
        const show = await makeShow(sql, {
          seats: SEATS,
          perUserLimit: LIMIT,
          holdTtlSeconds: holdTtl,
        });
        const users = Array.from({ length: USERS }, () => uniq("p"));
        /** (user,key) -> the one reservation that key ever created. */
        const byKey = new Map<string, Reservation>();
        const sold = new Map<string, string>(); // seat -> reservation id

        for (const batch of batches) {
          const reqs = batch.map((r) => ({
            user: users[r.user]!,
            seats: r.seats.map((i) => SEATS[i]!),
            key: `k${r.key}`,
          }));
          const outcomes: ReserveOutcome[] = await Promise.all(
            reqs.map((r) => book(sql, show.id, r.user, r.seats, r.key)),
          );

          // Register this batch's creations first: a replay may answer a sibling in the batch.
          outcomes.forEach((o, i) => {
            if (o.outcome !== "created") return;
            const k = `${reqs[i]!.user}/${reqs[i]!.key}`;
            expect(byKey.has(k), `key ${k} created twice`).toBe(false);
            byKey.set(k, o.reservation);
            for (const s of o.reservation.seats) {
              expect(sold.has(s), `seat ${s} sold twice`).toBe(false);
              sold.set(s, o.reservation.reservation_id);
            }
          });

          outcomes.forEach((o, i) => {
            const req = reqs[i]!;
            const original = byKey.get(`${req.user}/${req.key}`);
            switch (o.outcome) {
              case "created":
                expect(sameSet(o.reservation.seats, req.seats)).toBe(true);
                expect(o.reservation.user_id).toBe(req.user);
                break;
              case "replayed":
                expect(original?.reservation_id).toBe(o.reservation.reservation_id);
                expect(sameSet(original!.seats, req.seats)).toBe(true);
                break;
              case "idempotency_key_reused":
                expect(original).toBeDefined();
                expect(sameSet(original!.seats, req.seats)).toBe(false);
                break;
              case "seat_taken":
                expect(o.unavailable_seats.length).toBeGreaterThan(0);
                expect(o.unavailable_seats.every((s) => req.seats.includes(s))).toBe(true);
                break;
              case "per_user_limit":
                expect(o.active + o.requested).toBeGreaterThan(LIMIT);
                break;
              default:
                throw new Error(`unexpected outcome ${JSON.stringify(o)}`);
            }
          });

          expect(await invariantViolations(sql, show.id)).toEqual([]);
        }

        const perUser = new Map<string, number>();
        for (const r of byKey.values()) {
          perUser.set(r.user_id, (perUser.get(r.user_id) ?? 0) + r.seats.length);
        }
        for (const n of perUser.values()) expect(n).toBeLessThanOrEqual(LIMIT);

        const [row] = await sql<{ taken: number }[]>`
          select count(*)::int as taken from seats
           where show_id = ${show.id}::uuid and status <> 'available'`;
        expect(row!.taken).toBe(sold.size);
      }),
      { numRuns: 25 },
    );
  });
});
