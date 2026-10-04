/**
 * Prometheus metrics (GET /metrics) and the War Room's per-second series, fed by the same calls.
 *
 * Every recording method updates the Prometheus instrument, the in-memory totals behind
 * /ops/summary, and the open TimeSeries second together, so the three views can never disagree.
 * The burst script relies on that: the delta of `fdfs_reserve_responses_total` across a burst
 * must equal the responses it observed, outcome by outcome.
 *
 * Cardinality is bounded by construction: labels are outcomes, error codes, route templates
 * (never raw URLs), status classes, job names and SQLSTATEs. The only per-show series is
 * `fdfs_seats`, and it covers just the shows the reconciler audited last (at most 25), rebuilt on
 * every scrape so deleted or idle shows drop out.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import type { AuditReport, LifecycleOutcome } from "../engine/types";
import { TimeSeries, type Gauges, type Point, type StatusClass } from "./timeseries";
import type { Totals } from "./types";

/** Live readings the gauges pull at scrape time; bound once the app and jobs exist. */
export type MetricSources = {
  admission?: () => { inFlight: number; maxInFlight: number };
  streams?: () => { clients: number; channels: number };
  audits?: () => Iterable<{ report: AuditReport; at: Date }>;
  jobs?: () => Iterable<{
    name: string;
    lastSuccessAt: number | null;
    consecutiveFailures: number;
  }>;
  /** The readiness verdict (the same 1s-cached, single-flight probe as GET /readyz). */
  ready?: () => Promise<boolean>;
};

export type ReserveState = "confirmed" | "held";

/** Reserve outcomes (created/replayed or the error code) counted as declines, by reason. */
const DECLINE_REASON: Record<string, string> = {
  replayed: "idempotent_replay",
  seat_taken: "seat_taken",
  per_user_limit: "per_user_limit",
  idempotency_key_reused: "idempotency_key_reused",
  unknown_seats: "invalid",
  validation_error: "invalid",
  show_not_found: "not_found",
};

const LOOP_RESOLUTION_MS = 20;

/** Seconds; up to 30s because a 0.1-CPU free instance under a stampede is slow, not broken. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export function statusClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

export class Metrics {
  readonly registry = new Registry();
  readonly series: TimeSeries;
  readonly totals: Totals = {
    reserve: {},
    confirmed: 0,
    held: 0,
    cancelled: 0,
    holdsExpired: 0,
    seatsReleased: 0,
    spoofIgnored: 0,
    invariantViolations: 0,
    audits: 0,
    dbRetries: 0,
    shed: 0,
    http: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 },
  };
  private sources: MetricSources = {};
  private dbInFlight = 0;
  private readonly loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

  private readonly reserveResponses: Counter<"outcome">;
  private readonly reservationsConfirmed: Counter;
  private readonly reservationsHeld: Counter;
  private readonly reservationsDeclined: Counter<"reason">;
  private readonly reservationsCancelled: Counter;
  private readonly holdsExpired: Counter;
  private readonly seatsReleased: Counter;
  private readonly spoofIgnored: Counter;
  private readonly invariantViolations: Counter;
  private readonly auditsTotal: Counter<"result">;
  private readonly dbRetries: Counter<"sqlstate">;
  private readonly shedTotal: Counter;
  private readonly httpResponses: Counter<"route" | "status_class">;
  private readonly reserveDuration: Histogram<"outcome">;
  private readonly httpDuration: Histogram<"route">;

  constructor(
    readonly poolMax: number,
    opts: { defaultMetrics?: boolean; seriesCapacity?: number } = {},
  ) {
    this.series = new TimeSeries(opts.seriesCapacity);
    const registers = [this.registry];
    if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
    this.loop.enable();

    this.reserveResponses = new Counter({
      name: "fdfs_reserve_responses_total",
      help: "Every response of POST /shows/:id/reserve: created, replayed, or the error code",
      labelNames: ["outcome"],
      registers,
    });
    this.reservationsConfirmed = new Counter({
      name: "fdfs_reservations_confirmed_total",
      help: "Reservations that became confirmed (instant-mode reserves plus confirmed holds)",
      registers,
    });
    this.reservationsHeld = new Counter({
      name: "fdfs_reservations_held_total",
      help: "Holds created (hold-mode reserves)",
      registers,
    });
    this.reservationsDeclined = new Counter({
      name: "fdfs_reservations_declined_total",
      help: "Reserve requests that created nothing, by reason",
      labelNames: ["reason"],
      registers,
    });
    this.reservationsCancelled = new Counter({
      name: "fdfs_reservations_cancelled_total",
      help: "Reservations cancelled by their owner",
      registers,
    });
    this.holdsExpired = new Counter({
      name: "fdfs_holds_expired_total",
      help: "Lapsed holds finalized as expired by the sweeper",
      registers,
    });
    this.seatsReleased = new Counter({
      name: "fdfs_hold_seats_released_total",
      help: "Seats of lapsed holds released back to available by the sweeper",
      registers,
    });
    this.spoofIgnored = new Counter({
      name: "fdfs_identity_spoof_ignored_total",
      help: "Reserve requests whose body user_id differed from the token's subject (ignored)",
      registers,
    });
    this.invariantViolations = new Counter({
      name: "fdfs_invariant_violations_total",
      help: "Invariant violations found by the reconciler's audits. Must stay 0",
      registers,
    });
    this.auditsTotal = new Counter({
      name: "fdfs_audits_total",
      help: "Reconciler audits run, by result",
      labelNames: ["result"],
      registers,
    });
    this.dbRetries = new Counter({
      name: "fdfs_db_retries_total",
      help: "Engine calls retried after transient contention, by SQLSTATE",
      labelNames: ["sqlstate"],
      registers,
    });
    this.shedTotal = new Counter({
      name: "fdfs_admission_shed_total",
      help: "Requests refused with 429 because the admission queue was full",
      registers,
    });
    this.httpResponses = new Counter({
      name: "fdfs_http_responses_total",
      help: "HTTP responses by route template and status class (ops routes and static files excluded)",
      labelNames: ["route", "status_class"],
      registers,
    });
    this.reserveDuration = new Histogram({
      name: "fdfs_reservation_duration_seconds",
      help: "POST /shows/:id/reserve latency, by outcome",
      labelNames: ["outcome"],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.httpDuration = new Histogram({
      name: "fdfs_http_request_duration_seconds",
      help: "HTTP request latency by route template",
      labelNames: ["route"],
      buckets: LATENCY_BUCKETS,
      registers,
    });

    // Gauges read live state at scrape time. `this` inside collect() is the gauge itself, so the
    // metrics object is reached through these closures.
    const live = {
      sources: () => this.sources,
      dbInFlight: () => this.dbInFlight,
      poolMax: this.poolMax,
    };
    new Gauge({
      name: "fdfs_admission_in_flight",
      help: "Requests holding an admission slot",
      registers,
      collect() {
        this.set(live.sources().admission?.().inFlight ?? 0);
      },
    });
    new Gauge({
      name: "fdfs_admission_capacity",
      help: "Admission slots (MAX_QUEUE); beyond it requests get 429",
      registers,
      collect() {
        this.set(live.sources().admission?.().maxInFlight ?? 0);
      },
    });
    new Gauge({
      name: "fdfs_db_calls_in_flight",
      help: "Request-path DB calls in flight; above fdfs_db_pool_max they queue for a connection",
      registers,
      collect() {
        this.set(live.dbInFlight());
      },
    });
    new Gauge({
      name: "fdfs_db_pool_max",
      help: "Connections in the request pool (DB_POOL_MAX)",
      registers,
      collect() {
        this.set(live.poolMax);
      },
    });
    new Gauge({
      name: "fdfs_stream_clients",
      help: "Open seat-map streams (SSE)",
      registers,
      collect() {
        this.set(live.sources().streams?.().clients ?? 0);
      },
    });
    new Gauge({
      name: "fdfs_ready",
      help: "1 when the readiness probe passes, 0 when the DB is unreachable or the instance drains",
      registers,
      // Probes at scrape time (cached 1s, so at most one `select 1` a second): an unprobed
      // gauge would export 0 and page "not ready" on a healthy instance.
      async collect() {
        const ready = live.sources().ready;
        if (ready) this.set((await ready()) ? 1 : 0);
      },
    });
    new Gauge({
      name: "fdfs_seats",
      help: "Seats by status for the shows the reconciler audited last (DB-derived)",
      labelNames: ["show", "status"],
      registers,
      collect() {
        this.reset();
        for (const { report } of live.sources().audits?.() ?? []) {
          const c = report.counts;
          this.set({ show: report.show_id, status: "available" }, c.available);
          this.set({ show: report.show_id, status: "held" }, c.held);
          this.set({ show: report.show_id, status: "confirmed" }, c.confirmed);
        }
      },
    });
    new Gauge({
      name: "fdfs_job_last_success_timestamp_seconds",
      help: "When each background job last completed a tick (unix seconds)",
      labelNames: ["job"],
      registers,
      collect() {
        for (const j of live.sources().jobs?.() ?? []) {
          if (j.lastSuccessAt !== null) this.set({ job: j.name }, j.lastSuccessAt / 1000);
        }
      },
    });
    new Gauge({
      name: "fdfs_job_consecutive_failures",
      help: "Failed ticks in a row per background job (0 when healthy)",
      labelNames: ["job"],
      registers,
      collect() {
        for (const j of live.sources().jobs?.() ?? []) {
          this.set({ job: j.name }, j.consecutiveFailures);
        }
      },
    });
  }

  bind(sources: MetricSources): void {
    this.sources = { ...this.sources, ...sources };
  }

  /** One response of POST /shows/:id/reserve. `state` is set when a reservation was created. */
  reserveResponse(outcome: string, seconds: number, state?: ReserveState): void {
    this.reserveResponses.inc({ outcome });
    this.reserveDuration.observe({ outcome }, seconds);
    this.totals.reserve[outcome] = (this.totals.reserve[outcome] ?? 0) + 1;
    this.series.reserve(outcome, seconds * 1000);
    const reason = DECLINE_REASON[outcome];
    if (reason) this.reservationsDeclined.inc({ reason });
    if (outcome === "created" && state === "confirmed") this.confirmed();
    if (outcome === "created" && state === "held") {
      this.reservationsHeld.inc();
      this.totals.held++;
      this.series.add("held");
    }
  }

  /** A confirm/cancel call's outcome; only real transitions (changed) count. */
  lifecycle(o: LifecycleOutcome): void {
    if (!("changed" in o) || !o.changed) return;
    if (o.outcome === "confirmed") this.confirmed();
    if (o.outcome === "cancelled") {
      this.reservationsCancelled.inc();
      this.totals.cancelled++;
      this.series.add("cancelled");
    }
  }

  private confirmed(): void {
    this.reservationsConfirmed.inc();
    this.totals.confirmed++;
    this.series.add("confirmed");
  }

  http(route: string, status: number, seconds: number): void {
    const cls = statusClass(status);
    this.httpResponses.inc({ route, status_class: cls });
    this.httpDuration.observe({ route }, seconds);
    this.totals.http[cls]++;
    this.series.http(cls);
  }

  spoof(): void {
    this.spoofIgnored.inc();
    this.totals.spoofIgnored++;
  }

  dbRetry(sqlstate: string): void {
    this.dbRetries.inc({ sqlstate });
    this.totals.dbRetries++;
  }

  shed(): void {
    this.shedTotal.inc();
    this.totals.shed++;
  }

  sweep(seatsReleased: number, holdsExpired: number): void {
    if (seatsReleased > 0) {
      this.seatsReleased.inc(seatsReleased);
      this.totals.seatsReleased += seatsReleased;
    }
    if (holdsExpired > 0) {
      this.holdsExpired.inc(holdsExpired);
      this.totals.holdsExpired += holdsExpired;
      this.series.add("expired", holdsExpired);
    }
  }

  audit(report: AuditReport): void {
    this.auditsTotal.inc({ result: report.ok ? "ok" : "violation" });
    this.totals.audits++;
    if (report.violations.length > 0) {
      this.invariantViolations.inc(report.violations.length);
      this.totals.invariantViolations += report.violations.length;
    }
  }

  /**
   * Wraps a request-path DB call to count it while it runs. The count follows the work itself,
   * not the request's deadline: an abandoned call still holds (or waits for) a connection.
   */
  trackDb<T>(work: Promise<T>): Promise<T> {
    this.dbInFlight++;
    this.series.dbInFlight(this.dbInFlight);
    const done = () => {
      this.dbInFlight--;
    };
    work.then(done, done);
    return work;
  }

  gauges(): Gauges {
    const mem = process.memoryUsage();
    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    // The monitor reports whole timer intervals, so an idle loop reads ~LOOP_RESOLUTION_MS;
    // subtract it to report the lag itself. No samples since the last reset reads as NaN (or a
    // huge sentinel): report 0.
    const lagNs = this.loop.percentile(99);
    const loopMs =
      Number.isFinite(lagNs) && lagNs < 6e10
        ? Math.max(0, Math.round((lagNs / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10)
        : 0;
    return {
      admission: this.sources.admission?.().inFlight ?? 0,
      db: this.dbInFlight,
      streams: this.sources.streams?.().clients ?? 0,
      loopMs,
      rssMb: mb(mem.rss),
      heapMb: mb(mem.heapUsed),
    };
  }

  /** Closes the current second (called once a second by the ops hub). */
  tick(now = Date.now()): Point {
    const point = this.series.roll(now, this.gauges());
    this.loop.reset();
    return point;
  }

  async exposition(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  close(): void {
    this.loop.disable();
  }
}
