/**
 * The War Room's time axis: one point per second, the last ten minutes, in memory.
 *
 * Recording is a few integer increments on the hot path. Once a second `roll()` closes the open
 * bucket into a point: per-outcome reserve counts, HTTP status classes, reserve latency
 * percentiles for that second, and the saturation gauges sampled at that moment (plus the peak of
 * DB calls in flight seen during the second, since a burst can fill and drain the pool between
 * two samples). Per instance, like the counters it mirrors; Prometheus is the durable copy.
 */

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

export type Gauges = {
  /** Requests holding an admission slot. */
  admission: number;
  /** Request-path DB calls in flight; above the pool size, calls are queueing for a connection. */
  db: number;
  streams: number;
  /** Event-loop delay p99 over the second, ms. */
  loopMs: number;
  rssMb: number;
  heapMb: number;
};

export type Latency = { p50: number; p95: number; p99: number; max: number; n: number };

export type Point = {
  /** Epoch ms at which the second closed. */
  t: number;
  /** Responses of POST /shows/:id/reserve by outcome (domain outcome or error code). */
  reserve: Record<string, number>;
  /** Reservations that became confirmed / held / cancelled, holds the sweeper expired. */
  confirmed: number;
  held: number;
  cancelled: number;
  expired: number;
  http: Record<StatusClass, number>;
  /** Reserve latency (ms) over the second; null when there were no reserves. */
  latency: Latency | null;
  /** Peak request-path DB calls in flight during the second. */
  dbPeak: number;
  gauges: Gauges;
};

/** Latency samples kept per second (reservoir), bounding memory and sort cost at any rate. */
const SAMPLES_PER_SECOND = 1024;

type Bucket = Omit<Point, "t" | "latency" | "gauges"> & { samples: number[]; seen: number };

function emptyBucket(): Bucket {
  return {
    reserve: {},
    confirmed: 0,
    held: 0,
    cancelled: 0,
    expired: 0,
    http: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
    dbPeak: 0,
    samples: [],
    seen: 0,
  };
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function latencyOf(samples: readonly number[]): Latency | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]!),
    n: sorted.length,
  };
}

export class TimeSeries {
  private readonly points: Point[] = [];
  /** Sample arrays of the most recent closed seconds, for the rolling latency summary. */
  private readonly recentSamples: number[][] = [];
  private open: Bucket = emptyBucket();

  constructor(
    private readonly capacity = 600,
    private readonly summaryWindow = 60,
    private readonly random: () => number = Math.random,
  ) {}

  reserve(outcome: string, ms: number): void {
    const b = this.open;
    b.reserve[outcome] = (b.reserve[outcome] ?? 0) + 1;
    // Reservoir sampling keeps a uniform sample of the second however many requests it saw.
    b.seen++;
    if (b.samples.length < SAMPLES_PER_SECOND) b.samples.push(ms);
    else {
      const j = Math.floor(this.random() * b.seen);
      if (j < SAMPLES_PER_SECOND) b.samples[j] = ms;
    }
  }

  http(statusClass: StatusClass): void {
    this.open.http[statusClass]++;
  }

  add(field: "confirmed" | "held" | "cancelled" | "expired", n = 1): void {
    this.open[field] += n;
  }

  dbInFlight(n: number): void {
    if (n > this.open.dbPeak) this.open.dbPeak = n;
  }

  /** Closes the open second into a point. */
  roll(now: number, gauges: Gauges): Point {
    const { samples, seen: _seen, ...rest } = this.open;
    const point: Point = {
      t: now,
      ...rest,
      dbPeak: Math.max(rest.dbPeak, gauges.db),
      latency: latencyOf(samples),
      gauges,
    };
    this.open = emptyBucket();
    this.points.push(point);
    if (this.points.length > this.capacity) this.points.shift();
    this.recentSamples.push(samples);
    if (this.recentSamples.length > this.summaryWindow) this.recentSamples.shift();
    return point;
  }

  /** Points closed strictly after `t` (all of them when omitted), oldest first. */
  since(t = 0): Point[] {
    if (t <= 0) return [...this.points];
    let i = this.points.length;
    while (i > 0 && this.points[i - 1]!.t > t) i--;
    return this.points.slice(i);
  }

  /** Reserve latency over the last `summaryWindow` seconds (sampled). */
  windowLatency(): Latency | null {
    return latencyOf(this.recentSamples.flat());
  }
}
