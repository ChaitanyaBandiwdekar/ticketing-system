import type { SeatStatus } from "../lib/api";

/** One char per seat on the stream: a=available h=held c=confirmed. */
export type SeatCode = "a" | "h" | "c";

/** The stream's one-char seat encoding (server/src/realtime/hub.ts), for REST snapshots too. */
export const SEAT_CODE: Record<SeatStatus, SeatCode> = {
  available: "a",
  held: "h",
  confirmed: "c",
};
