import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { purgeEphemeralShows } from "../../server/src/engine/maintenance";
import { getShowSnapshot } from "../../server/src/engine/shows";
import { createSweeper } from "../../server/src/jobs/sweeper";
import { SEAT_CODE } from "../../server/src/realtime/hub";
import { errorOf, useTestApp, type TestApp } from "../helpers/api";
import { seatRow } from "../helpers/engine";
import { SeatStream } from "../helpers/sse";

const t = useTestApp({
  STREAM_COALESCE_MS: "20",
  STREAM_HEARTBEAT_MS: "100",
  // Resync off for the test's lifetime: convergence must come from deltas alone.
  STREAM_RESYNC_MS: "3600000",
});

const streams: SeatStream[] = [];
afterAll(async () => {
  await Promise.all(streams.map((s) => s.close()));
});

async function open(app: TestApp, showId: string): Promise<SeatStream> {
  const s = await SeatStream.open(await app.listen(), showId);
  streams.push(s);
  return s;
}

function reserve(showId: string, headers: Record<string, string>, seats: string[], key?: string) {
  return t.app.inject({
    method: "POST",
    url: `/shows/${showId}/reserve`,
    headers: { ...headers, "idempotency-key": key ?? randomUUID() },
    payload: { seats },
  });
}

function lifecycle(action: "confirm" | "cancel", id: string, headers: Record<string, string>) {
  return t.app.inject({ method: "POST", url: `/reservations/${id}/${action}`, headers });
}

async function dbSeats(showId: string): Promise<Map<string, string>> {
  const snap = await getShowSnapshot(t.sql, showId);
  return new Map(snap!.seats.map((s) => [s.label, SEAT_CODE[s.status]]));
}

function sameSeats(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

describe("GET /stream", () => {
  it("opens with a snapshot of the seat map as server-sent events", async () => {
    const show = await t.show({ seats: seatRow("A", 6) });
    const { headers } = await t.user();
    expect((await reserve(show.id, headers, ["A2"])).statusCode).toBe(201);

    const s = await open(t, show.id);
    await s.waitFor(() => s.count("snapshot") === 1);

    expect(s.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(s.headers.get("cache-control")).toMatch(/no-cache/);
    expect(s.headers.get("x-request-id")).toBeTruthy();
    const snap = s.frames[0]!.data;
    expect(snap).toMatchObject({
      labels: seatRow("A", 6),
      status: "acaaaa",
      counts: { total: 6, available: 5, held: 0, confirmed: 1, invariant_ok: true },
    });
    expect((snap.show as { id: string }).id).toBe(show.id);
  });

  it("pushes reserve, confirm and cancel as deltas with reconciled counts", async () => {
    const show = await t.show({ seats: seatRow("A", 4), hold_ttl_seconds: 60 });
    const { headers } = await t.user();
    const s = await open(t, show.id);
    await s.waitFor(() => s.count("snapshot") === 1);

    const held = (await reserve(show.id, headers, ["A1", "A3"])).json<{ reservation_id: string }>();
    await s.waitFor(() => s.seats.get("A1") === "h" && s.seats.get("A3") === "h", 5_000, "hold");
    expect(s.counts).toMatchObject({ available: 2, held: 2, confirmed: 0, invariant_ok: true });

    await lifecycle("confirm", held.reservation_id, headers);
    await s.waitFor(() => s.seats.get("A1") === "c" && s.seats.get("A3") === "c", 5_000, "confirm");
    expect(s.counts).toMatchObject({ available: 2, held: 0, confirmed: 2 });

    await lifecycle("cancel", held.reservation_id, headers);
    await s.waitFor(() => s.seats.get("A1") === "a" && s.seats.get("A3") === "a", 5_000, "cancel");
    expect(s.counts).toMatchObject({ available: 4, held: 0, confirmed: 0, invariant_ok: true });

    // Idempotent repeats change nothing and publish nothing.
    const deltas = s.count("delta");
    await lifecycle("cancel", held.reservation_id, headers);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.count("delta")).toBe(deltas);
  });

  it("coalesces a burst of changes into a few deltas", async () => {
    const show = await t.show({ seats: seatRow("A", 40) });
    const s = await open(t, show.id);
    await s.waitFor(() => s.count("snapshot") === 1);
    const users = await Promise.all(Array.from({ length: 40 }, () => t.user()));

    const results = await Promise.all(
      users.map((u, i) => reserve(show.id, u.headers, [`A${i + 1}`])),
    );
    expect(results.map((r) => r.statusCode)).toEqual(results.map(() => 201));

    // Counts are whole-show totals at each read, so they may lead the seat map by one window
    // (a seat committed just before a read, whose own event lands in the next window).
    await s.waitFor(() => [...s.seats.values()].every((c) => c === "c"), 5_000, "all confirmed");
    expect(s.counts).toMatchObject({ total: 40, available: 0, held: 0, confirmed: 40 });
    expect(s.count("delta")).toBeLessThan(40);
  });

  it("sends heartbeats on idle streams", async () => {
    const show = await t.show({ seats: seatRow("A", 2) });
    const s = await open(t, show.id);
    await s.waitFor(() => s.heartbeats >= 2, 3_000, "heartbeats");
  });

  it("answers errors as JSON before a stream opens: 404 unknown/malformed show, 400 no show", async () => {
    for (const show of [randomUUID(), "not-a-uuid"]) {
      const res = await t.app.inject({ url: `/stream?show=${show}` });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe("show_not_found");
    }
    const res = await t.app.inject({ url: "/stream" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("validation_error");
  });

  it("tells subscribers when their show is deleted, then ends the stream", async () => {
    const show = await t.show({ seats: seatRow("A", 3), ephemeral: true });
    const { headers } = await t.user();
    const s = await open(t, show.id);
    await s.waitFor(() => s.count("snapshot") === 1);

    await t.sql`update shows set created_at = now() - interval '2 days' where id = ${show.id}::uuid`;
    expect(await purgeEphemeralShows(t.sql, 24)).toContain(show.id);
    // The next change notification for the show makes the hub re-read it and find it gone.
    t.app.realtime.bus.emit({ showId: show.id, labels: ["A1"], cause: "cancel" });

    await s.closed();
    expect(s.frames.at(-1)).toEqual({ event: "gone", data: { show_id: show.id } });
    const res = await reserve(show.id, headers, ["A1"]);
    expect(res.statusCode).toBe(404);
  });

  it("two clients converge to the database's state after a mixed burst (deltas only)", async () => {
    const seats = seatRow("A", 40);
    const show = await t.show({ seats, hold_ttl_seconds: 1, per_user_limit: 4 });
    const users = await Promise.all(Array.from({ length: 30 }, () => t.user()));
    const sweeper = createSweeper(t.sql, t.app.realtime.bus);
    const early = await open(t, show.id);
    await early.waitFor(() => early.count("snapshot") === 1);

    let sweeping = true;
    const sweepLoop = (async () => {
      while (sweeping) {
        await sweeper.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    const pick = () => {
      const n = 1 + Math.floor(Math.random() * 3);
      const start = Math.floor(Math.random() * (seats.length - n));
      return seats.slice(start, start + n);
    };
    const actor = async (u: { headers: { authorization: string } }, i: number) => {
      for (let round = 0; round < 4; round++) {
        const key = randomUUID();
        const want = pick();
        const res = await reserve(show.id, u.headers, want, key);
        if (i % 5 === 0) await reserve(show.id, u.headers, want, key); // retry: replay, no delta
        if (res.statusCode !== 201) continue;
        const id = res.json<{ reservation_id: string }>().reservation_id;
        const roll = (i + round) % 3;
        if (roll === 0) await lifecycle("confirm", id, u.headers);
        else if (roll === 1) await lifecycle("cancel", id, u.headers);
        // roll 2: let the hold lapse; the sweeper releases it
        await new Promise((r) => setTimeout(r, Math.random() * 120));
      }
    };
    const work = users.map((u, i) => actor(u, i));
    await new Promise((r) => setTimeout(r, 150));
    const late = await open(t, show.id); // joins mid-burst
    await Promise.all(work);

    // Let every remaining hold lapse, then one last sweep releases them.
    await new Promise((r) => setTimeout(r, 1_200));
    sweeping = false;
    await sweepLoop;
    await sweeper.tick();

    const truth = await dbSeats(show.id);
    const snap = await getShowSnapshot(t.sql, show.id);
    for (const s of [early, late]) {
      await s.waitFor(() => sameSeats(s.seats, truth), 5_000, "convergence");
      await s.waitFor(
        () =>
          s.counts?.available === snap!.counts.available &&
          s.counts.confirmed === snap!.counts.confirmed,
        5_000,
        "counts",
      );
      expect(s.counts).toMatchObject({ ...snap!.counts, held: 0 });
    }
    expect(sameSeats(early.seats, late.seats)).toBe(true);
    // Nothing but the connect snapshot: convergence came from deltas, not resync.
    expect(early.count("snapshot")).toBe(1);
    expect(late.count("snapshot")).toBe(1);
    expect(early.count("delta")).toBeGreaterThan(0);
    expect(sweeper.stats.seatsReleased).toBeGreaterThan(0);
  });
});

describe("stream limits and shutdown", () => {
  const capped = useTestApp({ STREAM_MAX_CLIENTS: "1", STREAM_RESYNC_MS: "1000" });

  it("refuses streams beyond STREAM_MAX_CLIENTS with 503 + Retry-After", async () => {
    const show = await capped.show({ seats: seatRow("A", 2) });
    const first = await open(capped, show.id);
    await first.waitFor(() => first.count("snapshot") === 1);

    const res = await fetch(`${await capped.listen()}/stream?show=${show.id}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("stream_capacity");

    await first.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await open(capped, show.id);
    await again.waitFor(() => again.count("snapshot") === 1);
    await again.close();
  });

  it("resyncs subscribers with a full snapshot every STREAM_RESYNC_MS", async () => {
    const show = await capped.show({ seats: seatRow("A", 2) });
    const s = await open(capped, show.id);
    await s.waitFor(() => s.count("snapshot") >= 2, 4_000, "resync snapshot");
    await s.close();
  });

  it("ends open streams on close, so shutdown never waits on them", async () => {
    const show = await capped.show({ seats: seatRow("A", 2) });
    const s = await open(capped, show.id);
    await s.waitFor(() => s.count("snapshot") === 1);

    const started = Date.now();
    await capped.app.close();
    await s.closed();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(capped.app.realtime.hub.admit()).toBe("closed");
  });
});
