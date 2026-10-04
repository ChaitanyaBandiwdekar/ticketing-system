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

/**
 * A burst's final report as the burst client (CLI or Stampede simulator) posts it to POST
 * /ops/runs: the fields the War Room's scorecard renders, measured by the client.
 */
export type RunReport = {
  ok: boolean;
  show: { id: string; name: string; total_seats: number };
  durationMs: number;
  /** Reserve responses by outcome, retries included. */
  outcomes: Record<string, number>;
  /** Final outcome per scenario (after retries). */
  scenarios: Record<string, Record<string, number>>;
  status: { "2xx": number; "4xx": number; "429": number; "5xx": number; network: number };
  retries: number;
  /** Reserves and cancels still unanswered after every retry (absent on older runs). */
  unanswered?: number;
  /** Requests re-sent in transit: booked once, answered with the replay (absent on older runs). */
  resent?: number;
  reserveRequests: number;
  /** Reserve requests per second over the run. */
  throughput: number;
  /** Reserve latency as the client saw it (ms). */
  latency: { p50: number; p95: number; p99: number; max: number } | null;
  slowest: { requestId: string; ms: number; outcome: string }[];
  final: { total: number; available: number; held: number; confirmed: number } | null;
  checks: { name: string; ok: boolean; detail: string }[];
  settings?: { concurrency: number; perUserLimit: number };
};

/** GET /ops/runs: one stored run, newest first. */
export type BurstRun = {
  id: string;
  show_id: string;
  ok: boolean;
  created_at: string;
  report: RunReport;
  /** The server's own audit of the show when the report arrived; null if the show was gone. */
  server_audit: { ok: boolean; counts: AuditReport["counts"]; violations: number } | null;
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
