import { afterAll, describe, expect, inject, it } from "vitest";
import { createSql, type Sql } from "../../server/src/db/pool";
import { Readiness } from "../../server/src/http/readiness";

const pools: Sql[] = [];
function pool(url: string): Sql {
  const sql = createSql(url, { max: 1, appName: "fdfs-test-readiness" });
  pools.push(sql);
  return sql;
}
afterAll(() => Promise.all(pools.map((p) => p.end({ timeout: 1 }))));

/** A stand-in for the sql tag: Readiness only ever runs sql`select 1`. */
function fakeSql(impl: () => Promise<unknown> = async () => []) {
  const stats = { calls: 0 };
  const sql = Object.assign(async () => {
    stats.calls++;
    return impl();
  }, {}) as unknown as Sql;
  return { sql, stats };
}

describe("Readiness", () => {
  it("is ready against a live database", async () => {
    const readiness = new Readiness(pool(inject("databaseUrl")));
    expect(await readiness.check()).toEqual({ ready: true });
  });

  it("serves the cached state within cacheMs without querying again", async () => {
    const { sql, stats } = fakeSql();
    const readiness = new Readiness(sql, { cacheMs: 60_000 });
    const first = await readiness.check();
    const second = await readiness.check();
    expect(first).toEqual({ ready: true });
    expect(second).toBe(first);
    expect(stats.calls).toBe(1);
  });

  it("probes again once the cache window has passed", async () => {
    const { sql, stats } = fakeSql();
    const readiness = new Readiness(sql, { cacheMs: 0 });
    await readiness.check();
    await readiness.check();
    expect(stats.calls).toBe(2);
  });

  it("concurrent checks share one probe", async () => {
    const { sql, stats } = fakeSql(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 30)),
    );
    const readiness = new Readiness(sql);
    const states = await Promise.all(Array.from({ length: 5 }, () => readiness.check()));
    expect(stats.calls).toBe(1);
    expect(states.every((s) => s.ready)).toBe(true);
  });

  it("markDraining reports not ready immediately, even over a cached ready state", async () => {
    const { sql, stats } = fakeSql();
    const readiness = new Readiness(sql, { cacheMs: 60_000 });
    expect(await readiness.check()).toEqual({ ready: true });
    readiness.markDraining();
    expect(await readiness.check()).toEqual({ ready: false, reason: "draining" });
    expect(stats.calls).toBe(1);
  });

  it("fails closed when the query rejects, and caches that verdict", async () => {
    const { sql, stats } = fakeSql(async () => {
      throw new Error("boom");
    });
    const readiness = new Readiness(sql, { cacheMs: 60_000 });
    expect(await readiness.check()).toEqual({ ready: false, reason: "db_unreachable" });
    expect(await readiness.check()).toEqual({ ready: false, reason: "db_unreachable" });
    expect(stats.calls).toBe(1);
  });

  it("fails closed when the query hangs past timeoutMs", async () => {
    const { sql } = fakeSql(() => new Promise(() => {}));
    const readiness = new Readiness(sql, { timeoutMs: 50 });
    const started = Date.now();
    expect(await readiness.check()).toEqual({ ready: false, reason: "db_unreachable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports db_unreachable for an unreachable database, without throwing, within ~3s", async () => {
    const readiness = new Readiness(pool("postgres://u:p@127.0.0.1:1/x"), { timeoutMs: 1_500 });
    const started = Date.now();
    const state = await readiness.check();
    expect(state).toEqual({ ready: false, reason: "db_unreachable" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
