/**
 * A small live time-series chart in SVG: stacked areas (parts of a whole per second) or lines.
 *
 * Built for the War Room's 1-second points over a sliding 5-minute window: x is wall-clock time
 * ending at `now`; a gap of more than ~2.5s between points (a reconnect, a restart) breaks the
 * marks instead of drawing a line across missing data. Hover or focus shows a crosshair snapped
 * to the nearest second, with one tooltip listing every series; arrow keys step through seconds.
 * Values are always reachable without hovering too, through the table twin (ChartTable).
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../components/ui";

export type Series = { key: string; label: string; color: string };
export type Row = { t: number; values: (number | null)[] };

type Props = {
  /** Names the chart for assistive tech (the visible title lives outside). */
  label: string;
  rows: Row[];
  series: Series[];
  kind: "stacked" | "lines";
  /** Formats a value for tooltips, direct labels and the y axis. */
  format: (v: number) => string;
  now: number;
  windowMs?: number;
  height?: number;
  /** A horizontal reference (e.g. the pool size) drawn as a labeled hairline. */
  refLine?: { value: number; label: string };
  /** Label each line's latest value at the right edge (lines only, <= 4 series). */
  directLabels?: boolean;
  /** Lower bound for the y-axis maximum, so a quiet chart doesn't magnify noise. */
  minMax?: number;
};

const GAP_MS = 2_500;
const M = { top: 8, bottom: 22, left: 44 };

/** 1-2-5 rounding: the smallest "nice" number >= v. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

function yTicks(max: number): number[] {
  const step = niceCeil(max / 3);
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

/** Splits rows into runs with no gap longer than GAP_MS. */
function runs(rows: Row[]): Row[][] {
  const out: Row[][] = [];
  let cur: Row[] = [];
  for (const r of rows) {
    if (cur.length && r.t - cur[cur.length - 1]!.t > GAP_MS) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

const clockFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function TimeChart({
  label,
  rows,
  series,
  kind,
  format,
  now,
  windowMs = 300_000,
  height = 180,
  refLine,
  directLabels = false,
  minMax = 1,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const tipId = useId();

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const right = directLabels ? 92 : 12;
  const plotW = Math.max(0, width - M.left - right);
  const plotH = height - M.top - M.bottom;
  const t0 = now - windowMs;
  const visible = useMemo(() => rows.filter((r) => r.t >= t0 - 1_000), [rows, t0]);

  // Stacked: cumulative tops per series; lines: the raw values.
  const tops = useMemo(
    () =>
      visible.map((r) => {
        if (kind === "lines") return r.values;
        let acc = 0;
        return r.values.map((v) => (acc += v ?? 0));
      }),
    [visible, kind],
  );

  let dataMax = 0;
  for (const row of tops) for (const v of row) if (v != null && v > dataMax) dataMax = v;
  const yMax = niceCeil(Math.max(minMax, dataMax, refLine ? refLine.value * 1.15 : 0));
  const ticks = yTicks(yMax);

  const x = (t: number) => M.left + ((t - t0) / windowMs) * plotW;
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;

  const index = new Map(visible.map((r, i) => [r, i]));
  const segments = runs(visible);

  const areaPaths: { d: string; edge: string; color: string; key: string }[] = [];
  const linePaths: { d: string; color: string; key: string }[] = [];
  if (plotW > 0) {
    series.forEach((s, si) => {
      for (const seg of segments) {
        const ids = seg.map((r) => index.get(r)!);
        if (kind === "stacked") {
          const top = ids.map((i) => [x(visible[i]!.t), y(tops[i]![si] ?? 0)] as const);
          const base = ids
            .map((i) => [x(visible[i]!.t), y(si === 0 ? 0 : (tops[i]![si - 1] ?? 0))] as const)
            .reverse();
          const pts = (p: readonly (readonly [number, number])[]) =>
            p.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L");
          areaPaths.push({
            d: `M${pts(top)}L${pts(base)}Z`,
            edge: `M${pts(top)}`,
            color: s.color,
            key: `${s.key}-${seg[0]!.t}`,
          });
        } else {
          let d = "";
          let pen = false;
          for (const i of ids) {
            const v = tops[i]![si];
            if (v == null) {
              pen = false;
              continue;
            }
            d += `${pen ? "L" : "M"}${x(visible[i]!.t).toFixed(1)},${y(v).toFixed(1)}`;
            pen = true;
          }
          if (d) linePaths.push({ d, color: s.color, key: `${s.key}-${seg[0]!.t}` });
        }
      }
    });
  }

  // Direct labels: each line's latest value at the right edge, nudged apart so none overlap.
  const labels: { text: string; y: number; color: string }[] = [];
  if (directLabels && kind === "lines" && visible.length) {
    // Each line's latest value; a quiet last second (no data) keeps the previous label.
    series.forEach((s, si) => {
      let v: number | null | undefined = null;
      for (let i = tops.length - 1; i >= 0 && v == null; i--) v = tops[i]![si];
      if (v != null) labels.push({ text: `${s.label} ${format(v)}`, y: y(v), color: s.color });
    });
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
      labels[i]!.y = Math.max(labels[i]!.y, labels[i - 1]!.y + 13);
    }
    const overflow = labels.length ? labels[labels.length - 1]!.y - (M.top + plotH) : 0;
    if (overflow > 0) for (const l of labels) l.y -= overflow;
  }

  const pick = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || !visible.length) return;
    const px = clientX - el.getBoundingClientRect().left;
    const t = t0 + ((px - M.left) / plotW) * windowMs;
    let best = 0;
    for (let i = 1; i < visible.length; i++) {
      if (Math.abs(visible[i]!.t - t) < Math.abs(visible[best]!.t - t)) best = i;
    }
    setHover(best);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!visible.length) return;
    const last = visible.length - 1;
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? last + 1) - 1));
    else if (e.key === "ArrowRight") setHover((h) => Math.min(last, (h ?? last - 1) + 1));
    else if (e.key === "Home") setHover(0);
    else if (e.key === "End") setHover(last);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const h = hover !== null && hover < visible.length ? hover : null;
  const hx = h !== null ? x(visible[h]!.t) : 0;
  const tipLeft = hx > M.left + plotW / 2;

  // Every minute when there is room for it, every other minute on narrow (phone) plots.
  const xTicks = (plotW < 300 ? [4, 2, 0] : [5, 4, 3, 2, 1, 0])
    .map((m) => ({ t: now - m * 60_000, text: m === 0 ? "now" : `−${m}m` }))
    .filter((tk) => tk.t >= t0);

  return (
    <div
      ref={wrapRef}
      className="relative w-full touch-pan-y select-none outline-none"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={label}
      aria-describedby={h !== null ? tipId : undefined}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={y(v)}
                y2={y(v)}
                className="stroke-line"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={M.left - 8}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="tabular fill-muted text-[0.6875rem]"
              >
                {format(v)}
              </text>
            </g>
          ))}
          {xTicks.map((tk) => (
            <text
              key={tk.text}
              x={x(tk.t)}
              y={height - 6}
              textAnchor={tk.text === "now" ? "end" : "middle"}
              className="tabular fill-muted text-[0.6875rem]"
            >
              {tk.text}
            </text>
          ))}

          {areaPaths.map((a) => (
            <path key={a.key} d={a.d} fill={a.color} fillOpacity={0.85} />
          ))}
          {/* The surface gap between stacked layers, so adjacent fills never touch. */}
          {areaPaths.map((a) => (
            <path
              key={`${a.key}-edge`}
              d={a.edge}
              fill="none"
              className="stroke-surface"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ))}
          {linePaths.map((l) => (
            <path
              key={l.key}
              d={l.d}
              fill="none"
              stroke={l.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {refLine && refLine.value <= yMax && (
            <g>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={y(refLine.value)}
                y2={y(refLine.value)}
                className="stroke-amber"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {/* Labeled at the left: live data piles up at the right ("now") edge. */}
              <text
                x={M.left + 6}
                y={y(refLine.value) - 5}
                className="fill-amber text-[0.6875rem] font-medium"
              >
                {refLine.label}
              </text>
            </g>
          )}

          {labels.map((l) => (
            <g key={l.text}>
              <line
                x1={M.left + plotW + 6}
                x2={M.left + plotW + 16}
                y1={l.y}
                y2={l.y}
                stroke={l.color}
                strokeWidth={2}
                strokeLinecap="round"
              />
              <text
                x={M.left + plotW + 20}
                y={l.y}
                dy="0.32em"
                className="tabular fill-ink-2 text-[0.6875rem]"
              >
                {l.text}
              </text>
            </g>
          ))}

          {h !== null && (
            <g>
              <line
                x1={hx}
                x2={hx}
                y1={M.top}
                y2={M.top + plotH}
                className="stroke-ink-2"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {kind === "lines" &&
                series.map((s, si) => {
                  const v = tops[h]![si];
                  return v == null ? null : (
                    <circle
                      key={s.key}
                      cx={hx}
                      cy={y(v)}
                      r={4}
                      fill={s.color}
                      className="stroke-surface"
                      strokeWidth={2}
                    />
                  );
                })}
            </g>
          )}
        </svg>
      )}

      {width > 0 && visible.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center pl-11 text-[0.8125rem] text-muted">
          Waiting for the first seconds of data…
        </p>
      )}

      {h !== null && (
        <div
          id={tipId}
          role="status"
          className={cx(
            "pointer-events-none absolute top-1 z-(--z-popover) min-w-40 rounded-md border border-line-strong bg-surface-2 px-3 py-2 shadow-lg shadow-black/40",
          )}
          style={tipLeft ? { right: width - hx + 10 } : { left: hx + 10 }}
        >
          <p className="tabular mb-1 text-[0.6875rem] text-muted">
            {clockFmt.format(visible[h]!.t)}
          </p>
          <ul className="flex flex-col gap-0.5">
            {(kind === "stacked" ? [...series].reverse() : series).map((s) => {
              const v = visible[h]!.values[series.indexOf(s)];
              return (
                <li key={s.key} className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ background: s.color }}
                  />
                  <span className="tabular min-w-10 font-semibold text-ink">
                    {v == null ? "–" : format(v)}
                  </span>
                  <span className="truncate text-muted">{s.label}</span>
                </li>
              );
            })}
            {kind === "stacked" && (
              <li className="mt-1 flex items-center gap-2 border-t border-line pt-1 text-xs">
                <span aria-hidden className="w-3" />
                <span className="tabular min-w-10 font-semibold text-ink">
                  {format(visible[h]!.values.reduce<number>((a, v) => a + (v ?? 0), 0))}
                </span>
                <span className="text-muted">total</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The legend: rect keys for areas, line keys for lines. Always shown for two or more series. */
export function Legend({ series, kind }: { series: Series[]; kind: "stacked" | "lines" }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-xs text-ink-2">
          <span
            aria-hidden
            className={kind === "stacked" ? "size-2.5 rounded-[2px]" : "h-0.5 w-3 rounded-full"}
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
