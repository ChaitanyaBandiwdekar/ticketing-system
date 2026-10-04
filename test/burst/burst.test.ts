/**
 * The burst engine (scripts/burst/core.ts) against the real app over real HTTP: a scaled-down
 * run of every scenario must pass every check, including the /metrics diff. Plus its pure
 * pieces: the seat plan, the Zipf sampler, quantiles and the metrics parser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULTS,
  exactSeatsNeeded,
  parseMetrics,
  planSeats,
  plannedRequests,
  quantile,
  reserveCounters,
  rng,
  runBurst,
  zipf,
  type BurstOptions,
} from "../../scripts/burst/core";
import { TEST_ADMIN_KEY, useTestApp } from "../helpers/api";

const SMALL: Partial<BurstOptions> = {
  rows: 12,
  seatsPerRow: 20,
  requests: 600,
  users: 150,
  hotUsers: 60,
  retryGroups: 10,
  keyReuseGroups: 5,
  limitUsers: 3,
  crossedPairs: 5,
  spoofs: 5,
  foreignCancels: 5,
  concurrency: 32,
  pollMs: 20,
};

describe("burst against the real app", () => {
  // The janitor and reconciler are not needed; the show-snapshot cache is off (test default).
  const t = useTestApp();

  it("passes every check, and /metrics agrees with what it saw", async () => {
    const base = await t.listen();
    const progress: number[] = [];
    const report = await runBurst({
      ...SMALL,
      base,
      adminKey: TEST_ADMIN_KEY,
      onProgress: (p) => progress.push(p.done),
    });

    const failed = report.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "no 5xx",
        "no seat sold twice",
        "no user over the limit",
        "final map matches what was granted",
        "invariant held during the burst",
        "audit",
        "hot: one winner per hot seat",
        "metrics match observations",
      ]),
    );

    // Every planned request was answered, each one counted in the report's outcomes.
    const o = { ...DEFAULTS, ...SMALL } as BurstOptions;
    const cancels = o.foreignCancels;
    expect(report.reserveRequests).toBe(plannedRequests(o) - cancels);
    expect(Object.values(report.outcomes).reduce((a, b) => a + b, 0)).toBe(report.reserveRequests);
    expect(report.scenarios.limit.created).toBe(o.limitUsers * o.perUserLimit);
    expect(report.scenarios.crossed.created).toBe(o.crossedPairs);
    expect(report.scenarios.foreign["cancel:forbidden"]).toBe(cancels);
    expect(report.status["5xx"]).toBe(0);
    expect(report.polls.count).toBeGreaterThan(0);
    expect(report.final?.confirmed).toBe(report.final!.total - report.final!.available);
    expect(progress.at(-1)).toBe(plannedRequests(o));
  });

  describe("over a lossy network", () => {
    afterEach(() => vi.unstubAllGlobals());
    const real = globalThis.fetch;
    const isReserve = (url: string, init: RequestInit) =>
      init.method === "POST" && new URL(url).pathname.endsWith("/reserve");

    it("a booking re-sent in transit is still the request's own", async () => {
      const base = await t.listen();
      // What a browser or an edge proxy does after a dropped connection: the first copy books,
      // its answer is lost, the same request goes again and the client sees only the replay.
      let created = 0;
      let resent = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const res = await real(url, init);
        if (!isReserve(url, init) || res.status !== 201) return res;
        if (res.headers.get("idempotent-replayed") === "true" || ++created % 5) return res;
        await res.text();
        resent++;
        return real(url, init);
      });

      const report = await runBurst({ ...SMALL, base, adminKey: TEST_ADMIN_KEY });

      expect(report.checks.filter((c) => !c.ok)).toEqual([]);
      expect(resent).toBeGreaterThan(0);
      expect(report.resent).toBe(resent);
      const o = { ...DEFAULTS, ...SMALL } as BurstOptions;
      expect(report.scenarios.limit.created).toBe(o.limitUsers * o.perUserLimit);
      expect(report.scenarios.stampede.replayed).toBeUndefined();
      const metrics = report.checks.find((c) => c.name === "metrics match observations")!;
      expect(metrics.detail).toContain(`${resent} answers the server sent never arrived`);
    });

    it("answers lost after the server sent them fail only 'no network errors'", async () => {
      const base = await t.listen();
      let n = 0;
      let dropped = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const res = await real(url, init);
        if (!isReserve(url, init) || ++n % 10) return res;
        await res.text();
        dropped++;
        throw new TypeError("fetch failed");
      });

      const report = await runBurst({ ...SMALL, base, adminKey: TEST_ADMIN_KEY });

      const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
      expect(failed).toEqual(["no network errors"]);
      expect(report.status.network).toBe(dropped);
      const metrics = report.checks.find((c) => c.name === "metrics match observations")!;
      expect(metrics.detail).toContain(`${dropped} answers the server sent never arrived`);
    });

    it("still fails when the metrics run ahead by more than was lost", async () => {
      const base = await t.listen();
      // Every 10th reserve goes to the server twice, unseen: a declined copy can't be spotted
      // by the client, so the server's extra counts exceed what the client can account for.
      let n = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        if (isReserve(url, init) && ++n % 10 === 0) await (await real(url, init)).text();
        return real(url, init);
      });

      const report = await runBurst({ ...SMALL, base, adminKey: TEST_ADMIN_KEY });

      const metrics = report.checks.find((c) => c.name === "metrics match observations")!;
      expect(metrics.ok).toBe(false);
      expect(metrics.detail).toMatch(/more than the \d+ requests whose answer was lost/);
    });
  });

  it("refuses to start without a valid admin key", async () => {
    const base = await t.listen();
    await expect(runBurst({ ...SMALL, base, adminKey: "wrong-key-0123456789" })).rejects.toThrow(
      /HTTP 403.*admin key/,
    );
  });
});

describe("burst against a server that breaks the rules", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails the checks a double-selling, limit-ignoring server breaks", async () => {
    // Grants every reserve, to whoever the body claims to be, and replays nothing.
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    let n = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (path === "/shows" && init.method === "POST") {
        return json(201, {
          id: "00000000-0000-4000-8000-000000000001",
          name: body.name,
          total_seats: body.seats.length,
        });
      }
      if (path === "/auth/tokens") {
        return json(200, {
          tokens: Array.from({ length: body.count }, (_, i) => ({
            user_id: `${body.prefix}-${body.start + i}`,
            token: `${body.prefix}-${body.start + i}`,
          })),
        });
      }
      if (path.endsWith("/reserve")) {
        const token = String((init.headers as Record<string, string>).authorization).slice(7);
        return json(201, {
          reservation_id: `r${++n}`,
          user_id: body.user_id ?? token,
          seats: body.seats,
          status: "confirmed",
        });
      }
      if (path.endsWith("/cancel")) return json(200, {});
      if (path.endsWith("/audit")) return json(200, { ok: true, violations: [] });
      if (path.startsWith("/shows/")) {
        return json(200, {
          counts: { total: 240, available: 240, held: 0, confirmed: 0, invariant_ok: true },
          seats: [],
        });
      }
      return json(404, { error: { code: "not_found" } });
    });

    const report = await runBurst({ ...SMALL, base: "http://fake", adminKey: "k", pollMs: 0 });
    const failed = new Set(report.checks.filter((c) => !c.ok).map((c) => c.name));
    expect(report.ok).toBe(false);
    for (const name of [
      "no seat sold twice",
      "no user over the limit",
      "final map matches what was granted",
      "hot: one winner per hot seat",
      "same key: one booking, the rest replay it",
      "key reuse: 409, then the original replays",
      "limit: exactly 4 of 10 parallel",
      "crossed pairs: one winner, no deadlock",
      "spoofed user_id ignored",
      "foreign cancel refused (403)",
    ]) {
      expect(failed, name).toContain(name);
    }
    // What this fake does get right stays green.
    expect(failed).not.toContain("no 5xx");
    expect(failed).not.toContain("audit");
  });
});

describe("burst plan", () => {
  it("splits the hall: A12 first among the hot seats, exact seats at the back, no overlap", () => {
    const o = { ...DEFAULTS, rows: 10, seatsPerRow: 20 };
    const need = exactSeatsNeeded({ ...o, ...SMALL } as BurstOptions);
    const p = planSeats(o, need);
    expect(p.hot[0]).toBe("A12");
    expect(p.hot).toHaveLength(6);
    expect(p.exact).toHaveLength(need);
    const all = [...p.hot, ...p.crowd, ...p.exact];
    expect(new Set(all).size).toBe(200);
    expect(all.sort()).toEqual([...p.all].sort());
  });

  it("refuses a hall too small for the exact scenarios", () => {
    expect(() => planSeats({ rows: 2, seatsPerRow: 10, hotSeats: 6 }, 100)).toThrow(/too small/);
  });

  it("samples Zipf ranks with the popular ones first", () => {
    const pick = zipf(100, 1, rng(7));
    const hits = new Array<number>(100).fill(0);
    for (let i = 0; i < 20_000; i++) hits[pick()]!++;
    expect(hits[0]!).toBeGreaterThan(hits[9]! * 5);
    expect(hits[9]!).toBeGreaterThan(hits[99]!);
    expect(Math.min(...hits)).toBeGreaterThan(0);
  });

  it("quantiles are nearest-rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([0.5, 0.95, 0.99, 1].map((q) => quantile(xs, q))).toEqual([50, 95, 99, 100]);
    expect(quantile([], 0.5)).toBe(0);
  });

  it("reads reserve outcomes out of Prometheus text", () => {
    const text = [
      "# HELP fdfs_reserve_responses_total x",
      'fdfs_reserve_responses_total{outcome="created"} 12',
      'fdfs_reserve_responses_total{outcome="seat_taken"} 30',
      'fdfs_reservations_declined_total{reason="seat_taken"} 30',
    ].join("\n");
    expect([...reserveCounters(parseMetrics(text))]).toEqual([
      ["created", 12],
      ["seat_taken", 30],
    ]);
  });
});
