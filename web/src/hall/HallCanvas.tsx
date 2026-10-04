import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../components/ui";
import { measure, paintHall, readHallColors, type HallMetrics, type HallPaint } from "./draw";
import type { HallGeometry } from "./geometry";

type Props = {
  geometry: HallGeometry;
  paint: HallPaint;
  /** Upper bound on seat pitch (CSS px) so small halls don't balloon. */
  maxPitch?: number;
  /** Accessible summary of what the map shows. */
  label: string;
  className?: string;
  /** Called with the metrics after each layout (interactive layers hit-test with them). */
  onMetrics?: (m: HallMetrics) => void;
  children?: ReactNode;
};

/** The hall drawn on a DPR-aware canvas that fits its container's width. */
export function HallCanvas({
  geometry,
  paint,
  maxPitch,
  label,
  className,
  onMetrics,
  children,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = useMemo(
    () => (width > 0 ? measure(geometry, width, { maxPitch }) : null),
    [geometry, width, maxPitch],
  );
  const colors = useMemo(() => readHallColors(), []);

  useEffect(() => {
    if (metrics) onMetrics?.(metrics);
  }, [metrics, onMetrics]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !metrics) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(metrics.cssWidth * dpr);
    const h = Math.round(metrics.cssHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintHall(ctx, geometry, metrics, paint, colors);
  }, [geometry, metrics, paint, colors]);

  return (
    <div ref={wrapRef} className={cx("relative w-full", className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        style={{ width: metrics?.cssWidth ?? "100%", height: metrics?.cssHeight ?? 0 }}
        className="block"
      />
      {children}
    </div>
  );
}

/** The screen: a lit curve at the front of the hall, its light falling on the first rows. */
export function Screen({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none relative mx-auto mb-6 w-[78%] max-w-3xl pt-2">
      <svg
        viewBox="0 0 400 28"
        className="block w-full overflow-visible"
        preserveAspectRatio="none"
      >
        <defs>
          <filter id="screen-glow" x="-10%" y="-200%" width="120%" height="500%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>
        <path
          d="M4 22 Q200 -6 396 22"
          fill="none"
          stroke="var(--color-primary-ink)"
          strokeWidth="6"
          opacity={dimmed ? 0.15 : 0.55}
          filter="url(#screen-glow)"
        />
        <path
          d="M4 22 Q200 -6 396 22"
          fill="none"
          stroke="var(--color-primary-ink)"
          strokeWidth="2.25"
          strokeLinecap="round"
          opacity={dimmed ? 0.4 : 1}
        />
      </svg>
      <div
        className="absolute inset-x-[6%] top-5 h-16"
        style={{
          background:
            "radial-gradient(60% 100% at 50% 0%, oklch(0.76 0.13 262 / 0.13), transparent 70%)",
        }}
      />
      <p className="mt-1 text-center font-mono text-[0.6875rem] tracking-[0.3em] text-muted">
        SCREEN
      </p>
    </div>
  );
}

/** Key for the seat glyphs. Mirrors draw.ts: shape carries state as much as color does. */
export function HallLegend({ showMine = false }: { showMine?: boolean }) {
  const item = (glyph: ReactNode, text: string) => (
    <li className="flex items-center gap-2">
      {glyph}
      <span>{text}</span>
    </li>
  );
  const box = "size-3.5 rounded-[0.2rem]";
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
      {item(<span className={cx(box, "border-[1.5px] border-seat-free")} />, "Available")}
      {item(
        <span
          className={cx(box, "border-[1.5px] border-seat-held")}
          style={{
            background: "linear-gradient(to bottom, transparent 50%, var(--color-seat-held) 50%)",
          }}
        />,
        "Held",
      )}
      {item(<span className={cx(box, "bg-seat-sold")} />, "Sold")}
      {showMine && item(<span className={cx(box, "bg-seat-mine")} />, "Yours")}
    </ul>
  );
}
