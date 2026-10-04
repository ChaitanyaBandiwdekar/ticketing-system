/**
 * Hold-expiry sweeper. Correctness never waits on it: expiry is derived from DB time everywhere
 * (a lapsed hold already reads as available). It finalizes lapsed holds and, more visibly,
 * publishes the released seats so live seat maps flip back to available.
 */
import type { Sql } from "../db/pool";
import { expireHolds } from "../engine/lifecycle";
import type { EventBus } from "../realtime/bus";

/** Rows per fdfs_expire_holds call; a full batch means "more may be due", so sweep again. */
const BATCH = 500;
/** Bounds one tick's work so a huge backlog can't monopolize a pool connection. */
const MAX_ROUNDS_PER_TICK = 20;

export type SweeperStats = { seatsReleased: number; holdsExpired: number };

export function createSweeper(sql: Sql, bus: EventBus) {
  const stats: SweeperStats = { seatsReleased: 0, holdsExpired: 0 };
  const tick = async (): Promise<void> => {
    for (let round = 0; round < MAX_ROUNDS_PER_TICK; round++) {
      const { released, expired } = await expireHolds(sql, BATCH);
      let seats = 0;
      for (const group of released) {
        seats += group.seats.length;
        bus.emit({ showId: group.show_id, labels: group.seats, cause: "expire" });
      }
      stats.seatsReleased += seats;
      stats.holdsExpired += expired;
      if (seats < BATCH && expired < BATCH) return;
    }
  };
  return { tick, stats };
}
