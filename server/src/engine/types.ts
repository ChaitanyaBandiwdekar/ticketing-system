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

export type LifecycleOutcome =
  /** changed=false: an idempotent repeat (already confirmed / already cancelled). */
  | { outcome: "confirmed" | "cancelled"; changed: boolean; reservation: Reservation }
  | {
      outcome: "reservation_expired" | "reservation_cancelled";
      changed: false;
      reservation: Reservation;
    }
  | { outcome: "not_found" }
  | { outcome: "forbidden" };

export type ExpireHoldsResult = {
  /** Seats returned to "available", grouped by show (feeds realtime deltas). */
  released: { show_id: string; seats: string[] }[];
  /** Reservations finalized as "expired". */
  expired: number;
};

export type AuditCheck =
  "seat_count" | "counts" | "orphan_seat" | "missing_seats" | "amount" | "per_user_limit";

export type AuditReport = {
  show_id: string;
  ok: boolean;
  counts: SeatCounts;
  /** Capped at 100. */
  violations: { check: AuditCheck; detail: string }[];
};
