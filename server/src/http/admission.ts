/**
 * Admission control. Requests are cheap to accept but each one in flight holds memory (socket,
 * parsed body, a slot in the DB pool's queue). Past a high-water mark we shed load with a fast
 * 429 + Retry-After instead of letting the heap grow until the process is OOM-killed, which on a
 * single instance would turn into a burst of edge 5xx. The mark is set high (MAX_QUEUE): slow is
 * fine, 429 is the last resort, a crash is never acceptable.
 */
export class Admission {
  private inFlight = 0;
  private shed = 0;

  constructor(private readonly maxInFlight: number) {}

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
    };
  }

  stats() {
    return { inFlight: this.inFlight, maxInFlight: this.maxInFlight, shed: this.shed };
  }
}
