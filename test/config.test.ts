import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadMigrationUrl } from "../server/src/config";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:6543/postgres",
  JWT_SECRET: "x".repeat(32),
  ADMIN_API_KEY: "admin-key-123456",
};

describe("loadConfig", () => {
  it("applies defaults for everything optional", () => {
    const c = loadConfig(valid);
    expect(c.port).toBe(8080);
    expect(c.db).toEqual({
      url: valid.DATABASE_URL,
      migrationUrl: valid.DATABASE_URL,
      poolMax: 20,
      requestTimeoutMs: 10_000,
    });
    expect(c.auth.demoLogin).toBe(true);
    expect(c.reservations).toEqual({
      defaultPerUserLimit: 4,
      maxSeatsPerShow: 20_000,
      holdSweepIntervalMs: 1_000,
    });
    expect(c.realtime).toEqual({
      maxClients: 2_000,
      coalesceMs: 100,
      heartbeatMs: 15_000,
      resyncMs: 30_000,
    });
    expect(c.jobs).toEqual({
      reconcileIntervalMs: 5_000,
      janitorIntervalMs: 600_000,
      ephemeralShowTtlHours: 24,
      idempotencyKeyTtlHours: 24,
      demoShowsIntervalMs: 0,
    });
  });

  it("coerces numbers and booleans from strings", () => {
    const c = loadConfig({ ...valid, PORT: "10000", DB_POOL_MAX: "15", AUTH_DEMO_LOGIN: "false" });
    expect(c.port).toBe(10000);
    expect(c.db.poolMax).toBe(15);
    expect(c.auth.demoLogin).toBe(false);
  });

  it("runs the demo shows job only when DEMO_SHOWS is on", () => {
    expect(loadConfig({ ...valid, DEMO_SHOWS: "true" }).jobs.demoShowsIntervalMs).toBe(60_000);
    expect(
      loadConfig({ ...valid, DEMO_SHOWS: "true", DEMO_SHOWS_INTERVAL_MS: "5000" }).jobs
        .demoShowsIntervalMs,
    ).toBe(5_000);
    expect(loadConfig({ ...valid, DEMO_SHOWS_INTERVAL_MS: "5000" }).jobs.demoShowsIntervalMs).toBe(
      0,
    );
  });

  it("uses the session URL for migrations when given", () => {
    const session = "postgresql://u:p@localhost:5432/postgres";
    expect(loadConfig({ ...valid, DATABASE_URL_SESSION: session }).db.migrationUrl).toBe(session);
    expect(loadMigrationUrl({ DATABASE_URL: valid.DATABASE_URL })).toBe(valid.DATABASE_URL);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ DATABASE_URL: "mysql://nope", JWT_SECRET: "short" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join("\n");
      expect(issues).toMatch(/DATABASE_URL/);
      expect(issues).toMatch(/JWT_SECRET/);
      expect(issues).toMatch(/ADMIN_API_KEY/);
    }
  });
});
