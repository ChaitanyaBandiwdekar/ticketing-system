/**
 * The server's clock, as seen from here. Hold deadlines (`expires_at`) are stamped by the
 * database's `now()`, so a countdown against a laptop clock that is a minute off would lie. Every
 * API response's `Date` header nudges the estimate; it has one-second resolution, so the server
 * read its clock somewhere in [date, date + 1s) and we take the middle.
 */
let skewMs = 0;

export function noteServerDate(header: string | null, receivedAt = Date.now()): void {
  if (!header) return;
  const t = Date.parse(header);
  if (!Number.isFinite(t)) return;
  const estimate = t + 500 - receivedAt;
  // Within the header's own resolution, keep what we have rather than jitter.
  if (Math.abs(estimate - skewMs) > 1_000) skewMs = estimate;
}

/** Milliseconds since the epoch on the server's clock (best estimate). */
export function serverNow(): number {
  return Date.now() + skewMs;
}

/** For tests. */
export function resetClock(): void {
  skewMs = 0;
}
