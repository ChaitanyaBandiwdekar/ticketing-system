/**
 * /readyz: "can this instance serve reservations right now?" It fails closed.
 *
 * The probe runs on its OWN one-connection pool, so a saturated request pool can't queue the
 * probe behind 20k reservations and make a healthy instance look dead (and vice versa: probes
 * never steal request capacity). Results are cached for a second, so probe traffic costs at most
 * one `select 1` per second. During shutdown it reports not-ready immediately.
 */
import type { Sql } from "../db/pool";

export type ReadyState = { ready: boolean; reason?: "draining" | "db_unreachable" };

export class Readiness {
  private cached: { at: number; state: ReadyState } | null = null;
  private inflight: Promise<ReadyState> | null = null;
  private draining = false;

  constructor(
    private readonly sql: Sql,
    private readonly opts: { cacheMs?: number; timeoutMs?: number } = {},
  ) {}

  markDraining(): void {
    this.draining = true;
  }

  /** The last probe's verdict without probing (null before the first probe). For metrics. */
  peek(): boolean | null {
    if (this.draining) return false;
    return this.cached?.state.ready ?? null;
  }

  async check(): Promise<ReadyState> {
    if (this.draining) return { ready: false, reason: "draining" };
    const now = Date.now();
    if (this.cached && now - this.cached.at < (this.opts.cacheMs ?? 1000)) return this.cached.state;
    // Single-flight: concurrent probes share one query.
    this.inflight ??= this.probe().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async probe(): Promise<ReadyState> {
    const timeoutMs = this.opts.timeoutMs ?? 2000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("readiness probe timed out")), timeoutMs);
    });
    let state: ReadyState;
    try {
      await Promise.race([this.sql`select 1`, timeout]);
      state = { ready: true };
    } catch {
      state = { ready: false, reason: "db_unreachable" };
    } finally {
      clearTimeout(timer);
    }
    this.cached = { at: Date.now(), state };
    return state;
  }
}
