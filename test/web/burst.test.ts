/**
 * The War Room's burst detection (web/src/warroom/burst.ts): a burst is running while busy
 * seconds keep arriving, finishing until a report newer than its start is stored (or a minute
 * passes), and a person booking by hand is not a burst. Typechecked by web/tsconfig.json.
 */
import { describe, expect, it } from "vitest";
import { burstState } from "../../web/src/warroom/burst";
import type { BurstRun, Point } from "../../server/src/obs/types";

const T = 1_700_000_040_000;
const point = (s: number, reserve: Record<string, number> = {}): Point =>
  ({ t: T + s * 1000, reserve }) as unknown as Point;
const quiet = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => point(from + i));
const busy = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => point(from + i, { created: 5, seat_taken: 20 }));
const run = (s: number) => ({ created_at: new Date(T + s * 1000).toISOString() }) as BurstRun;

describe("burstState", () => {
  it("is idle with no traffic, or a person booking by hand", () => {
    expect(burstState(quiet(0, 30), T + 29_000, undefined).phase).toBe("idle");
    const byHand = [...quiet(0, 10), point(10, { created: 1 }), ...quiet(11, 20)];
    expect(burstState(byHand, T + 19_000, undefined).phase).toBe("idle");
  });

  it("is running while busy seconds arrive, tallied from the burst's first second", () => {
    const points = [...quiet(0, 10), ...busy(10, 20), ...quiet(20, 22), ...busy(22, 25)];
    const b = burstState(points, T + 24_000, run(-600));
    expect(b).toMatchObject({ phase: "running", startedAt: T + 10_000, requests: 13 * 25 });
    expect(b.phase === "running" && b.booked).toBe(13 * 5);
  });

  it("is finishing after the traffic stops, until a newer report is stored", () => {
    const points = [...busy(0, 10), ...quiet(10, 30)];
    expect(burstState(points, T + 29_000, run(-600)).phase).toBe("finishing");
    expect(burstState(points, T + 29_000, undefined).phase).toBe("finishing");
    expect(burstState(points, T + 29_000, run(15)).phase).toBe("idle");
  });

  it("stops waiting for a report after a minute", () => {
    const points = [...busy(0, 10), ...quiet(10, 75)];
    expect(burstState(points, T + 74_000, run(-600)).phase).toBe("idle");
  });

  it("starts a new burst after a long gap", () => {
    const points = [...busy(0, 5), ...quiet(5, 40), ...busy(40, 42)];
    expect(burstState(points, T + 41_000, run(20))).toMatchObject({
      phase: "running",
      startedAt: T + 40_000,
    });
  });
});
