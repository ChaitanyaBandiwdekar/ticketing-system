/**
 * Booking requests that are safe to retry. A reserve carries a client-generated Idempotency-Key
 * that stays the same across every retry of one attempt, so a request that timed out after the
 * server committed comes back as a 200 replay of the same reservation, never a second booking.
 * Confirm and cancel are idempotent on the server already.
 */
import { ApiError } from "./api";

/** Transport trouble or overload: the request may not have run, and the same request may be sent again. */
export function isTransient(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    (err.status === 0 || err.status === 429 || (err.status >= 502 && err.status <= 504))
  );
}

export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Non-secure contexts (plain http on a LAN address) lack randomUUID.
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export type RetryOptions = {
  /** Total tries, including the first. */
  attempts?: number;
  /** Called before each retry with the try about to run (2, 3, ...) and the wait. */
  onRetry?: (attempt: number, delayMs: number, err: ApiError) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const MAX_DELAY_MS = 8_000;

/** The wait before try `attempt` (2, 3, ...): the server's Retry-After, else jittered backoff. */
export function retryDelay(attempt: number, err: ApiError, random = Math.random): number {
  if (err.retryAfterS) return Math.min(err.retryAfterS * 1000, MAX_DELAY_MS);
  return Math.min(500 * 2 ** (attempt - 2) + Math.floor(random() * 250), MAX_DELAY_MS);
}

/** Runs `fn`, retrying transient failures; any other error, or the last transient one, is thrown. */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isTransient(err) || attempt >= attempts) throw err;
      const delay = retryDelay(attempt + 1, err, opts.random);
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/** "A12", "A12 and A13", "A12, A13 and A14". */
export function seatList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
