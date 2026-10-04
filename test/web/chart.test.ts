/**
 * The War Room charts' data shaping (web/src/warroom/chartData.ts): one slot per second across
 * the window, whitespace where a second has no point, running totals for stacks, and the y-axis
 * top. Typechecked by web/tsconfig.json.
 */
import { describe, expect, it } from "vitest";
import { buildSlots, niceCeil, toSec, yMax, type Row } from "../../web/src/warroom/chartData";

const T = 1_700_000_000_000; // a whole second, in ms
const row = (dt: number, ...values: (number | null)[]): Row => ({ t: T + dt * 1000, values });

describe("buildSlots", () => {
  it("gives every series one slot per second of the window, ending at now", () => {
    const slots = buildSlots([row(0, 1, 2)], 2, "lines", T, 10_000);
    for (const s of slots) {
      expect(s).toHaveLength(10);
      expect(s.at(-1)!.time).toBe(toSec(T));
      expect(s[0]!.time).toBe(toSec(T) - 9);
    }
  });

  it("leaves seconds without a point as whitespace, so lines break across gaps", () => {
    const rows = [row(-5, 3), row(-4, 4), row(-1, 7), row(0, 8)];
    const [s] = buildSlots(rows, 1, "lines", T, 6_000);
    expect(s!.map((x) => ("value" in x ? x.value : null))).toEqual([3, 4, null, null, 7, 8]);
  });

  it("breaks only the one series whose value is null", () => {
    const [a, b] = buildSlots([row(0, null, 5)], 2, "lines", T, 1_000);
    expect(a).toEqual([{ time: toSec(T) }]);
    expect(b).toEqual([{ time: toSec(T), value: 5 }]);
  });

  it("stacks bottom-up as running totals, treating null as zero", () => {
    const slots = buildSlots([row(0, 2, null, 3)], 3, "stacked", T, 1_000);
    expect(slots.map((s) => ("value" in s[0]! ? s[0]!.value : null))).toEqual([2, 2, 5]);
  });

  it("drops points older than the window and tolerates sub-second stamps", () => {
    const rows = [row(-60, 99), { t: T + 400, values: [1] }];
    const [s] = buildSlots(rows, 1, "lines", T + 400, 2_000);
    expect(s).toEqual([{ time: toSec(T) - 1 }, { time: toSec(T), value: 1 }]);
  });

  it("is empty before the first point", () => {
    expect(buildSlots([], 2, "lines", 0, 300_000)).toEqual([[], []]);
  });
});

describe("y-axis top", () => {
  it("rounds up to 1-2-2.5-5 steps", () => {
    expect([0, 0.3, 1, 3, 7, 11, 24, 260, 4100].map(niceCeil)).toEqual([
      1, 0.5, 1, 5, 10, 20, 25, 500, 5000,
    ]);
  });

  it("never drops below minMax and leaves room over the reference line", () => {
    expect(yMax(0, 50)).toBe(50);
    expect(yMax(3, 4, 10)).toBe(20); // 10 × 1.15 → 20
    expect(yMax(130, 4, 10)).toBe(200);
  });
});
