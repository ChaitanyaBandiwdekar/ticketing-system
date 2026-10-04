/**
 * The Stampede simulator: the burst (scripts/burst/core.ts, the same engine as
 * `npm run burst`) fired from this browser, with the hall it is aimed at filling live beside it.
 *
 * Set the crowd, the hot-seat storm, the share of same-key retries and spoofed requests, and
 * how many users try to go over the limit; fire; watch. It ends with the outcome distribution
 * and every check the CLI runs: no 5xx, nothing sold twice, nobody over the limit, every
 * snapshot balanced, the audit, and /metrics agreeing with what the browser saw.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";
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
import { Button, Input, Notice, Pill, Segmented, Skeleton, Switch, cx } from "../components/ui";
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

type Preset = { id: string; name: string; blurb: string; settings: Settings };

/** One click to a known scale. "Full" is close to the CLI's run: ~21,600 requests at 2,000 seats. */
const PRESETS: Preset[] = [
  {
    id: "quick",
    name: "Quick check",
    blurb: "Best first run",
    settings: INITIAL,
  },
  {
    id: "full",
    name: "Full release night",
    blurb: "Same scale as npm run burst",
    settings: {
      hall: "large",
      users: 5_000,
      requests: 20_000,
      hotUsers: 500,
      retryPct: 3,
      spoofPct: 1,
      overLimitUsers: 20,
      edgeCases: true,
      concurrency: 256,
      metrics: true,
    },
  },
];

const sameSettings = (a: Settings, b: Settings) =>
  (Object.keys(a) as (keyof Settings)[]).every((k) => a[k] === b[k]);

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

function planned(s: Settings): number {
  try {
    return plannedRequests(toOptions(s, "x") as BurstOptions);
  } catch {
    return 0;
  }
}

const seatsIn = (h: Hall) => HALLS[h].rows * HALLS[h].seatsPerRow;

/** A numbered step of the form: what to do, and why. */
function Step({
  n,
  title,
  hint,
  aside,
  children,
}: {
  n: number;
  title: string;
  hint?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="tabular mt-px grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[0.6875rem] font-semibold text-ink-2"
        >
          {n}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {hint && <p className="text-xs text-pretty text-muted">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Each preset as a card: its name, what it is for, and the scale it sets. */
function PresetPicker({
  value,
  onPick,
  disabled,
}: {
  value: Settings;
  onPick: (s: Settings) => void;
  disabled: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">Scenario preset</legend>
      {PRESETS.map((p) => {
        const on = sameSettings(value, p.settings);
        const ps = p.settings;
        return (
          <label
            key={p.id}
            className={cx(
              "flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 transition-colors duration-150",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary-ink",
              "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
              on
                ? "border-primary bg-primary-soft"
                : "border-line bg-surface-2/50 hover:border-line-strong",
            )}
          >
            <input
              type="radio"
              name={name}
              checked={on}
              onChange={() => onPick(p.settings)}
              className="sr-only"
            />
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cx(
                    "grid size-4 shrink-0 place-items-center rounded-full border",
                    on ? "border-primary-ink" : "border-line-strong",
                  )}
                >
                  {on && <span className="size-2 rounded-full bg-primary-ink" />}
                </span>
                <span className="text-sm font-semibold text-ink">{p.name}</span>
              </span>
              <Pill tone={on ? "primary" : "neutral"} className="tabular">
                {num(planned(ps))} requests
              </Pill>
            </span>
            <span className="tabular pl-6 text-xs text-muted">
              {p.blurb} · {num(seatsIn(ps.hall))} seats · {num(ps.users)} users
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** A labelled number input with its explanation beside it, sized for a narrow column. */
function NumberRow({
  label,
  hint,
  value,
  onChange,
  error,
  suffix,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  error?: string;
  suffix?: string;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-start gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-[0.8125rem] font-medium text-ink">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-xs text-pretty text-muted">
          {hint}
        </p>
      </div>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        aria-describedby={error ? `${id}-hint ${id}-err` : `${id}-hint`}
        invalid={!!error}
        suffix={suffix}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
      />
      {error && (
        <p id={`${id}-err`} role="alert" className="col-span-2 text-[0.8125rem] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** A titled cluster of settings inside the fine-tune step. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-4">
      <h3 id={id} className="text-xs font-semibold tracking-wide text-ink-2 uppercase">
        {title}
      </h3>
      {children}
    </div>
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
  const total = useMemo(() => planned(s), [s]);
  const custom = !PRESETS.some((p) => sameSettings(s, p.settings));
  const tuneErrors = Object.keys(errors).some((k) => k !== "key");
  const [tuning, setTuning] = useState(false);
  const tuneOpen = tuning || tuneErrors;

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

  const keyError = errors.key ?? (keyRejected ? "That admin key isn't valid." : undefined);
  const show = run.phase === "idle" ? null : run.show;
  const { hotSeats, perUserLimit, limitParallel, retryCopies } = DEFAULTS;

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

      <div className="grid items-start gap-6 lg:grid-cols-[25rem_minmax(0,1fr)]">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-4"
          aria-label="Stampede settings"
        >
          <Step n={1} title="Admin key">
            <Input
              type="password"
              autoComplete="off"
              placeholder="Needed to create the show"
              aria-label="Admin key"
              aria-describedby={keyError ? "stampede-key-error" : undefined}
              invalid={!!keyError}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            {keyError && (
              <p
                id="stampede-key-error"
                role="alert"
                className="-mt-1 text-[0.8125rem] text-danger"
              >
                {keyError}
              </p>
            )}
          </Step>

          <Step n={2} title="Pick a scenario" aside={custom && <Pill tone="amber">Custom</Pill>}>
            <PresetPicker value={s} onPick={setS} disabled={running} />
          </Step>

          <Step
            n={3}
            title="Fine-tune"
            hint="Optional"
            aside={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={tuneOpen}
                aria-controls="stampede-tune"
                onClick={() => setTuning(!tuneOpen)}
                className="-mt-1 shrink-0"
              >
                {tuneOpen ? "Hide" : "Show"}
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className={cx(
                    "size-3.5 transition-transform duration-150",
                    tuneOpen && "rotate-180",
                  )}
                >
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </Button>
            }
          >
            {tuneOpen && (
              <div
                id="stampede-tune"
                className="flex flex-col gap-5 rounded-md bg-surface-2/40 p-3"
              >
                <Group title="Crowd">
                  <Segmented
                    label="Hall"
                    value={s.hall}
                    onChange={set("hall")}
                    options={(Object.keys(HALLS) as Hall[]).map((h) => ({
                      value: h,
                      label: HALLS[h].label,
                    }))}
                  />
                  <NumberRow
                    label="Users"
                    suffix="users"
                    value={s.users}
                    onChange={set("users")}
                    error={errors.users}
                  />
                  <NumberRow
                    label="Booking requests"
                    value={s.requests}
                    onChange={set("requests")}
                    error={errors.requests}
                  />
                  <NumberRow
                    label="At once"
                    hint="Requests in flight"
                    value={s.concurrency}
                    onChange={set("concurrency")}
                    error={errors.concurrency}
                  />
                </Group>

                <Group title="Traps">
                  <NumberRow
                    label="Hot-seat storm"
                    hint={`All rush A12 and ${hotSeats - 1} nearby`}
                    suffix="users"
                    value={s.hotUsers}
                    onChange={set("hotUsers")}
                    error={errors.hotUsers}
                  />
                  <NumberRow
                    label="Same-key retries"
                    hint={`Sent ${retryCopies}× with one key`}
                    suffix="%"
                    value={s.retryPct}
                    onChange={set("retryPct")}
                    error={errors.retryPct}
                  />
                  <NumberRow
                    label="Spoofed user_id"
                    hint="Claim to be someone else"
                    suffix="%"
                    value={s.spoofPct}
                    onChange={set("spoofPct")}
                    error={errors.spoofPct}
                  />
                  <NumberRow
                    label="Over-limit users"
                    hint={`Each tries ${limitParallel}, limit ${perUserLimit}`}
                    suffix="users"
                    value={s.overLimitUsers}
                    onChange={set("overLimitUsers")}
                    error={errors.overLimitUsers}
                  />
                  <Switch
                    checked={s.edgeCases}
                    onChange={set("edgeCases")}
                    label="Edge cases"
                    hint="Crossed pairs, key reuse, foreign cancels"
                  />
                  <Switch
                    checked={s.metrics}
                    onChange={set("metrics")}
                    label="Compare with /metrics"
                    hint="Off if others are booking here"
                  />
                </Group>
              </div>
            )}
          </Step>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="tabular text-xs text-pretty text-muted">
              <span className="font-semibold text-ink">{num(total)} requests</span> at a{" "}
              <span className="font-semibold text-ink">{num(seatsIn(s.hall))}-seat</span> hall
            </p>
            {running ? (
              <Button type="button" variant="danger" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="primary">
                {run.phase === "idle" ? "Start the stampede" : "Run again"}
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
