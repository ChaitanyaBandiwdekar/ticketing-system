/**
 * The War Room charts' data, shaped for Lightweight Charts and kept free of the DOM so it can be
 * tested on its own.
 *
 * Lightweight Charts spaces bars by index, not by time. To keep x proportional to wall-clock
 * time, the window gets one slot per second ending at `now`. A second with no point (before
 * the feed started, a reconnect, a restart) is whitespace, which breaks the marks instead of
 * drawing a line across missing data. A null value does the same for one series.
 */
import type { UTCTimestamp } from "lightweight-charts";

export type Series = { key: string; label: string; color: string };
export type Row = { t: number; values: (number | null)[] };

export type Slot = { time: UTCTimestamp } | { time: UTCTimestamp; value: number };

/** The second a point belongs to (points are stamped in ms). */
export const toSec = (t: number) => Math.floor(t / 1000) as UTCTimestamp;

/**
 * One slot list per series, all aligned on the same seconds.
 * - `lines`: each series' own values.
 * - `stacked`: running totals bottom-up (series 0 at the bottom), so drawing the series from
 *   the top of the stack down, each filled to zero, reads as a stack.
 */
export function buildSlots(
  rows: Row[],
  seriesCount: number,
  kind: "stacked" | "lines",
  now: number,
  windowMs: number,
): Slot[][] {
  const out: Slot[][] = Array.from({ length: seriesCount }, () => []);
  if (!now) return out;
  const bySec = new Map<number, Row>();
  for (const r of rows) bySec.set(toSec(r.t), r);
  const last = toSec(now);
  const first = last - Math.max(1, Math.round(windowMs / 1000)) + 1;
  for (let s = first; s <= last; s++) {
    const time = s as UTCTimestamp;
    const row = bySec.get(s);
    let acc = 0;
    for (let i = 0; i < seriesCount; i++) {
      const v = row?.values[i];
      if (!row) {
        out[i]!.push({ time });
      } else if (kind === "stacked") {
        acc += v ?? 0;
        out[i]!.push({ time, value: acc });
      } else {
        out[i]!.push(v == null ? { time } : { time, value: v });
      }
    }
  }
  return out;
}

/** 1-2-5 rounding: the smallest "nice" number >= v, so the y axis ends on a round value. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/** The y-axis top: the data, never below `minMax`, with headroom over a reference line. */
export function yMax(dataMax: number, minMax: number, ref?: number): number {
  return niceCeil(Math.max(minMax, dataMax, ref ? ref * 1.15 : 0));
}
