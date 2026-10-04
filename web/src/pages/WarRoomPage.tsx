/**
 * The War Room: is the system correct and how did it hold up, readable in one look.
 *
 * Top to bottom it answers: the verdict in one line (books balanced, server errors, the last
 * burst); the last burst's scorecard (stored, so it survives the live window and restarts); what
 * this instance is doing right now (requests per second split into booked / declined correctly /
 * failed, and latency); the reconciler's books per show; and, folded away, the internals an
 * operator digs into (DB pool, event loop, memory, background jobs, the log tail).
 *
 * The live parts come from one SSE feed (GET /ops/stream): a point per second, the summary, and
 * the log lines since the last tick. The scorecard comes from GET /ops/runs.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Pill, Segmented, cx } from "../components/ui";
import { get } from "../lib/api";
import { ago, num } from "../lib/format";
import { useBurstRuns, useShows } from "../lib/queries";
import { GROUPS, groupCounts } from "../warroom/outcomes";
import { mb, ms, perSec, plain, uptime } from "../warroom/fmt";
import { AlertIcon, CheckIcon, CrossIcon } from "../warroom/icons";
import { Meter } from "../warroom/Meter";
import { Scorecard } from "../warroom/Scorecard";
import { ChartTable, Legend, TimeChart, type Row, type Series } from "../warroom/TimeChart";
import {
  useOpsFeed,
  type FeedLink,
  type LogEntry,
  type Point,
  type Summary,
} from "../warroom/useOpsFeed";
import type { BurstRun } from "../../../server/src/obs/types";

// ---------------------------------------------------------------------------------------------
// Series

const LATENCY: Series[] = [
  { key: "p50", label: "p50 (typical)", color: "var(--color-ramp-3)" },
  { key: "p99", label: "p99 (slowest 1%)", color: "var(--color-ramp-1)" },
];
const LATENCY_AGGS = ["mean", "max"] as const;
const MAX_AGG = ["max"] as const;
const ONE = (key: string, label: string): Series[] => [
  { key, label, color: "var(--color-series-1)" },
];

const WINDOWS = { "1": 60_000, "5": 300_000, "10": 600_000 } as const;
type WindowKey = keyof typeof WINDOWS;

const reserves = (p: Point) => Object.values(p.reserve).reduce((a, n) => a + n, 0);

// ---------------------------------------------------------------------------------------------
// Pieces

function Card({
  title,
  hint,
  children,
  className,
  aside,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <section
      className={cx(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4",
        className,
      )}
      aria-label={title}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {hint && <p className="text-xs text-pretty text-muted">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div
      className={cx(
        "flex min-w-0 flex-col gap-1 rounded-md border p-3",
        tone === "danger" ? "border-danger/45 bg-danger-soft" : "border-line bg-bg/40",
      )}
    >
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={cx(
          "flex items-baseline gap-1 text-xl leading-tight font-semibold tracking-[-0.01em]",
          tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-ink",
        )}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-pretty text-muted">{sub}</p>}
    </div>
  );
}

function LinkState({ link, summary }: { link: FeedLink; summary: Summary | null }) {
  const meta = {
    live: { dot: "bg-success", text: "Live" },
    connecting: { dot: "bg-line-strong", text: "Connecting…" },
    reconnecting: { dot: "bg-amber", text: "Reconnecting…" },
  }[link];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" role="status">
      <span className="inline-flex items-center gap-1.5 font-medium text-ink-2">
        <span className={cx("size-1.5 rounded-full", meta.dot)} aria-hidden />
        {meta.text}
      </span>
      {summary && (
        <>
          <span className="font-mono" title="This instance">
            {summary.instance}
          </span>
          <span>up {uptime(summary.uptime_s)}</span>
          {summary.commit && <span className="font-mono">{summary.commit}</span>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The verdict in one line

function Verdict({
  ok,
  pending,
  children,
}: {
  ok: boolean;
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2">
      {pending ? (
        <span aria-hidden className="size-4 shrink-0 rounded-full border-2 border-line-strong" />
      ) : ok ? (
        <CheckIcon className="size-4 text-success" />
      ) : (
        <AlertIcon className="size-4 text-danger" />
      )}
      <span className={cx(ok || pending ? "text-ink-2" : "text-danger")}>{children}</span>
    </li>
  );
}

function VerdictLine({ summary, run }: { summary: Summary | null; run: BurstRun | undefined }) {
  if (!summary) {
    return <div className="h-6 w-full max-w-xl animate-pulse rounded bg-surface" />;
  }
  const t = summary.totals;
  const shows = summary.audits.length;
  const fivexx = t.http["5xx"];
  const checks = run?.report.checks ?? [];
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[0.8125rem]" aria-label="Verdict">
      <Verdict ok={summary.invariant_ok}>
        {summary.invariant_ok
          ? shows
            ? `Books balance on all ${shows} audited show${shows === 1 ? "" : "s"}`
            : "Books balance"
          : `${num(t.invariantViolations)} invariant violation${t.invariantViolations === 1 ? "" : "s"}`}
      </Verdict>
      <Verdict ok={fivexx === 0}>
        {num(fivexx)} server error{fivexx === 1 ? "" : "s"} since this instance started
      </Verdict>
      {run ? (
        <Verdict ok={run.ok}>
          Last burst {run.ok ? "passed" : "failed"} {checks.filter((c) => c.ok).length} of{" "}
          {checks.length} checks, {ago(run.created_at)}
        </Verdict>
      ) : (
        <Verdict ok pending>
          No burst recorded yet
        </Verdict>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Right now: this instance's traffic and latency

function Live({
  points,
  summary,
  now,
  windowKey,
  setWindowKey,
}: {
  points: Point[];
  summary: Summary | null;
  now: number;
  windowKey: WindowKey;
  setWindowKey: (k: WindowKey) => void;
}) {
  const windowMs = WINDOWS[windowKey];
  const inWindow = points.filter((p) => p.t > now - windowMs);
  const active = inWindow.some((p) => reserves(p) > 0);
  const lastActive = [...points].reverse().find((p) => reserves(p) > 0);

  const traffic = useMemo<Row[]>(
    () =>
      points.map((p) => {
        const g = groupCounts(p.reserve);
        return { t: p.t, values: [g.booked, g.declined, g.failed] };
      }),
    [points],
  );
  const latency = useMemo<Row[]>(
    () =>
      points.map((p) => ({
        t: p.t,
        values: p.latency ? [p.latency.p50, p.latency.p99] : [null, null],
      })),
    [points],
  );

  const last10 = points.slice(-10);
  const rate = last10.length ? last10.reduce((a, p) => a + reserves(p), 0) / last10.length : 0;
  const peak = inWindow.reduce((m, p) => Math.max(m, reserves(p)), 0);
  const booked = inWindow.reduce((a, p) => a + (p.reserve.created ?? 0), 0);
  const t = summary?.totals;
  const lat = summary?.latency_60s;
  const fivexx = t?.http["5xx"] ?? 0;
  const label = { "1": "minute", "5": "5 min", "10": "10 min" }[windowKey];

  return (
    <Card
      title="Right now"
      hint="This instance, second by second: every response to POST /shows/:id/reserve. Resets when the instance restarts."
      aside={
        <Segmented
          label="Window"
          hideLabel
          value={windowKey}
          onChange={setWindowKey}
          options={[
            { value: "1", label: "1 min" },
            { value: "5", label: "5 min" },
            { value: "10", label: "10 min" },
          ]}
        />
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Reserve requests"
          value={
            <>
              {perSec(rate)}
              <span className="text-sm font-medium text-muted">/s</span>
            </>
          }
          sub={`peak ${perSec(peak)}/s in the last ${label}`}
        />
        <Tile
          label={`Booked · last ${label}`}
          value={num(booked)}
          sub={`${num(t?.reserve.created ?? 0)} since the instance started`}
        />
        <Tile
          label="Reserve p99 · last 60s"
          value={lat ? ms(lat.p99) : "–"}
          sub={lat ? `p50 ${ms(lat.p50)} · ${num(lat.n)} timed` : "no reserves in the last minute"}
        />
        <Tile
          label="Server errors"
          tone={fivexx > 0 ? "danger" : "neutral"}
          value={
            <>
              {fivexx > 0 && <AlertIcon className="size-5 self-center" />}
              {num(fivexx)}
            </>
          }
          sub={`5xx since start · ${num(t?.shed ?? 0)} shed with 429`}
        />
      </div>

      {!active && points.length > 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-[0.8125rem] text-muted">
          No reservation traffic in the last {label}
          {lastActive && <> (last request {ago(new Date(lastActive.t).toISOString())})</>}. The last
          burst is summarised above; run one and its traffic draws here live.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[0.8125rem] font-medium text-ink">Requests per second</h3>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {GROUPS.map((g) => (
                  <li key={g.key} className="flex items-center gap-1.5 text-xs text-ink-2">
                    <span
                      aria-hidden
                      className="size-2.5 rounded-[2px]"
                      style={{ background: g.color }}
                    />
                    {g.label}
                    <span className="hidden text-muted xl:inline">· {g.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
            <TimeChart
              label={`Reserve requests per second by result, last ${label}`}
              rows={traffic}
              series={GROUPS}
              kind="bars"
              format={perSec}
              now={now}
              windowMs={windowMs}
              height={200}
              minMax={5}
              bucketNote={(n) => `Averaged per second over these ${n} seconds.`}
            />
            <ChartTable rows={traffic} series={GROUPS} format={plain} />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[0.8125rem] font-medium text-ink">Reserve latency</h3>
              <Legend series={LATENCY} kind="lines" />
            </div>
            <TimeChart
              label={`Reserve latency p50 and p99, last ${label}`}
              rows={latency}
              series={LATENCY}
              aggs={[...LATENCY_AGGS]}
              kind="lines"
              format={ms}
              now={now}
              windowMs={windowMs}
              height={140}
              minMax={50}
              bucketNote={(n) => `p50 averaged and p99 the worst second over these ${n} seconds.`}
            />
            <ChartTable rows={latency} series={LATENCY} format={ms} />
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The reconciler's books

function Books({ summary, names }: { summary: Summary | null; names: Map<string, string> }) {
  const audits = summary?.audits ?? [];
  return (
    <Card
      title="Books per show"
      hint="The reconciler re-audits every recently active or watched show from one snapshot, every few seconds: free + held + sold must equal the hall, and no seat may belong to two reservations."
    >
      {audits.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">
          No show changed in the last 10 minutes. Book a seat or run a burst, and it is audited
          within seconds.
        </p>
      ) : (
        <ul className="-mx-1 grid max-h-96 gap-x-8 overflow-auto lg:grid-cols-2">
          {audits.map((a) => {
            const c = a.counts;
            return (
              <li key={a.show_id} className="flex min-w-0 flex-col gap-2 rounded-md px-1 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <Link
                    to={`/shows/${a.show_id}`}
                    className="truncate text-[0.8125rem] font-medium text-ink hover:text-primary-ink"
                  >
                    {names.get(a.show_id) ?? `Show ${a.show_id.slice(0, 8)}`}
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    <time className="text-xs text-muted" dateTime={a.at}>
                      {ago(a.at)}
                    </time>
                    {a.ok ? (
                      <Pill tone="success">
                        <CheckIcon className="size-3.5" />
                        Balanced
                      </Pill>
                    ) : (
                      <Pill tone="danger">
                        <CrossIcon className="size-3.5" />
                        {a.violations} violation{a.violations === 1 ? "" : "s"}
                      </Pill>
                    )}
                  </div>
                </div>
                <Meter
                  label="Seats"
                  height="h-2"
                  total={c.total}
                  segments={[
                    {
                      key: "sold",
                      label: "Sold",
                      value: c.confirmed,
                      color: "var(--color-series-1)",
                    },
                    { key: "held", label: "Held", value: c.held, color: "var(--color-amber)" },
                    {
                      key: "free",
                      label: "Free",
                      value: c.available,
                      color: "var(--color-surface-3)",
                    },
                  ]}
                />
                <span className="tabular text-xs text-muted">
                  {num(c.confirmed)} sold + {num(c.held)} held + {num(c.available)} free ={" "}
                  {num(c.total)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Internals

function Jobs({ summary }: { summary: Summary | null }) {
  const jobs = summary?.jobs ?? [];
  const what: Record<string, string> = {
    sweeper: "Releases lapsed holds",
    reconciler: "Audits the invariant",
    janitor: "Deletes burst shows after 24h, keeps the last 50 runs",
    demo_shows: "Keeps a demo hall open",
  };
  return (
    <Card title="Background jobs" hint="Each one ticks on its own; a failing tick never stops it.">
      <table className="tabular w-full text-left text-[0.8125rem]">
        <thead className="text-xs text-muted">
          <tr>
            <th className="pb-1.5 font-medium">Job</th>
            <th className="pb-1.5 text-right font-medium">Ticks</th>
            <th className="pb-1.5 text-right font-medium">Last success</th>
            <th className="pb-1.5 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {jobs.map((j) => (
            <tr key={j.name}>
              <td className="py-2">
                <span className="font-medium text-ink">{j.name}</span>
                <span className="block text-xs text-muted">{what[j.name]}</span>
              </td>
              <td className="py-2 text-right text-ink-2">{num(j.ticks)}</td>
              <td className="py-2 text-right text-ink-2">
                {j.last_success_at ? ago(j.last_success_at) : "–"}
              </td>
              <td className="py-2 text-right">
                {j.consecutive_failures > 0 ? (
                  <Pill tone="danger" title={j.last_error ?? undefined}>
                    {j.consecutive_failures} failing
                  </Pill>
                ) : j.ticks === 0 ? (
                  <Pill tone="neutral">Waiting</Pill>
                ) : (
                  <Pill tone="success">OK</Pill>
                )}
              </td>
            </tr>
          ))}
          {jobs.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-muted">
                Jobs report once the server has started them.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function Saturation({
  points,
  summary,
  now,
  windowMs,
}: {
  points: Point[];
  summary: Summary | null;
  now: number;
  windowMs: number;
}) {
  const db = useMemo<Row[]>(() => points.map((p) => ({ t: p.t, values: [p.dbPeak] })), [points]);
  const loop = useMemo<Row[]>(
    () => points.map((p) => ({ t: p.t, values: [p.gauges.loopMs] })),
    [points],
  );
  const rss = useMemo<Row[]>(
    () => points.map((p) => ({ t: p.t, values: [p.gauges.rssMb] })),
    [points],
  );
  const pool = summary?.limits.pool_max ?? 0;
  const inWindow = points.filter((p) => p.t > now - windowMs);
  const peak = inWindow.reduce((m, p) => Math.max(m, p.dbPeak), 0);
  const nowDb = points.at(-1)?.gauges.db ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card
        title="DB pool"
        hint={
          pool
            ? `${Math.min(nowDb, pool)} of ${pool} connections busy now · peak ${num(peak)} calls in flight, ${num(Math.max(0, peak - pool))} of them waiting for a connection`
            : "Database calls in flight"
        }
      >
        <TimeChart
          label="Peak database calls in flight, with the pool size"
          rows={db}
          series={ONE("db", "Calls in flight (peak)")}
          aggs={[...MAX_AGG]}
          kind="lines"
          format={plain}
          now={now}
          windowMs={windowMs}
          height={120}
          refLine={pool ? { value: pool, label: `pool ${pool}: above it, calls queue` } : undefined}
          minMax={4}
        />
      </Card>
      <Card title="Event-loop lag" hint="p99 per second. High means the CPU is the bottleneck.">
        <TimeChart
          label="Event-loop lag p99"
          rows={loop}
          series={ONE("loop", "Lag p99")}
          aggs={[...MAX_AGG]}
          kind="lines"
          format={ms}
          now={now}
          windowMs={windowMs}
          height={120}
          minMax={20}
        />
      </Card>
      <Card title="Memory" hint="Resident set size against the free instance's 512 MB.">
        <TimeChart
          label="Resident memory"
          rows={rss}
          series={ONE("rss", "RSS")}
          kind="lines"
          format={mb}
          now={now}
          windowMs={windowMs}
          height={120}
          refLine={{ value: 512, label: "512 MB limit" }}
          minMax={128}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Log tail

type LevelFilter = "all" | "warn" | "error";
const RANK: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

function levelClass(level: string): string {
  if (level === "error" || level === "fatal") return "text-danger";
  if (level === "warn") return "text-amber";
  return "text-muted";
}

/** The fields worth reading at a glance, in reading order. */
function describe(e: LogEntry): string {
  const f = e.fields;
  const parts: string[] = [];
  if (f.method && f.route) parts.push(`${String(f.method)} ${String(f.route)}`);
  if (f.status !== undefined) parts.push(String(f.status));
  if (typeof f.ms === "number") parts.push(`${f.ms}ms`);
  for (const k of ["outcome", "state", "path", "code", "user", "seats", "job", "frames"]) {
    if (f[k] !== undefined) {
      parts.push(`${k}=${Array.isArray(f[k]) ? (f[k] as unknown[]).join(",") : String(f[k])}`);
    }
  }
  if (f.spoof_ignored) parts.push("spoof_ignored");
  if (f.claimed_user) parts.push(`claimed_user=${String(f.claimed_user)}`);
  const err = f.err as { message?: string } | undefined;
  if (err?.message) parts.push(`err="${err.message}"`);
  return parts.join("  ");
}

/** A request to follow, from outside the tail (the scorecard's slowest requests). */
type Follow = { id: string; n: number };

function LogTail({
  logs,
  skipped,
  follow,
}: {
  logs: LogEntry[];
  skipped: number;
  follow: Follow | null;
}) {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [paused, setPaused] = useState<LogEntry[] | null>(null);
  const [history, setHistory] = useState<LogEntry[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const source = paused ?? logs;

  const followId = (id: string) => {
    // Keep what this page already holds for the request: under load the server's ring may have
    // moved past it by the time the fetch lands.
    setHistory(source.filter((l) => l.request_id === id));
    setRequestId(id);
  };

  // A request asked for from outside (by its counter): adopt it while rendering, then bring the
  // tail into view.
  const [followed, setFollowed] = useState(0);
  if (follow && follow.n !== followed) {
    setFollowed(follow.n);
    followId(follow.id);
  }
  useEffect(() => {
    if (follow) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [follow]);

  // A request's full trail: its older lines may predate this page, so fetch them once.
  useEffect(() => {
    if (!requestId) return;
    const ctrl = new AbortController();
    get<{ lines: LogEntry[] }>(`/ops/logs?limit=500&request_id=${encodeURIComponent(requestId)}`, {
      signal: ctrl.signal,
    })
      .then((r) => setHistory((held) => [...held, ...r.lines]))
      .catch(() => {});
    return () => ctrl.abort();
  }, [requestId]);

  const shown = useMemo(() => {
    let rows = source;
    if (requestId) {
      const seen = new Set<number>();
      rows = [...history, ...source]
        .filter((e) => e.request_id === requestId && !seen.has(e.seq) && seen.add(e.seq))
        .sort((a, b) => a.seq - b.seq);
    }
    if (level !== "all") rows = rows.filter((e) => (RANK[e.level] ?? 0) >= RANK[level]!);
    return rows.slice(-400);
  }, [source, history, requestId, level]);

  // Follow the tail unless the reader scrolled up to look at something.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div ref={cardRef} className="scroll-mt-20">
      <Card
        title="Log tail"
        hint="The server's own JSON lines, redacted. Click a request id to follow one request."
        aside={
          <div className="flex flex-wrap items-center gap-2">
            {requestId && (
              <button
                type="button"
                onClick={() => {
                  setRequestId(null);
                  setHistory([]);
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-primary-soft px-2.5 font-mono text-xs text-primary-ink transition-colors hover:bg-primary/25"
                aria-label={`Clear the request filter ${requestId}`}
              >
                {requestId.length > 18
                  ? `${requestId.slice(0, 8)}…${requestId.slice(-6)}`
                  : requestId}
                <span aria-hidden>×</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setPaused((p) => (p ? null : logs))}
              className="h-7 rounded-md border border-line-strong bg-surface-2 px-2.5 text-xs font-medium text-ink transition-colors hover:bg-surface-3"
              aria-pressed={paused !== null}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Segmented
            label="Level"
            value={level}
            onChange={setLevel}
            options={[
              { value: "all", label: "All" },
              { value: "warn", label: "Warnings+" },
              { value: "error", label: "Errors" },
            ]}
          />
          {skipped > 0 && (
            <p className="text-xs text-muted">
              {num(skipped)} lines too fast to stream; filter by request to see them all.
            </p>
          )}
        </div>
        <div
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="h-80 overflow-auto rounded-md border border-line bg-bg font-mono text-[0.75rem] leading-relaxed"
          role="log"
          aria-live="off"
          tabIndex={0}
          aria-label="Server log lines"
        >
          {shown.length === 0 ? (
            <p className="p-3 font-sans text-[0.8125rem] text-muted">
              {requestId
                ? "No lines for this request in the buffer (it holds the most recent lines of this instance)."
                : "Quiet. Lines appear here as requests arrive."}
            </p>
          ) : (
            <ol className="min-w-max py-1">
              {shown.map((e) => (
                <li key={e.seq} className="flex gap-3 px-3 py-0.5 hover:bg-surface">
                  <time className="shrink-0 text-muted" dateTime={e.time}>
                    {timeFmt.format(new Date(e.time))}
                  </time>
                  <span className={cx("w-10 shrink-0 uppercase", levelClass(e.level))}>
                    {e.level}
                  </span>
                  <span className="w-[8ch] shrink-0">
                    {e.request_id && (
                      <button
                        type="button"
                        onClick={() => followId(e.request_id!)}
                        className="max-w-full truncate rounded-sm text-primary-ink underline-offset-2 hover:underline"
                        title={`Show only request ${e.request_id}`}
                      >
                        {e.request_id.slice(0, 8)}
                      </button>
                    )}
                  </span>
                  <span className="shrink-0 text-ink">{e.msg}</span>
                  <span className="whitespace-pre text-ink-2">{describe(e)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function WarRoomPage() {
  const { link, summary, points, logs, logsSkipped } = useOpsFeed();
  const runs = useBurstRuns();
  const shows = useShows();
  const names = useMemo(() => new Map((shows.data ?? []).map((s) => [s.id, s.name])), [shows.data]);
  const liveShows = useMemo(() => new Set(names.keys()), [names]);
  const [windowKey, setWindowKey] = useState<WindowKey>("10");
  const [internals, setInternals] = useState(false);
  const [follow, setFollow] = useState<Follow | null>(null);
  // The chart window ends at the latest point (server time), so clock skew never shifts it.
  const now = points.at(-1)?.t ?? 0;

  // A burst finishing on this instance: pick up its stored report soon after the traffic stops.
  const refetchRuns = runs.refetch;
  const active = points.length > 0 && reserves(points.at(-1)!) > 0;
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    const id = setTimeout(() => void refetchRuns(), 4_000);
    return () => clearTimeout(id);
  }, [active, refetchRuns]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-2xl flex-col gap-1.5">
            <h1 className="text-2xl font-semibold">War Room</h1>
            <p className="text-ink-2">
              Is the box office correct, and how did it hold up under the stampede? The same live
              numbers are at{" "}
              <a href="/metrics" className="font-mono text-primary-ink hover:underline">
                /metrics
              </a>{" "}
              for Prometheus.
            </p>
          </div>
          <LinkState link={link} summary={summary} />
        </div>
        <VerdictLine summary={summary} run={runs.data?.[0]} />
      </div>

      <Scorecard
        runs={runs.data ?? []}
        loading={runs.isPending}
        liveShows={liveShows}
        onFollow={(id) => {
          setInternals(true);
          setFollow((f) => ({ id, n: (f?.n ?? 0) + 1 }));
        }}
      />

      <Live
        points={points}
        summary={summary}
        now={now}
        windowKey={windowKey}
        setWindowKey={setWindowKey}
      />

      <Books summary={summary} names={names} />

      <details
        open={internals}
        onToggle={(e) => setInternals(e.currentTarget.open)}
        className="group rounded-lg border border-line bg-surface/40"
      >
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
          <span className="text-sm font-semibold text-ink">Internals</span>
          <span className="text-xs text-muted">
            DB pool, event loop, memory, background jobs and the log tail
          </span>
        </summary>
        {internals && (
          <div className="flex flex-col gap-4 border-t border-line p-4">
            <Saturation points={points} summary={summary} now={now} windowMs={WINDOWS[windowKey]} />
            <Jobs summary={summary} />
            <LogTail logs={logs} skipped={logsSkipped} follow={follow} />
          </div>
        )}
      </details>
    </div>
  );
}
