import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ShowDetail } from "../lib/api";
import { SEAT_CODE } from "./codes";
import { FLASH_MS, type SeatCode } from "./draw";
import type { HallGeometry } from "./geometry";
import {
  initialLive,
  liveReducer,
  type AuditFrame,
  type DeltaFrame,
  type LinkState,
  type LiveAction,
  type LiveState,
  type SeatIndex,
  type SnapshotFrame,
} from "./live";

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type LiveShow = LiveState & {
  /** Paint our own just-reserved seats before the stream's delta lands. */
  assume(labels: readonly string[], code: SeatCode): void;
};

/**
 * The show's seat map, kept current by GET /stream (server-sent events), seeded and backed up by
 * the REST read. The browser's EventSource reconnects by itself after a dropped connection (the
 * server asks for 2s); when the server refuses a stream outright (503 at capacity, a deploy), it
 * gives up, so this reopens it with backoff. Every (re)connect starts with a full snapshot.
 */
export function useLiveShow(
  showId: string,
  detail: ShowDetail | undefined,
  geometry: HallGeometry | null,
  events: { onGone?: () => void; onLink?: (link: LinkState) => void } = {},
): LiveShow {
  const index = useMemo<SeatIndex>(
    () => ({ byLabel: geometry?.byLabel ?? new Map(), size: geometry?.seats.length ?? 0 }),
    [geometry],
  );
  const flashMs = useMemo(() => (prefersReducedMotion() ? 0 : FLASH_MS), []);
  const [state, dispatch] = useReducer(
    (s: LiveState, a: LiveAction) => liveReducer(s, a, index, flashMs),
    initialLive,
  );
  const ready = geometry !== null;
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  });

  // The REST read seeds the map, and stands in for the stream while it is down.
  useEffect(() => {
    if (!detail || !ready) return;
    dispatch({
      type: "seed",
      labels: detail.seats.map((s) => s.label),
      status: detail.seats.map((s) => SEAT_CODE[s.status]).join(""),
      counts: detail.counts,
      at: performance.now(),
    });
  }, [detail, ready]);

  useEffect(() => {
    if (!ready) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let disposed = false;

    let link: LinkState | null = null;
    const setLink = (next: LinkState) => {
      if (next === link) return;
      link = next;
      dispatch({ type: "link", link: next });
      eventsRef.current.onLink?.(next);
    };
    const parse = <T>(e: Event) => JSON.parse((e as MessageEvent<string>).data) as T;
    const connect = () => {
      const source = new EventSource(`/stream?show=${encodeURIComponent(showId)}`);
      es = source;
      source.addEventListener("snapshot", (e) => {
        failures = 0;
        dispatch({ type: "snapshot", frame: parse<SnapshotFrame>(e), at: performance.now() });
        setLink("live");
      });
      source.addEventListener("delta", (e) => {
        dispatch({ type: "delta", frame: parse<DeltaFrame>(e), at: performance.now() });
      });
      source.addEventListener("audit", (e) => {
        dispatch({ type: "audit", frame: parse<AuditFrame>(e) });
      });
      source.addEventListener("gone", () => {
        disposed = true;
        source.close();
        setLink("gone");
        eventsRef.current.onGone?.();
      });
      source.onerror = () => {
        if (disposed) return;
        setLink("reconnecting");
        if (source.readyState !== EventSource.CLOSED) return; // the browser retries by itself
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
        failures++;
        timer = setTimeout(connect, wait + Math.floor(Math.random() * 500));
      };
    };

    setLink("connecting");
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [showId, ready]);

  const assume = useCallback(
    (labels: readonly string[], code: SeatCode) =>
      dispatch({ type: "assume", labels, code, at: performance.now() }),
    [],
  );
  return useMemo(() => ({ ...state, assume }), [state, assume]);
}
