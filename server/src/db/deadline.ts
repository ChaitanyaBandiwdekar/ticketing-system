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

/**
 * When the database last answered anything on the request path. A deadline consults it before
 * failing: if the database answered some other call within the last deadline window, it is
 * alive and this call is only queued behind a busy pool, a cold pool reconnecting, or a CPU-
 * starved event loop. The call then keeps waiting, up to a hard cap. A pooler queueing for a
 * dead Postgres answers nothing, so that still fails at the deadline.
 *
 * Why: at 0.1 CPU a burst's first wave queues for 15-25s (measured in CI), often against a cold
 * pool (idle_timeout closes idle connections after 30s), while the database answers everyone
 * else. "Slow is fine, 5xx is not": the deadline is for a silent database, not a busy one.
 */
export class DbProgress {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly now: () => number = () => performance.now()) {}
  mark(): void {
    this.last = this.now();
  }
  /** Milliseconds since the database last answered (Infinity if never). */
  sinceMs(): number {
    return this.now() - this.last;
  }
}

/** The longest a call may wait while the database is answering others: 6 deadlines. */
export const DEADLINE_CAP_FACTOR = 6;

export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  progress?: DbProgress,
  now: () => number = () => performance.now(),
): Promise<T> {
  const start = now();
  const cap = ms * DEADLINE_CAP_FACTOR;
  let timer: NodeJS.Timeout | undefined;
  let check: NodeJS.Immediate | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const arm = (delay: number) => {
      // When the timer fires, the answer may already be sitting in the socket: a saturated
      // event loop (0.1 CPU under a stampede) runs due timers BEFORE it polls I/O. Deciding one
      // turn later, after the poll phase, never turns an answered query into a 503.
      timer = setTimeout(() => {
        check = setImmediate(() => {
          const quiet = progress ? progress.sinceMs() : Number.POSITIVE_INFINITY;
          const waited = now() - start;
          if (quiet < ms && waited < cap) arm(Math.min(ms - quiet, cap - waited));
          else reject(new DbDeadlineError(ms));
        });
      }, delay);
    };
    arm(ms);
  });
  // The abandoned work may still reject later; observe it so that's never an unhandled rejection.
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    clearImmediate(check);
  });
}
