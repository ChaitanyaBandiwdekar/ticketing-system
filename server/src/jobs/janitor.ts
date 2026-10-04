/** Janitor: keeps a public demo's database bounded (old burst shows, expired idempotency keys). */
import type { Sql } from "../db/pool";
import { purgeEphemeralShows, purgeIdempotencyKeys } from "../engine/maintenance";
import type { HubLog } from "../realtime/hub";

export type JanitorStats = { showsDeleted: number; keysDeleted: number };

export function createJanitor(
  sql: Sql,
  opts: { ephemeralShowTtlHours: number; idempotencyKeyTtlHours: number },
  log: HubLog,
  onShowsDeleted: (ids: string[]) => void = () => {},
) {
  const stats: JanitorStats = { showsDeleted: 0, keysDeleted: 0 };
  const tick = async (): Promise<void> => {
    const shows = await purgeEphemeralShows(sql, opts.ephemeralShowTtlHours);
    const keys = await purgeIdempotencyKeys(sql, opts.idempotencyKeyTtlHours);
    stats.showsDeleted += shows.length;
    stats.keysDeleted += keys;
    if (shows.length > 0) onShowsDeleted(shows);
    if (shows.length > 0 || keys > 0) {
      log.info({ job: "janitor", shows_deleted: shows.length, keys_deleted: keys }, "janitor");
    }
  };
  return { tick, stats };
}
