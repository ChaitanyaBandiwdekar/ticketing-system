import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cx } from "../components/ui";
import {
  FLASH_MS,
  measure,
  paintHall,
  readHallColors,
  seatAt,
  type HallMetrics,
  type HallPaint,
} from "./draw";
import type { HallGeometry } from "./geometry";

/** Pointer and keyboard wiring for a hall people pick seats on. */
export type HallInteraction = {
  onSeatClick(index: number): void;
  onSeatHover(index: number | null): void;
  /** Whether clicking this seat does anything (drives the cursor). */
  clickable(index: number): boolean;
  onKeyDown(e: KeyboardEvent<HTMLCanvasElement>): void;
  onFocus?(e: FocusEvent<HTMLCanvasElement>): void;
  onBlur?(): void;
  /** Id of the element explaining the keyboard controls. */
  describedBy?: string;
};

type Props = {
  geometry: HallGeometry;
  paint: HallPaint;
  /** Upper bound on seat pitch (CSS px) so small halls don't balloon. */
  maxPitch?: number;
  /** Lower bound on seat pitch; a hall wider than its container then scrolls sideways. */
  minPitch?: number;
  /** Accessible summary of what the map shows. */
  label: string;
  className?: string;
  /** Called with the metrics after each layout (interactive layers hit-test with them). */
  onMetrics?: (m: HallMetrics) => void;
  interaction?: HallInteraction;
  children?: ReactNode;
};

function hasLiveFlash(paint: HallPaint, now: number): boolean {
  if (!paint.flashes) return false;
  for (const at of paint.flashes.values()) if (now - at < FLASH_MS) return true;
  return false;
}

/** The hall drawn on a DPR-aware canvas that fits its container's width. */
export function HallCanvas({
  geometry,
  paint,
  maxPitch,
  minPitch,
  label,
  className,
  onMetrics,
  interaction,
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
    () => (width > 0 ? measure(geometry, width, { maxPitch, minPitch }) : null),
    [geometry, width, maxPitch, minPitch],
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
    const draw = (now: number) => paintHall(ctx, geometry, metrics, { ...paint, now }, colors);
    draw(performance.now());
    // Changed seats glow and fade; animate only while a glow is still visible.
    let frame = 0;
    const tick = (now: number) => {
      draw(now);
      if (hasLiveFlash(paint, now)) frame = requestAnimationFrame(tick);
    };
    if (hasLiveFlash(paint, performance.now())) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [geometry, metrics, paint, colors]);

  const seatFromEvent = (e: PointerEvent<HTMLCanvasElement>): number | null => {
    if (!metrics) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    return seatAt(geometry, metrics, e.clientX - rect.left, e.clientY - rect.top);
  };
  const [pointerClickable, setPointerClickable] = useState(false);

  return (
    <div ref={wrapRef} className={cx("relative w-full", className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        aria-describedby={interaction?.describedBy}
        tabIndex={interaction ? 0 : undefined}
        style={{ width: metrics?.cssWidth ?? "100%", height: metrics?.cssHeight ?? 0 }}
        className={cx(
          "block touch-manipulation rounded-sm",
          interaction && pointerClickable && "cursor-pointer",
        )}
        onPointerMove={
          interaction &&
          ((e) => {
            const i = seatFromEvent(e);
            setPointerClickable(i !== null && interaction.clickable(i));
            if (e.pointerType === "mouse") interaction.onSeatHover(i);
          })
        }
        onPointerLeave={
          interaction &&
          (() => {
            setPointerClickable(false);
            interaction.onSeatHover(null);
          })
        }
        onClick={
          interaction &&
          ((e) => {
            if (!metrics) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const i = seatAt(geometry, metrics, e.clientX - rect.left, e.clientY - rect.top);
            if (i !== null) interaction.onSeatClick(i);
          })
        }
        onKeyDown={interaction?.onKeyDown}
        onFocus={interaction?.onFocus}
        onBlur={interaction?.onBlur}
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
      {showMine && (
        <>
          {item(
            <span className={cx(box, "relative border-[2.5px] border-seat-mine")}>
              <span className="absolute inset-0 m-auto size-1 rounded-full bg-seat-mine" />
            </span>,
            "Your pick",
          )}
          {item(<span className={cx(box, "bg-seat-mine")} />, "Yours")}
        </>
      )}
    </ul>
  );
}
