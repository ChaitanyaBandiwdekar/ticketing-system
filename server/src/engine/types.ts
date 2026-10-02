/**
 * Engine-level types. Field names are snake_case because these objects are the API response
 * bodies verbatim (they are built in SQL by fdfs_reservation_json).
 */

export type ReservationStatus = "held" | "confirmed" | "cancelled" | "expired";
export type SeatStatus = "available" | "held" | "confirmed";

export type Reservation = {
  reservation_id: string;
  show_id: string;
  user_id: string;
  /** Labels in seat order. */
  seats: string[];
  amount_paise: number;
  /** Effective status: a hold past its deadline reads as "expired" before the sweeper runs. */
  status: ReservationStatus;
  expires_at: string | null;
  created_at: string;
};

/** "fast": decided from a lock-free snapshot. "locked": decided under row/advisory locks. */
export type DecisionPath = "fast" | "locked";

export type ReserveOutcome =
  | { outcome: "created"; path: "locked"; reservation: Reservation }
  | { outcome: "replayed"; path: DecisionPath; reservation: Reservation }
  | { outcome: "seat_taken"; path: DecisionPath; unavailable_seats: string[] }
  | {
      outcome: "per_user_limit";
      path: DecisionPath;
      limit: number;
      active: number;
      requested: number;
    }
  | { outcome: "idempotency_key_reused"; path: DecisionPath }
  | { outcome: "invalid"; path: DecisionPath; message: string; unknown_seats: string[] }
  | { outcome: "show_not_found"; path: DecisionPath };

export type ReserveOutcomeKind = ReserveOutcome["outcome"];

export type Show = {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  hold_ttl_seconds: number | null;
  total_seats: number;
  ephemeral: boolean;
  created_at: string;
};

export type SeatCounts = {
  total: number;
  available: number;
  held: number;
  confirmed: number;
  /** available + held + confirmed == total, computed from the same snapshot as the seat list. */
  invariant_ok: boolean;
};

export type ShowSnapshot = {
  show: Show;
  /** Effective per-seat state in seat order (lapsed holds read as available). */
  seats: { label: string; status: SeatStatus }[];
  counts: SeatCounts;
};
