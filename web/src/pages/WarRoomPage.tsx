/**
 * The War Room: what this instance is doing right now, second by second.
 *
 * Everything comes from one SSE feed (GET /ops/stream): a point per second, the summary, and the
 * log lines since the last tick. The page answers, top to bottom: are the books balanced (the
 * reconciler's verdict); how much traffic and what happened to it (outcomes per second); is it
 * fast (latency); is it saturated (DB pool, event loop, memory); and, for any one request, what
 * exactly happened (the log tail, filterable by request id).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Pill, Segmented, cx } from "../components/ui";
import { get } from "../lib/api";
import { ago, num } from "../lib/format";
import { useShows } from "../lib/queries";
import {
  ChartCredit,
  ChartTable,
  Legend,
  TimeChart,
  type Row,
  type Series,
} from "../warroom/TimeChart";
import {
  useOpsFeed,
  type FeedLink,
  type LogEntry,
  type Point,
  type Summary,
} from "../warroom/useOpsFeed";

// ---------------------------------------------------------------------------------------------
// Series

/** Reserve outcomes in a fixed order: color follows the outcome, never its rank. */
const OUTCOMES: (Series & { match: (o: string) => boolean })[] = [
  {
    key: "created",
    label: "Booked",
    color: "var(--color-series-1)",
    match: (o) => o === "created",
  },
  {
    key: "seat_taken",
    label: "Seat taken",
    color: "var(--color-series-2)",
    match: (o) => o === "seat_taken",
  },
  {
    key: "per_user_limit",
    label: "Over limit",
    color: "var(--color-series-3)",
    match: (o) => o === "per_user_limit",
  },
  {
    key: "replayed",
    label: "Replayed",
    color: "var(--color-series-4)",
    match: (o) => o === "replayed",
  },
  {
    key: "idempotency_key_reused",
    label: "Key reused",
    color: "var(--color-series-5)",
    match: (o) => o === "idempotency_key_reused",
  },
  {
    key: "other",
    label: "Other 4xx",
    color: "var(--color-series-6)",
    match: (o) => !isFailure(o) && !KNOWN.has(o),
  },
  { key: "failed", label: "429 / 5xx", color: "var(--color-series-7)", match: isFailure },
];
const KNOWN = new Set([
  "created",
  "seat_taken",
  "per_user_limit",
  "replayed",
  "idempotency_key_reused",
]);
const FAILURES = new Set([
  "overloaded",
  "contention",
  "db_unavailable",
  "internal",
  "shutting_down",
]);
function isFailure(o: string): boolean {
  return FAILURES.has(o) || /^http_(5\d\d|429)$/.test(o);
}

const LATENCY: Series[] = [
  { key: "p50", label: "p50", color: "var(--color-ramp-3)" },
  { key: "p95", label: "p95", color: "var(--color-ramp-2)" },
  { key: "p99", label: "p99", color: "var(--color-ramp-1)" },
];

const ONE = (key: string, label: string): Series[] => [
  { key, label, color: "var(--color-series-1)" },
];

function outcomeRows(points: Point[]): Row[] {
  return points.map((p) => {
    const values = OUTCOMES.map(() => 0);
    for (const [o, n] of Object.entries(p.reserve)) {
      const i = OUTCOMES.findIndex((s) => s.match(o));
      values[i] = (values[i] ?? 0) + n;
    }
    return { t: p.t, values };
  });
}

// ---------------------------------------------------------------------------------------------
// Formatting

const ms = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s` : `${Math.round(v)}ms`;
const perSec = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const mb = (v: number) => `${Math.round(v)} MB`;
const plain = (v: number) => num(Math.round(v));

function uptime(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

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
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {hint && <p className="text-xs text-muted">{hint}</p>}
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
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "neutral" | "success" | "danger";
  icon?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex min-w-0 flex-col gap-1 rounded-lg border p-3.5",
        tone === "success" && "border-success/35 bg-success-soft",
        tone === "danger" && "border-danger/45 bg-danger-soft",
        tone === "neutral" && "border-line bg-surface",
      )}
    >
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={cx(
          "flex items-center gap-1.5 text-[1.375rem] leading-tight font-semibold tracking-[-0.01em]",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
          tone === "neutral" && "text-ink",
        )}
      >
        {icon}
        {value}
      </p>
      {sub && <p className="text-xs text-pretty text-muted">{sub}</p>}
    </div>
  );
}

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" className="size-5" aria-hidden>
    <path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const AlertIcon = () => (
  <svg viewBox="0 0 16 16" className="size-5" aria-hidden>
    <path d="M8 3v6M8 12v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

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
          <span className="font-mono">{summary.instance}</span>
          <span>up {uptime(summary.uptime_s)}</span>
          {summary.commit && <span className="font-mono">{summary.commit}</span>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Headline tiles

function Tiles({ summary, points }: { summary: Summary | null; points: Point[] }) {
  if (!summary) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="h-[5.25rem] animate-pulse rounded-lg border border-line bg-surface"
          />
        ))}
      </div>
    );
  }
  const t = summary.totals;
  const last10 = points.slice(-10);
  const reqs = (p: Point) => Object.values(p.reserve).reduce((a, n) => a + n, 0);
  const rate = last10.length ? last10.reduce((a, p) => a + reqs(p), 0) / last10.length : 0;
  const peak = points.reduce((m, p) => Math.max(m, reqs(p)), 0);
  const lastMinute = points.slice(-60).reduce((a, p) => a + p.confirmed, 0);
  const dbPeak = last10.reduce((m, p) => Math.max(m, p.dbPeak), 0);
  const audited = summary.audits.length;
  const lat = summary.latency_60s;
  const fivexx = t.http["5xx"];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <Tile
        label="Invariant"
        tone={summary.invariant_ok ? "success" : "danger"}
        icon={summary.invariant_ok ? <CheckIcon /> : <AlertIcon />}
        value={
          summary.invariant_ok
            ? "Holds"
            : `${num(t.invariantViolations)} violation${t.invariantViolations === 1 ? "" : "s"}`
        }
        sub={
          audited
            ? `${num(t.audits)} audits · ${audited} show${audited === 1 ? "" : "s"} watched`
            : `${num(t.audits)} audits so far`
        }
      />
      <Tile
        label="Reserve requests"
        value={
          <>
            {perSec(rate)}
            <span className="text-sm font-medium text-muted">/s</span>
          </>
        }
        sub={`peak ${perSec(peak)}/s in 5 min`}
      />
      <Tile
        label="Confirmed"
        value={num(t.confirmed)}
        sub={`+${num(lastMinute)} in the last minute`}
      />
      <Tile
        label="Reserve p99 · 60s"
        value={lat ? ms(lat.p99) : "–"}
        sub={lat ? `p50 ${ms(lat.p50)} · p95 ${ms(lat.p95)}` : "no reserves in the last minute"}
      />
      <Tile
        label="Server errors"
        tone={fivexx > 0 ? "danger" : "neutral"}
        icon={fivexx > 0 ? <AlertIcon /> : undefined}
        value={num(fivexx)}
        sub={`5xx since start · ${num(t.shed)} shed with 429`}
      />
      <Tile
        label="DB pool"
        value={
          <>
            {dbPeak}
            <span className="text-sm font-medium text-muted"> / {summary.limits.pool_max}</span>
          </>
        }
        sub={`peak in flight, 10s · ${summary.gauges.streams} live maps`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Reconciler verdicts and jobs

function Audits({ summary }: { summary: Summary | null }) {
  const shows = useShows(true);
  const names = useMemo(() => new Map((shows.data ?? []).map((s) => [s.id, s.name])), [shows.data]);
  const audits = summary?.audits ?? [];
  return (
    <Card
      title="Reconciler verdicts"
      hint="Every few seconds each recently active or watched show is audited from one snapshot."
    >
      {audits.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">
          No show changed in the last 10 minutes. Book a seat or run a burst, and it is audited
          within seconds.
        </p>
      ) : (
        <ul className="-mx-1 flex max-h-72 flex-col overflow-auto">
          {audits.map((a) => {
            const c = a.counts;
            return (
              <li
                key={a.show_id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md px-1 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <Link
                    to={`/shows/${a.show_id}`}
                    className="truncate text-[0.8125rem] font-medium text-ink hover:text-primary-ink"
                  >
                    {names.get(a.show_id) ?? `Show ${a.show_id.slice(0, 8)}`}
                  </Link>
                  <span className="tabular text-xs text-muted">
                    {num(c.available)} free + {num(c.held)} held + {num(c.confirmed)} sold ={" "}
                    {num(c.total)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <time className="text-xs text-muted" dateTime={a.at}>
                    {ago(a.at)}
                  </time>
                  {a.ok ? (
                    <Pill tone="success">Balanced</Pill>
                  ) : (
                    <Pill tone="danger">
                      {a.violations} violation{a.violations === 1 ? "" : "s"}
                    </Pill>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Jobs({ summary }: { summary: Summary | null }) {
  const jobs = summary?.jobs ?? [];
  const what: Record<string, string> = {
    sweeper: "Releases lapsed holds",
    reconciler: "Audits the invariant",
    janitor: "Deletes burst shows after 24h",
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

function LogTail({ logs, skipped }: { logs: LogEntry[]; skipped: number }) {
  const [level, setLevel] = useState<LevelFilter>("all");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [paused, setPaused] = useState<LogEntry[] | null>(null);
  const [history, setHistory] = useState<LogEntry[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

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

  const source = paused ?? logs;
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
              ? "No lines for this request in the buffer."
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
                      onClick={() => {
                        // Keep what this page already holds for the request: under load the
                        // server's ring may have moved past it by the time the fetch lands.
                        const id = e.request_id!;
                        setHistory(source.filter((l) => l.request_id === id));
                        setRequestId(id);
                      }}
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
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function WarRoomPage() {
  const { link, summary, points, logs, logsSkipped } = useOpsFeed();
  // The chart window ends at the latest point (server time), so clock skew never shifts it.
  const now = points.at(-1)?.t ?? 0;

  const outcomes = useMemo(() => outcomeRows(points), [points]);
  const latency = useMemo<Row[]>(
    () =>
      points.map((p) => ({
        t: p.t,
        values: p.latency ? [p.latency.p50, p.latency.p95, p.latency.p99] : [null, null, null],
      })),
    [points],
  );
  const db = useMemo<Row[]>(() => points.map((p) => ({ t: p.t, values: [p.dbPeak] })), [points]);
  const loop = useMemo<Row[]>(
    () => points.map((p) => ({ t: p.t, values: [p.gauges.loopMs] })),
    [points],
  );
  const rss = useMemo<Row[]>(
    () => points.map((p) => ({ t: p.t, values: [p.gauges.rssMb] })),
    [points],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-2xl flex-col gap-1.5">
          <h1 className="text-2xl font-semibold">War Room</h1>
          <p className="text-ink-2">
            This instance, second by second: whether the books balance, what happened to every
            reservation request, and how close it is to its limits. The same numbers are at{" "}
            <a href="/metrics" className="font-mono text-primary-ink hover:underline">
              /metrics
            </a>{" "}
            for Prometheus.
          </p>
        </div>
        <LinkState link={link} summary={summary} />
      </div>

      <Tiles summary={summary} points={points} />

      <Card
        title="Reserve outcomes per second"
        hint="Every response to POST /shows/:id/reserve. Declines are the system working; only red is a failure."
      >
        <Legend series={OUTCOMES} kind="stacked" />
        <TimeChart
          label="Reserve outcomes per second, last 5 minutes"
          rows={outcomes}
          series={OUTCOMES}
          kind="stacked"
          format={perSec}
          now={now}
          height={220}
          minMax={5}
        />
        <ChartTable rows={outcomes} series={OUTCOMES} format={plain} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Reserve latency" hint="Per second, measured in the server.">
          <Legend series={LATENCY} kind="lines" />
          <TimeChart
            label="Reserve latency p50, p95 and p99 per second, last 5 minutes"
            rows={latency}
            series={LATENCY}
            kind="lines"
            format={ms}
            now={now}
            directLabels
            minMax={50}
          />
          <ChartTable rows={latency} series={LATENCY} format={ms} />
        </Card>
        <Card
          title="DB calls in flight"
          hint="Peak per second. Above the pool size, calls queue for a connection."
        >
          <TimeChart
            label="Peak database calls in flight per second, with the pool size"
            rows={db}
            series={ONE("db", "in flight")}
            kind="lines"
            format={plain}
            now={now}
            refLine={
              summary
                ? { value: summary.limits.pool_max, label: `pool ${summary.limits.pool_max}` }
                : undefined
            }
            minMax={4}
          />
          <ChartTable rows={db} series={ONE("db", "In flight (peak)")} format={plain} />
        </Card>
        <Card title="Event-loop lag" hint="p99 per second. High means the CPU is the bottleneck.">
          <TimeChart
            label="Event-loop lag p99 per second"
            rows={loop}
            series={ONE("loop", "lag p99")}
            kind="lines"
            format={ms}
            now={now}
            height={150}
            minMax={20}
          />
          <ChartTable rows={loop} series={ONE("loop", "Lag p99")} format={ms} />
        </Card>
        <Card title="Memory" hint="Resident set size. The free instance has 512 MB.">
          <TimeChart
            label="Resident memory per second"
            rows={rss}
            series={ONE("rss", "RSS")}
            kind="lines"
            format={mb}
            now={now}
            height={150}
            minMax={128}
          />
          <ChartTable rows={rss} series={ONE("rss", "RSS")} format={mb} />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Audits summary={summary} />
        <Jobs summary={summary} />
      </div>

      <LogTail logs={logs} skipped={logsSkipped} />

      <ChartCredit />
    </div>
  );
}
