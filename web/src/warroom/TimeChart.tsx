/**
 * A live time-series chart on TradingView Lightweight Charts: stacked areas (parts of a whole
 * per second) or lines.
 *
 * Built for the War Room's 1-second points over a sliding 5-minute window: x is wall-clock time
 * ending at `now` (one slot per second, see chartData.ts), and a missing second breaks the marks
 * instead of drawing across it. The window is live, so scrolling and zooming are off. Hover or
 * focus shows a crosshair snapped to a second, with one tooltip listing every series; arrow keys
 * step through seconds. Values are always reachable without hovering too, through the table
 * twin (ChartTable).
 *
 * The chart draws on canvas, so the theme's CSS custom properties are resolved to concrete
 * colors when it is created.
 *
 * Attribution (Apache-2.0, per the library's NOTICE): TradingView Lightweight Charts™,
 * Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/. The license also asks for a
 * link to tradingview.com on the page; the War Room carries one credit line (ChartCredit) rather
 * than a logo inside every plot, where it would sit on top of the data.
 */
import {
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "../components/ui";
import { buildSlots, toSec, yMax, type Row, type Series } from "./chartData";

export type { Row, Series };

type Props = {
  /** Names the chart for assistive tech (the visible title lives outside). */
  label: string;
  rows: Row[];
  series: Series[];
  kind: "stacked" | "lines";
  /** Formats a value for tooltips, last-value labels and the y axis. */
  format: (v: number) => string;
  now: number;
  windowMs?: number;
  height?: number;
  /** A horizontal reference (e.g. the pool size) drawn as a labeled hairline. */
  refLine?: { value: number; label: string };
  /** Label each line's latest value on the price axis (lines only). */
  directLabels?: boolean;
  /** Lower bound for the y-axis maximum, so a quiet chart doesn't magnify noise. */
  minMax?: number;
};

type AnySeries = ISeriesApi<"Area"> | ISeriesApi<"Line">;

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
const secOf = (t: Time) => (typeof t === "number" ? t : 0);

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * A theme color as rgba() for the canvas: resolves `var(--token)` and normalizes any CSS color
 * the browser understands (the tokens are OKLCH) by painting one pixel.
 */
function resolveColor(color: string, el: Element): string {
  const token = /^var\((--[\w-]+)\)$/.exec(color.trim());
  const raw = token ? getComputedStyle(el).getPropertyValue(token[1]!).trim() : color;
  if (probe === undefined) {
    probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  }
  if (!probe || !raw) return raw || "#888";
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#888";
  probe.fillStyle = raw;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${((a ?? 255) / 255).toFixed(3)})`;
}

type Hover = { sec: number; x: number; width: number };

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
  const chartEl = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; series: AnySeries[]; amber: string } | null>(null);
  const priceLine = useRef<IPriceLine | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const tipId = useId();

  // Read by the chart's callbacks, which outlive any one render.
  const live = useRef({ format, minMax, ref: refLine?.value });
  useEffect(() => {
    live.current = { format, minMax, ref: refLine?.value };
  });

  // Recreate the chart only when its shape changes; data flows in through setData below.
  const shape = `${kind}|${directLabels}|${series.map((s) => `${s.key}=${s.color}`).join(",")}`;
  useEffect(() => {
    const el = chartEl.current;
    if (!el) return;
    const theme = (name: string) => resolveColor(`var(${name})`, el);
    const surface = theme("--color-surface");
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: surface },
        textColor: theme("--color-muted"),
        fontFamily: getComputedStyle(el).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: theme("--color-line") } },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.06, bottom: 0 },
        minimumWidth: 52,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (t: Time, type: TickMarkType) =>
          (type === TickMarkType.TimeWithSeconds ? clockFmt : minuteFmt).format(secOf(t) * 1000),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme("--color-ink-2"),
          width: 1,
          style: LineStyle.Solid,
          labelVisible: false,
        },
        horzLine: { visible: false, labelVisible: false },
      },
      localization: {
        priceFormatter: (v: number) => live.current.format(v),
        timeFormatter: (t: Time) => clockFmt.format(secOf(t) * 1000),
      },
      // A live window: nothing to pan to, and page scrolling must pass through on phones.
      handleScroll: false,
      handleScale: false,
    });

    // Zero-based, never below minMax, with headroom over the reference line.
    const autoscale = (original: () => AutoscaleInfo | null): AutoscaleInfo => ({
      priceRange: {
        minValue: 0,
        maxValue: yMax(
          original()?.priceRange?.maxValue ?? 0,
          live.current.minMax,
          live.current.ref,
        ),
      },
    });

    const apis: AnySeries[] = new Array(series.length);
    // Stacked: the top of the stack first, so each lower layer paints over it.
    const order = series.map((_, i) => i);
    if (kind === "stacked") order.reverse();
    for (const i of order) {
      const color = resolveColor(series[i]!.color, el);
      apis[i] =
        kind === "stacked"
          ? chart.addSeries(AreaSeries, {
              topColor: color,
              bottomColor: color,
              // The surface gap between stacked layers, so adjacent fills never touch.
              lineColor: surface,
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              autoscaleInfoProvider: autoscale,
            })
          : chart.addSeries(LineSeries, {
              color,
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: directLabels,
              title: directLabels ? series[i]!.label : "",
              crosshairMarkerRadius: 4,
              crosshairMarkerBorderColor: surface,
              crosshairMarkerBorderWidth: 2,
              autoscaleInfoProvider: autoscale,
            });
    }

    chart.subscribeCrosshairMove((p) => {
      if (p.time === undefined || !p.point || p.point.x < 0) setHover(null);
      else setHover({ sec: secOf(p.time), x: p.point.x, width: el.clientWidth });
    });

    chartRef.current = { chart, series: apis, amber: theme("--color-amber") };
    return () => {
      chartRef.current = null;
      priceLine.current = null;
      chart.remove();
    };
    // `shape` stands for kind, series and directLabels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const bySec = useMemo(() => new Map<number, Row>(rows.map((r) => [toSec(r.t), r])), [rows]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const slots = buildSlots(rows, series.length, kind, now, windowMs);
    c.series.forEach((s, i) => s.setData(slots[i]!));
    c.chart.timeScale().fitContent();
  }, [rows, now, windowMs, kind, series.length, shape]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    if (priceLine.current) c.series[0]?.removePriceLine(priceLine.current);
    priceLine.current = null;
    if (refLine && c.series[0]) {
      // Labeled on the axis: live data piles up at the right ("now") edge of the plot.
      priceLine.current = c.series[0].createPriceLine({
        price: refLine.value,
        color: c.amber,
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: refLine.label,
      });
    }
  }, [refLine?.value, refLine?.label, shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seconds that hold a point, in order: what the arrow keys step through.
  const t0 = toSec(now - windowMs);
  const secs = useMemo(() => rows.map((r): number => toSec(r.t)).filter((s) => s > t0), [rows, t0]);

  const moveTo = (sec: number) => {
    const c = chartRef.current;
    const row = bySec.get(sec);
    if (!c || !row) return;
    // Anchor the crosshair on the stack's top, or on the first line with a value.
    const total = row.values.reduce<number>((a, v) => a + (v ?? 0), 0);
    const i = kind === "stacked" ? series.length - 1 : row.values.findIndex((v) => v != null);
    const anchor = c.series[Math.max(0, i)];
    if (!anchor) return;
    const value = kind === "stacked" ? total : (row.values[i] ?? 0);
    c.chart.setCrosshairPosition(value, sec as UTCTimestamp, anchor);
    const x = c.chart.timeScale().timeToCoordinate(sec as UTCTimestamp);
    if (x !== null) setHover({ sec, x, width: wrapRef.current?.clientWidth ?? 0 });
  };

  const clear = () => {
    chartRef.current?.chart.clearCrosshairPosition();
    setHover(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!secs.length) return;
    const last = secs.length - 1;
    const at = hover ? secs.indexOf(hover.sec) : -1;
    if (e.key === "ArrowLeft") moveTo(secs[at < 0 ? last : Math.max(0, at - 1)]!);
    else if (e.key === "ArrowRight") moveTo(secs[at < 0 ? last : Math.min(last, at + 1)]!);
    else if (e.key === "Home") moveTo(secs[0]!);
    else if (e.key === "End") moveTo(secs[last]!);
    else if (e.key === "Escape") clear();
    else return;
    e.preventDefault();
  };

  const row = hover ? bySec.get(hover.sec) : undefined;
  const tipLeft = hover ? hover.x > hover.width / 2 : false;

  return (
    <div
      ref={wrapRef}
      className="relative w-full touch-pan-y select-none outline-none"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={label}
      aria-describedby={row ? tipId : undefined}
      onKeyDown={onKey}
      onBlur={clear}
    >
      <div ref={chartEl} className="absolute inset-0" aria-hidden />

      {rows.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center pr-12 text-[0.8125rem] text-muted">
          Waiting for the first seconds of data…
        </p>
      )}

      {hover && row && (
        <div
          id={tipId}
          role="status"
          className={cx(
            "pointer-events-none absolute top-1 z-(--z-popover) min-w-40 rounded-md border border-line-strong bg-surface-2 px-3 py-2 shadow-lg shadow-black/40",
          )}
          style={tipLeft ? { right: hover.width - hover.x + 10 } : { left: hover.x + 10 }}
        >
          <p className="tabular mb-1 text-[0.6875rem] text-muted">{clockFmt.format(row.t)}</p>
          <ul className="flex flex-col gap-0.5">
            {(kind === "stacked" ? [...series].reverse() : series).map((s) => {
              const v = row.values[series.indexOf(s)];
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
                  {format(row.values.reduce<number>((a, v) => a + (v ?? 0), 0))}
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

/** The link to tradingview.com that the charting library's license asks for, once per page. */
export function ChartCredit() {
  return (
    <p className="text-xs text-muted">
      Charts by{" "}
      <a
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noreferrer"
        className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
      >
        TradingView Lightweight Charts™
      </a>
    </p>
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
