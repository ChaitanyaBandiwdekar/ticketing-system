/**
 * A background job ticking every `intervalMs`. Ticks never overlap: the next one is scheduled
 * only after the current one settles. A failing tick is logged and the job carries on (the DB
 * being briefly unreachable must not kill the sweeper). stop() waits for an in-flight tick, so
 * shutdown never ends a pool under a running job.
 */
import type { HubLog } from "../realtime/hub";

export class Periodic {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  /** Consecutive failures, to log the first one loudly and the rest quietly. */
  private failures = 0;
  ticks = 0;
  lastError: string | null = null;
  /** Epoch ms of the last tick that completed without throwing. */
  lastSuccessAt: number | null = null;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly log: HubLog,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  /** Runs one tick now (or joins the one in flight). Used by start-up and tests. */
  runOnce(): Promise<void> {
    this.running ??= this.tick()
      .then(() => {
        if (this.failures > 0) this.log.info({ job: this.name }, "job recovered");
        this.failures = 0;
        this.lastError = null;
        this.lastSuccessAt = Date.now();
      })
      .catch((err: unknown) => {
        this.failures++;
        this.lastError = err instanceof Error ? err.message : String(err);
        if (this.failures === 1) this.log.warn({ err, job: this.name }, "job tick failed");
      })
      .finally(() => {
        this.ticks++;
        this.running = null;
      });
    return this.running;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().then(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }
}
