/**
 * Reserve outcomes as the War Room and the Stampede simulator show them: a fixed order and a
 * fixed color per outcome (color follows the outcome, never its rank). Validated palette: see
 * the chart tokens in styles.css.
 *
 * Each outcome also belongs to one of three groups, which is how the War Room reads a burst at a
 * glance: booked (the accent), declined correctly (de-emphasis gray: the system working), and
 * failed (the danger status color: the only thing that should never happen).
 */
import type { Series } from "./chartData";

export type OutcomeGroup = "booked" | "declined" | "failed";

/** Reserve outcomes in a fixed order: color follows the outcome, never its rank. */
export const OUTCOMES: (Series & { group: OutcomeGroup; match: (o: string) => boolean })[] = [
  {
    key: "created",
    label: "Booked",
    color: "var(--color-series-1)",
    group: "booked",
    match: (o) => o === "created",
  },
  {
    key: "seat_taken",
    label: "Seat taken",
    color: "var(--color-series-2)",
    group: "declined",
    match: (o) => o === "seat_taken",
  },
  {
    key: "per_user_limit",
    label: "Over limit",
    color: "var(--color-series-3)",
    group: "declined",
    match: (o) => o === "per_user_limit",
  },
  {
    key: "replayed",
    label: "Replayed",
    color: "var(--color-series-4)",
    group: "declined",
    match: (o) => o === "replayed",
  },
  {
    key: "idempotency_key_reused",
    label: "Key reused",
    color: "var(--color-series-5)",
    group: "declined",
    match: (o) => o === "idempotency_key_reused",
  },
  {
    key: "other",
    label: "Other 4xx",
    color: "var(--color-series-6)",
    group: "declined",
    match: (o) => !isFailure(o) && !KNOWN.has(o),
  },
  {
    key: "failed",
    label: "429 / 5xx",
    color: "var(--color-series-7)",
    group: "failed",
    match: isFailure,
  },
];
const KNOWN = new Set([
  "created",
  "seat_taken",
  "per_user_limit",
  "replayed",
  "idempotency_key_reused",
]);
const FAILURES = new Set([
  "overloaded",
  "contention",
  "db_unavailable",
  "internal",
  "shutting_down",
  "network_error",
]);
export function isFailure(o: string): boolean {
  return FAILURES.has(o) || /^http_(5\d\d|429)$/.test(o);
}

/** The outcome series a raw outcome (created, seat_taken, http_503...) is counted under. */
export function outcomeSeries(o: string): (typeof OUTCOMES)[number] {
  return OUTCOMES.find((s) => s.match(o)) ?? OUTCOMES[OUTCOMES.length - 1]!;
}

/** The three groups, bottom of a stack first, so bookings always sit on the baseline. */
export const GROUPS: (Series & { key: OutcomeGroup; hint: string })[] = [
  { key: "booked", label: "Booked", color: "var(--color-series-1)", hint: "a seat was sold" },
  {
    key: "declined",
    label: "Declined correctly",
    color: "var(--color-decline-1)",
    hint: "seat taken, over the limit, or an idempotent replay",
  },
  {
    key: "failed",
    label: "Failed",
    color: "var(--color-danger)",
    hint: "shed with 429, or a 5xx",
  },
];

/** Counts per group from raw outcome counts. */
export function groupCounts(outcomes: Record<string, number>): Record<OutcomeGroup, number> {
  const out: Record<OutcomeGroup, number> = { booked: 0, declined: 0, failed: 0 };
  for (const [o, n] of Object.entries(outcomes)) out[outcomeSeries(o).group] += n;
  return out;
}
