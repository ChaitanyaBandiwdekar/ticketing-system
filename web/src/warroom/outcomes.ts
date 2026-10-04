/**
 * Reserve outcomes as the War Room and the Stampede simulator show them: a fixed order and a
 * fixed color per outcome (color follows the outcome, never its rank). Validated palette: see
 * the chart tokens in styles.css.
 */
import type { Series } from "./chartData";

/** Reserve outcomes in a fixed order: color follows the outcome, never its rank. */
export const OUTCOMES: (Series & { match: (o: string) => boolean })[] = [
  {
    key: "created",
    label: "Booked",
    color: "var(--color-series-1)",
    match: (o) => o === "created",
  },
  {
    key: "seat_taken",
    label: "Seat taken",
    color: "var(--color-series-2)",
    match: (o) => o === "seat_taken",
  },
  {
    key: "per_user_limit",
    label: "Over limit",
    color: "var(--color-series-3)",
    match: (o) => o === "per_user_limit",
  },
  {
    key: "replayed",
    label: "Replayed",
    color: "var(--color-series-4)",
    match: (o) => o === "replayed",
  },
  {
    key: "idempotency_key_reused",
    label: "Key reused",
    color: "var(--color-series-5)",
    match: (o) => o === "idempotency_key_reused",
  },
  {
    key: "other",
    label: "Other 4xx",
    color: "var(--color-series-6)",
    match: (o) => !isFailure(o) && !KNOWN.has(o),
  },
  { key: "failed", label: "429 / 5xx", color: "var(--color-series-7)", match: isFailure },
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
]);
export function isFailure(o: string): boolean {
  return FAILURES.has(o) || /^http_(5\d\d|429)$/.test(o);
}

/** The outcome series a raw outcome (created, seat_taken, http_503...) is counted under. */
export function outcomeSeries(o: string): (typeof OUTCOMES)[number] {
  return OUTCOMES.find((s) => s.match(o)) ?? OUTCOMES[OUTCOMES.length - 1]!;
}
