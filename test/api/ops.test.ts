import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJobs, type Jobs } from "../../server/src/jobs";
import { LogBuffer } from "../../server/src/obs/logbuffer";
import { createLogger } from "../../server/src/obs/logger";
import type { Summary } from "../../server/src/obs/types";
import type { Point } from "../../server/src/obs/timeseries";
import { errorOf, useTestApp, type TestApp } from "../helpers/api";
import { uniq } from "../helpers/db";
import { lapse, seatRow } from "../helpers/engine";

type Scrape = Map<string, number>;

async function scrape(app: FastifyInstance): Promise<Scrape> {
  const res = await app.inject({ method: "GET", url: "/metrics" });
  expect(res.statusCode).toBe(200);
  const m: Scrape = new Map();
  for (const line of res.body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" ");
    m.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return m;
}

const delta = (before: Scrape, after: Scrape, key: string) =>
  (after.get(key) ?? 0) - (before.get(key) ?? 0);

/** What a client observed: created / replayed (the 201's header), otherwise the error code. */
function observedOutcome(res: {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
}): string {
  if (res.statusCode === 201) {
    return res.headers["idempotent-replayed"] === "true" ? "replayed" : "created";
  }
  return (res.json() as { error: { code: string } }).error.code;
}

function startJobs(t: TestApp): Jobs {
  return createJobs({
    config: t.config,
    sql: t.sql,
    bus: t.app.realtime.bus,
    hub: t.app.realtime.hub,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    obs: t.app.obs,
  });
}

describe("metrics and ops", () => {
  const t = useTestApp();
  let jobs: Jobs;
  beforeAll(() => {
    jobs = startJobs(t);
  });
  afterAll(() => jobs.stop());

  it("serves Prometheus exposition with the documented families", async () => {
    const res = await t.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    for (const name of [
      "fdfs_reserve_responses_total",
      "fdfs_reservations_confirmed_total",
      "fdfs_reservations_declined_total",
      "fdfs_holds_expired_total",
      "fdfs_reservations_cancelled_total",
      "fdfs_identity_spoof_ignored_total",
      "fdfs_invariant_violations_total",
      "fdfs_http_responses_total",
      "fdfs_reservation_duration_seconds",
      "fdfs_db_calls_in_flight",
      "fdfs_db_pool_max",
      "fdfs_admission_in_flight",
      "fdfs_stream_clients",
      "process_resident_memory_bytes",
      "nodejs_eventloop_lag_seconds",
      // Referenced by ops/alerts.yml.
      "nodejs_eventloop_lag_p99_seconds",
      "fdfs_ready",
      "fdfs_admission_shed_total",
      "fdfs_job_last_success_timestamp_seconds",
    ]) {
      expect(res.body, name).toContain(`# TYPE ${name} `);
    }
    // Probed at scrape time: a healthy instance reads 1 even if nobody called /readyz.
    expect(res.body).toMatch(/^fdfs_ready 1$/m);
  });

  it("labels HTTP metrics by route template, never by raw URL", async () => {
    const show = await t.show();
    const before = await scrape(t.app);
    await t.app.inject({ method: "GET", url: `/shows/${show.id}` });
    await t.app.inject({ method: "GET", url: `/no/such/${randomUUID()}` });
    await t.app.inject({ method: "GET", url: "/healthz" });
    await t.app.inject({ method: "GET", url: "/ops/summary" });
    const after = await scrape(t.app);
    const key = (route: string, cls: string) =>
      `fdfs_http_responses_total{route="${route}",status_class="${cls}"}`;
    expect(delta(before, after, key("/shows/:id", "2xx"))).toBe(1);
    expect(delta(before, after, key("(unmatched)", "4xx"))).toBe(1);
    const exposition = (await t.app.inject({ method: "GET", url: "/metrics" })).body;
    expect(exposition).not.toContain(show.id);
    // Ops routes are not counted: watching must not change what is watched.
    expect(exposition).not.toMatch(/route="\/(healthz|metrics|ops\/summary)"/);
  });

  it("after a mixed burst, metric deltas equal the outcomes clients observed, and the invariant holds throughout", async () => {
    const show = await t.show({ seats: seatRow("A", 30), per_user_limit: 2 });
    const users = await Promise.all(Array.from({ length: 40 }, () => t.user()));
    const before = await scrape(t.app);

    const reserve = (
      headers: Record<string, string>,
      seats: string[],
      key: string | null = uniq("k"),
      extra: Record<string, unknown> = {},
      showId = show.id,
    ) =>
      t.app.inject({
        method: "POST",
        url: `/shows/${showId}/reserve`,
        headers: { ...headers, ...(key !== null && { "idempotency-key": key }) },
        payload: { seats, ...extra },
      });

    const [greedy, replayer, spoofer] = users;
    const requests = [
      // Hot seat: one winner.
      ...users.slice(0, 25).map((u) => reserve(u.headers, ["A1"])),
      // Everyone grabs a seat somewhere: wins, seat_taken, per_user_limit.
      ...users.map((u, i) => reserve(u.headers, [`A${2 + ((i * 7) % 28)}`])),
      // One user far over the limit in parallel.
      ...Array.from({ length: 6 }, (_, i) => reserve(greedy!.headers, [`A${24 + i}`])),
      // Same-key retries, then the key reused for other seats.
      ...Array.from({ length: 5 }, () => reserve(replayer!.headers, ["A30"], "same-key")),
      reserve(replayer!.headers, ["A29"], "same-key"),
      // Spoofed identity, unknown seat, unknown show, no token, no key.
      reserve(spoofer!.headers, ["A15"], uniq("k"), { user_id: "someone-else" }),
      reserve(users[3]!.headers, ["Z99"]),
      reserve(users[4]!.headers, ["A2"], uniq("k"), {}, randomUUID()),
      reserve({}, ["A2"]),
      reserve(users[5]!.headers, ["A2"], null),
    ];
    // Read the seat map while the burst runs: counts must reconcile in every snapshot.
    const polls = Array.from({ length: 8 }, () =>
      t.app.inject({ method: "GET", url: `/shows/${show.id}` }),
    );
    const [responses, snapshots] = await Promise.all([Promise.all(requests), Promise.all(polls)]);
    for (const s of snapshots) {
      expect(s.json<{ counts: { invariant_ok: boolean } }>().counts.invariant_ok).toBe(true);
    }

    const observed: Record<string, number> = {};
    for (const r of responses) {
      const o = observedOutcome(r);
      observed[o] = (observed[o] ?? 0) + 1;
    }
    // The burst really exercised every path.
    expect(Object.keys(observed).sort()).toEqual(
      [
        "created",
        "replayed",
        "seat_taken",
        "per_user_limit",
        "idempotency_key_reused",
        "unknown_seats",
        "show_not_found",
        "unauthorized",
        "validation_error",
      ].sort(),
    );

    const after = await scrape(t.app);
    const outcomeDelta = (o: string) =>
      delta(before, after, `fdfs_reserve_responses_total{outcome="${o}"}`);
    for (const [o, n] of Object.entries(observed)) expect(outcomeDelta(o), o).toBe(n);
    // ...and nothing else was counted.
    let total = 0;
    for (const [k] of after) {
      if (k.startsWith("fdfs_reserve_responses_total{")) {
        total += delta(before, after, k);
      }
    }
    expect(total).toBe(responses.length);

    const declined = (reason: string) =>
      delta(before, after, `fdfs_reservations_declined_total{reason="${reason}"}`);
    expect(delta(before, after, "fdfs_reservations_confirmed_total")).toBe(observed.created);
    expect(declined("seat_taken")).toBe(observed.seat_taken);
    expect(declined("per_user_limit")).toBe(observed.per_user_limit);
    expect(declined("idempotent_replay")).toBe(observed.replayed);
    expect(declined("idempotency_key_reused")).toBe(observed.idempotency_key_reused);
    expect(declined("invalid")).toBe(observed.unknown_seats! + observed.validation_error!);
    expect(declined("not_found")).toBe(observed.show_not_found);
    expect(delta(before, after, "fdfs_identity_spoof_ignored_total")).toBe(1);
    expect(
      delta(before, after, `fdfs_reservation_duration_seconds_count{outcome="seat_taken"}`),
    ).toBe(observed.seat_taken);
    expect(
      delta(
        before,
        after,
        `fdfs_http_responses_total{route="/shows/:id/reserve",status_class="5xx"}`,
      ),
    ).toBe(0);

    // The reconciler audits the show; its verdict and the DB-derived seat gauges come out right.
    await jobs.reconciler.tick();
    const audited = await scrape(t.app);
    const counts = (await t.app.inject({ method: "GET", url: `/shows/${show.id}` })).json<{
      counts: { available: number; held: number; confirmed: number };
    }>().counts;
    expect(audited.get("fdfs_invariant_violations_total")).toBe(0);
    expect(delta(after, audited, `fdfs_audits_total{result="ok"}`)).toBeGreaterThanOrEqual(1);
    expect(audited.get(`fdfs_seats{show="${show.id}",status="confirmed"}`)).toBe(counts.confirmed);
    expect(audited.get(`fdfs_seats{show="${show.id}",status="available"}`)).toBe(counts.available);
    expect(counts.confirmed).toBe(observed.created);

    t.app.obs.ops.tick();
    const summary = (await t.app.inject({ method: "GET", url: "/ops/summary" })).json<Summary>();
    expect(summary.invariant_ok).toBe(true);
    expect(summary.audits.find((a) => a.show_id === show.id)).toMatchObject({ ok: true });
    expect(summary.totals.reserve.created).toBe(
      audited.get(`fdfs_reserve_responses_total{outcome="created"}`),
    );
  });

  it("counts hold lifecycle transitions once, and the sweeper's expiries", async () => {
    const show = await t.show({ seats: seatRow("H", 6), hold_ttl_seconds: 120 });
    const u = await t.user();
    const reserve = async (seats: string[]) => {
      const res = await t.app.inject({
        method: "POST",
        url: `/shows/${show.id}/reserve`,
        headers: { ...u.headers, "idempotency-key": uniq("k") },
        payload: { seats },
      });
      expect(res.statusCode).toBe(201);
      return res.json<{ reservation_id: string; status: string }>();
    };
    const post = (url: string) => t.app.inject({ method: "POST", url, headers: u.headers });
    const before = await scrape(t.app);

    const a = await reserve(["H1"]);
    expect(a.status).toBe("held");
    expect((await post(`/reservations/${a.reservation_id}/confirm`)).statusCode).toBe(200);
    expect((await post(`/reservations/${a.reservation_id}/confirm`)).statusCode).toBe(200);
    const b = await reserve(["H2"]);
    expect((await post(`/reservations/${b.reservation_id}/cancel`)).statusCode).toBe(200);
    expect((await post(`/reservations/${b.reservation_id}/cancel`)).statusCode).toBe(200);
    const c = await reserve(["H3", "H4"]);
    await lapse(t.sql, c.reservation_id);
    await jobs.sweeper.tick();

    const after = await scrape(t.app);
    expect(delta(before, after, "fdfs_reservations_held_total")).toBe(3);
    expect(delta(before, after, "fdfs_reservations_confirmed_total")).toBe(1);
    expect(delta(before, after, "fdfs_reservations_cancelled_total")).toBe(1);
    expect(delta(before, after, "fdfs_holds_expired_total")).toBeGreaterThanOrEqual(1);
    expect(delta(before, after, "fdfs_hold_seats_released_total")).toBeGreaterThanOrEqual(2);
  });

  it("rolls each second into a point served by /ops/timeseries", async () => {
    const show = await t.show();
    const u = await t.user();
    const since = Date.now() - 1;
    t.app.obs.ops.tick(since); // close whatever earlier tests left open
    await t.app.inject({
      method: "POST",
      url: `/shows/${show.id}/reserve`,
      headers: { ...u.headers, "idempotency-key": uniq("k") },
      payload: { seats: ["A1"] },
    });
    t.app.obs.ops.tick(since + 1);
    const res = await t.app.inject({ method: "GET", url: `/ops/timeseries?since=${since}` });
    const { points } = res.json<{ points: Point[] }>();
    expect(points.length).toBeGreaterThanOrEqual(1);
    const p = points.at(-1)!;
    expect(p.reserve).toEqual({ created: 1 });
    expect(p.confirmed).toBe(1);
    expect(p.latency?.n).toBe(1);
    expect(p.dbPeak).toBeGreaterThanOrEqual(1);
    expect(p.gauges.rssMb).toBeGreaterThan(0);
  });

  it("streams the War Room feed: hello with history, then ticks", async () => {
    const base = await t.listen();
    const abort = new AbortController();
    const res = await fetch(`${base}/ops/stream`, { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    let buf = "";
    const until = async (pred: () => boolean) => {
      while (!pred()) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    };
    await until(() => events.some((e) => e.event === "hello"));
    const hello = events.find((e) => e.event === "hello")!.data;
    expect(hello).toHaveProperty("summary.totals");
    expect(Array.isArray(hello.points)).toBe(true);
    expect(t.app.obs.ops.clientCount()).toBe(1);
    t.app.obs.ops.tick();
    await until(() => events.some((e) => e.event === "tick"));
    const tick = events.find((e) => e.event === "tick")!.data;
    expect(tick).toHaveProperty("point.gauges");
    expect(tick).toHaveProperty("summary.invariant_ok");
    abort.abort();
    await vi.waitFor(() => expect(t.app.obs.ops.clientCount()).toBe(0));
  });
});

describe("public log tail", () => {
  const buffer = new LogBuffer();
  const t = useTestApp(
    { LOG_LEVEL: "info" },
    { logger: createLogger("info", { buffer, stdout: false }), logBuffer: buffer },
  );

  it("finds every line of one request by its id, redacted, and never logs ops traffic", async () => {
    const show = await t.show();
    const u = await t.user();
    const res = await t.app.inject({
      method: "POST",
      url: `/shows/${show.id}/reserve`,
      headers: { ...u.headers, "idempotency-key": uniq("k"), "x-request-id": "trace-me-1" },
      payload: { seats: ["A3"], user_id: "mallory" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["x-request-id"]).toBe("trace-me-1");

    const seqBefore = buffer.latestSeq();
    await t.app.inject({ method: "GET", url: "/ops/summary" });
    await t.app.inject({ method: "GET", url: "/metrics" });
    await t.app.inject({ method: "GET", url: "/ops/logs" });
    expect(buffer.latestSeq()).toBe(seqBefore);

    const logs = await t.app.inject({ method: "GET", url: "/ops/logs?request_id=trace-me-1" });
    const { lines } = logs.json<{
      lines: { level: string; msg: string; fields: Record<string, unknown> }[];
    }>();
    expect(lines.map((l) => l.msg)).toEqual(["identity_spoof_ignored", "request"]);
    expect(lines[0]).toMatchObject({ level: "warn", fields: { claimed_user: "mallory" } });
    expect(lines[1]!.fields).toMatchObject({
      route: "/shows/:id/reserve",
      status: 201,
      outcome: "created",
      state: "confirmed",
      spoof_ignored: true,
    });
    expect(logs.body).not.toMatch(/bearer|eyJ/i);

    const warn = await t.app.inject({ method: "GET", url: "/ops/logs?level=warn" });
    const warnLines = warn.json<{ lines: { level: string }[] }>().lines;
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    expect(warnLines.every((l) => l.level !== "info")).toBe(true);
  });

  it("rejects a bad level filter with the standard error shape", async () => {
    const res = await t.app.inject({ method: "GET", url: "/ops/logs?level=loud" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("validation_error");
  });
});

describe("burst runs", () => {
  const t = useTestApp();

  const report = (show: { id: string; name: string }, extra: Record<string, unknown> = {}) => ({
    ok: true,
    show: { id: show.id, name: show.name, total_seats: 20 },
    durationMs: 1234.5,
    outcomes: { created: 3, seat_taken: 40 },
    scenarios: { stampede: { created: 3, seat_taken: 40 } },
    status: { "2xx": 3, "4xx": 40, "429": 0, "5xx": 0, network: 0 },
    retries: 0,
    reserveRequests: 43,
    throughput: 34.8,
    latency: { p50: 12.3, p95: 40, p99: 51.2, max: 60 },
    slowest: [{ requestId: "b1-7", ms: 60, outcome: "created" }],
    final: { total: 20, available: 17, held: 0, confirmed: 3 },
    checks: [{ name: "no 5xx", ok: true, detail: "0 server errors" }],
    settings: { concurrency: 8, perUserLimit: 4 },
    ...extra,
  });

  const post = (body: unknown, headers: Record<string, string> = t.admin) =>
    t.app.inject({ method: "POST", url: "/ops/runs", headers, payload: body as object });

  it("records a run only with the admin key", async () => {
    const show = await t.show();
    const body = report({ id: show.id, name: String(show.name) });
    expect((await post(body, {})).statusCode).toBe(401);
    const user = await t.user();
    expect((await post(body, user.headers)).statusCode).toBe(403);
  });

  it("stores the report with the server's own audit, keeps only rendered fields, and lists newest first", async () => {
    const show = await t.show();
    const first = await post(
      report({ id: show.id, name: String(show.name) }, { base: "http://x", polls: { count: 1 } }),
    );
    expect(first.statusCode).toBe(201);
    const run = first.json<{
      id: string;
      report: Record<string, unknown>;
      server_audit: unknown;
    }>();
    expect(run.report).not.toHaveProperty("base");
    expect(run.report).not.toHaveProperty("polls");
    expect(run.server_audit).toMatchObject({
      ok: true,
      counts: { total: 20, available: 20, held: 0, confirmed: 0 },
      violations: 0,
    });

    // A show that no longer exists still records, without a server audit.
    const gone = { id: "00000000-0000-4000-8000-000000000000", name: "gone" };
    const second = await post(report(gone, { ok: false }));
    expect(second.statusCode).toBe(201);
    expect(second.json<{ server_audit: unknown }>().server_audit).toBeNull();

    const list = await t.app.inject({ method: "GET", url: "/ops/runs?limit=20" });
    expect(list.statusCode).toBe(200);
    const ids = list.json<{ runs: { id: string }[] }>().runs.map((r) => r.id);
    const secondId = second.json<{ id: string }>().id;
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(run.id));
  });

  it("rejects a malformed report", async () => {
    const res = await post({ ok: true, show: { id: "not-a-uuid" } });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("validation_error");
  });
});
