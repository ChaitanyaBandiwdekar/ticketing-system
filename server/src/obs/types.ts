/**
 * The War Room's wire types (GET /ops/summary, GET /ops/stream frames). Free of Node imports, so
 * the web app shares them with the server instead of redeclaring them.
 */
import type { AuditReport } from "../engine/types";
import type { LogEntry } from "./logbuffer";
import type { Gauges, Latency, Point, StatusClass } from "./timeseries";

export type { Gauges, Latency, LogEntry, Point, StatusClass };

/** Counters since the process started (mirrors the Prometheus counters). */
export type Totals = {
  reserve: Record<string, number>;
  confirmed: number;
  held: number;
  cancelled: number;
  holdsExpired: number;
  seatsReleased: number;
  spoofIgnored: number;
  invariantViolations: number;
  audits: number;
  dbRetries: number;
  shed: number;
  http: Record<StatusClass, number>;
};

export type AuditSummary = {
  show_id: string;
  ok: boolean;
  counts: AuditReport["counts"];
  violations: number;
  at: string;
};

export type JobSummary = {
  name: string;
  ticks: number;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
};

export type Summary = {
  now: string;
  started_at: string;
  uptime_s: number;
  instance: string;
  commit: string | null;
  ready: boolean | null;
  limits: {
    pool_max: number;
    admission_capacity: number;
    stream_capacity: number;
  };
  totals: Totals;
  /** Reserve latency over the last minute (ms, sampled). */
  latency_60s: Latency | null;
  gauges: Gauges;
  /** The reconciler's latest verdict per audited show, newest first. */
  audits: AuditSummary[];
  /** True when every audit above is ok and no violation was ever counted. */
  invariant_ok: boolean;
  jobs: JobSummary[];
  streams: { clients: number; channels: number };
};

/** GET /ops/stream: the first frame after connecting. */
export type HelloFrame = {
  summary: Summary;
  points: Point[];
  logs: LogEntry[];
  latest_seq: number;
};

/** GET /ops/stream: one frame per second. */
export type TickFrame = {
  point: Point;
  summary: Summary;
  logs: LogEntry[];
  logs_skipped: number;
};
