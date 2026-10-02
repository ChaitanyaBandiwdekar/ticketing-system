/**
 * Bounded retry for transient contention errors. Lock order makes deadlocks impossible by design,
 * but a retry here turns "impossible in theory" into "never a 500 in practice":
 *   40P01 deadlock_detected · 40001 serialization_failure · 55P03 lock_not_available (lock_timeout)
 * Each engine call is a single-statement transaction, so re-running it is always safe.
 */
import { setTimeout as sleep } from "node:timers/promises";

export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001", "55P03"]);
/**
 * 57014 query_canceled: a server-side statement_timeout (managed Postgres often sets one per role).
 * Still contention, not a bug, so it must not become a 500; but the statement already ran for the
 * whole timeout, so retrying would only pile more load on a saturated database.
 */
export const TIMEOUT_SQLSTATES: ReadonlySet<string> = new Set(["57014"]);

/** Contention outlasted the retry budget. The API maps this to 503 + Retry-After, never 500. */
export class ContentionError extends Error {
  constructor(
    public readonly sqlState: string,
    public readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(`database contention (${sqlState}) persisted after ${attempts} attempts`, options);
    this.name = "ContentionError";
  }
}

export type RetryOptions = {
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Base backoff; attempt k waits base * 2^(k-1) plus up to 100% jitter. */
  baseDelayMs?: number;
  /** Observability hook (metrics, logs, tests asserting "zero deadlocks"). */
  onRetry?: (sqlState: string, attempt: number) => void;
};

export function sqlStateOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function withContentionRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const base = opts.baseDelayMs ?? 5;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const state = sqlStateOf(err);
      if (state !== undefined && TIMEOUT_SQLSTATES.has(state)) {
        throw new ContentionError(state, attempt, { cause: err });
      }
      if (state === undefined || !RETRYABLE_SQLSTATES.has(state)) throw err;
      if (attempt >= maxAttempts) throw new ContentionError(state, attempt, { cause: err });
      opts.onRetry?.(state, attempt);
      const backoff = base * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * backoff);
    }
  }
}
