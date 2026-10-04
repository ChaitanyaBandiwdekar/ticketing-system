/**
 * Invariant reconciler: every few seconds, audit() each recently active show. That means shows
 * with seat changes in the last few minutes, plus shows someone is watching. A violation is
 * logged as an error and counted (the `fdfs_invariant_violations_total` metric, which should
 * read 0 forever). Every verdict is pushed to the show's live streams for the invariant badge.
 */
import type { Sql } from "../db/pool";
import { audit } from "../engine/audit";
import type { AuditReport } from "../engine/types";
import type { EventBus } from "../realtime/bus";
import type { HubLog } from "../realtime/hub";

/** A show stays "active" this long after its last seat change. */
const ACTIVE_WINDOW_MS = 10 * 60_000;
/** Audits per tick: bounds the reconciler's DB cost however many shows a burst creates. */
const MAX_SHOWS_PER_TICK = 25;

export type ReconcilerStats = {
  /** Total violations observed across all audits (a persisting violation counts each tick). */
  violations: number;
  audits: number;
};

export type ReconcilerDeps = {
  sql: Sql;
  bus: EventBus;
  log: HubLog;
  /** Shows with live subscribers. */
  watchedShows?: () => string[];
  onReport?: (report: AuditReport, at: Date) => void;
};

export function createReconciler(deps: ReconcilerDeps) {
  const lastActivity = new Map<string, number>();
  const latest = new Map<string, { report: AuditReport; at: Date }>();
  const stats: ReconcilerStats = { violations: 0, audits: 0 };

  const unsubscribe = deps.bus.on((change) => lastActivity.set(change.showId, Date.now()));

  const forget = (showIds: string[]) => {
    for (const id of showIds) {
      lastActivity.delete(id);
      latest.delete(id);
    }
  };

  const activeShows = (): string[] => {
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    for (const [id, at] of lastActivity) if (at < cutoff) lastActivity.delete(id);
    const byRecency = [...lastActivity.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const ids = new Set([...(deps.watchedShows?.() ?? []), ...byRecency]);
    return [...ids].slice(0, MAX_SHOWS_PER_TICK);
  };

  const tick = async (): Promise<void> => {
    const active = activeShows();
    for (const showId of active) {
      const report = await audit(deps.sql, showId);
      if (!report) {
        forget([showId]);
        continue;
      }
      const at = new Date();
      stats.audits++;
      latest.set(showId, { report, at });
      if (!report.ok) {
        stats.violations += report.violations.length;
        deps.log.error(
          { show: showId, violations: report.violations.slice(0, 10), counts: report.counts },
          "invariant_violation",
        );
      }
      deps.onReport?.(report, at);
    }
    // Only the active set's verdicts are kept, so `latest` stays bounded.
    const keep = new Set(active);
    for (const id of latest.keys()) if (!keep.has(id)) latest.delete(id);
  };

  return { tick, stats, latest, forget, activeShows, stop: unsubscribe };
}
