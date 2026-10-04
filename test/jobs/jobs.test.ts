import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { audit } from "../../server/src/engine/audit";
import { purgeEphemeralShows, purgeIdempotencyKeys } from "../../server/src/engine/maintenance";
import type { ReserveOutcome } from "../../server/src/engine/types";
import { createJanitor } from "../../server/src/jobs/janitor";
import { Periodic } from "../../server/src/jobs/periodic";
import { createReconciler } from "../../server/src/jobs/reconciler";
import { createSweeper } from "../../server/src/jobs/sweeper";
import { EventBus, type SeatChange } from "../../server/src/realtime/bus";
import { uniq, useTestSql } from "../helpers/db";
import { book, lapse, makeShow, seatRow } from "../helpers/engine";

const sql = useTestSql(30);

const quietLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function created(o: ReserveOutcome) {
  if (o.outcome !== "created") throw new Error(`expected created, got ${o.outcome}`);
  return o.reservation;
}

async function rowCounts(showId: string) {
  const [row] = await sql<{ shows: number; seats: number; reservations: number; keys: number }[]>`
    select (select count(*) from shows where id = ${showId}::uuid)::int as shows,
           (select count(*) from seats where show_id = ${showId}::uuid)::int as seats,
           (select count(*) from reservations where show_id = ${showId}::uuid)::int as reservations,
           (select count(*) from idempotency_keys k join reservations r on r.id = k.reservation_id
             where r.show_id = ${showId}::uuid)::int as keys`;
  return row!;
}

describe("Periodic", () => {
  it("never overlaps ticks, survives a failing tick, and stop() waits for the one in flight", async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const log = quietLog();
    const job = new Periodic(
      "test",
      5,
      async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
        if (calls === 2) throw new Error("boom");
      },
      log,
    );
    job.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(4), { timeout: 2_000 });
    await job.stop();
    expect(running).toBe(0);
    expect(maxRunning).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ job: "test" }, "job recovered");
    const after = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(after);
  });

  it("logs only the first of consecutive failures and remembers the last error", async () => {
    const log = quietLog();
    const job = new Periodic("flaky", 1_000, () => Promise.reject(new Error("db down")), log);
    await job.runOnce();
    await job.runOnce();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(job.lastError).toBe("db down");
    expect(job.ticks).toBe(2);
  });
});

describe("sweeper job", () => {
  it("releases lapsed holds and publishes the released seats per show", async () => {
    const bus = new EventBus();
    const events: SeatChange[] = [];
    bus.on((e) => events.push(e));
    const a = await makeShow(sql, { holdTtlSeconds: 60 });
    const b = await makeShow(sql, { holdTtlSeconds: 60 });
    const ra = created(await book(sql, a.id, uniq("u"), ["A1", "A2"]));
    const rb = created(await book(sql, b.id, uniq("u"), ["A5"]));
    const live = created(await book(sql, a.id, uniq("u"), ["A3"]));
    await lapse(sql, ra.reservation_id);
    await lapse(sql, rb.reservation_id);

    const sweeper = createSweeper(sql, bus);
    await sweeper.tick();

    const mine = events.filter((e) => e.showId === a.id || e.showId === b.id);
    expect(mine).toEqual(
      expect.arrayContaining([
        { showId: a.id, labels: ["A1", "A2"], cause: "expire" },
        { showId: b.id, labels: ["A5"], cause: "expire" },
      ]),
    );
    expect(mine.flatMap((e) => e.labels)).not.toContain("A3");
    expect(sweeper.stats.seatsReleased).toBeGreaterThanOrEqual(3);
    expect(sweeper.stats.holdsExpired).toBeGreaterThanOrEqual(2);
    const [seat] = await sql<{ status: string }[]>`
      select status from seats where show_id = ${a.id}::uuid and label = 'A3'`;
    expect(seat!.status).toBe("held");
    expect(live.status).toBe("held");
  });

  it("keeps sweeping within one tick while full batches come back", async () => {
    const bus = new EventBus();
    let released = 0;
    bus.on((e) => (released += e.labels.length));
    const show = await makeShow(sql, {
      seats: seatRow("A", 1_200),
      holdTtlSeconds: 60,
      perUserLimit: 100,
    });
    const users = Array.from({ length: 12 }, () => uniq("u"));
    const holds = await Promise.all(
      users.map((u, i) => book(sql, show.id, u, seatRow("A", 1_200).slice(i * 100, (i + 1) * 100))),
    );
    await Promise.all(holds.map((o) => lapse(sql, created(o).reservation_id)));

    await createSweeper(sql, bus).tick();
    expect(released).toBeGreaterThanOrEqual(1_200);
    const report = await audit(sql, show.id);
    expect(report!.counts.available).toBe(1_200);
  });
});

describe("reconciler job", () => {
  it("audits recently active and watched shows, and reports each verdict", async () => {
    const bus = new EventBus();
    const touched = await makeShow(sql);
    const watched = await makeShow(sql);
    const idle = await makeShow(sql);
    const onReport = vi.fn();
    const rec = createReconciler({
      sql,
      bus,
      log: quietLog(),
      watchedShows: () => [watched.id],
      onReport,
    });
    bus.emit({ showId: touched.id, labels: ["A1"], cause: "reserve" });

    await rec.tick();
    const audited = onReport.mock.calls.map(([r]) => (r as { show_id: string }).show_id);
    expect(audited.sort()).toEqual([touched.id, watched.id].sort());
    expect(audited).not.toContain(idle.id);
    expect(rec.stats).toEqual({ violations: 0, audits: 2 });
    expect(rec.latest.get(touched.id)!.report.ok).toBe(true);
    rec.stop();
  });

  it("logs and counts violations, and forgets deleted shows", async () => {
    const bus = new EventBus();
    const log = quietLog();
    const show = await makeShow(sql, { perUserLimit: 4 });
    const r = created(await book(sql, show.id, uniq("u"), ["A1", "A2", "A3"]));
    await sql`update reservations set amount_paise = 1 where id = ${r.reservation_id}::uuid`;
    const rec = createReconciler({ sql, bus, log });
    bus.emit({ showId: show.id, labels: ["A1"], cause: "reserve" });

    await rec.tick();
    expect(rec.stats.violations).toBeGreaterThanOrEqual(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ show: show.id }),
      "invariant_violation",
    );

    const gone = randomUUID();
    bus.emit({ showId: gone, labels: ["A1"], cause: "reserve" });
    await rec.tick();
    expect(rec.activeShows()).not.toContain(gone);
    rec.stop();
  });
});

describe("janitor", () => {
  it("deletes old ephemeral shows with their seats, reservations and keys; keeps the rest", async () => {
    const old = await makeShow(sql, { ephemeral: true });
    const fresh = await makeShow(sql, { ephemeral: true });
    const oldReal = await makeShow(sql, { ephemeral: false });
    for (const s of [old, fresh, oldReal]) {
      created(await book(sql, s.id, uniq("u"), ["A1", "A2"]));
    }
    await sql`
      update shows set created_at = now() - interval '25 hours'
       where id in (${old.id}::uuid, ${oldReal.id}::uuid)`;

    const deleted: string[][] = [];
    const janitor = createJanitor(
      sql,
      { ephemeralShowTtlHours: 24, idempotencyKeyTtlHours: 24 },
      quietLog(),
      (ids) => deleted.push(ids),
    );
    await janitor.tick();

    expect(await rowCounts(old.id)).toEqual({ shows: 0, seats: 0, reservations: 0, keys: 0 });
    expect(await rowCounts(fresh.id)).toMatchObject({ shows: 1, seats: 20, reservations: 1 });
    expect(await rowCounts(oldReal.id)).toMatchObject({ shows: 1, seats: 20, reservations: 1 });
    expect(deleted.flat()).toContain(old.id);
    expect(janitor.stats.showsDeleted).toBeGreaterThanOrEqual(1);
  });

  it("expires idempotency keys past their TTL: a late retry becomes a new request", async () => {
    const show = await makeShow(sql);
    const user = uniq("u");
    const first = created(await book(sql, show.id, user, ["A1"], "k-old"));
    created(await book(sql, show.id, user, ["A2"], "k-new"));
    await sql`
      update idempotency_keys set created_at = now() - interval '25 hours'
       where user_id = ${user} and key = 'k-old'`;

    expect(await purgeIdempotencyKeys(sql, 24)).toBeGreaterThanOrEqual(1);
    const keys = await sql<{ key: string }[]>`
      select key from idempotency_keys where user_id = ${user} order by key`;
    expect(keys.map((k) => k.key)).toEqual(["k-new"]);

    // Same key and seats again: no longer a replay of `first`. A1 is still taken by it.
    const retry = await book(sql, show.id, user, ["A1"], "k-old");
    expect(retry.outcome).toBe("seat_taken");
    expect(first.status).toBe("confirmed");
    expect((await audit(sql, show.id))!.ok).toBe(true);
  });

  it("purging a show mid-stampede leaves no orphans and no errors", async () => {
    const show = await makeShow(sql, { seats: seatRow("A", 60), ephemeral: true });
    await sql`update shows set created_at = now() - interval '25 hours' where id = ${show.id}::uuid`;
    const attempts = Array.from({ length: 120 }, (_, i) =>
      book(sql, show.id, uniq("u"), [`A${(i % 60) + 1}`]),
    );
    const [outcomes, purged] = await Promise.all([
      Promise.all(attempts),
      new Promise((r) => setTimeout(r, 5)).then(() => purgeEphemeralShows(sql, 24)),
    ]);

    expect(purged).toContain(show.id);
    const kinds = new Set(outcomes.map((o) => o.outcome));
    for (const k of kinds) expect(["created", "seat_taken", "show_not_found"]).toContain(k);
    expect(await rowCounts(show.id)).toEqual({ shows: 0, seats: 0, reservations: 0, keys: 0 });
    const [orphans] = await sql<{ n: number }[]>`
      select count(*)::int as n from reservations where show_id = ${show.id}::uuid`;
    expect(orphans!.n).toBe(0);
  });
});
