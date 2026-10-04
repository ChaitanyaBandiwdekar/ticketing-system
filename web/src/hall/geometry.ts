/**
 * Seat labels (+ optional layout) -> positions on a grid measured in seat units. Pure; no DOM.
 *
 * Labels like "A12" / "AA-3" are read as row + number: one hall row per row label, ordered by
 * first appearance, seats by number, aisles as one-seat gaps, cross-aisles as a half-row gap, and
 * short rows centred like a real hall. When under 95% of labels read that way ("101", "VIP-A"),
 * it falls back to a plain grid in seat order. Very long rows wrap, so a script's 10k seats
 * "S-0001".."S-10000" (one row S) still fit a screen.
 */
import type { ShowLayout } from "../../../server/src/engine/types";

export type SeatCell = {
  label: string;
  /** Index in the show's seat order (= the index into the stream's status string). */
  index: number;
  row: string | null;
  num: number | null;
  /** Top-left corner, in seat units. */
  x: number;
  y: number;
};

export type RowMark = { label: string; y: number };

export type HallGeometry = {
  seats: SeatCell[];
  rows: RowMark[];
  /** Extent in seat units. */
  width: number;
  height: number;
  byLabel: Map<string, number>;
  /** bySeat[index] = that seat's cell. */
  bySeat: SeatCell[];
  mode: "rows" | "grid";
};

const LABEL = /^([A-Za-z]+)-?(\d+)$/;
const AISLE = 1;
const ROW_GAP = 0.6;
const WRAP_AT = 60;

export function hallGeometry(labels: readonly string[], layout: ShowLayout | null): HallGeometry {
  const parsed = labels.map((l) => LABEL.exec(l));
  const rowsMode = labels.length > 0 && parsed.filter(Boolean).length / labels.length >= 0.95;
  const geo = rowsMode ? byRows(labels, parsed, layout) : grid(labels);
  geo.byLabel = new Map(geo.seats.map((s) => [s.label, s.index]));
  geo.bySeat = [];
  for (const s of geo.seats) geo.bySeat[s.index] = s;
  return geo;
}

function byRows(
  labels: readonly string[],
  parsed: (RegExpExecArray | null)[],
  layout: ShowLayout | null,
): HallGeometry {
  const aisles = layout?.aisles_after ?? [];
  const gaps = new Set((layout?.row_gaps_after ?? []).map((r) => r.toUpperCase()));
  // Group by row label in order of first appearance; unparseable stragglers get their own row.
  const rows = new Map<string, { label: string; index: number; num: number }[]>();
  labels.forEach((label, index) => {
    const m = parsed[index];
    const row = m ? m[1]!.toUpperCase() : "·";
    const num = m ? Number(m[2]) : index + 1;
    let list = rows.get(row);
    if (!list) rows.set(row, (list = []));
    list.push({ label, index, num });
  });

  // Lay out each row (wrapping very long ones), then centre rows against the widest.
  type Line = { row: string; cells: { label: string; index: number; num: number; x: number }[] };
  const lines: (Line & { gapAfter: boolean })[] = [];
  for (const [row, seats] of rows) {
    seats.sort((a, b) => a.num - b.num || a.index - b.index);
    const chunks = seats.length > WRAP_AT ? chunk(seats, WRAP_AT / 1.2) : [seats];
    chunks.forEach((part, i) => {
      const cells = part.map((s, j) => {
        // Aisles only make sense for unwrapped rows numbered from 1.
        const before = chunks.length === 1 ? aisles.filter((a) => a < s.num).length : 0;
        return { ...s, x: j + before * AISLE };
      });
      lines.push({ row, cells, gapAfter: i === chunks.length - 1 && gaps.has(row) });
    });
  }
  const lineWidth = (l: Line) => (l.cells.length ? l.cells[l.cells.length - 1]!.x + 1 : 0);
  const width = Math.max(1, ...lines.map(lineWidth));

  const seats: SeatCell[] = [];
  const marks: RowMark[] = [];
  let y = 0;
  let lastRow: string | null = null;
  for (const line of lines) {
    const offset = (width - lineWidth(line)) / 2;
    if (line.row !== lastRow) marks.push({ label: line.row, y });
    lastRow = line.row;
    for (const c of line.cells) {
      seats.push({ label: c.label, index: c.index, row: line.row, num: c.num, x: c.x + offset, y });
    }
    y += 1 + (line.gapAfter ? ROW_GAP : 0);
  }
  return { seats, rows: marks, width, height: y, byLabel: new Map(), bySeat: [], mode: "rows" };
}

function grid(labels: readonly string[]): HallGeometry {
  const cols = Math.min(WRAP_AT, Math.max(1, Math.ceil(Math.sqrt(labels.length * 2))));
  const seats = labels.map((label, index) => ({
    label,
    index,
    row: null,
    num: null,
    x: index % cols,
    y: Math.floor(index / cols),
  }));
  const height = Math.ceil(labels.length / cols);
  return { seats, rows: [], width: cols, height, byLabel: new Map(), bySeat: [], mode: "grid" };
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * Where an arrow key moves from seat `index`: left/right stay on the same line (across aisles),
 * up/down go to the nearest line in that direction and the seat closest in x. Null at an edge.
 */
export function neighbor(geo: HallGeometry, index: number, dir: Direction): number | null {
  const from = geo.bySeat[index];
  if (!from) return null;
  let best: number | null = null;
  let bestScore = Infinity;
  for (const s of geo.seats) {
    const dx = s.x - from.x;
    const dy = s.y - from.y;
    let score: number;
    if (dir === "left" || dir === "right") {
      if (dy !== 0 || (dir === "left" ? dx >= 0 : dx <= 0)) continue;
      score = Math.abs(dx);
    } else {
      if (dir === "up" ? dy >= 0 : dy <= 0) continue;
      // Nearest line first, then the closest seat on it.
      score = Math.abs(dy) * 1e6 + Math.abs(dx);
    }
    if (score < bestScore) {
      bestScore = score;
      best = s.index;
    }
  }
  return best;
}

function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
