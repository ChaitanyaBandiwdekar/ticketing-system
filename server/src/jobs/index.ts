/** Wires the background jobs into the server lifecycle (main.ts starts them after listen). */
import type { Config } from "../config";
import type { Sql } from "../db/pool";
import type { EventBus } from "../realtime/bus";
import type { HubLog, StreamHub } from "../realtime/hub";
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
}) {
  const { config, sql, bus, hub, log } = deps;
  const sweeper = createSweeper(sql, bus);
  const reconciler = createReconciler({
    sql,
    bus,
    log,
    watchedShows: () => hub.watchedShows(),
    onReport: (report, at) => hub.publishAudit(report, at),
  });
  const janitor = createJanitor(sql, config.jobs, log, (ids) => reconciler.forget(ids));

  const runners = [
    new Periodic("sweeper", config.reservations.holdSweepIntervalMs, sweeper.tick, log),
    new Periodic("reconciler", config.jobs.reconcileIntervalMs, reconciler.tick, log),
    new Periodic("janitor", config.jobs.janitorIntervalMs, janitor.tick, log),
  ];

  return {
    sweeper,
    reconciler,
    janitor,
    runners,
    start(): void {
      for (const r of runners) r.start();
    },
    /** Waits for in-flight ticks, so pools are never ended under a running job. */
    async stop(): Promise<void> {
      await Promise.all(runners.map((r) => r.stop()));
      reconciler.stop();
    },
  };
}
