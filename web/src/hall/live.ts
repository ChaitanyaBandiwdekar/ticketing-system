/**
 * The live seat map as a pure state machine over /stream frames (protocol in
 * server/src/realtime/hub.ts). Status is a string with one char per seat, indexed like the hall
 * geometry (a=available h=held c=confirmed). No DOM and no timers: useLiveShow feeds it frames
 * and timestamps. Frames are applied in arrival order, which is what the server's convergence
 * argument relies on: a delta overwrites the seats it lists, a snapshot replaces everything.
 */
import type { SeatCounts } from "../lib/api";
import type { SeatCode } from "./codes";

export type SnapshotFrame = {
  seq: number;
  counts: SeatCounts;
  labels: string[];
  status: string;
};

export type DeltaFrame = {
  seq: number;
  changes: Record<string, SeatCode>;
  counts: SeatCounts;
};

export type AuditFrame = { show_id: string; ok: boolean; violations: number; at: string };

/** Where the map stands with the server. */
export type LinkState = "connecting" | "live" | "reconnecting" | "gone";

export type LiveState = {
  /** null until the first REST seed or snapshot. */
  status: string | null;
  counts: SeatCounts | null;
  link: LinkState;
  /** Where the current map came from; a REST seed never overwrites a live stream. */
  source: "rest" | "stream" | null;
  audit: AuditFrame | null;
  /** Seat index -> when (performance.now) it last changed, for the change glow. */
  flashes: ReadonlyMap<number, number>;
};

/** The hall's seat order: label -> index, plus the seat count. */
export type SeatIndex = { byLabel: ReadonlyMap<string, number>; size: number };

export type LiveAction =
  | { type: "seed"; labels: readonly string[]; status: string; counts: SeatCounts; at: number }
  | { type: "snapshot"; frame: SnapshotFrame; at: number }
  | { type: "delta"; frame: DeltaFrame; at: number }
  | { type: "audit"; frame: AuditFrame }
  | { type: "link"; link: LinkState }
  /** Paint seats we know changed (our own reserve) before the stream says so. */
  | { type: "assume"; labels: readonly string[]; code: SeatCode; at: number };

export const initialLive: LiveState = {
  status: null,
  counts: null,
  link: "connecting",
  source: null,
  audit: null,
  flashes: new Map(),
};

/**
 * Lays `status` (in `labels` order) onto the hall's order. Labels the hall doesn't know are
 * ignored; seats the frame doesn't mention keep `prev` (or read as available). The common case,
 * identical order, is a straight copy.
 */
export function remap(
  labels: readonly string[],
  status: string,
  index: SeatIndex,
  prev: string | null,
): string {
  if (labels.length === index.size && status.length === index.size) {
    let same = true;
    for (let i = 0; i < labels.length && same; i++) same = index.byLabel.get(labels[i]!) === i;
    if (same) return status;
  }
  const chars = prev && prev.length === index.size ? prev.split("") : Array(index.size).fill("a");
  labels.forEach((label, i) => {
    const at = index.byLabel.get(label);
    const code = status[i];
    if (at !== undefined && code) chars[at] = code;
  });
  return chars.join("");
}

/** Applies a delta's changes; returns `prev` itself when nothing moved. */
export function applyChanges(
  prev: string,
  changes: Readonly<Record<string, string>>,
  index: SeatIndex,
): { status: string; changed: number[] } {
  const changed: number[] = [];
  let chars: string[] | null = null;
  for (const [label, code] of Object.entries(changes)) {
    const at = index.byLabel.get(label);
    if (at === undefined || prev[at] === code) continue;
    chars ??= prev.split("");
    chars[at] = code;
    changed.push(at);
  }
  return { status: chars ? chars.join("") : prev, changed };
}

/** Indices whose char differs between two maps of the same hall. */
export function diff(a: string | null, b: string): number[] {
  if (a === null || a.length !== b.length) return [];
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

export function withFlashes(
  prev: ReadonlyMap<number, number>,
  changed: readonly number[],
  at: number,
  ttlMs: number,
): ReadonlyMap<number, number> {
  if (changed.length === 0 && prev.size === 0) return prev;
  const next = new Map<number, number>();
  for (const [i, t] of prev) if (at - t < ttlMs) next.set(i, t);
  for (const i of changed) next.set(i, at);
  return next;
}

/**
 * The reducer. `index` is the hall's seat order; `flashMs` is how long a change glows (0 turns
 * the glow off, e.g. for reduced motion).
 */
export function liveReducer(
  state: LiveState,
  action: LiveAction,
  index: SeatIndex,
  flashMs: number,
): LiveState {
  const flash = (changed: number[], at: number) =>
    flashMs > 0 ? withFlashes(state.flashes, changed, at, flashMs) : state.flashes;
  switch (action.type) {
    case "seed": {
      // A REST read may have been in flight when the stream connected; the stream wins.
      if (state.source === "stream" && state.link === "live") return state;
      const status = remap(action.labels, action.status, index, state.status);
      return {
        ...state,
        status,
        counts: action.counts,
        source: "rest",
        flashes: flash(diff(state.status, status), action.at),
      };
    }
    case "snapshot": {
      const { frame } = action;
      const status = remap(frame.labels, frame.status, index, state.status);
      return {
        ...state,
        status,
        counts: frame.counts,
        link: "live",
        source: "stream",
        flashes: flash(diff(state.status, status), action.at),
      };
    }
    case "delta": {
      // A delta before any map can't be placed; the connect snapshot always comes first.
      if (state.status === null) return state;
      const { status, changed } = applyChanges(state.status, action.frame.changes, index);
      return { ...state, status, counts: action.frame.counts, flashes: flash(changed, action.at) };
    }
    case "audit":
      return { ...state, audit: action.frame };
    case "link":
      return state.link === action.link ? state : { ...state, link: action.link };
    case "assume": {
      if (state.status === null) return state;
      const changes = Object.fromEntries(action.labels.map((l) => [l, action.code]));
      const { status, changed } = applyChanges(state.status, changes, index);
      return status === state.status
        ? state
        : { ...state, status, flashes: flash(changed, action.at) };
    }
  }
}
