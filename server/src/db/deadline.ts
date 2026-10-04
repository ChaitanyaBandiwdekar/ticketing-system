/**
 * A deadline for request-path DB calls, so a client never hangs on an unreachable database.
 *
 * Why it's needed: behind a transaction pooler the app's connections are to the POOLER, which
 * stays up when Postgres goes away. The pooler then queues each query until its own wait timeout
 * (PgBouncer's query_wait_timeout defaults to 120s), so without this an outage looks like a hang
 * instead of a fast 503.
 *
 * The deadline abandons the wait. It does not cancel the query, which may still run once the
 * database is back. For a reserve that is safe: the client got 503 (outcome unknown) and retries
 * with the same Idempotency-Key, which replays the booking if it did commit.
 */

/** Marked like a postgres.js connection error, so isDbUnavailable() maps it to 503. */
export class DbDeadlineError extends Error {
  readonly code = "DB_DEADLINE";
  constructor(ms: number) {
    super(`database did not answer within ${ms}ms`);
    this.name = "DbDeadlineError";
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let check: NodeJS.Immediate | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // When the timer fires, the answer may already be sitting in the socket: a saturated event
    // loop (0.1 CPU under a stampede) runs due timers BEFORE it polls I/O. Deciding one turn
    // later, after the poll phase, never turns an answered query into a 503 (found by the
    // Phase 8 overload burst). A truly silent database still fails, one loop turn later.
    timer = setTimeout(() => {
      check = setImmediate(() => reject(new DbDeadlineError(ms)));
    }, ms);
  });
  // The abandoned work may still reject later; observe it so that's never an unhandled rejection.
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    clearImmediate(check);
  });
}
