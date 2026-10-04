/**
 * Canvas renderer for the hall. 10k+ seats as DOM/SVG nodes would crawl; on canvas one frame is
 * a handful of batched paths (one per visual state), a few ms even at 20k seats.
 *
 * Seat state is carried by SHAPE as well as color (WCAG 1.4.1):
 *   free      hollow outline
 *   held      outline + bottom half filled (pending)
 *   sold      solid, dim
 *   yours     solid cobalt (+ a check when large enough); your hold is half-filled cobalt
 *   selected  thick cobalt ring + centre dot
 */
import type { HallGeometry } from "./geometry";

export type SeatCode = "a" | "h" | "c";

export type HallPaint = {
  /** One char per seat in seat order: a=available h=held c=confirmed. */
  status: string;
  mine?: ReadonlySet<number>;
  selected?: ReadonlySet<number>;
  focus?: number | null;
  /** Seat index -> time (ms, performance.now) it last changed; drawn as a fading glow. */
  flashes?: ReadonlyMap<number, number>;
  now?: number;
};

export type HallMetrics = {
  /** Centre-to-centre distance, CSS px. */
  pitch: number;
  /** Seat box size, CSS px. */
  seat: number;
  gutter: number;
  padY: number;
  cssWidth: number;
  cssHeight: number;
  showRowLabels: boolean;
};

export type HallColors = {
  free: string;
  held: string;
  sold: string;
  mine: string;
  focus: string;
  label: string;
  bg: string;
};

export const FLASH_MS = 700;

export function readHallColors(el: Element = document.documentElement): HallColors {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    free: v("--color-seat-free", "#7f8aa8"),
    held: v("--color-seat-held", "#f2b14a"),
    sold: v("--color-seat-sold", "#3a3a3a"),
    mine: v("--color-seat-mine", "#6f8cff"),
    focus: v("--color-seat-focus", "#f4f4f4"),
    label: v("--color-muted", "#9a9a9a"),
    bg: v("--color-bg", "#0b0b0b"),
  };
}

export function measure(
  geo: HallGeometry,
  cssWidth: number,
  opts: { maxPitch?: number; minPitch?: number } = {},
): HallMetrics {
  const maxPitch = opts.maxPitch ?? 30;
  const minPitch = opts.minPitch ?? 3;
  const labelled = geo.mode === "rows" && geo.rows.length > 0;
  let gutter = labelled ? 28 : 4;
  let pitch = Math.min(maxPitch, Math.max(minPitch, (cssWidth - 2 * gutter) / geo.width));
  const showRowLabels = labelled && pitch >= 12;
  if (!showRowLabels) {
    gutter = 4;
    pitch = Math.min(maxPitch, Math.max(minPitch, (cssWidth - 2 * gutter) / geo.width));
  }
  const seat = pitch * (pitch >= 12 ? 0.78 : 0.84);
  const padY = Math.max(4, pitch * 0.25);
  return {
    pitch,
    seat,
    gutter,
    padY,
    cssWidth,
    cssHeight: Math.ceil(geo.height * pitch + padY * 2),
    showRowLabels,
  };
}

/** Top-left of seat `x,y` (seat units) in CSS px. The hall is centred horizontally. */
function origin(geo: HallGeometry, m: HallMetrics) {
  return { ox: (m.cssWidth - geo.width * m.pitch) / 2, oy: m.padY };
}

export function seatRect(geo: HallGeometry, m: HallMetrics, index: number) {
  const s = geo.bySeat[index];
  if (!s) return null;
  const { ox, oy } = origin(geo, m);
  const inset = (m.pitch - m.seat) / 2;
  return { x: ox + s.x * m.pitch + inset, y: oy + s.y * m.pitch + inset, size: m.seat };
}

/** Hit test in CSS px; returns the seat index or null (gaps between seats count as misses). */
export function seatAt(geo: HallGeometry, m: HallMetrics, px: number, py: number): number | null {
  const { ox, oy } = origin(geo, m);
  const inset = (m.pitch - m.seat) / 2;
  for (const s of geo.seats) {
    const x = ox + s.x * m.pitch + inset;
    const y = oy + s.y * m.pitch + inset;
    if (px >= x && px <= x + m.seat && py >= y && py <= y + m.seat) return s.index;
  }
  return null;
}

function addSeat(path: Path2D, x: number, y: number, w: number, h: number, r: number | number[]) {
  if (typeof path.roundRect === "function") path.roundRect(x, y, w, h, r);
  else path.rect(x, y, w, h);
}

export function paintHall(
  ctx: CanvasRenderingContext2D,
  geo: HallGeometry,
  m: HallMetrics,
  paint: HallPaint,
  colors: HallColors,
): void {
  ctx.clearRect(0, 0, m.cssWidth, m.cssHeight);
  const { ox, oy } = origin(geo, m);
  const inset = (m.pitch - m.seat) / 2;
  const s = m.seat;
  const r = Math.max(1, s * 0.26);
  const line = Math.max(1, s * 0.09);
  const half = s * 0.5;

  const freeP = new Path2D();
  const heldOutline = new Path2D();
  const heldFill = new Path2D();
  const sold = new Path2D();
  const mineSolid = new Path2D();
  const mineOutline = new Path2D();
  const mineHalf = new Path2D();
  const selected = new Path2D();
  const dots = new Path2D();
  const checks: { x: number; y: number }[] = [];

  for (const cell of geo.seats) {
    const x = ox + cell.x * m.pitch + inset;
    const y = oy + cell.y * m.pitch + inset;
    const code = paint.status[cell.index] as SeatCode | undefined;
    const isMine = paint.mine?.has(cell.index) ?? false;
    if (paint.selected?.has(cell.index) && code === "a") {
      addSeat(selected, x, y, s, s, r);
      dots.moveTo(x + s / 2 + s * 0.13, y + s / 2);
      dots.arc(x + s / 2, y + s / 2, s * 0.13, 0, Math.PI * 2);
      continue;
    }
    if (isMine && code === "c") {
      addSeat(mineSolid, x, y, s, s, r);
      if (s >= 12) checks.push({ x, y });
    } else if (isMine && code === "h") {
      addSeat(mineOutline, x, y, s, s, r);
      addSeat(mineHalf, x, y + half, s, s - half, [0, 0, r, r]);
    } else if (code === "c") {
      addSeat(sold, x, y, s, s, r);
    } else if (code === "h") {
      addSeat(heldOutline, x, y, s, s, r);
      addSeat(heldFill, x, y + half, s, s - half, [0, 0, r, r]);
    } else {
      addSeat(freeP, x, y, s, s, r);
    }
  }

  // Inset strokes by half the line width so outlines and fills share one silhouette.
  ctx.lineWidth = line;
  ctx.strokeStyle = colors.free;
  ctx.stroke(freeP);
  ctx.fillStyle = colors.sold;
  ctx.fill(sold);
  ctx.strokeStyle = colors.held;
  ctx.stroke(heldOutline);
  ctx.fillStyle = colors.held;
  ctx.fill(heldFill);
  ctx.fillStyle = colors.mine;
  ctx.fill(mineSolid);
  ctx.fill(mineHalf);
  ctx.strokeStyle = colors.mine;
  ctx.stroke(mineOutline);
  ctx.lineWidth = Math.max(1.5, s * 0.16);
  ctx.stroke(selected);
  ctx.fill(dots);

  if (checks.length) {
    ctx.strokeStyle = colors.bg;
    ctx.lineWidth = Math.max(1.5, s * 0.12);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const p = new Path2D();
    for (const { x, y } of checks) {
      p.moveTo(x + s * 0.28, y + s * 0.52);
      p.lineTo(x + s * 0.44, y + s * 0.68);
      p.lineTo(x + s * 0.73, y + s * 0.34);
    }
    ctx.stroke(p);
  }

  if (paint.flashes?.size) {
    const now = paint.now ?? performance.now();
    for (const [index, at] of paint.flashes) {
      const t = (now - at) / FLASH_MS;
      if (t < 0 || t >= 1) continue;
      const rect = seatRect(geo, m, index);
      if (!rect) continue;
      ctx.globalAlpha = (1 - t) * (1 - t) * 0.9;
      ctx.strokeStyle = colors.focus;
      ctx.lineWidth = Math.max(1, s * 0.12);
      const grow = 2 + t * s * 0.35;
      const g = new Path2D();
      addSeat(g, rect.x - grow, rect.y - grow, s + grow * 2, s + grow * 2, r + grow);
      ctx.stroke(g);
    }
    ctx.globalAlpha = 1;
  }

  if (paint.focus != null) {
    const rect = seatRect(geo, m, paint.focus);
    if (rect) {
      ctx.strokeStyle = colors.focus;
      ctx.lineWidth = 2;
      const g = new Path2D();
      addSeat(g, rect.x - 3, rect.y - 3, s + 6, s + 6, r + 3);
      ctx.stroke(g);
    }
  }

  if (m.showRowLabels) {
    ctx.fillStyle = colors.label;
    const size = Math.max(9, Math.min(11, Math.round(m.pitch * 0.5)));
    ctx.font = `500 ${size}px "Geist Mono Variable", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    for (const row of geo.rows) {
      const cy = oy + row.y * m.pitch + m.pitch / 2;
      ctx.textAlign = "left";
      ctx.fillText(row.label, 4, cy);
      ctx.textAlign = "right";
      ctx.fillText(row.label, m.cssWidth - 4, cy);
    }
  }
}
