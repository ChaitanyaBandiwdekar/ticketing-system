/**
 * In-process, after-commit event bus.
 *
 * Every engine mutation is ONE autocommitted statement, so by the time an engine call returns its
 * effects are committed: publishers emit after the call returns, never before. Events are hints
 * ("these seats of this show changed"), not state: subscribers re-read the truth from Postgres
 * (see hub.ts), so an event that is late, duplicated or delivered out of order can't corrupt
 * anyone's view.
 *
 * Per instance by design. With several instances, a client sees its own instance's changes as
 * deltas and everyone else's through the periodic snapshot resync.
 */

export type SeatChangeCause = "reserve" | "confirm" | "cancel" | "expire";

export type SeatChange = {
  showId: string;
  labels: readonly string[];
  cause: SeatChangeCause;
};

type Listener = (change: SeatChange) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synchronous fan-out. A throwing listener is reported, never allowed to fail the publisher. */
  emit(change: SeatChange): void {
    if (change.labels.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  onListenerError: (err: unknown) => void = () => {};
}
