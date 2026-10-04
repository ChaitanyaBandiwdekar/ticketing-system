/**
 * Process entry point.
 *
 * Boot order matters: connect + migrate FIRST, listen LAST. Render's health check hits /healthz,
 * which does no I/O, so "listening" must already imply "database reachable and schema current".
 *
 * Shutdown (SIGTERM on deploy/scale-down; Render allows ~30s):
 *   1. /readyz flips to 503 at once; background jobs stop (an in-flight tick finishes)
 *   2. live streams end (clients reconnect elsewhere); new requests get 503 + Connection: close
 *   3. in-flight requests finish, idle keep-alive sockets are closed
 *   4. DB pools drain; exit 0
 * A watchdog exits non-zero if draining hangs, so the platform never has to SIGKILL us mid-write.
 */
import { loadConfig, loadDotEnv } from "./config";
import { migrate } from "./db/migrate";
import { createSql } from "./db/pool";
import { sqlStateOf } from "./db/retry";
import { buildApp } from "./http/app";
import { isDbUnavailable } from "./http/errors";
import { Readiness } from "./http/readiness";
import { createJobs } from "./jobs";
import { LogBuffer } from "./obs/logbuffer";
import { createLogger } from "./obs/logger";
import { EventBus } from "./realtime/bus";

const LISTEN_BACKLOG = 4096;
const DRAIN_TIMEOUT_MS = 25_000;

loadDotEnv();
const config = loadConfig();
// One logger for the whole process: stdout for the platform, plus the ring behind /ops/logs.
const logBuffer = new LogBuffer();
const log = createLogger(config.logLevel, { buffer: logBuffer });

/** The database may come up after us (compose, a cold Supabase): retry connecting, not forever. */
async function migrateWithRetry(attempts = 15, delayMs = 2_000): Promise<void> {
  for (let i = 1; ; i++) {
    const sql = createSql(config.db.migrationUrl, { max: 1, appName: "fdfs-migrate" });
    try {
      const { applied, alreadyApplied } = await migrate(sql);
      log.info({ applied, already_applied: alreadyApplied }, "migrations up to date");
      return;
    } catch (err) {
      if (!isDbUnavailable(err) || i >= attempts) throw err;
      log.warn({ attempt: i, code: sqlStateOf(err) }, "database not reachable yet; retrying");
      await new Promise((r) => setTimeout(r, delayMs));
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

async function main(): Promise<void> {
  await migrateWithRetry();

  const sql = createSql(config.db.url, { max: config.db.poolMax, appName: "fdfs-api" });
  const readySql = createSql(config.db.url, { max: 1, appName: "fdfs-ready" });
  const readiness = new Readiness(readySql);
  const bus = new EventBus();
  const app = await buildApp({ config, sql, readiness, bus, logger: log, logBuffer });
  const jobs = createJobs({ config, sql, bus, hub: app.realtime.hub, log, obs: app.obs });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "draining");
    readiness.markDraining();
    const watchdog = setTimeout(() => {
      log.error("drain timed out; exiting");
      process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    watchdog.unref();
    try {
      await jobs.stop();
      await app.close();
      await Promise.all([sql.end({ timeout: 5 }), readySql.end({ timeout: 1 })]);
      log.info("drained; bye");
      process.exit(0);
    } catch (err) {
      log.error({ err }, "error while draining");
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Node's default accept backlog is 511. A stampede opens thousands of connections at once;
  // past the backlog the kernel drops them and resets each ~15s later (found by the burst at
  // 2,000 in flight: ECONNRESET, ListenOverflows). The kernel caps this at net.core.somaxconn.
  await app.listen({ port: config.port, host: "0.0.0.0", backlog: LISTEN_BACKLOG });
  jobs.start();
}

process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));

main().catch((err: unknown) => {
  log.fatal({ err }, "boot failed");
  process.exit(1);
});
