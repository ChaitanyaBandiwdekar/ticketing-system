/**
 * The War Room charts' data, shaped for drawing and kept free of the DOM so it can be tested on
 * its own.
 *
 * Points arrive one per second. A chart groups them into buckets wide enough to draw (a column
 * per bucket, at least a few pixels wide), aligned to whole multiples of the bucket size so a
 * bucket's edges don't shift as the window slides. A bucket with no point (before the feed
 * started, a reconnect, a restart) has null values, which leave a gap instead of drawing across
 * missing data.
 */

export type Series = { key: string; label: string; color: string };
/** One second: `t` in epoch ms, one value per series (null: no value that second). */
export type Row = { t: number; values: (number | null)[] };

/** How a bucket folds its seconds into one value per series. */
export type Agg = "mean" | "max";

export type Bucket = {
  /** First second of the bucket (epoch s), inclusive. */
  start: number;
  /** Seconds the bucket spans. */
  size: number;
  /** Seconds that held a point. */
  seen: number;
  values: (number | null)[];
};

/** The second a point belongs to (points are stamped in ms). */
export const toSec = (t: number) => Math.floor(t / 1000);

/** Bucket sizes a chart may use, in seconds. */
const BUCKETS = [1, 2, 3, 5, 10, 15, 30, 60];

/** The smallest bucket that gives every column at least `minPx` of width. */
export function pickBucket(windowSec: number, plotWidth: number, minPx = 6): number {
  for (const b of BUCKETS) if ((plotWidth / windowSec) * b >= minPx) return b;
  return BUCKETS.at(-1)!;
}

/**
 * The window [now - windowMs, now] in buckets of `size` seconds, oldest first. Each series'
 * value is the mean (rates, typical latency) or the max (worst-case latency, peaks) over the
 * seconds that held a point; null when none did.
 */
export function bucketize(
  rows: Row[],
  now: number,
  windowMs: number,
  size: number,
  aggs: Agg[],
): Bucket[] {
  if (!now) return [];
  const last = toSec(now);
  const first = last - Math.max(1, Math.round(windowMs / 1000)) + 1;
  const firstStart = Math.floor(first / size) * size;
  const count = Math.floor(last / size) - firstStart / size + 1;
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    start: firstStart + i * size,
    size,
    seen: 0,
    values: aggs.map(() => null),
  }));
  const sums = buckets.map(() => aggs.map(() => 0));
  const ns = buckets.map(() => aggs.map(() => 0));
  for (const r of rows) {
    const s = toSec(r.t);
    if (s < first || s > last) continue;
    const i = Math.floor(s / size) - firstStart / size;
    const b = buckets[i];
    if (!b) continue;
    b.seen++;
    aggs.forEach((agg, k) => {
      const v = r.values[k];
      if (v == null) return;
      if (agg === "max") b.values[k] = Math.max(b.values[k] ?? -Infinity, v);
      else {
        sums[i]![k]! += v;
        ns[i]![k]!++;
      }
    });
  }
  buckets.forEach((b, i) =>
    aggs.forEach((agg, k) => {
      if (agg === "mean" && ns[i]![k]! > 0) b.values[k] = sums[i]![k]! / ns[i]![k]!;
    }),
  );
  return buckets;
}

/** 1-2-2.5-5 rounding: the smallest "nice" number >= v. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

/**
 * The y axis: zero-based, never below `minMax`, with headroom over a reference line, in about
 * four round steps. Returns the gridline values, the last being the top.
 */
export function yTicks(dataMax: number, minMax: number, ref?: number): number[] {
  const want = Math.max(minMax, dataMax, ref ? ref * 1.15 : 0);
  const step = niceCeil(want / 4);
  const top = step * Math.max(1, Math.ceil(want / step - 1e-9));
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

/** Tick steps for the time axis, in seconds. */
const TIME_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800];

/**
 * Time-axis ticks on whole steps of the clock (whole minutes for windows of a few minutes),
 * spaced at least `minGapPx` apart. Returns epoch seconds inside [startSec, endSec].
 */
export function timeTicks(
  startSec: number,
  endSec: number,
  plotWidth: number,
  minGapPx = 72,
): number[] {
  const span = Math.max(1, endSec - startSec);
  const step = TIME_STEPS.find((s) => (plotWidth / span) * s >= minGapPx) ?? TIME_STEPS.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(startSec / step) * step; t <= endSec; t += step) ticks.push(t);
  return ticks;
}
