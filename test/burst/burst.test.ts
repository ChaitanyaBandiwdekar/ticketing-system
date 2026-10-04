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
      "key reuse: 422, then the original replays",
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
