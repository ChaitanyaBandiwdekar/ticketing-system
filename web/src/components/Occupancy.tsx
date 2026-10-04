import type { SeatCounts } from "../lib/api";
import { num } from "../lib/format";
import { cx } from "./ui";

/**
 * Sold / held / free as one proportional bar plus exact numbers. The bar is a glance; the
 * numbers are the truth (and reconcile: sold + held + free = total, flagged if not).
 */
export function Occupancy({ counts, compact = false }: { counts: SeatCounts; compact?: boolean }) {
  const { total, confirmed, held, available } = counts;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className={cx("flex flex-col gap-1.5", compact ? "w-full" : "w-full max-w-md")}>
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        role="img"
        aria-label={`${num(confirmed)} sold, ${num(held)} held, ${num(available)} available of ${num(total)}`}
      >
        <span className="h-full bg-ink-2" style={{ width: `${pct(confirmed)}%` }} />
        <span className="h-full bg-amber" style={{ width: `${pct(held)}%` }} />
      </div>
      <p className="tabular flex flex-wrap gap-x-3 text-xs text-muted">
        <span>
          <span className="text-ink">{num(confirmed)}</span> sold
        </span>
        {held > 0 && (
          <span>
            <span className="text-amber">{num(held)}</span> held
          </span>
        )}
        <span>
          <span className="text-ink-2">{num(available)}</span> free
        </span>
        <span>of {num(total)}</span>
      </p>
    </div>
  );
}

/** The books-balance badge: available + held + confirmed == total, from one snapshot. */
export function InvariantBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-success"
      title="available + held + sold = total, from one database snapshot"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
        <path
          d="M3.5 8.5l3 3 6-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Books balance
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-danger">
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
        <path d="M8 3v6M8 12v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Counts don't reconcile
    </span>
  );
}
