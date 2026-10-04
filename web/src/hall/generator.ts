/**
 * Hall-layout generator for "create show": rows × seats with aisles and cross-aisles, producing
 * the seat labels the API stores plus the layout the seat map draws. Pure; no DOM.
 */
import type { ShowLayout } from "../../../server/src/engine/types";

export type HallSpec = {
  rows: number;
  seatsPerRow: number;
  /** Vertical aisle after these seat numbers. */
  aislesAfter: number[];
  /** Cross-aisle after these row numbers (1-based: 5 = after row E). */
  rowGapsAfter: number[];
};

/** maxLayoutEntries mirrors the API's cap on each layout list (server/src/engine/shows.ts). */
export const LIMITS = { maxRows: 52, maxSeatsPerRow: 60, maxLayoutEntries: 50 } as const;

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 51 -> "AZ" (cinema row lettering). */
export function rowLabel(index: number): string {
  let label = "";
  let i = index;
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

/** Row-major labels: A1..A<n>, B1..B<n>, ... */
export function generateSeats(spec: Pick<HallSpec, "rows" | "seatsPerRow">): string[] {
  const seats: string[] = [];
  for (let r = 0; r < spec.rows; r++) {
    const row = rowLabel(r);
    for (let s = 1; s <= spec.seatsPerRow; s++) seats.push(`${row}${s}`);
  }
  return seats;
}

/**
 * Keeps only aisles strictly inside the row and gaps strictly between rows; sorted, unique, and
 * at most LIMITS.maxLayoutEntries each, so the preview is exactly what the API will accept.
 */
export function normalizeSpec(spec: HallSpec): HallSpec {
  const clean = (list: number[], max: number) =>
    [...new Set(list.filter((n) => Number.isInteger(n) && n >= 1 && n < max))]
      .sort((a, b) => a - b)
      .slice(0, LIMITS.maxLayoutEntries);
  return {
    ...spec,
    aislesAfter: clean(spec.aislesAfter, spec.seatsPerRow),
    rowGapsAfter: clean(spec.rowGapsAfter, spec.rows),
  };
}

export function toLayout(spec: HallSpec): ShowLayout {
  const n = normalizeSpec(spec);
  return {
    aisles_after: n.aislesAfter,
    row_gaps_after: n.rowGapsAfter.map((i) => rowLabel(i - 1)),
  };
}

/** A sensible default: two aisles splitting the row into roughly 1/4 · 1/2 · 1/4 blocks. */
export function defaultAisles(seatsPerRow: number): number[] {
  if (seatsPerRow < 8) return [];
  const q = Math.round(seatsPerRow / 4);
  return [q, seatsPerRow - q];
}

/** "4, 12" -> [4, 12]; ignores junk so typing never throws. */
export function parseNumberList(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isInteger(n));
}
