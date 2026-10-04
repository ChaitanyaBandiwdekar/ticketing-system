/**
 * The Stampede simulator: the burst (scripts/burst/core.ts, the same engine as
 * `npm run burst`) fired from this browser, with the hall it is aimed at filling live beside it.
 *
 * Set the crowd, the hot-seat storm, the share of same-key retries and spoofed requests, and
 * how many users try to go over the limit; fire; watch. It ends with the outcome distribution
 * and every check the CLI runs: no 5xx, nothing sold twice, nobody over the limit, every
 * snapshot balanced, the audit, and /metrics agreeing with what the browser saw.
 */
import { useEffect, useMemo, useRef, useState, type SubmitEvent } from "react";
import { Link } from "react-router";
import {
  DEFAULTS,
  exactSeatsNeeded,
  plannedRequests,
  runBurst,
  type BurstOptions,
  type BurstReport,
  type Progress,
} from "../../../scripts/burst/core";
import { Occupancy } from "../components/Occupancy";
import {
  Button,
  Field,
  Input,
  Notice,
  Pill,
  Segmented,
  Skeleton,
  Switch,
  cx,
} from "../components/ui";
import { HallCanvas, HallLegend, Screen } from "../hall/HallCanvas";
import { hallGeometry } from "../hall/geometry";
import { useLiveShow } from "../hall/useLiveShow";
import { num } from "../lib/format";
import { useShow } from "../lib/queries";
import { useSession } from "../lib/session";
import { OUTCOMES, outcomeSeries } from "../warroom/outcomes";

// ---------------------------------------------------------------------------------------------
// Settings → burst options

type Hall = "small" | "medium" | "large";
const HALLS: Record<Hall, { rows: number; seatsPerRow: number; label: string }> = {
  small: { rows: 12, seatsPerRow: 24, label: "Small · 288" },
  medium: { rows: 24, seatsPerRow: 40, label: "Medium · 960" },
  large: { rows: 40, seatsPerRow: 50, label: "Large · 2,000" },
};

type Settings = {
  hall: Hall;
  users: number;
  requests: number;
  hotUsers: number;
  retryPct: number;
  spoofPct: number;
  overLimitUsers: number;
  edgeCases: boolean;
  concurrency: number;
  metrics: boolean;
};

const INITIAL: Settings = {
  hall: "medium",
  users: 800,
  requests: 3_000,
  hotUsers: 200,
  retryPct: 5,
  spoofPct: 1,
  overLimitUsers: 10,
  edgeCases: true,
  concurrency: 48,
  metrics: true,
};

const LIMITS = {
  users: [1, 10_000],
  requests: [0, 20_000],
  hotUsers: [0, 2_000],
  retryPct: [0, 50],
  spoofPct: [0, 20],
  overLimitUsers: [0, 50],
  concurrency: [1, 256],
} as const;

function toOptions(s: Settings, adminKey: string): Omit<BurstOptions, "signal"> {
  const hall = HALLS[s.hall];
  const copies = DEFAULTS.retryCopies;
  const edge = s.edgeCases ? 10 : 0;
  return {
    ...DEFAULTS,
    base: "",
    adminKey,
    rows: hall.rows,
    seatsPerRow: hall.seatsPerRow,
    users: s.users,
    requests: s.requests,
    hotUsers: s.hotUsers,
    retryGroups: Math.round((s.requests * s.retryPct) / 100 / copies),
    spoofs: Math.round((s.requests * s.spoofPct) / 100),
    limitUsers: s.overLimitUsers,
    keyReuseGroups: edge,
    crossedPairs: edge,
    foreignCancels: edge,
    concurrency: s.concurrency,
    metrics: s.metrics,
    pollMs: 500,
    showName: `Stampede ${new Date().toLocaleTimeString(undefined, { hour12: false })}`,
  };
}

function problems(s: Settings, adminKey: string): Partial<Record<keyof Settings | "key", string>> {
  const e: Partial<Record<keyof Settings | "key", string>> = {};
  if (!adminKey.trim()) e.key = "The admin key is required: the simulator creates a show.";
  for (const [k, [min, max]] of Object.entries(LIMITS) as [
    keyof typeof LIMITS,
    readonly [number, number],
  ][]) {
    const v = s[k];
    if (!Number.isInteger(v) || v < min || v > max) e[k] = `Between ${num(min)} and ${num(max)}.`;
  }
  if (!e.users && !e.requests && s.requests > 0 && s.users < 1) e.users = "At least one user.";
  const hall = HALLS[s.hall];
  const opts = toOptions(s, "x");
  if (exactSeatsNeeded(opts) >= hall.rows * hall.seatsPerRow - DEFAULTS.hotSeats) {
    e.overLimitUsers = "The hall is too small for these scenarios; pick a bigger hall.";
  }
  return e;
}

// ---------------------------------------------------------------------------------------------
// The run

type ShowRef = { id: string; name: string; total_seats: number };
type Run =
  | { phase: "idle" }
  | { phase: "running"; status: string; show: ShowRef | null; progress: Progress | null }
  | { phase: "done"; show: ShowRef; report: BurstReport }
  | { phase: "stopped" | "failed"; show: ShowRef | null; error: string };

function useStampede() {
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const fire = (opts: Omit<BurstOptions, "signal">) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    let show: ShowRef | null = null;
    setRun({ phase: "running", status: "Starting…", show: null, progress: null });
    const update = (patch: Partial<Extract<Run, { phase: "running" }>>) =>
      setRun((r) => (r.phase === "running" && ctrl.current === c ? { ...r, ...patch } : r));
    runBurst({
      ...opts,
      signal: c.signal,
      onStatus: (status) => update({ status }),
      onShow: (s) => {
        show = s;
        update({ show: s });
      },
      onProgress: (progress) => update({ progress }),
    })
      .then((report) => {
        if (ctrl.current === c) setRun({ phase: "done", show: report.show, report });
      })
      .catch((err: unknown) => {
        if (ctrl.current !== c) return;
        const stopped = c.signal.aborted;
        setRun({
          phase: stopped ? "stopped" : "failed",
          show,
          error: stopped ? "Stopped before the end." : (err as Error).message,
        });
      });
  };
  const stop = () => ctrl.current?.abort();
  return { run, fire, stop };
}

// ---------------------------------------------------------------------------------------------
// Pieces

function NumberField({
  label,
  hint,
  value,
  onChange,
  error,
  suffix,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  error?: string;
  suffix?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          aria-describedby={describedBy}
          invalid={invalid}
          suffix={suffix}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
        />
      )}
    </Field>
  );
}

/** The hall the burst is aimed at, live over the seat-map stream. */
function LiveHall({ show }: { show: ShowRef }) {
  const [streamUp, setStreamUp] = useState(false);
  const query = useShow(show.id, { poll: !streamUp });
  const data = query.data;
  const geometry = useMemo(
    () =>
      data
        ? hallGeometry(
            data.seats.map((s) => s.label),
            data.layout,
          )
        : null,
    [data],
  );
  const live = useLiveShow(show.id, data, geometry, {
    onLink: (link) => setStreamUp(link === "live"),
  });
  const paint = useMemo(
    () => ({ status: live.status ?? "", flashes: live.flashes }),
    [live.status, live.flashes],
  );
  const counts = live.counts ?? data?.counts;

  return (
    <section aria-label="Live hall" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{show.name}</h2>
        <Link to={`/shows/${show.id}`} className="text-xs text-primary-ink hover:underline">
          Open the show
        </Link>
      </div>
      <div className="rounded-lg border border-line bg-surface/40 px-2 py-5 sm:px-5">
        <Screen />
        {geometry && live.status ? (
          <HallCanvas
            geometry={geometry}
            paint={paint}
            maxPitch={20}
            minPitch={4}
            label={`Seat map: ${num(counts?.available ?? 0)} of ${num(show.total_seats)} seats available`}
          />
        ) : (
          <Skeleton className="mt-4 h-56 w-full" />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {counts && <Occupancy counts={counts} compact />}
        <HallLegend />
      </div>
    </section>
  );
}

/** Outcomes as one proportional bar plus exact counts, in the War Room's colors. */
function OutcomeBar({ outcomes }: { outcomes: Record<string, number> }) {
  const grouped = new Map<string, number>();
  for (const [o, n] of Object.entries(outcomes)) {
    const key = outcomeSeries(o).key;
    grouped.set(key, (grouped.get(key) ?? 0) + n);
  }
  const total = [...grouped.values()].reduce((a, b) => a + b, 0);
  const rows = OUTCOMES.filter((s) => grouped.get(s.key));
  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-surface-3"
        role="img"
        aria-label={rows.map((s) => `${s.label} ${grouped.get(s.key)}`).join(", ")}
      >
        {rows.map((s) => (
          <span
            key={s.key}
            className="h-full"
            style={{ width: `${((grouped.get(s.key) ?? 0) / total) * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <ul className="tabular flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {rows.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
            <span className="font-semibold text-ink">{num(grouped.get(s.key) ?? 0)}</span>
            {s.label}
          </li>
        ))}
        {total === 0 && <li className="text-muted">No responses yet.</li>}
      </ul>
    </div>
  );
}

function ProgressPanel({ run }: { run: Extract<Run, { phase: "running" }> }) {
  const p = run.progress;
  const pct = p ? Math.min(100, (p.done / Math.max(1, p.planned)) * 100) : 0;
  const rate = p && p.elapsedMs > 0 ? (p.done / p.elapsedMs) * 1000 : 0;
  return (
    <section
      aria-label="Progress"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-ink" role="status">
          {run.status}
        </p>
        {p && (
          <p className="tabular text-xs text-muted">
            {num(p.done)} of {num(p.planned)} · {Math.round(rate)} req/s · {p.inFlight} in flight ·{" "}
            {(p.elapsedMs / 1000).toFixed(0)}s
          </p>
        )}
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Requests answered"
      >
        <span
          className="block h-full bg-primary transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      {p && <OutcomeBar outcomes={p.outcomes} />}
      {p && (
        <p className="text-xs text-muted">
          {p.polls} seat-map snapshots checked during the burst
          {p.pollViolations > 0 ? (
            <span className="text-danger"> · {p.pollViolations} unbalanced</span>
          ) : (
            ", every one balanced"
          )}
          .
        </p>
      )}
    </section>
  );
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);

function ReportSummary({ report }: { report: BurstReport }) {
  const f = report.final;
  return (
    <section aria-label="Verdict" className="flex flex-col gap-4">
      <Notice
        tone={report.ok ? "success" : "danger"}
        title={report.ok ? "Every guarantee held." : "A guarantee broke. See the failed checks."}
      >
        {num(report.reserveRequests)} reserve requests in {(report.durationMs / 1000).toFixed(1)}s (
        {Math.round(report.throughput)} req/s)
        {report.latency &&
          ` · p50 ${ms(report.latency.p50)} · p95 ${ms(report.latency.p95)} · p99 ${ms(report.latency.p99)}`}
        {f && ` · ${num(f.confirmed)} of ${num(f.total)} seats sold`}
      </Notice>
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Outcomes</h2>
        <OutcomeBar outcomes={report.outcomes} />
        <p className="text-xs text-muted">
          {num(report.status["429"])} shed with 429 and retried · {num(report.status["5xx"])} 5xx ·{" "}
          {num(report.status.network)} network errors
        </p>
      </div>
    </section>
  );
}

function ReportChecks({ report }: { report: BurstReport }) {
  return (
    <section
      aria-label="Checks"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
    >
      <h2 className="text-sm font-semibold text-ink">
        Checks{" "}
        <span className="font-normal text-muted">
          · {report.checks.filter((c) => c.ok).length} of {report.checks.length} passed
        </span>
      </h2>
      <ul className="flex flex-col divide-y divide-line">
        {report.checks.map((c) => (
          <li key={c.name} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-3">
            <span className="flex w-full shrink-0 items-center gap-2 sm:w-72">
              {c.ok ? <Pill tone="success">Pass</Pill> : <Pill tone="danger">Fail</Pill>}
              <span className="text-[0.8125rem] font-medium text-ink">{c.name}</span>
            </span>
            <span className="min-w-0 text-xs text-pretty break-words text-muted sm:pt-1">
              {c.detail}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export function StampedePage() {
  const { adminKey, setAdminKey } = useSession();
  const [key, setKey] = useState(adminKey ?? "");
  const [s, setS] = useState<Settings>(INITIAL);
  const [touched, setTouched] = useState(false);
  const { run, fire, stop } = useStampede();
  const set =
    <K extends keyof Settings>(k: K) =>
    (v: Settings[K]) =>
      setS((p) => ({ ...p, [k]: v }));

  const errors = touched ? problems(s, key) : {};
  const running = run.phase === "running";
  const planned = useMemo(() => {
    try {
      return plannedRequests(toOptions(s, "x") as BurstOptions);
    } catch {
      return 0;
    }
  }, [s]);

  // A rejected key comes back as the failure "could not create the show: HTTP 401/403".
  const keyRejected = run.phase === "failed" && /HTTP 40[13]/.test(run.error) && run.show === null;
  useEffect(() => {
    if (keyRejected) setAdminKey(null);
  }, [keyRejected, setAdminKey]);

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(problems(s, key)).length) return;
    setAdminKey(key.trim());
    fire(toOptions(s, key.trim()));
  };

  const show = run.phase === "idle" ? null : run.show;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-1.5">
        <h1 className="text-2xl font-semibold">Stampede simulator</h1>
        <p className="text-pretty text-ink-2">
          Release night from this browser: a fresh show, a crowd that storms it, and every guarantee
          checked from the outside while the hall fills. It runs the same scenarios as{" "}
          <code className="font-mono text-[0.8125rem] text-ink">npm run burst</code>. The{" "}
          <Link to="/war-room" className="text-primary-ink hover:underline">
            War Room
          </Link>{" "}
          shows the server's side.
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
          aria-label="Stampede settings"
        >
          <Field
            label="Admin key"
            hint="Creating the show needs it. Kept for this tab only."
            error={errors.key ?? (keyRejected ? "That admin key isn't valid." : undefined)}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                aria-describedby={describedBy}
                invalid={invalid}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            )}
          </Field>

          <Segmented
            label="Hall"
            value={s.hall}
            onChange={set("hall")}
            options={(Object.keys(HALLS) as Hall[]).map((h) => ({
              value: h,
              label: HALLS[h].label,
            }))}
          />

          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Crowd"
              suffix="users"
              value={s.users}
              onChange={set("users")}
              error={errors.users}
            />
            <NumberField
              label="Requests"
              value={s.requests}
              onChange={set("requests")}
              error={errors.requests}
            />
            <NumberField
              label="Hot-seat storm"
              hint="On A12 and 5 more"
              suffix="users"
              value={s.hotUsers}
              onChange={set("hotUsers")}
              error={errors.hotUsers}
            />
            <NumberField
              label="Over-limit users"
              hint={`${DEFAULTS.limitParallel} at once, limit ${DEFAULTS.perUserLimit}`}
              value={s.overLimitUsers}
              onChange={set("overLimitUsers")}
              error={errors.overLimitUsers}
            />
            <NumberField
              label="Same-key retries"
              hint={`${DEFAULTS.retryCopies} copies each`}
              suffix="%"
              value={s.retryPct}
              onChange={set("retryPct")}
              error={errors.retryPct}
            />
            <NumberField
              label="Spoofed user_id"
              suffix="%"
              value={s.spoofPct}
              onChange={set("spoofPct")}
              error={errors.spoofPct}
            />
            <NumberField
              label="In flight"
              hint="Requests at once"
              value={s.concurrency}
              onChange={set("concurrency")}
              error={errors.concurrency}
            />
          </div>

          <Switch
            checked={s.edgeCases}
            onChange={set("edgeCases")}
            label="Edge cases"
            hint="Crossed seat pairs, a reused key, cancelling someone else's booking."
          />
          <Switch
            checked={s.metrics}
            onChange={set("metrics")}
            label="Compare with /metrics"
            hint="Turn off if someone else is booking on this instance right now."
          />

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="tabular text-xs text-muted">{num(planned)} requests planned</p>
            {running ? (
              <Button type="button" variant="danger" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary">
                {run.phase === "idle" ? "Open the box office" : "Run again"}
              </Button>
            )}
          </div>
        </form>

        <div className="flex min-w-0 flex-col gap-6">
          {run.phase === "idle" && (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line-strong p-6">
              <p className="font-medium text-ink">The hall appears here.</p>
              <p className="text-[0.8125rem] text-pretty text-muted">
                Each run creates a new ephemeral show (deleted after 24h) and mints tokens for the
                crowd. Seats flip as the stream reports them; the verdict follows once the last
                request is answered and the books are audited.
              </p>
            </div>
          )}
          {run.phase === "running" && <ProgressPanel run={run} />}
          {(run.phase === "failed" || run.phase === "stopped") && (
            <Notice
              tone={run.phase === "failed" ? "danger" : "amber"}
              title={run.phase === "failed" ? "The run could not finish" : "Stopped"}
            >
              {run.error}
            </Notice>
          )}
          {run.phase === "done" && <ReportSummary report={run.report} />}
          {show && <LiveHall key={show.id} show={show} />}
          {run.phase === "done" && <ReportChecks report={run.report} />}
          {!show && running && <Skeleton className={cx("h-72 w-full")} />}
        </div>
      </div>
    </div>
  );
}
