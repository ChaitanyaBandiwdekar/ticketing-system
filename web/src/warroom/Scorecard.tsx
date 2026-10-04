/**
 * The last burst, as a verdict an evaluator can read in one look, whenever they arrive: the
 * stored report (GET /ops/runs) survives the live window moving on and the instance restarting.
 *
 * Top to bottom: pass/fail and what was fired; the hall (sold / free, nothing sold twice, nobody
 * over the limit); where every request went (booked, declined correctly, failed); how fast; and
 * every guarantee the burst checked.
 */
import { useState } from "react";
import { Link } from "react-router";
import type { BurstRun } from "../../../server/src/obs/types";
import { Pill, Segmented, cx } from "../components/ui";
import { ago, num } from "../lib/format";
import { duration, ms, sentence } from "./fmt";
import { CheckIcon, CrossIcon } from "./icons";
import { LatencyRuler } from "./LatencyRuler";
import { Meter, type Segment } from "./Meter";
import { OUTCOMES, groupCounts } from "./outcomes";

const SCENARIOS: Record<string, string> = {
  hot: "Hundreds of users race for the same few seats",
  stampede: "The crowd books across the hall",
  retry: "The same idempotency key, sent several times at once",
  keyreuse: "One key reused for a different request",
  limit: "One user fires parallel requests past the per-user limit",
  crossed: "Two users take the same seat pair in opposite order",
  spoof: "A body claiming someone else's user_id",
  foreign: "Cancelling another user's booking",
};

const timeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "neutral" | "success" | "danger";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={cx(
          "flex items-baseline gap-1 text-[1.625rem] leading-tight font-semibold tracking-[-0.01em]",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
          tone === "neutral" && "text-ink",
        )}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-pretty text-muted">{sub}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="text-xs font-semibold tracking-wide text-ink-2 uppercase">{title}</h3>
      {children}
    </div>
  );
}

export function Scorecard({
  runs,
  loading,
  liveShows,
  onFollow,
}: {
  runs: BurstRun[];
  loading: boolean;
  /** Shows that still exist (burst shows are deleted after 24h): only those get a link. */
  liveShows: Set<string>;
  /** Opens the log tail on one request id. */
  onFollow: (requestId: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const run = runs.find((r) => r.id === picked) ?? runs[0];

  if (loading && !run) {
    return <div className="h-[30rem] animate-pulse rounded-lg border border-line bg-surface" />;
  }
  if (!run) return <EmptyScorecard />;

  const r = run.report;
  const checks = r.checks;
  const passed = checks.filter((c) => c.ok).length;
  const groups = groupCounts(r.outcomes);
  /** Responses that weren't an answer from a healthy server: 429 shed, 5xx, no answer. */
  const failed = groups.failed;
  // A connection dropped in transit and answered on retry is not a server error. Older runs
  // didn't record which drops went unanswered, so they count every one.
  const broken = r.status["5xx"] + (r.unanswered ?? r.status.network);
  const by = (key: string) =>
    Object.entries(r.outcomes)
      .filter(([o]) => OUTCOMES.find((s) => s.match(o))?.key === key)
      .reduce((a, [, n]) => a + n, 0);

  const requestSplit: Segment[] = [
    { key: "booked", label: "Booked", value: groups.booked, color: "var(--color-series-1)" },
    {
      key: "seat_taken",
      label: "Seat taken",
      hint: "someone got there first",
      value: by("seat_taken"),
      color: "var(--color-decline-1)",
    },
    {
      key: "per_user_limit",
      label: "Over the limit",
      hint: `max ${r.settings?.perUserLimit ?? 4} per user`,
      value: by("per_user_limit"),
      color: "var(--color-decline-2)",
    },
    {
      key: "idem",
      label: "Idempotent",
      hint: "replayed, or key reused (409)",
      value: by("replayed") + by("idempotency_key_reused"),
      color: "var(--color-decline-3)",
    },
    ...(by("other") > 0
      ? [{ key: "other", label: "Other 4xx", value: by("other"), color: "var(--color-decline-2)" }]
      : []),
    {
      key: "failed",
      label: "Failed",
      hint: "429 shed or 5xx",
      value: failed,
      color: "var(--color-danger)",
    },
  ];

  const f = r.final;
  const sold = f ? f.confirmed : 0;
  const seats: Segment[] = f
    ? [
        { key: "sold", label: "Sold", value: f.confirmed, color: "var(--color-series-1)" },
        { key: "held", label: "Held", value: f.held, color: "var(--color-amber)" },
        { key: "free", label: "Free", value: f.available, color: "var(--color-surface-3)" },
      ]
    : [];
  const doubleSold = checks.find((c) => c.name === "no seat sold twice");
  const overLimit = checks.find((c) => c.name === "no user over the limit");
  const audit = run.server_audit;

  return (
    <section
      aria-label="Last burst"
      className={cx(
        "flex flex-col gap-6 rounded-lg border bg-surface p-4 sm:p-5",
        run.ok ? "border-line" : "border-danger/45",
      )}
    >
      {/* Verdict */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-ink">Last burst</h2>
            <span
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm font-semibold",
                run.ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
              )}
            >
              {run.ok ? <CheckIcon className="size-4" /> : <CrossIcon className="size-4" />}
              {run.ok ? "Passed" : "Failed"} · {passed} of {checks.length} checks
            </span>
            {audit && (
              <Pill
                tone={audit.ok ? "success" : "danger"}
                title="The server re-audited the show from its own snapshot when the report arrived"
              >
                {audit.ok ? "Books verified by the server" : "Server audit failed"}
              </Pill>
            )}
          </div>
          <p className="text-[0.8125rem] text-pretty text-muted">
            {liveShows.has(r.show.id) ? (
              <Link
                to={`/shows/${r.show.id}`}
                className="font-medium text-ink-2 hover:text-primary-ink"
              >
                {r.show.name}
              </Link>
            ) : (
              <span className="font-medium text-ink-2">{r.show.name}</span>
            )}
            {" · "}
            <time dateTime={run.created_at} title={timeFmt.format(new Date(run.created_at))}>
              {ago(run.created_at)}
            </time>
            {" · "}
            {num(r.reserveRequests)} reserve requests in {duration(r.durationMs)}
            {r.settings && ` · ${num(r.settings.concurrency)} in flight at once`}
          </p>
        </div>
        {runs.length > 1 && (
          <Segmented
            label="Recorded runs"
            hideLabel
            value={run.id}
            onChange={setPicked}
            options={runs.map((x, i) => ({
              value: x.id,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cx("size-1.5 rounded-full", x.ok ? "bg-success" : "bg-danger")}
                  />
                  {i === 0 ? "Latest" : timeFmt.format(new Date(x.created_at))}
                </span>
              ),
            }))}
          />
        )}
      </div>

      {/* Headline figures */}
      <div className="grid gap-6 sm:grid-cols-3">
        <Stat
          label="Seats sold"
          value={
            <>
              {num(sold)}
              <span className="text-sm font-medium text-muted">
                / {num(f?.total ?? r.show.total_seats)}
              </span>
            </>
          }
          sub={
            doubleSold?.ok && overLimit?.ok
              ? `None sold twice · ${overLimit.detail.replace(/ seats per user$/, " per user")}`
              : "See the failed checks below"
          }
        />
        <Stat
          label="Throughput"
          value={
            <>
              {num(Math.round(r.throughput))}
              <span className="text-sm font-medium text-muted">req/s</span>
            </>
          }
          sub={`${num(r.retries)} retries after 429/503 · p99 ${r.latency ? ms(r.latency.p99) : "–"}`}
        />
        <Stat
          label="Server errors"
          tone={broken > 0 ? "danger" : "success"}
          value={
            <>
              {broken === 0 && <CheckIcon className="size-5 self-center" />}
              {num(broken)}
            </>
          }
          sub={`${num(r.status["5xx"])} 5xx · ${r.unanswered === undefined ? `${num(r.status.network)} network` : `${num(r.unanswered)} unanswered · ${num(r.status.network)} dropped and retried`} · ${num(r.status["429"])} shed with 429`}
        />
      </div>

      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-3">
        <Section title="The hall after the burst">
          {f ? (
            <Meter label="Seats" segments={seats} total={f.total} height="h-3" legend columns={1} />
          ) : (
            <p className="text-[0.8125rem] text-muted">The final seat map wasn't read.</p>
          )}
          {audit && (
            <p className="tabular text-xs text-muted">
              Server audit: {num(audit.counts.available)} free + {num(audit.counts.held)} held +{" "}
              {num(audit.counts.confirmed)} sold = {num(audit.counts.total)}
              {audit.ok ? ", balanced" : `, ${audit.violations} violations`}
            </p>
          )}
        </Section>

        <Section title={`Where ${num(r.reserveRequests)} requests went`}>
          <Meter
            label="Reserve responses"
            segments={requestSplit}
            height="h-3"
            legend
            columns={1}
          />
          <p className="text-xs text-muted">
            Declines are the system working: a stampede for {num(r.show.total_seats)} seats turns
            most people away. Only red is a failure.
          </p>
        </Section>

        <Section title="Reserve latency, as the client saw it">
          {r.latency ? (
            <LatencyRuler latency={r.latency} format={ms} />
          ) : (
            <p className="text-[0.8125rem] text-muted">No reserve requests were timed.</p>
          )}
        </Section>
      </div>

      <Section title="Guarantees checked">
        <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {checks.map((c) => (
            <li key={c.name} className="flex min-w-0 gap-2 text-[0.8125rem]">
              {c.ok ? (
                <CheckIcon className="mt-0.5 size-4 text-success" />
              ) : (
                <CrossIcon className="mt-0.5 size-4 text-danger" />
              )}
              <span className="min-w-0">
                <span className={cx("font-medium", c.ok ? "text-ink" : "text-danger")}>
                  {sentence(c.name)}
                </span>
                <span className="block text-xs break-words text-muted">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <details className="group rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-[0.8125rem] font-medium text-ink-2 hover:text-ink">
          Scenarios and slowest requests
        </summary>
        <div className="grid gap-6 border-t border-line p-3 lg:grid-cols-[1.6fr_1fr]">
          <table className="tabular w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="pb-1.5 font-medium">Scenario</th>
                <th className="pb-1.5 font-medium">Final outcomes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {Object.entries(r.scenarios)
                .filter(([, o]) => Object.keys(o).length > 0)
                .map(([s, o]) => (
                  <tr key={s}>
                    <td className="py-1.5 pr-3 align-top">
                      <span className="font-mono text-ink">{s}</span>
                      <span className="block text-muted">{SCENARIOS[s]}</span>
                    </td>
                    <td className="py-1.5 align-top text-ink-2">
                      {Object.entries(o)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, n]) => `${k} ${num(n)}`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted">
              Slowest reserve requests. Click one to follow it in the log tail, while the server
              still holds its lines.
            </p>
            <ul className="flex flex-col gap-1 text-xs">
              {r.slowest.map((s) => (
                <li key={s.requestId} className="flex items-baseline gap-3">
                  <button
                    type="button"
                    onClick={() => onFollow(s.requestId)}
                    className="font-mono text-primary-ink underline-offset-2 hover:underline"
                  >
                    {s.requestId}
                  </button>
                  <span className="tabular text-ink">{ms(s.ms)}</span>
                  <span className="text-muted">{s.outcome}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}

function EmptyScorecard() {
  const origin = typeof window === "undefined" ? "<BASE_URL>" : window.location.origin;
  return (
    <section
      aria-label="Last burst"
      className="flex flex-col gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-5"
    >
      <h2 className="text-lg font-semibold text-ink">No burst recorded yet</h2>
      <p className="max-w-2xl text-[0.8125rem] text-pretty text-ink-2">
        A burst fires about 21,600 concurrent reservation requests at a fresh 2,000-seat hall, then
        checks every guarantee: no seat sold twice, nobody over the limit, idempotent retries, no
        5xx. Its verdict lands here and stays after the live charts below have moved on.
      </p>
      <pre className="w-fit max-w-full overflow-x-auto rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-ink">
        npm run burst -- {origin} --admin-key &lt;ADMIN_API_KEY&gt;
      </pre>
      <p className="text-[0.8125rem] text-muted">
        Or run a smaller one from the browser on the{" "}
        <Link to="/stampede" className="text-primary-ink hover:underline">
          Stampede
        </Link>{" "}
        page.
      </p>
    </section>
  );
}
