/**
 * The War Room charts' data shaping (web/src/warroom/chartData.ts): seconds folded into buckets
 * wide enough to draw, aligned to the clock, with gaps where no point arrived; round y-axis
 * steps; time ticks on whole minutes. Typechecked by web/tsconfig.json.
 */
import { describe, expect, it } from "vitest";
import {
  bucketize,
  niceCeil,
  pickBucket,
  timeTicks,
  toSec,
  yTicks,
  type Row,
} from "../../web/src/warroom/chartData";

const T = 1_700_000_040_000; // a whole minute, in ms
const row = (dt: number, ...values: (number | null)[]): Row => ({ t: T + dt * 1000, values });

describe("bucketize", () => {
  it("gives one bucket per second of the window at size 1, ending at now", () => {
    const b = bucketize([row(0, 1, 2)], T, 10_000, 1, ["mean", "mean"]);
    expect(b).toHaveLength(10);
    expect(b.at(-1)!.start).toBe(toSec(T));
    expect(b[0]!.start).toBe(toSec(T) - 9);
    expect(b.at(-1)!.values).toEqual([1, 2]);
  });

  it("leaves buckets without a point as gaps (null, seen 0)", () => {
    const b = bucketize([row(-5, 3), row(0, 8)], T, 6_000, 1, ["mean"]);
    expect(b.map((x) => x.values[0])).toEqual([3, null, null, null, null, 8]);
    expect(b.map((x) => x.seen)).toEqual([1, 0, 0, 0, 0, 1]);
  });

  it("aligns buckets to whole multiples of their size", () => {
    const b = bucketize([row(0, 1)], T + 3_000, 20_000, 5, ["mean"]);
    for (const x of b) expect(x.start % 5).toBe(0);
    expect(b.at(-1)!.start).toBe(toSec(T)); // T+3s falls in the bucket starting at T
  });

  it("averages rates and keeps the worst value, per series", () => {
    const rows = [row(0, 10, 100), row(1, 20, 300), row(2, null, 200)];
    const [b] = bucketize(rows, T + 2_000, 3_000, 5, ["mean", "max"]).slice(-1);
    expect(b!.values).toEqual([15, 300]);
    expect(b!.seen).toBe(3);
  });

  it("drops points older than the window and tolerates sub-second stamps", () => {
    const b = bucketize([row(-60, 99), { t: T + 400, values: [1] }], T + 400, 2_000, 1, ["mean"]);
    expect(b.map((x) => x.values[0])).toEqual([null, 1]);
  });

  it("is empty before the first point", () => {
    expect(bucketize([], 0, 300_000, 5, ["mean"])).toEqual([]);
  });
});

describe("pickBucket", () => {
  it("picks the smallest size that gives every column a few pixels", () => {
    expect(pickBucket(60, 900)).toBe(1); // 15px per second
    expect(pickBucket(600, 900)).toBe(5); // 1.5px per second -> 7.5px per 5s
    expect(pickBucket(600, 300)).toBe(15);
  });
});

describe("y axis", () => {
  it("rounds up to 1-2-2.5-5 steps", () => {
    expect([0, 0.3, 1, 3, 7, 11, 24, 260, 4100].map(niceCeil)).toEqual([
      1, 0.5, 1, 5, 10, 20, 25, 500, 5000,
    ]);
  });

  it("steps from zero in about four round steps", () => {
    expect(yTicks(173, 5)).toEqual([0, 50, 100, 150, 200]);
    expect(yTicks(0, 50)).toEqual([0, 20, 40, 60]);
  });

  it("never drops below minMax and leaves room over the reference line", () => {
    expect(yTicks(3, 4, 10).at(-1)).toBeGreaterThanOrEqual(11.5);
    expect(yTicks(250, 4, 10).at(-1)).toBe(300);
  });
});

describe("timeTicks", () => {
  it("lands on whole minutes for a ten-minute window", () => {
    const end = toSec(T) + 30;
    const ticks = timeTicks(end - 600, end, 900);
    expect(ticks.length).toBeGreaterThan(3);
    for (const t of ticks) expect(t % 60).toBe(0);
  });

  it("spaces ticks at least minGapPx apart", () => {
    const end = toSec(T);
    const ticks = timeTicks(end - 600, end, 300, 72);
    const px = 300 / 600;
    for (let i = 1; i < ticks.length; i++) {
      expect((ticks[i]! - ticks[i - 1]!) * px).toBeGreaterThanOrEqual(72);
    }
  });
});
