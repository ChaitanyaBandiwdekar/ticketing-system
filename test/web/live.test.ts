/**
 * The live hall's pure pieces: the stream reducer, keyboard movement on the map, the booking
 * retry policy, the server-clock estimate and the countdown format. Typechecked by
 * web/tsconfig.json.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { SeatCounts } from "../../server/src/engine/types";
import { generateSeats, toLayout } from "../../web/src/hall/generator";
import { hallGeometry, neighbor, type HallGeometry } from "../../web/src/hall/geometry";
import {
  applyChanges,
  initialLive,
  liveReducer,
  remap,
  type LiveAction,
  type LiveState,
  type SeatIndex,
} from "../../web/src/hall/live";
import { ApiError } from "../../web/src/lib/api";
import { isTransient, retryDelay, seatList, withRetries } from "../../web/src/lib/booking";
import { noteServerDate, resetClock, serverNow } from "../../web/src/lib/clock";
import { clock } from "../../web/src/lib/format";

const counts = (c: Partial<SeatCounts> = {}): SeatCounts => ({
  total: 4,
  available: 4,
  held: 0,
  confirmed: 0,
  invariant_ok: true,
  ...c,
});

function indexOf(labels: string[]): SeatIndex {
  return { byLabel: new Map(labels.map((l, i) => [l, i])), size: labels.length };
}

const LABELS = ["A1", "A2", "A3", "A4"];
const IDX = indexOf(LABELS);
const run = (actions: LiveAction[], flashMs = 700, index = IDX): LiveState =>
  actions.reduce((s, a) => liveReducer(s, a, index, flashMs), initialLive);

const snapshot = (status: string, at = 0): LiveAction => ({
  type: "snapshot",
  frame: { seq: 1, counts: counts(), labels: LABELS, status },
  at,
});
const delta = (changes: Record<string, "a" | "h" | "c">, at = 0): LiveAction => ({
  type: "delta",
  frame: { seq: 2, counts: counts(), changes },
  at,
});

describe("live seat map reducer", () => {
  it("remap copies a frame in the hall's order and re-orders anything else by label", () => {
    const status = "ahca";
    expect(remap(LABELS, status, IDX, null)).toBe(status);
    expect(remap([...LABELS].reverse(), "ahca", IDX, null)).toBe("acha");
    // Unknown labels are ignored; seats the frame omits keep what we had.
    expect(remap(["A2", "Z9"], "cc", IDX, "hhhh")).toBe("hchh");
    expect(remap(["A2"], "c", IDX, null)).toBe("acaa");
  });

  it("applyChanges reports what moved and keeps the same string when nothing did", () => {
    const prev = "aaaa";
    expect(applyChanges(prev, { A1: "a", Z9: "c" }, IDX).status).toBe(prev);
    expect(applyChanges(prev, { A1: "a" }, IDX).changed).toEqual([]);
    expect(applyChanges(prev, { A2: "h", A4: "c", A1: "a" }, IDX)).toEqual({
      status: "ahac",
      changed: [1, 3],
    });
  });

  it("goes live on the connect snapshot and applies deltas in arrival order", () => {
    const s = run([snapshot("aaaa"), delta({ A1: "h" }), delta({ A1: "c", A2: "h" })]);
    expect(s).toMatchObject({ status: "chaa", link: "live", source: "stream" });
  });

  it("a REST seed paints first but never overwrites a live stream", () => {
    const seed = (status: string): LiveAction => ({
      type: "seed",
      labels: LABELS,
      status,
      counts: counts({ available: 0 }),
      at: 0,
    });
    expect(run([seed("cccc")])).toMatchObject({ status: "cccc", source: "rest" });
    // A REST read that was in flight when the stream connected lands late: ignored.
    expect(run([seed("cccc"), snapshot("aaaa"), seed("hhhh")]).status).toBe("aaaa");
    // Once the stream drops, the REST poll stands in again.
    const down = run([snapshot("aaaa"), { type: "link", link: "reconnecting" }, seed("hhhh")]);
    expect(down).toMatchObject({ status: "hhhh", source: "rest", link: "reconnecting" });
  });

  it("ignores a delta that arrives before any map", () => {
    expect(run([delta({ A1: "c" })])).toEqual(initialLive);
  });

  it("flashes changed seats, prunes old flashes, and can turn the glow off", () => {
    const s = run([snapshot("aaaa", 0), delta({ A1: "c" }, 100), delta({ A3: "h" }, 900)]);
    // A1 changed at 100 and is past its 700 ms by 900; A3 just changed.
    expect([...s.flashes]).toEqual([[2, 900]]);
    // A resync snapshot that differs flashes the differences too.
    expect([...run([snapshot("aaaa", 0), snapshot("acaa", 50)]).flashes]).toEqual([[1, 50]]);
    expect(run([snapshot("aaaa"), delta({ A1: "c" }, 10)], 0).flashes.size).toBe(0);
  });

  it("assume paints our own seats until the stream catches up", () => {
    const s = run([snapshot("aaaa"), { type: "assume", labels: ["A2", "A3"], code: "h", at: 5 }]);
    expect(s.status).toBe("ahha");
    // The stream's word is final.
    expect(liveReducer(s, delta({ A2: "a" }), IDX, 700).status).toBe("aaha");
  });

  it("records audit verdicts and link changes", () => {
    const audit = { show_id: "x", ok: true, violations: 0, at: "2026-10-04T00:00:00Z" };
    const s = run([snapshot("aaaa"), { type: "audit", frame: audit }]);
    expect(s.audit).toEqual(audit);
    expect(liveReducer(s, { type: "link", link: "live" }, IDX, 700)).toBe(s);
    expect(liveReducer(s, { type: "link", link: "gone" }, IDX, 700).link).toBe("gone");
  });

  it("any snapshot + deltas sequence matches a plain label -> code map", () => {
    const code = fc.constantFrom("a" as const, "h" as const, "c" as const);
    const labels = Array.from({ length: 12 }, (_, i) => `R${i + 1}`);
    const index = indexOf(labels);
    fc.assert(
      fc.property(
        fc.array(code, { minLength: 12, maxLength: 12 }),
        fc.array(fc.dictionary(fc.constantFrom(...labels, "ZZ9"), code), { maxLength: 30 }),
        fc.boolean(),
        (initial, deltas, shuffled) => {
          // The frame may list labels in any order; the hall's order is fixed.
          const order = shuffled ? [...labels].reverse() : labels;
          const model = new Map(labels.map((l, i) => [l, initial[i]!]));
          const frameStatus = order.map((l) => model.get(l)).join("");
          let s = liveReducer(
            initialLive,
            {
              type: "snapshot",
              frame: { seq: 1, counts: counts(), labels: order, status: frameStatus },
              at: 0,
            },
            index,
            700,
          );
          deltas.forEach((changes, i) => {
            for (const [l, c] of Object.entries(changes)) if (model.has(l)) model.set(l, c);
            s = liveReducer(
              s,
              { type: "delta", frame: { seq: i + 2, counts: counts(), changes }, at: i },
              index,
              700,
            );
          });
          expect(s.status).toBe(labels.map((l) => model.get(l)).join(""));
        },
      ),
    );
  });
});

describe("keyboard movement on the map", () => {
  const hall = (rows: number, perRow: number, aisles: number[], gaps: number[]): HallGeometry => {
    const spec = { rows, seatsPerRow: perRow, aislesAfter: aisles, rowGapsAfter: gaps };
    return hallGeometry(generateSeats(spec), toLayout(spec));
  };
  const at = (geo: HallGeometry, label: string) => geo.byLabel.get(label)!;
  const go = (geo: HallGeometry, from: string, dir: "left" | "right" | "up" | "down") => {
    const i = neighbor(geo, at(geo, from), dir);
    return i === null ? null : geo.bySeat[i]!.label;
  };

  it("left/right walk a row across aisles and stop at its ends", () => {
    const geo = hall(3, 8, [4], []);
    expect(go(geo, "A4", "right")).toBe("A5");
    expect(go(geo, "A5", "left")).toBe("A4");
    expect(go(geo, "A8", "right")).toBeNull();
    expect(go(geo, "A1", "left")).toBeNull();
  });

  it("up/down move to the nearest row, across cross-aisles, keeping the column", () => {
    const geo = hall(4, 8, [4], [2]);
    expect(go(geo, "B3", "down")).toBe("C3");
    expect(go(geo, "C3", "up")).toBe("B3");
    expect(go(geo, "A6", "up")).toBeNull();
    expect(go(geo, "D6", "down")).toBeNull();
  });

  it("up/down from a centred short row lands on the closest seat", () => {
    // Row B is shorter and centred under A, so B1 sits under A2.
    const geo = hallGeometry(["A1", "A2", "A3", "A4", "B1", "B2"], null);
    expect(go(geo, "B1", "up")).toBe("A2");
    expect(go(geo, "A1", "down")).toBe("B1");
  });

  it("every seat in a generated hall is reachable by arrows from the first", () => {
    const geo = hall(6, 14, [3, 11], [2, 4]);
    const seen = new Set([geo.seats[0]!.index]);
    const queue = [geo.seats[0]!.index];
    while (queue.length) {
      const i = queue.shift()!;
      for (const d of ["left", "right", "up", "down"] as const) {
        const n = neighbor(geo, i, d);
        if (n !== null && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect(seen.size).toBe(geo.seats.length);
  });
});

describe("booking retries", () => {
  const err = (status: number, code = `http_${status}`, retryAfterS: number | null = null) =>
    new ApiError(status, code, "x", null, {}, retryAfterS);

  it("treats transport trouble and overload as transient, and answers as final", () => {
    for (const s of [0, 429, 502, 503, 504]) expect(isTransient(err(s))).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422, 500]) expect(isTransient(err(s))).toBe(false);
    expect(isTransient(new Error("boom"))).toBe(false);
  });

  it("waits per Retry-After when the server says, else backs off with jitter", () => {
    expect(retryDelay(2, err(503, "contention", 3), () => 0)).toBe(3_000);
    expect(retryDelay(2, err(429, "overloaded", 60), () => 0)).toBe(8_000);
    expect(retryDelay(2, err(0), () => 0)).toBe(500);
    expect(retryDelay(3, err(0), () => 0)).toBe(1_000);
    expect(retryDelay(3, err(0), () => 0.999)).toBe(1_249);
  });

  it("retries transient failures with the same call, up to the limit", async () => {
    const waits: number[] = [];
    const seen: number[] = [];
    let calls = 0;
    const result = await withRetries(
      async (attempt) => {
        seen.push(attempt);
        if (++calls < 3) throw err(503, "contention");
        return "ok";
      },
      {
        attempts: 4,
        sleep: async (ms) => void waits.push(ms),
        random: () => 0,
        onRetry: () => {},
      },
    );
    expect(result).toBe("ok");
    expect(seen).toEqual([1, 2, 3]);
    expect(waits).toEqual([500, 1_000]);
  });

  it("gives up after the last attempt, and never retries a final answer", async () => {
    let calls = 0;
    const sleep = async () => {};
    await expect(
      withRetries(
        async () => {
          calls++;
          throw err(0, "network_error");
        },
        { attempts: 3, sleep },
      ),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw err(409, "seat_taken");
        },
        { attempts: 3, sleep },
      ),
    ).rejects.toMatchObject({ code: "seat_taken" });
    expect(calls).toBe(1);
  });

  it("seatList reads like a sentence", () => {
    expect(seatList([])).toBe("");
    expect(seatList(["A1"])).toBe("A1");
    expect(seatList(["A1", "A2"])).toBe("A1 and A2");
    expect(seatList(["A1", "A2", "A3"])).toBe("A1, A2 and A3");
  });
});

describe("server clock and countdown", () => {
  afterEach(resetClock);

  it("adopts the server's clock from Date headers, ignoring sub-second noise", () => {
    const local = Date.parse("2026-10-04T12:00:00.000Z");
    // Server 90s ahead.
    noteServerDate(new Date(local + 90_000).toUTCString(), local);
    const skew = serverNow() - Date.now();
    expect(skew).toBeGreaterThan(89_000);
    expect(skew).toBeLessThan(91_000);
    // Within the header's 1s resolution: kept as is.
    noteServerDate(new Date(local + 90_400).toUTCString(), local);
    expect(Math.abs(serverNow() - Date.now() - skew)).toBeLessThan(50);
    // Garbage is ignored.
    noteServerDate("not a date", local);
    noteServerDate(null, local);
    expect(Math.abs(serverNow() - Date.now() - skew)).toBeLessThan(50);
  });

  it("formats a countdown, rounding up so 0:00 means over", () => {
    expect(clock(272_000)).toBe("4:32");
    expect(clock(7_400)).toBe("0:08");
    expect(clock(1)).toBe("0:01");
    expect(clock(0)).toBe("0:00");
    expect(clock(-5_000)).toBe("0:00");
    expect(clock(600_000)).toBe("10:00");
  });
});
