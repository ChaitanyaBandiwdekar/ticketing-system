/** Wires the background jobs into the server lifecycle (main.ts starts them after listen). */
import type { Config } from "../config";
import type { Sql } from "../db/pool";
import type { Metrics } from "../obs/metrics";
import type { OpsHub } from "../obs/opshub";
import type { EventBus } from "../realtime/bus";
import type { HubLog, StreamHub } from "../realtime/hub";
import { createDemoShows } from "./demo";
import { createJanitor } from "./janitor";
import { Periodic } from "./periodic";
import { createReconciler } from "./reconciler";
import { createSweeper } from "./sweeper";

export type Jobs = ReturnType<typeof createJobs>;

export function createJobs(deps: {
  config: Config;
  sql: Sql;
  bus: EventBus;
  hub: StreamHub;
  log: HubLog;
  /** When given, job outcomes feed /metrics and the War Room. */
  obs?: { metrics: Metrics; ops: OpsHub };
}) {
  const { config, sql, bus, hub, log, obs } = deps;
  const sweeper = createSweeper(sql, bus, (seats, expired) => obs?.metrics.sweep(seats, expired));
  const reconciler = createReconciler({
    sql,
    bus,
    log,
    watchedShows: () => hub.watchedShows(),
    onReport: (report, at) => {
      obs?.metrics.audit(report);
      hub.publishAudit(report, at);
    },
  });
  const janitor = createJanitor(sql, config.jobs, log, (ids) => reconciler.forget(ids));

  const runners = [
    new Periodic("sweeper", config.reservations.holdSweepIntervalMs, sweeper.tick, log),
    new Periodic("reconciler", config.jobs.reconcileIntervalMs, reconciler.tick, log),
    new Periodic("janitor", config.jobs.janitorIntervalMs, janitor.tick, log),
  ];
  const demo =
    config.jobs.demoShowsIntervalMs > 0
      ? new Periodic(
          "demo_shows",
          config.jobs.demoShowsIntervalMs,
          createDemoShows(sql, { maxSeatsPerShow: config.reservations.maxSeatsPerShow }, log).tick,
          log,
        )
      : null;
  if (demo) runners.push(demo);

  if (obs) {
    const audits = () => reconciler.latest.values();
    const jobs = () => runners;
    obs.metrics.bind({ audits, jobs });
    obs.ops.bind({ audits, jobs });
  }

  return {
    sweeper,
    reconciler,
    janitor,
    runners,
    start(): void {
      for (const r of runners) r.start();
      // Open the demo halls at boot, not a minute later: a cold-started deploy is never empty.
      void demo?.runOnce();
    },
    /** Waits for in-flight ticks, so pools are never ended under a running job. */
    async stop(): Promise<void> {
      await Promise.all(runners.map((r) => r.stop()));
      reconciler.stop();
    },
  };
}
