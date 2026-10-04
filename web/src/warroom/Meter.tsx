/**
 * Part-to-whole at a glance: one horizontal bar split into segments, separated by 2px surface
 * gaps, with an optional legend of exact counts and shares below it. Used for a hall's seats
 * (sold / held / free) and for where a burst's requests went.
 */
import { num } from "../lib/format";
import { cx } from "../components/ui";

export type Segment = {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Shown after the label in the legend, muted. */
  hint?: string;
};

export function Meter({
  label,
  segments,
  total,
  height = "h-2.5",
  legend = false,
  columns = 2,
  className,
}: {
  /** Names the bar for assistive tech. */
  label: string;
  segments: Segment[];
  /** Defaults to the sum of the segments. */
  total?: number;
  height?: string;
  /** Show every segment, zeros included, with its count and share. */
  legend?: boolean;
  /** Legend columns from the small breakpoint up. */
  columns?: 1 | 2;
  className?: string;
}) {
  const sum = total ?? segments.reduce((a, s) => a + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  const share = (v: number) => {
    if (!sum) return "0%";
    const p = (v / sum) * 100;
    if (p > 0 && p < 0.1) return "<0.1%";
    return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
  };
  return (
    <div className={cx("flex flex-col gap-2.5", className)}>
      <div
        role="img"
        aria-label={`${label}: ${segments.map((s) => `${s.label} ${num(s.value)}`).join(", ")}`}
        className={cx("flex w-full gap-[2px] overflow-hidden rounded-[4px]", height)}
      >
        {sum === 0 ? (
          <div className="w-full bg-surface-3" />
        ) : (
          shown.map((s) => (
            <div
              key={s.key}
              className="min-w-[3px]"
              style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
              title={`${s.label}: ${num(s.value)} (${share(s.value)})`}
            />
          ))
        )}
      </div>
      {legend && (
        <ul className={cx("grid gap-x-6 gap-y-1.5 text-xs", columns === 2 && "sm:grid-cols-2")}>
          {segments.map((s) => (
            <li key={s.key} className="flex min-w-0 items-baseline gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 translate-y-[1px] rounded-[2px]"
                style={{ background: s.color }}
              />
              <span className="min-w-0 text-ink-2">
                {s.label}
                {s.hint && <span className="block text-[0.6875rem] text-muted">{s.hint}</span>}
              </span>
              <span className="tabular ml-auto shrink-0 font-semibold text-ink">
                {num(s.value)}
              </span>
              <span className="tabular w-11 shrink-0 text-right text-muted">{share(s.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
