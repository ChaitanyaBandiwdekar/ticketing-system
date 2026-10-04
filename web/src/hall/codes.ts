import type { SeatStatus } from "../lib/api";

/** The stream's one-char seat encoding (server/src/realtime/hub.ts), for REST snapshots too. */
export const SEAT_CODE: Record<SeatStatus, "a" | "h" | "c"> = {
  available: "a",
  held: "h",
  confirmed: "c",
};
