/**
 * Admission control. Requests are cheap to accept but each one in flight holds memory (socket,
 * parsed body, a slot in the DB pool's queue). Past a high-water mark we shed load with a fast
 * 429 + Retry-After instead of letting the heap grow until the process is OOM-killed, which on a
 * single instance would turn into a burst of edge 5xx. The mark is set high (MAX_QUEUE): slow is
 * fine, 429 is the last resort, a crash is never acceptable.
 *
 * Retry-After says when the queue ahead should have drained: requests in flight over the recent
 * completion rate. A fixed "1" invited a retry storm: at 0.1 CPU, answering thousands of early
 * retries starved the admitted requests until their DB deadlines turned them into 503s (found by
 * the Phase 8 burst). Clients that honor it spread out instead.
 */

/** Seconds of completions behind the drain-rate estimate (the current second excluded). */
const RATE_WINDOW_S = 5;
const RETRY_AFTER_MIN_S = 1;
const RETRY_AFTER_MAX_S = 30;

export class Admission {
  private inFlight = 0;
  private shed = 0;
  /** Completions per second, a ring indexed by epoch second. */
  private readonly completions = new Array<number>(RATE_WINDOW_S + 1).fill(0);
  private currentSec = 0;

  constructor(
    private readonly maxInFlight: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Claims a slot, or returns null when full. The returned release is safe to call twice. */
  tryEnter(): (() => void) | null {
    if (this.inFlight >= this.maxInFlight) {
      this.shed++;
      return null;
    }
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      const sec = this.roll();
      this.completions[sec % this.completions.length]!++;
    };
  }

  /** Whole seconds a shed client should wait: in flight ÷ recent completions per second. */
  retryAfterSeconds(): number {
    const sec = this.roll();
    let done = 0;
    for (let s = sec - RATE_WINDOW_S; s < sec; s++) {
      done += this.completions[(s + this.completions.length) % this.completions.length]!;
    }
    const perSecond = done / RATE_WINDOW_S;
    if (perSecond <= 0) return RETRY_AFTER_MAX_S;
    const wait = Math.ceil(this.inFlight / perSecond);
    return Math.min(RETRY_AFTER_MAX_S, Math.max(RETRY_AFTER_MIN_S, wait));
  }

  stats() {
    return { inFlight: this.inFlight, maxInFlight: this.maxInFlight, shed: this.shed };
  }

  /** Advances the ring to the current second, zeroing the seconds that passed without traffic. */
  private roll(): number {
    const sec = Math.floor(this.now() / 1000);
    if (sec !== this.currentSec) {
      const n = this.completions.length;
      for (let s = Math.max(this.currentSec + 1, sec - n + 1); s <= sec; s++) {
        this.completions[s % n] = 0;
      }
      this.currentSec = sec;
    }
    return sec;
  }
}
