/**
 * Is a burst hitting this instance right now? Read off the live feed's per-second points, so the
 * War Room can stand the last burst's scorecard down while a new one runs instead of showing an
 * old verdict above fresh traffic.
 *
 * A burst second is one with at least BURST_RATE reserve responses: well above a person booking
 * by hand, well below any burst. Seconds closer than GAP_MS belong to the same burst. After the
 * traffic stops the burst is `finishing` until a report newer than its start is stored, or for
 * at most REPORT_WAIT_MS (a burst that couldn't record its report must not hide the scorecard).
 */
import type { BurstRun, Point } from "../../../server/src/obs/types";
import { groupCounts } from "./outcomes";

export const BURST_RATE = 10;
export const GAP_MS = 8_000;
export const REPORT_WAIT_MS = 60_000;

export type BurstState =
  | { phase: "idle" }
  | {
      phase: "running" | "finishing";
      /** Server time (ms) of the burst's first busy second, and of its last. */
      startedAt: number;
      lastAt: number;
      requests: number;
      booked: number;
      declined: number;
      failed: number;
      /** Reserve responses per second over the last few seconds. */
      rate: number;
    };

const reserves = (p: Point) => Object.values(p.reserve).reduce((a, n) => a + n, 0);

/** `now` is the latest point's server time; `latest` the newest stored run. */
export function burstState(points: Point[], now: number, latest: BurstRun | undefined): BurstState {
  let end = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (reserves(points[i]!) >= BURST_RATE) {
      end = i;
      break;
    }
  }
  if (end < 0) return { phase: "idle" };
  const lastAt = points[end]!.t;
  const quiet = now - lastAt;
  if (quiet > REPORT_WAIT_MS) return { phase: "idle" };

  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const p = points[i]!;
    if (points[start]!.t - p.t > GAP_MS) break;
    if (reserves(p) >= BURST_RATE) start = i;
  }
  const startedAt = points[start]!.t;

  const running = quiet <= GAP_MS;
  if (!running && latest && Date.parse(latest.created_at) >= startedAt) return { phase: "idle" };

  let requests = 0;
  let booked = 0;
  let declined = 0;
  let failed = 0;
  for (let i = start; i < points.length; i++) {
    const p = points[i]!;
    const g = groupCounts(p.reserve);
    requests += reserves(p);
    booked += g.booked;
    declined += g.declined;
    failed += g.failed;
  }
  const recent = points.slice(-5);
  const rate = running ? recent.reduce((a, p) => a + reserves(p), 0) / recent.length : 0;

  return {
    phase: running ? "running" : "finishing",
    startedAt,
    lastAt,
    requests,
    booked,
    declined,
    failed,
    rate,
  };
}
