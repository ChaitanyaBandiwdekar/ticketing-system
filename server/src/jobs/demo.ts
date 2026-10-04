/** Demo shows job: keeps a public hall of each demo spec open (engine/demo.ts). */
import type { Sql } from "../db/pool";
import { ensureDemoShows } from "../engine/demo";
import type { HubLog } from "../realtime/hub";

export function createDemoShows(sql: Sql, opts: { maxSeatsPerShow: number }, log: HubLog) {
  const tick = async (): Promise<void> => {
    for (const show of await ensureDemoShows(sql, opts)) {
      log.info(
        { job: "demo_shows", show_id: show.id, name: show.name, seats: show.total_seats },
        "demo show opened",
      );
    }
  };
  return { tick };
}
