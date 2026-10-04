import { connect, createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config";
import { DbDeadlineError, withDeadline } from "../../server/src/db/deadline";
import { createSql } from "../../server/src/db/pool";
import { buildApp } from "../../server/src/http/app";
import { toApiError } from "../../server/src/http/errors";
import { Readiness } from "../../server/src/http/readiness";

describe("withDeadline", () => {
  it("passes results and errors through when the work is in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 100)).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("db said no")), 100)).rejects.toThrow(
      "db said no",
    );
  });

  it("rejects with DbDeadlineError, which the API answers as 503 db_unavailable", async () => {
    const never = new Promise<never>(() => {});
    const err = await withDeadline(never, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbDeadlineError);
    const api = toApiError(err);
    expect(api.statusCode).toBe(503);
    expect(api.code).toBe("db_unavailable");
    expect(api.headers["retry-after"]).toBe("2");
  });

  it("never times out an answer that arrived while the event loop was blocked", async () => {
    // The peer writes its reply, then this process stays busy past the deadline (a saturated
    // loop at 0.1 CPU): the answer sits in the socket while the timer comes due. Due timers run
    // before I/O is polled, so a naive deadline would win this race and report a 503.
    const echo = createServer((s) => {
      s.on("error", () => {});
      s.on("data", (d) => {
        s.write(d);
        const until = Date.now() + 120;
        while (Date.now() < until);
      });
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const { port } = echo.address() as { port: number };
    const client = await new Promise<Socket>((resolve) => {
      const c: Socket = connect(port, "127.0.0.1", () => resolve(c));
    });
    client.on("error", () => {});
    try {
      const reply = new Promise<string>((resolve) =>
        client.once("data", (d) => resolve(String(d))),
      );
      const answered = withDeadline(reply, 20);
      client.write("pong");
      await expect(answered).resolves.toBe("pong");
    } finally {
      client.destroy();
      await new Promise((r) => echo.close(r));
    }
  });

  it("never leaves the abandoned work as an unhandled rejection", async () => {
    let rejectLate!: (e: Error) => void;
    const late = new Promise<never>((_, reject) => (rejectLate = reject));
    await expect(withDeadline(late, 10)).rejects.toBeInstanceOf(DbDeadlineError);
    rejectLate(new Error("arrived after the deadline"));
    await new Promise((r) => setTimeout(r, 10)); // vitest fails the run on unhandled rejections
  });
});

/**
 * A "database" that accepts TCP connections and never answers. That is what the app sees through a
 * pooler that is queueing for an unreachable Postgres.
 */
describe("API against a database that never answers", () => {
  let blackHole: Server;
  const sockets = new Set<Socket>();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let sql: ReturnType<typeof createSql>;
  let readySql: ReturnType<typeof createSql>;

  beforeAll(async () => {
    blackHole = createServer((s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((r) => blackHole.listen(0, "127.0.0.1", r));
    const { port } = blackHole.address() as { port: number };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: `postgres://u:p@127.0.0.1:${port}/db`,
      JWT_SECRET: "test-jwt-secret-0123456789abcdef0123456789",
      ADMIN_API_KEY: "test-admin-key-0123456789abcdef",
      DB_REQUEST_TIMEOUT_MS: "300",
      SNAPSHOT_CACHE_MS: "0",
    });
    sql = createSql(config.db.url, { max: 2 });
    readySql = createSql(config.db.url, { max: 1 });
    app = await buildApp({ config, sql, readiness: new Readiness(readySql, { timeoutMs: 300 }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const s of sockets) s.destroy();
    await Promise.all([sql.end({ timeout: 0 }), readySql.end({ timeout: 0 })]);
    await new Promise((r) => blackHole.close(r));
  });

  it("answers reserve, reads and streams with a fast 503 instead of hanging", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "hang" },
    });
    const auth = { authorization: `Bearer ${login.json<{ token: string }>().token}` };
    const show = "6f1d1c6e-7d39-4c39-9d3e-0e5c4c1b2a11";
    const requests = [
      {
        method: "POST" as const,
        url: `/shows/${show}/reserve`,
        headers: { ...auth, "idempotency-key": "k" },
        payload: { seats: ["A1"] },
      },
      { method: "GET" as const, url: `/shows/${show}` },
      { method: "GET" as const, url: "/shows" },
      { method: "GET" as const, url: `/stream?show=${show}` },
      { method: "POST" as const, url: `/reservations/${show}/cancel`, headers: auth },
    ];
    for (const req of requests) {
      const started = Date.now();
      const res = await app.inject(req);
      expect(res.statusCode, req.url).toBe(503);
      expect(res.json().error.code, req.url).toBe("db_unavailable");
      expect(Date.now() - started).toBeLessThan(2_000);
    }
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(503);
  });
});
