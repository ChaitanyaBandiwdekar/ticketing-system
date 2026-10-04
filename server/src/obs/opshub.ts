/**
 * The War Room's data plane. Once a second it closes the metrics' open second into a point,
 * rebuilds the summary, and pushes one `tick` frame (point + summary + new log lines) to every
 * open GET /ops/stream. One timer and one summary per second however many dashboards are open,
 * so watching the War Room never adds per-viewer work on the hot path.
 *
 * Frames (SSE, JSON data):
 *   hello  {summary, points[], logs[], latest_seq}  on connect: the last 10 minutes and log lines
 *   tick   {point, summary, logs[], logs_skipped}    every second; logs are the lines since the
 *          previous tick (at most LOGS_PER_TICK; the rest are counted, not sent; /ops/logs pages)
 */
import type { ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { AuditReport } from "../engine/types";
import type { LogBuffer, LogEntry } from "./logbuffer";
import type { Metrics } from "./metrics";
import type { Point } from "./timeseries";
import type { AuditSummary, HelloFrame, Summary, TickFrame } from "./types";

const TICK_MS = 1_000;
const HELLO_WINDOW_MS = 10 * 60_000;
const HELLO_LOGS = 200;
const LOGS_PER_TICK = 300;
const MAX_BUFFERED = 1024 * 1024;

export type OpsSources = {
  audits?: () => Iterable<{ report: AuditReport; at: Date }>;
  jobs?: () => Iterable<{
    name: string;
    ticks: number;
    lastSuccessAt: number | null;
    consecutiveFailures: number;
    lastError: string | null;
  }>;
  streams?: () => { clients: number; channels: number };
  ready?: () => boolean | null;
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class OpsHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly timer: NodeJS.Timeout;
  private readonly startedAt = Date.now();
  private sources: OpsSources = {};
  private lastSeq: number;
  private summaryCache: Summary;
  private closed = false;

  constructor(
    private readonly metrics: Metrics,
    private readonly logs: LogBuffer,
    private readonly limits: Summary["limits"],
    private readonly maxClients = 50,
  ) {
    this.lastSeq = logs.latestSeq();
    this.summaryCache = this.buildSummary();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  bind(sources: OpsSources): void {
    this.sources = { ...this.sources, ...sources };
  }

  summary(): Summary {
    return this.summaryCache;
  }

  /** Whether another dashboard stream may open. */
  admit(): "ok" | "full" | "closed" {
    if (this.closed) return "closed";
    return this.clients.size >= this.maxClients ? "full" : "ok";
  }

  /** Takes over an already-opened SSE response: sends `hello`, then a `tick` every second. */
  attach(res: ServerResponse): void {
    this.clients.add(res);
    res.once("close", () => this.clients.delete(res));
    res.write("retry: 2000\n\n");
    this.send(
      res,
      frame("hello", {
        summary: this.summaryCache,
        points: this.metrics.series.since(Date.now() - HELLO_WINDOW_MS),
        logs: this.logs.query({ limit: HELLO_LOGS }),
        latest_seq: this.logs.latestSeq(),
      } satisfies HelloFrame),
    );
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** One second: close the point, rebuild the summary, fan out. Public for tests. */
  tick(now = Date.now()): { point: Point; logs: LogEntry[]; skipped: number } {
    const point = this.metrics.tick(now);
    this.summaryCache = this.buildSummary(now, point.gauges);
    const latest = this.logs.latestSeq();
    const logs = this.logs.query({ after: this.lastSeq, limit: LOGS_PER_TICK });
    const skipped = latest - this.lastSeq - logs.length;
    this.lastSeq = latest;
    if (this.clients.size > 0) {
      const data = frame("tick", {
        point,
        summary: this.summaryCache,
        logs,
        logs_skipped: Math.max(0, skipped),
      } satisfies TickFrame);
      for (const res of this.clients) this.send(res, data);
    }
    return { point, logs, skipped };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private send(res: ServerResponse, data: string): void {
    if (res.destroyed || res.writableEnded) return;
    res.write(data);
    // A dashboard that stopped reading is dropped rather than buffered without bound.
    if (res.writableLength > MAX_BUFFERED) res.destroy();
  }

  private buildSummary(now = Date.now(), gauges = this.metrics.gauges()): Summary {
    const audits: AuditSummary[] = [...(this.sources.audits?.() ?? [])]
      .map(({ report, at }) => ({
        show_id: report.show_id,
        ok: report.ok,
        counts: report.counts,
        violations: report.violations.length,
        at: at.toISOString(),
      }))
      .sort((a, b) => b.at.localeCompare(a.at));
    const totals = this.metrics.totals;
    return {
      now: new Date(now).toISOString(),
      started_at: new Date(this.startedAt).toISOString(),
      uptime_s: Math.round((now - this.startedAt) / 1000),
      instance: process.env.RENDER_INSTANCE_ID ?? hostname(),
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      ready: this.sources.ready?.() ?? null,
      limits: this.limits,
      totals,
      latency_60s: this.metrics.series.windowLatency(),
      gauges,
      audits,
      invariant_ok: totals.invariantViolations === 0 && audits.every((a) => a.ok),
      jobs: [...(this.sources.jobs?.() ?? [])].map((j) => ({
        name: j.name,
        ticks: j.ticks,
        last_success_at: j.lastSuccessAt === null ? null : new Date(j.lastSuccessAt).toISOString(),
        consecutive_failures: j.consecutiveFailures,
        last_error: j.lastError,
      })),
      streams: this.sources.streams?.() ?? { clients: 0, channels: 0 },
    };
  }
}
