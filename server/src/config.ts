/**
 * Typed, validated configuration. Every env var the service reads goes through here, so a
 * misconfigured deploy fails at boot with a readable list of problems instead of at the first request.
 */
import { z } from "zod";

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// or postgresql:// URL");

const intWithDefault = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intWithDefault(8080, 1, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: postgresUrl,
  DATABASE_URL_SESSION: postgresUrl.optional(),
  DB_POOL_MAX: intWithDefault(20, 1, 200),
  DB_REQUEST_TIMEOUT_MS: intWithDefault(10_000, 100, 120_000),

  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  ADMIN_API_KEY: z.string().min(16, "must be at least 16 characters"),
  AUTH_DEMO_LOGIN: z.stringbool().default(true),

  DEFAULT_PER_USER_LIMIT: intWithDefault(4, 1, 100),
  MAX_SEATS_PER_SHOW: intWithDefault(20_000, 1, 200_000),
  HOLD_SWEEP_INTERVAL_MS: intWithDefault(1_000, 100, 60_000),
  // ~17.5 KB of RSS per request in flight (measured at 4,000 in flight under 0.1 CPU/512 MB):
  // 8,000 keeps the worst case near 250 MB, well inside a 512 MB instance.
  MAX_QUEUE: intWithDefault(8_000, 1, 1_000_000),
  SNAPSHOT_CACHE_MS: intWithDefault(250, 0, 10_000),
  WEB_DIST_DIR: z.string().min(1).default("dist/web"),

  STREAM_MAX_CLIENTS: intWithDefault(2_000, 1, 100_000),
  STREAM_COALESCE_MS: intWithDefault(100, 1, 5_000),
  STREAM_HEARTBEAT_MS: intWithDefault(15_000, 100, 120_000),
  STREAM_RESYNC_MS: intWithDefault(30_000, 1_000, 3_600_000),

  RECONCILE_INTERVAL_MS: intWithDefault(5_000, 100, 3_600_000),
  JANITOR_INTERVAL_MS: intWithDefault(600_000, 1_000, 86_400_000),
  EPHEMERAL_SHOW_TTL_HOURS: intWithDefault(24, 1, 24 * 365),
  IDEMPOTENCY_KEY_TTL_HOURS: intWithDefault(24, 1, 24 * 365),
  // Keep public demo halls open (engine/demo.ts). On for the deploy, off for tests and local dev.
  DEMO_SHOWS: z.stringbool().default(false),
  DEMO_SHOWS_INTERVAL_MS: intWithDefault(60_000, 1_000, 3_600_000),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof EnvSchema>["LOG_LEVEL"];
  /** requestTimeoutMs: deadline for a request's DB call before it answers 503 (db/deadline.ts). */
  db: { url: string; migrationUrl: string; poolMax: number; requestTimeoutMs: number };
  auth: { jwtSecret: string; adminApiKey: string; demoLogin: boolean };
  reservations: {
    defaultPerUserLimit: number;
    maxSeatsPerShow: number;
    holdSweepIntervalMs: number;
  };
  admission: { maxQueue: number };
  /** GET /shows/:id micro-cache: one serialized snapshot per show for this long (0 = off). */
  /** webDir: the built SPA (Vite output), served under /app/. */
  http: { snapshotCacheMs: number; webDir: string };
  /** GET /stream (SSE): connection cap, delta coalescing window, heartbeat, full resync period. */
  realtime: { maxClients: number; coalesceMs: number; heartbeatMs: number; resyncMs: number };
  /** Background jobs (the sweeper's interval lives under `reservations`). */
  jobs: {
    reconcileIntervalMs: number;
    janitorIntervalMs: number;
    ephemeralShowTtlHours: number;
    idempotencyKeyTtlHours: number;
    /** 0 = off: no demo shows are opened. */
    demoShowsIntervalMs: number;
  };
};

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error));
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    db: {
      url: e.DATABASE_URL,
      migrationUrl: e.DATABASE_URL_SESSION ?? e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      requestTimeoutMs: e.DB_REQUEST_TIMEOUT_MS,
    },
    auth: {
      jwtSecret: e.JWT_SECRET,
      adminApiKey: e.ADMIN_API_KEY,
      demoLogin: e.AUTH_DEMO_LOGIN,
    },
    reservations: {
      defaultPerUserLimit: e.DEFAULT_PER_USER_LIMIT,
      maxSeatsPerShow: e.MAX_SEATS_PER_SHOW,
      holdSweepIntervalMs: e.HOLD_SWEEP_INTERVAL_MS,
    },
    admission: { maxQueue: e.MAX_QUEUE },
    http: { snapshotCacheMs: e.SNAPSHOT_CACHE_MS, webDir: e.WEB_DIST_DIR },
    realtime: {
      maxClients: e.STREAM_MAX_CLIENTS,
      coalesceMs: e.STREAM_COALESCE_MS,
      heartbeatMs: e.STREAM_HEARTBEAT_MS,
      resyncMs: e.STREAM_RESYNC_MS,
    },
    jobs: {
      reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
      janitorIntervalMs: e.JANITOR_INTERVAL_MS,
      ephemeralShowTtlHours: e.EPHEMERAL_SHOW_TTL_HOURS,
      idempotencyKeyTtlHours: e.IDEMPOTENCY_KEY_TTL_HOURS,
      demoShowsIntervalMs: e.DEMO_SHOWS ? e.DEMO_SHOWS_INTERVAL_MS : 0,
    },
  };
}

/** Just the migration URL — for tooling (migrate CLI) that must not require auth secrets. */
export function loadMigrationUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = z
    .object({ DATABASE_URL: postgresUrl, DATABASE_URL_SESSION: postgresUrl.optional() })
    .safeParse(env);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error));
  return parsed.data.DATABASE_URL_SESSION ?? parsed.data.DATABASE_URL;
}

/** Loads ./.env into process.env when present (Node's built-in loader; real env vars win). */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
