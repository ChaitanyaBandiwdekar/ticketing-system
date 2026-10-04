/**
 * What stands in for the last burst's scorecard while a new burst runs: the running tally from
 * the live feed, then a short wait for the burst's own report. The old verdict above fresh
 * traffic read as if it described it.
 */
import { Spinner } from "../components/ui";
import { num } from "../lib/format";
import type { BurstState } from "./burst";
import { duration, perSec } from "./fmt";

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="text-[1.625rem] leading-tight font-semibold tracking-[-0.01em] text-ink">
        {value}
      </p>
    </div>
  );
}

export function BurstLive({
  burst,
  now,
}: {
  burst: Exclude<BurstState, { phase: "idle" }>;
  now: number;
}) {
  const running = burst.phase === "running";
  return (
    <section
      aria-label="Burst in progress"
      className="flex flex-col gap-5 rounded-lg border border-primary/40 bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-ink">
            {running ? "Burst in progress" : "Burst finished"}
          </h2>
          <span
            className="inline-flex h-7 items-center gap-2 rounded-full bg-primary-soft px-3 text-sm font-semibold text-primary-ink"
            role="status"
          >
            {running ? (
              <span className="relative flex size-2" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
            ) : (
              <Spinner />
            )}
            {running ? `Running for ${duration(now - burst.startedAt)}` : "Waiting for its report…"}
          </span>
        </div>
        <p className="max-w-2xl text-[0.8125rem] text-pretty text-muted">
          {running
            ? "Counted live from this instance's reserve responses; the charts below draw it second by second. Its full scorecard (every guarantee checked) replaces this card when it finishes."
            : "The traffic has stopped. The burst is running its final checks and will post its scorecard here in a few seconds."}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Figure label="Reserve requests" value={num(burst.requests)} />
        <Figure label="Booked" value={num(burst.booked)} />
        <Figure label="Declined correctly" value={num(burst.declined)} />
        <Figure
          label={running ? "Requests per second" : "Lasted"}
          value={running ? perSec(burst.rate) : duration(burst.lastAt - burst.startedAt + 1000)}
        />
      </div>
      {burst.failed > 0 && (
        <p className="text-[0.8125rem] font-medium text-danger">
          {num(burst.failed)} failed so far (shed with 429, 5xx, or no answer)
        </p>
      )}
    </section>
  );
}
