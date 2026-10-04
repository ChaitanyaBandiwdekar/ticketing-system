/**
 * The seat map's pure modules: the create-show generator, label → geometry, and the canvas
 * metrics/hit test (draw.ts, no canvas needed). Typechecked by web/tsconfig.json.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateShowInput } from "../../server/src/engine/shows";
import type { ShowLayout } from "../../server/src/engine/types";
import { measure, seatAt, seatRect } from "../../web/src/hall/draw";
import {
  defaultAisles,
  generateSeats,
  LIMITS,
  normalizeSpec,
  parseNumberList,
  rowLabel,
  toLayout,
  type HallSpec,
} from "../../web/src/hall/generator";
import { hallGeometry, type HallGeometry } from "../../web/src/hall/geometry";

const spec = (s: Partial<HallSpec> = {}): HallSpec => ({
  rows: 3,
  seatsPerRow: 10,
  aislesAfter: [],
  rowGapsAfter: [],
  ...s,
});

const hallSpecs = fc.record({
  rows: fc.integer({ min: 1, max: LIMITS.maxRows }),
  seatsPerRow: fc.integer({ min: 1, max: LIMITS.maxSeatsPerRow }),
  aislesAfter: fc.array(fc.integer({ min: -5, max: 70 }), { maxLength: 80 }),
  rowGapsAfter: fc.array(fc.integer({ min: -5, max: 60 }), { maxLength: 80 }),
});

const cell = (geo: HallGeometry, label: string) => geo.bySeat[geo.byLabel.get(label)!]!;

describe("generator", () => {
  it("rowLabel letters rows like a cinema", () => {
    const cases: [number, string][] = [
      [0, "A"],
      [1, "B"],
      [25, "Z"],
      [26, "AA"],
      [27, "AB"],
      [51, "AZ"],
      [52, "BA"],
      [701, "ZZ"],
      [702, "AAA"],
    ];
    for (const [i, label] of cases) expect(rowLabel(i), String(i)).toBe(label);
  });

  it("rowLabel is unique, letters only, and ordered by (length, alphabet)", () => {
    const labels = Array.from({ length: 2000 }, (_, i) => rowLabel(i));
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l).toMatch(/^[A-Z]+$/);
    const sorted = [...labels].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    expect(sorted).toEqual(labels);
  });

  it("generateSeats is row-major from A1", () => {
    expect(generateSeats({ rows: 2, seatsPerRow: 3 })).toEqual([
      "A1",
      "A2",
      "A3",
      "B1",
      "B2",
      "B3",
    ]);
    expect(generateSeats({ rows: 1, seatsPerRow: 1 })).toEqual(["A1"]);
  });

  it("normalizeSpec keeps aisles inside the row and gaps between rows, sorted and unique", () => {
    const n = normalizeSpec(
      spec({
        rows: 5,
        seatsPerRow: 10,
        aislesAfter: [9, 3, 3, 0, 10, -1, 2.5],
        rowGapsAfter: [5, 2, 4, 2, 0],
      }),
    );
    expect(n.aislesAfter).toEqual([3, 9]);
    expect(n.rowGapsAfter).toEqual([2, 4]);
    expect(n.rows).toBe(5);
    expect(n.seatsPerRow).toBe(10);
  });

  it("normalizeSpec caps each list at the API's limit", () => {
    const n = normalizeSpec({
      rows: LIMITS.maxRows,
      seatsPerRow: LIMITS.maxSeatsPerRow,
      aislesAfter: Array.from({ length: 59 }, (_, i) => 59 - i),
      rowGapsAfter: Array.from({ length: 51 }, (_, i) => i + 1),
    });
    expect(n.aislesAfter).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(n.rowGapsAfter).toHaveLength(LIMITS.maxLayoutEntries);
  });

  it("toLayout turns 1-based gap rows into row labels", () => {
    expect(toLayout(spec({ rows: 30, aislesAfter: [7, 3], rowGapsAfter: [26, 5, 1] }))).toEqual({
      aisles_after: [3, 7],
      row_gaps_after: ["A", "E", "Z"],
    });
  });

  it("defaultAisles splits the row about 1/4 · 1/2 · 1/4, none below 8 seats", () => {
    expect(defaultAisles(7)).toEqual([]);
    expect(defaultAisles(8)).toEqual([2, 6]);
    expect(defaultAisles(20)).toEqual([5, 15]);
    expect(defaultAisles(60)).toEqual([15, 45]);
  });

  it("parseNumberList reads commas and spaces and ignores junk", () => {
    expect(parseNumberList("4, 12")).toEqual([4, 12]);
    expect(parseNumberList(" 4  12,,16 ")).toEqual([4, 12, 16]);
    expect(parseNumberList("4,x,12a,-3")).toEqual([4, 12, -3]);
    expect(parseNumberList("")).toEqual([]);
    expect(parseNumberList(", ,")).toEqual([]);
  });

  it("any hall the form can describe is a show the API accepts", () => {
    fc.assert(
      fc.property(hallSpecs, (s) => {
        const seats = generateSeats(s);
        const layout = toLayout(s);
        const issues = validateShowInput(
          { name: "Hall", seats, pricePaise: 25_000, perUserLimit: 4, layout },
          LIMITS.maxRows * LIMITS.maxSeatsPerRow,
        );
        expect(issues).toEqual([]);
        expect(seats).toHaveLength(s.rows * s.seatsPerRow);
      }),
      { numRuns: 200 },
    );
  });
});

describe("hallGeometry: labelled rows", () => {
  it("places a generated hall seat by seat, with aisles and cross-aisles", () => {
    const s = spec({ rows: 3, seatsPerRow: 10, aislesAfter: [3, 7], rowGapsAfter: [1] });
    const labels = generateSeats(s);
    const geo = hallGeometry(labels, toLayout(s));

    expect(geo.mode).toBe("rows");
    expect(geo.width).toBe(12); // 10 seats + 2 aisles
    expect(geo.height).toBeCloseTo(3.6); // 3 rows + one cross-aisle
    expect(geo.rows).toEqual([
      { label: "A", y: 0 },
      { label: "B", y: expect.closeTo(1.6) },
      { label: "C", y: expect.closeTo(2.6) },
    ]);
    expect([1, 3, 4, 7, 8, 10].map((n) => cell(geo, `A${n}`).x)).toEqual([0, 2, 4, 7, 9, 11]);
    expect(cell(geo, "B4")).toMatchObject({ row: "B", num: 4, x: 4, y: expect.closeTo(1.6) });
  });

  it("keeps each seat's index into the show's seat order", () => {
    const labels = ["B2", "A1", "B1", "A2"];
    const geo = hallGeometry(labels, null);
    labels.forEach((label, i) => {
      expect(geo.byLabel.get(label)).toBe(i);
      expect(geo.bySeat[i]!.label).toBe(label);
    });
    // Rows in order of first appearance; seats by number within a row.
    expect(geo.rows.map((r) => r.label)).toEqual(["B", "A"]);
    expect(cell(geo, "B1").x).toBe(0);
    expect(cell(geo, "B2").x).toBe(1);
    expect(cell(geo, "A1").y).toBe(1);
  });

  it("orders seats numerically, not as strings", () => {
    const geo = hallGeometry(["A10", "A9", "A1", "A2"], null);
    expect(["A1", "A2", "A9", "A10"].map((l) => cell(geo, l).x)).toEqual([0, 1, 2, 3]);
  });

  it("centres short rows against the widest", () => {
    const labels = [...generateSeats({ rows: 1, seatsPerRow: 10 }), "B1", "B2", "B3", "B4"];
    const geo = hallGeometry(labels, null);
    expect(geo.width).toBe(10);
    expect(cell(geo, "A1").x).toBe(0);
    expect(cell(geo, "B1").x).toBe(3);
    expect(cell(geo, "B4").x).toBe(6);
  });

  it("reads lower case and dashed labels, and matches layout rows case-insensitively", () => {
    const geo = hallGeometry(["aa-1", "aa-2", "b1"], {
      aisles_after: [1],
      row_gaps_after: ["aa"],
    });
    expect(geo.mode).toBe("rows");
    expect(cell(geo, "aa-2")).toMatchObject({ row: "AA", num: 2, x: 2, y: 0 });
    expect(cell(geo, "b1")).toMatchObject({ row: "B", x: 1, y: expect.closeTo(1.6) });
  });

  it("puts a few unparseable stragglers in their own row", () => {
    const labels = [...generateSeats({ rows: 4, seatsPerRow: 24 }), "VIP", "BOX-A"]; // 96 + 2
    const geo = hallGeometry(labels, null);
    expect(geo.mode).toBe("rows");
    expect(geo.rows.map((r) => r.label)).toEqual(["A", "B", "C", "D", "·"]);
    expect(cell(geo, "VIP").row).toBe("·");
    expect(cell(geo, "BOX-A").y).toBe(4);
  });

  it("wraps very long rows (aisles off) and labels the row once", () => {
    const labels = Array.from({ length: 130 }, (_, i) => `S-${String(i + 1).padStart(4, "0")}`);
    const geo = hallGeometry(labels, { aisles_after: [10], row_gaps_after: [] });
    expect(geo.mode).toBe("rows");
    expect(geo.rows).toEqual([{ label: "S", y: 0 }]);
    expect(geo.width).toBe(50);
    expect(geo.height).toBe(3);
    expect(cell(geo, "S-0011").x).toBe(10); // no aisle gap in a wrapped row
    expect(cell(geo, "S-0051")).toMatchObject({ x: 0, y: 1 });
    expect(cell(geo, "S-0101")).toMatchObject({ x: 10, y: 2 }); // 30-seat tail, centred
  });

  it("a generated hall never overlaps and fits its extent", () => {
    fc.assert(
      fc.property(hallSpecs, (s) => {
        const labels = generateSeats(s);
        const n = normalizeSpec(s);
        const geo = hallGeometry(labels, toLayout(s));

        expect(geo.mode).toBe("rows");
        expect(geo.seats).toHaveLength(labels.length);
        expect(geo.width).toBe(s.seatsPerRow + n.aislesAfter.length);
        expect(geo.height).toBeCloseTo(s.rows + 0.6 * n.rowGapsAfter.length);
        expect(geo.rows.map((r) => r.label)).toEqual(
          Array.from({ length: s.rows }, (_, i) => rowLabel(i)),
        );

        const seen = new Set<string>();
        for (const c of geo.seats) {
          expect(geo.bySeat[c.index]).toBe(c);
          expect(labels[c.index]).toBe(c.label);
          expect(c.x).toBe(c.num! - 1 + n.aislesAfter.filter((a) => a < c.num!).length);
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.x + 1).toBeLessThanOrEqual(geo.width);
          expect(c.y + 1).toBeLessThanOrEqual(geo.height + 1e-9);
          const key = `${c.x},${c.y}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe("hallGeometry: grid fallback", () => {
  it("lays labels without row letters out in seat order", () => {
    const labels = Array.from({ length: 50 }, (_, i) => String(101 + i));
    const geo = hallGeometry(labels, { aisles_after: [2], row_gaps_after: ["A"] });
    expect(geo.mode).toBe("grid");
    expect(geo.rows).toEqual([]);
    expect(geo.width).toBe(10); // ceil(sqrt(100))
    expect(geo.height).toBe(5);
    expect(geo.bySeat[0]).toMatchObject({ label: "101", x: 0, y: 0, row: null, num: null });
    expect(geo.bySeat[13]).toMatchObject({ label: "114", x: 3, y: 1 });
  });

  it("falls back below 95% parseable labels", () => {
    const labels = [...generateSeats({ rows: 3, seatsPerRow: 6 }), "VIP-A", "VIP-B"]; // 18/20
    expect(hallGeometry(labels, null).mode).toBe("grid");
  });

  it("caps the grid at 60 columns and handles an empty show", () => {
    const big = hallGeometry(
      Array.from({ length: 10_000 }, (_, i) => `${i}`),
      null,
    );
    expect(big.width).toBe(60);
    expect(big.height).toBe(Math.ceil(10_000 / 60));

    const empty = hallGeometry([], null);
    expect(empty.seats).toEqual([]);
    expect(empty.height).toBe(0);
  });
});

describe("draw: metrics and hit testing", () => {
  const layout: ShowLayout = { aisles_after: [4, 12], row_gaps_after: ["E"] };
  const hall = hallGeometry(generateSeats({ rows: 10, seatsPerRow: 16 }), layout);

  it("clamps the pitch and shows row labels only when seats are large enough", () => {
    const wide = measure(hall, 4000);
    expect(wide.pitch).toBe(30);
    expect(wide.showRowLabels).toBe(true);
    expect(wide.gutter).toBe(28);
    expect(wide.cssHeight).toBe(Math.ceil(hall.height * 30 + 2 * wide.padY));

    const narrow = measure(hall, 120);
    expect(narrow.showRowLabels).toBe(false);
    expect(narrow.gutter).toBe(4);
    expect(narrow.pitch).toBeCloseTo((120 - 8) / hall.width);

    expect(measure(hall, 10).pitch).toBe(3);
    expect(measure(hall, 4000, { maxPitch: 20 }).pitch).toBe(20);
    expect(measure(hallGeometry(["1", "2"], null), 4000).showRowLabels).toBe(false);
  });

  it("every seat's centre hits that seat, at any width", () => {
    for (const width of [120, 360, 800, 1600]) {
      const m = measure(hall, width);
      for (const s of hall.seats) {
        const r = seatRect(hall, m, s.index)!;
        expect(r.size).toBe(m.seat);
        expect(seatAt(hall, m, r.x + r.size / 2, r.y + r.size / 2), `${width} ${s.label}`).toBe(
          s.index,
        );
      }
    }
  });

  it("aisles, cross-aisles and the space around the hall are misses", () => {
    const m = measure(hall, 800);
    const centre = (label: string) => {
      const r = seatRect(hall, m, hall.byLabel.get(label)!)!;
      return { x: r.x + r.size / 2, y: r.y + r.size / 2 };
    };
    // Midway between A4 and A5 is the aisle.
    const a4 = centre("A4");
    const a5 = centre("A5");
    expect(seatAt(hall, m, (a4.x + a5.x) / 2, a4.y)).toBeNull();
    // Midway between E1 and F1 is the cross-aisle.
    const e1 = centre("E1");
    const f1 = centre("F1");
    expect(seatAt(hall, m, e1.x, (e1.y + f1.y) / 2)).toBeNull();
    expect(seatAt(hall, m, 1, 1)).toBeNull();
    expect(seatAt(hall, m, 799, m.cssHeight - 1)).toBeNull();
  });

  it("centres the hall horizontally and keeps it inside the canvas", () => {
    const m = measure(hall, 800);
    const rects = hall.seats.map((s) => seatRect(hall, m, s.index)!);
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.size));
    expect(left).toBeCloseTo(800 - right);
    expect(left).toBeGreaterThanOrEqual(m.gutter - 1e-9);
    expect(Math.max(...rects.map((r) => r.y + r.size))).toBeLessThanOrEqual(m.cssHeight);
  });

  it("seatRect is null for an index the hall does not have", () => {
    const m = measure(hall, 800);
    expect(seatRect(hall, m, -1)).toBeNull();
    expect(seatRect(hall, m, hall.seats.length)).toBeNull();
  });
});
