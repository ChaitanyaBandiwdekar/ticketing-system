/** Janitor: keeps a public demo's database bounded (old burst shows, expired idempotency keys). */
import type { Sql } from "../db/pool";
import { purgeEphemeralShows, purgeIdempotencyKeys } from "../engine/maintenance";
import { pruneRuns } from "../engine/runs";
import type { HubLog } from "../realtime/hub";

/** Burst reports kept for the War Room's scorecard; older ones are deleted. */
export const RUNS_KEPT = 50;

export type JanitorStats = { showsDeleted: number; keysDeleted: number; runsDeleted: number };

export function createJanitor(
  sql: Sql,
  opts: { ephemeralShowTtlHours: number; idempotencyKeyTtlHours: number },
  log: HubLog,
  onShowsDeleted: (ids: string[]) => void = () => {},
) {
  const stats: JanitorStats = { showsDeleted: 0, keysDeleted: 0, runsDeleted: 0 };
  const tick = async (): Promise<void> => {
    const shows = await purgeEphemeralShows(sql, opts.ephemeralShowTtlHours);
    const keys = await purgeIdempotencyKeys(sql, opts.idempotencyKeyTtlHours);
    const runs = await pruneRuns(sql, RUNS_KEPT);
    stats.showsDeleted += shows.length;
    stats.keysDeleted += keys;
    stats.runsDeleted += runs;
    if (shows.length > 0) onShowsDeleted(shows);
    if (shows.length > 0 || keys > 0 || runs > 0) {
      log.info(
        { job: "janitor", shows_deleted: shows.length, keys_deleted: keys, runs_deleted: runs },
        "janitor",
      );
    }
  };
  return { tick, stats };
}
