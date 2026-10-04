/**
 * A live time chart drawn in SVG: stacked columns (parts of a whole per moment) or lines.
 *
 * Built for the War Room's 1-second points over a sliding window: x is wall-clock time ending at
 * `now`, and the seconds are grouped into buckets wide enough to read (chartData.ts), so a
 * ten-minute window on a phone still draws real columns rather than a smear. Bucket edges sit on
 * whole multiples of the bucket size, so columns don't jitter as the window slides. A bucket with
 * no point leaves a gap.
 *
 * Hover or focus shows a crosshair on one bucket and one tooltip listing every series; arrow keys
 * step through buckets. Values are always reachable without hovering too, through the table twin
 * (ChartTable).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  bucketize,
  pickBucket,
  timeTicks,
  toSec,
  yTicks,
  type Agg,
  type Bucket,
  type Row,
  type Series,
} from "./chartData";

export type { Row, Series };

type Props = {
  /** Names the chart for assistive tech (the visible title lives outside). */
  label: string;
  rows: Row[];
  series: Series[];
  kind: "bars" | "lines";
  /** How each series folds a bucket's seconds: mean (default) or max. */
  aggs?: Agg[];
  /** Formats a value for tooltips and the y axis. */
  format: (v: number) => string;
  now: number;
  windowMs: number;
  /** Height of the plot, without the time axis below it. */
  height?: number;
  /** A horizontal reference (e.g. the pool size) drawn as a labeled hairline. */
  refLine?: { value: number; label: string };
  /** Lower bound for the y-axis maximum, so a quiet chart doesn't magnify noise. */
  minMax?: number;
  /** What a bucket's value means when it spans several seconds (tooltip footnote). */
  bucketNote?: (size: number) => string;
};

const AXIS_W = 48;
const X_BAND = 22;
const TOP = 10;
const GAP = 2;
const MAX_COL = 24;

const clockFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const minuteFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** A column whose top corners are rounded by r (square at the baseline). */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return (
    `M${x},${y + h}V${y + rr}` +
    `Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}` +
    `V${y + h}Z`
  );
}

export function TimeChart({
  label,
  rows,
  series,
  kind,
  aggs,
  format,
  now,
  windowMs,
  height = 180,
  refLine,
  minMax = 1,
  bucketNote,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const tipId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(0, width - AXIS_W);
  const windowSec = Math.max(1, Math.round(windowMs / 1000));
  const endSec = toSec(now) + 1;
  const startSec = endSec - windowSec;
  const size = pickBucket(windowSec, Math.max(1, plotW), 6);
  const aggList = aggs ?? series.map((): Agg => "mean");

  const buckets = useMemo<Bucket[]>(
    () => bucketize(rows, now, windowMs, size, aggList),
    // aggList is derived from aggs/series; their identity is stable per render site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, now, windowMs, size, aggs, series.length],
  );

  const totals = buckets.map((b) => b.values.reduce<number>((a, v) => a + (v ?? 0), 0));
  const dataMax =
    kind === "bars"
      ? Math.max(0, ...totals)
      : Math.max(0, ...buckets.flatMap((b) => b.values.map((v) => v ?? 0)));
  const ticks = yTicks(dataMax, minMax, refLine?.value);
  const top = ticks.at(-1)!;
  const x = (sec: number) => ((sec - startSec) / windowSec) * plotW;
  const y = (v: number) => TOP + height - (v / top) * height;

  const xTicks = timeTicks(startSec, endSec, plotW).filter((t) => x(t) < plotW - 40);
  const tickFmt = xTicks.length > 1 && xTicks[1]! - xTicks[0]! < 60 ? clockFmt : minuteFmt;

  // Buckets that held a point, in order: what the arrow keys step through.
  const stops = buckets.flatMap((b, i) => (b.seen > 0 ? [i] : []));
  const hovered = hover !== null ? buckets[hover] : undefined;

  const slot = (b: Bucket) => {
    const x0 = Math.max(0, x(b.start));
    const x1 = Math.min(plotW, x(b.start + b.size));
    return { x0, x1 };
  };

  const onPointer = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || plotW <= 0) return;
    const px = clientX - el.getBoundingClientRect().left;
    if (px < 0 || px > plotW) return setHover(null);
    const sec = startSec + (px / plotW) * windowSec;
    const i = buckets.findIndex((b) => sec >= b.start && sec < b.start + b.size);
    setHover(i >= 0 && buckets[i]!.seen > 0 ? i : null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!stops.length) return;
    const last = stops.length - 1;
    const at = hover !== null ? stops.indexOf(hover) : -1;
    if (e.key === "ArrowLeft") setHover(stops[at < 0 ? last : Math.max(0, at - 1)]!);
    else if (e.key === "ArrowRight") setHover(stops[at < 0 ? last : Math.min(last, at + 1)]!);
    else if (e.key === "Home") setHover(stops[0]!);
    else if (e.key === "End") setHover(stops[last]!);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const hx = hovered ? (slot(hovered).x0 + slot(hovered).x1) / 2 : 0;
  const tipLeft = hx > plotW / 2;

  return (
    <div
      ref={wrapRef}
      className="relative w-full touch-pan-y select-none outline-none"
      style={{ height: height + TOP + X_BAND }}
      tabIndex={0}
      role="img"
      aria-label={label}
      aria-describedby={hovered ? tipId : undefined}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
      onPointerMove={(e) => onPointer(e.clientX)}
      onPointerLeave={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={height + TOP + X_BAND} className="block" aria-hidden>
          {/* Gridlines and y labels */}
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={0}
                x2={plotW}
                y1={y(v) + 0.5}
                y2={y(v) + 0.5}
                style={{ stroke: v === 0 ? "var(--color-line-strong)" : "var(--color-line)" }}
                strokeWidth={1}
              />
              <text
                x={plotW + 8}
                y={y(v)}
                dy="0.32em"
                className="tabular"
                style={{ fill: "var(--color-muted)", fontSize: 11 }}
              >
                {format(v)}
              </text>
            </g>
          ))}

          {/* Hovered bucket */}
          {hovered && kind === "bars" && (
            <rect
              x={slot(hovered).x0}
              y={TOP}
              width={Math.max(1, slot(hovered).x1 - slot(hovered).x0)}
              height={height}
              style={{ fill: "var(--color-surface-3)" }}
            />
          )}

          {/* Columns */}
          {kind === "bars" &&
            buckets.map((b) => {
              if (!b.seen) return null;
              const { x0, x1 } = slot(b);
              const w = Math.min(MAX_COL, x1 - x0 - GAP);
              if (w < 1) return null;
              const bx = x0 + (x1 - x0 - w) / 2;
              const parts = b.values.map((v, i) => ({ v: v ?? 0, i })).filter((p) => p.v > 0);
              let acc = 0;
              return (
                <g key={b.start}>
                  {parts.map((p, n) => {
                    const yb = y(acc) - (n > 0 ? GAP : 0);
                    acc += p.v;
                    const yt = y(acc);
                    const h = yb - yt;
                    if (h <= 0.25) return null;
                    const isTop = n === parts.length - 1;
                    return isTop ? (
                      <path
                        key={p.i}
                        d={topRounded(bx, yt, w, h, 4)}
                        style={{ fill: series[p.i]!.color }}
                      />
                    ) : (
                      <rect
                        key={p.i}
                        x={bx}
                        y={yt}
                        width={w}
                        height={h}
                        style={{ fill: series[p.i]!.color }}
                      />
                    );
                  })}
                </g>
              );
            })}

          {/* Lines */}
          {kind === "lines" &&
            series.map((s, i) => {
              let d = "";
              let pen = false;
              let last: { cx: number; cy: number } | null = null;
              for (const b of buckets) {
                const v = b.values[i];
                if (v == null) {
                  pen = false;
                  continue;
                }
                const cx = (slot(b).x0 + slot(b).x1) / 2;
                const cy = y(v);
                d += `${pen ? "L" : "M"}${cx.toFixed(1)},${cy.toFixed(1)}`;
                pen = true;
                last = { cx, cy };
              }
              return (
                <g key={s.key}>
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    style={{ stroke: s.color }}
                  />
                  {last && !hovered && (
                    <circle
                      cx={last.cx}
                      cy={last.cy}
                      r={4}
                      strokeWidth={2}
                      style={{ fill: s.color, stroke: "var(--color-surface)" }}
                    />
                  )}
                </g>
              );
            })}

          {/* Crosshair (lines) */}
          {hovered && kind === "lines" && (
            <g>
              <line
                x1={hx}
                x2={hx}
                y1={TOP}
                y2={TOP + height}
                strokeWidth={1}
                style={{ stroke: "var(--color-ink-2)" }}
              />
              {series.map((s, i) => {
                const v = hovered.values[i];
                return v == null ? null : (
                  <circle
                    key={s.key}
                    cx={hx}
                    cy={y(v)}
                    r={4}
                    strokeWidth={2}
                    style={{ fill: s.color, stroke: "var(--color-surface)" }}
                  />
                );
              })}
            </g>
          )}

          {/* Reference line */}
          {refLine && (
            <g>
              <line
                x1={0}
                x2={plotW}
                y1={y(refLine.value) + 0.5}
                y2={y(refLine.value) + 0.5}
                strokeWidth={1}
                style={{ stroke: "var(--color-amber)" }}
              />
              <text
                x={4}
                y={y(refLine.value) - 5}
                style={{ fill: "var(--color-ink-2)", fontSize: 11 }}
              >
                {refLine.label}
              </text>
            </g>
          )}

          {/* Time axis */}
          {xTicks.map((t) => (
            <text
              key={t}
              x={x(t)}
              y={TOP + height + 16}
              textAnchor="middle"
              className="tabular"
              style={{ fill: "var(--color-muted)", fontSize: 11 }}
            >
              {tickFmt.format(t * 1000)}
            </text>
          ))}
          <text
            x={plotW}
            y={TOP + height + 16}
            textAnchor="end"
            style={{ fill: "var(--color-ink-2)", fontSize: 11, fontWeight: 600 }}
          >
            now
          </text>
        </svg>
      )}

      {rows.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center pr-12 text-[0.8125rem] text-muted">
          Waiting for the first seconds of data…
        </p>
      )}

      {hovered && (
        <div
          id={tipId}
          role="status"
          className="pointer-events-none absolute top-1 z-(--z-popover) min-w-44 rounded-md border border-line-strong bg-surface-2 px-3 py-2 shadow-lg shadow-black/40"
          style={tipLeft ? { right: width - hx + 12 } : { left: hx + 12 }}
        >
          <p className="tabular mb-1 text-[0.6875rem] text-muted">
            {clockFmt.format(hovered.start * 1000)}
            {hovered.size > 1 && `–${clockFmt.format((hovered.start + hovered.size) * 1000)}`}
          </p>
          <ul className="flex flex-col gap-0.5">
            {(kind === "bars" ? [...series].reverse() : series).map((s) => {
              const v = hovered.values[series.indexOf(s)];
              return (
                <li key={s.key} className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden
                    className={
                      kind === "bars"
                        ? "size-2.5 shrink-0 rounded-[2px]"
                        : "h-0.5 w-3 shrink-0 rounded-full"
                    }
                    style={{ background: s.color }}
                  />
                  <span className="tabular min-w-12 font-semibold text-ink">
                    {v == null ? "–" : format(v)}
                  </span>
                  <span className="truncate text-muted">{s.label}</span>
                </li>
              );
            })}
            {kind === "bars" && (
              <li className="mt-1 flex items-center gap-2 border-t border-line pt-1 text-xs">
                <span aria-hidden className="w-2.5" />
                <span className="tabular min-w-12 font-semibold text-ink">
                  {format(hovered.values.reduce<number>((a, v) => a + (v ?? 0), 0))}
                </span>
                <span className="text-muted">total</span>
              </li>
            )}
          </ul>
          {hovered.size > 1 && bucketNote && (
            <p className="mt-1.5 max-w-52 text-[0.6875rem] text-muted">
              {bucketNote(hovered.size)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The legend: square keys for columns, line keys for lines. Shown for two or more series. */
export function Legend({ series, kind }: { series: Series[]; kind: "bars" | "lines" }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-xs text-ink-2">
          <span
            aria-hidden
            className={kind === "bars" ? "size-2.5 rounded-[2px]" : "h-0.5 w-3 rounded-full"}
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** The chart's table twin: the latest seconds, newest first. */
export function ChartTable({
  rows,
  series,
  format,
  limit = 30,
}: {
  rows: Row[];
  series: Series[];
  format: (v: number) => string;
  limit?: number;
}) {
  const recent = rows.slice(-limit).reverse();
  return (
    <details className="group text-xs">
      <summary className="w-fit cursor-pointer rounded-sm text-muted transition-colors hover:text-ink">
        Table: last {limit} seconds
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
        <table className="tabular w-full text-left">
          <thead className="sticky top-0 bg-surface-2 text-muted">
            <tr>
              <th className="px-2 py-1.5 font-medium">Time</th>
              {series.map((s) => (
                <th key={s.key} className="px-2 py-1.5 text-right font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-ink-2">
            {recent.map((r) => (
              <tr key={r.t}>
                <td className="px-2 py-1">{clockFmt.format(r.t)}</td>
                {r.values.map((v, i) => (
                  <td key={series[i]!.key} className="px-2 py-1 text-right">
                    {v == null ? "–" : format(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
