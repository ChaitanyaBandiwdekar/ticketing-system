import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, inject } from "vitest";
import { loadConfig, type Config } from "../../server/src/config";
import { createSql, type Sql } from "../../server/src/db/pool";
import { buildApp, type AppDeps } from "../../server/src/http/app";
import { Readiness } from "../../server/src/http/readiness";
import { seatRow } from "./engine";
import { uniq } from "./db";

export const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef";
const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef0123456789";

export type TestApp = {
  app: FastifyInstance;
  sql: Sql;
  config: Config;
  admin: { authorization: string };
  /** Demo-login a fresh (or given) user; returns bearer headers and the user id. */
  user(name?: string): Promise<{ userId: string; headers: { authorization: string } }>;
  /** Create a show through the API (admin). */
  show(body?: Record<string, unknown>): Promise<{ id: string } & Record<string, unknown>>;
  /** Starts a real HTTP listener (for streaming tests); returns its base URL. Idempotent. */
  listen(): Promise<string>;
};

/**
 * The real app on the run's test database, built once per file. Snapshot cache off so reads see
 * writes immediately; logging silent. `env` overrides any config variable; `deps` supplies extra
 * app dependencies (e.g. a logger writing into a test's log buffer).
 */
export function useTestApp(
  env: Record<string, string> = {},
  deps: Pick<AppDeps, "logger" | "logBuffer"> = {},
): TestApp {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: inject("databaseUrl"),
    JWT_SECRET: TEST_JWT_SECRET,
    ADMIN_API_KEY: TEST_ADMIN_KEY,
    SNAPSHOT_CACHE_MS: "0",
    ...env,
  });
  const sql = createSql(config.db.url, { max: 20, appName: "fdfs-test-api" });
  const readySql = createSql(config.db.url, { max: 1, appName: "fdfs-test-ready" });
  const t = {
    sql,
    config,
    admin: { authorization: `Bearer ${TEST_ADMIN_KEY}` },
  } as TestApp;

  beforeAll(async () => {
    t.app = await buildApp({ config, sql, readiness: new Readiness(readySql), ...deps });
    await t.app.ready();
  });
  afterAll(async () => {
    await t.app?.close();
    await Promise.all([sql.end({ timeout: 5 }), readySql.end({ timeout: 5 })]);
  });

  t.user = async (name = uniq("user")) => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: name },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const { token, user_id } = res.json<{ token: string; user_id: string }>();
    return { userId: user_id, headers: { authorization: `Bearer ${token}` } };
  };

  t.show = async (body = {}) => {
    const res = await t.app.inject({
      method: "POST",
      url: "/shows",
      headers: t.admin,
      payload: { name: uniq("show"), seats: seatRow("A", 20), price_paise: 25_000, ...body },
    });
    if (res.statusCode !== 201)
      throw new Error(`create show failed: ${res.statusCode} ${res.body}`);
    return res.json();
  };

  let baseUrl: Promise<string> | null = null;
  t.listen = () => {
    baseUrl ??= t.app.listen({ port: 0, host: "127.0.0.1" });
    return baseUrl;
  };

  return t;
}

export function errorOf(res: LightMyRequestResponse) {
  return res.json<{
    error: { code: string; message: string; request_id: string } & Record<string, unknown>;
  }>().error;
}
