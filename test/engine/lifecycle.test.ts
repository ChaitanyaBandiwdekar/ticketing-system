import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { audit } from "../../server/src/engine/audit";
import { cancel, confirm, expireHolds, listReservations } from "../../server/src/engine/lifecycle";
import { getShowSnapshot } from "../../server/src/engine/shows";
import type { ReserveOutcome, SeatStatus } from "../../server/src/engine/types";
import { uniq, useTestSql } from "../helpers/db";
import { book, invariantViolations, lapse, makeShow } from "../helpers/engine";

const sql = useTestSql(10);
const sweeperSql = useTestSql(2);

function created(o: ReserveOutcome) {
  if (o.outcome !== "created") throw new Error(`expected created, got ${JSON.stringify(o)}`);
  return o.reservation;
}

async function seatStatuses(showId: string, labels: string[]): Promise<SeatStatus[]> {
  const snap = await getShowSnapshot(sql, showId);
  return labels.map((l) => snap!.seats.find((s) => s.label === l)!.status);
}

describe("confirm", () => {
  it("turns a live hold into a confirmed booking and is idempotent", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1", "A2"]));
    expect(hold.status).toBe("held");

    const res = await confirm(sql, { reservationId: hold.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "confirmed", changed: true });
    if (res.outcome !== "confirmed") throw new Error("unreachable");
    expect(res.reservation).toMatchObject({
      reservation_id: hold.reservation_id,
      status: "confirmed",
      expires_at: null,
    });
    expect(await seatStatuses(show.id, ["A1", "A2"])).toEqual(["confirmed", "confirmed"]);
    const rows = await sql<{ held_until: Date | null }[]>`
      select held_until from seats where reservation_id = ${hold.reservation_id}::uuid`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.held_until === null)).toBe(true);

    const again = await confirm(sql, { reservationId: hold.reservation_id, userId: user });
    expect(again).toMatchObject({ outcome: "confirmed", changed: false });
    if (again.outcome !== "confirmed") throw new Error("unreachable");
    expect(again.reservation.reservation_id).toBe(hold.reservation_id);
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });

  it("reports an instant-confirm reservation as already confirmed", async () => {
    const show = await makeShow(sql);
    const user = uniq("u");
    const r = created(await book(sql, show.id, user, ["A1"]));
    const res = await confirm(sql, { reservationId: r.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "confirmed", changed: false });
  });

  it("rejects a non-owner, an unknown id and a malformed id", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1"]));
    expect(await confirm(sql, { reservationId: hold.reservation_id, userId: uniq("x") })).toEqual({
      outcome: "forbidden",
    });
    expect(await confirm(sql, { reservationId: randomUUID(), userId: user })).toEqual({
      outcome: "not_found",
    });
    expect(await confirm(sql, { reservationId: "not-a-uuid", userId: user })).toEqual({
      outcome: "not_found",
    });
    expect(await seatStatuses(show.id, ["A1"])).toEqual(["held"]);
  });

  it("refuses a lapsed hold and leaves its seats unconfirmed", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1", "A2"]));
    await lapse(sql, hold.reservation_id);

    const res = await confirm(sql, { reservationId: hold.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "reservation_expired", changed: false });
    expect(await seatStatuses(show.id, ["A1", "A2"])).toEqual(["available", "available"]);
  });

  it("refuses a cancelled reservation", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1"]));
    await cancel(sql, { reservationId: hold.reservation_id, userId: user });
    const res = await confirm(sql, { reservationId: hold.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "reservation_cancelled", changed: false });
  });
});

describe("cancel", () => {
  it("cancels a confirmed booking, frees seats and quota, and is idempotent", async () => {
    const show = await makeShow(sql, { perUserLimit: 2 });
    const user = uniq("u");
    const r = created(await book(sql, show.id, user, ["A1", "A2"]));
    expect((await book(sql, show.id, user, ["A3"])).outcome).toBe("per_user_limit");

    const res = await cancel(sql, { reservationId: r.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "cancelled", changed: true });
    if (res.outcome !== "cancelled") throw new Error("unreachable");
    expect(res.reservation.status).toBe("cancelled");
    expect(await seatStatuses(show.id, ["A1", "A2"])).toEqual(["available", "available"]);

    created(await book(sql, show.id, user, ["A3", "A4"]));

    const again = await cancel(sql, { reservationId: r.reservation_id, userId: user });
    expect(again).toMatchObject({ outcome: "cancelled", changed: false });
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });

  it("cancels a live hold and releases its seats", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1", "A2"]));
    const res = await cancel(sql, { reservationId: hold.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "cancelled", changed: true });
    expect(await seatStatuses(show.id, ["A1", "A2"])).toEqual(["available", "available"]);
  });

  it("reports a lapsed hold as expired", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1"]));
    await lapse(sql, hold.reservation_id);
    const res = await cancel(sql, { reservationId: hold.reservation_id, userId: user });
    expect(res).toMatchObject({ outcome: "reservation_expired", changed: false });
  });

  it("rejects a non-owner (seats stay taken) and an unknown id", async () => {
    const show = await makeShow(sql);
    const user = uniq("u");
    const r = created(await book(sql, show.id, user, ["A1"]));
    expect(await cancel(sql, { reservationId: r.reservation_id, userId: uniq("x") })).toEqual({
      outcome: "forbidden",
    });
    expect(await seatStatuses(show.id, ["A1"])).toEqual(["confirmed"]);
    expect(await cancel(sql, { reservationId: randomUUID(), userId: user })).toEqual({
      outcome: "not_found",
    });
  });
});

describe("expireHolds", () => {
  it("releases lapsed holds per show, finalizes reservations, and spares live holds", async () => {
    const show1 = await makeShow(sql, { holdTtlSeconds: 120 });
    const show2 = await makeShow(sql, { holdTtlSeconds: 120 });
    const a = created(await book(sql, show1.id, uniq("u"), ["A2", "A1"]));
    const b = created(await book(sql, show1.id, uniq("u"), ["A3"]));
    const c = created(await book(sql, show2.id, uniq("u"), ["A5", "A4"]));
    const live = created(await book(sql, show1.id, uniq("u"), ["A10"]));
    for (const r of [a, b, c]) await lapse(sql, r.reservation_id);

    const res = await expireHolds(sql);
    expect(res.expired).toBeGreaterThanOrEqual(3);
    const mine = res.released.filter((r) => r.show_id === show1.id || r.show_id === show2.id);
    expect(mine).toHaveLength(2);
    expect(mine.find((r) => r.show_id === show1.id)!.seats).toEqual(["A1", "A2", "A3"]);
    expect(mine.find((r) => r.show_id === show2.id)!.seats).toEqual(["A4", "A5"]);

    const ids = [a, b, c].map((r) => r.reservation_id);
    const resRows = await sql<{ status: string }[]>`
      select status from reservations where id = any(${ids}::uuid[])`;
    expect(resRows.map((r) => r.status)).toEqual(["expired", "expired", "expired"]);
    const seatRows = await sql<{ status: string; reservation_id: string | null }[]>`
      select status, reservation_id from seats
       where show_id in (${show1.id}::uuid, ${show2.id}::uuid)
         and label in ('A1', 'A2', 'A3', 'A4', 'A5')`;
    expect(seatRows).toHaveLength(10);
    expect(seatRows.every((s) => s.status === "available" && s.reservation_id === null)).toBe(true);

    const [liveSeat] = await sql<{ status: string }[]>`
      select status from seats where reservation_id = ${live.reservation_id}::uuid`;
    expect(liveSeat!.status).toBe("held");
    const [liveRes] = await sql<{ status: string }[]>`
      select status from reservations where id = ${live.reservation_id}::uuid`;
    expect(liveRes!.status).toBe("held");

    const second = await expireHolds(sql);
    expect(second.released.filter((r) => r.show_id === show1.id || r.show_id === show2.id)).toEqual(
      [],
    );
  });

  it("skips seats locked by another transaction instead of waiting", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const hold = created(await book(sql, show.id, uniq("u"), ["A1"]));
    await lapse(sql, hold.reservation_id);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const locker = sql.begin(async (tx) => {
      await tx`select id from seats where reservation_id = ${hold.reservation_id}::uuid for update`;
      locked();
      await gate;
    });
    await lockedP;

    const started = Date.now();
    const during = await expireHolds(sweeperSql);
    const elapsed = Date.now() - started;
    release();
    await locker;

    expect(elapsed).toBeLessThan(2000);
    expect(during.released.find((r) => r.show_id === show.id)).toBeUndefined();

    const after = await expireHolds(sweeperSql);
    expect(after.released.find((r) => r.show_id === show.id)?.seats).toEqual(["A1"]);
  });

  it("makes late confirm and cancel of a swept hold report expiry", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const hold = created(await book(sql, show.id, user, ["A1"]));
    await lapse(sql, hold.reservation_id);
    await expireHolds(sql);

    const input = { reservationId: hold.reservation_id, userId: user };
    expect(await confirm(sql, input)).toMatchObject({ outcome: "reservation_expired" });
    expect(await cancel(sql, input)).toMatchObject({ outcome: "reservation_expired" });
  });
});

describe("audit", () => {
  it("reports a fresh show as balanced and unknown shows as null", async () => {
    const show = await makeShow(sql);
    expect(await audit(sql, show.id)).toEqual({
      show_id: show.id,
      ok: true,
      counts: { total: 20, available: 20, held: 0, confirmed: 0, invariant_ok: true },
      violations: [],
    });
    expect(await audit(sql, randomUUID())).toBeNull();
    expect(await audit(sql, "nope")).toBeNull();
  });

  it("stays ok across holds, confirms, cancels and lapses, matching the snapshot", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 120 });
    const [u1, u2, u3, u4] = [uniq("u"), uniq("u"), uniq("u"), uniq("u")];
    created(await book(sql, show.id, u1, ["A1", "A2"]));
    const toConfirm = created(await book(sql, show.id, u2, ["A3"]));
    const toCancel = created(await book(sql, show.id, u3, ["A4"]));
    const toLapse = created(await book(sql, show.id, u4, ["A5", "A6"]));
    await confirm(sql, { reservationId: toConfirm.reservation_id, userId: u2 });
    await cancel(sql, { reservationId: toCancel.reservation_id, userId: u3 });
    await lapse(sql, toLapse.reservation_id);

    const report = await audit(sql, show.id);
    const snap = await getShowSnapshot(sql, show.id);
    expect(report!.ok).toBe(true);
    expect(report!.violations).toEqual([]);
    expect(report!.counts).toEqual(snap!.counts);
    expect(report!.counts).toMatchObject({ held: 2, confirmed: 1, available: 17 });
    expect(await invariantViolations(sql, show.id)).toEqual([]);
  });

  it("detects corrupted amounts and per-user limits", async () => {
    const show = await makeShow(sql, { perUserLimit: 4 });
    const r = created(await book(sql, show.id, uniq("u"), ["A1", "A2", "A3"]));
    await sql`update reservations set amount_paise = 1 where id = ${r.reservation_id}::uuid`;
    await sql`update shows set per_user_limit = 2 where id = ${show.id}::uuid`;

    const report = await audit(sql, show.id);
    expect(report!.ok).toBe(false);
    const checks = report!.violations.map((v) => v.check);
    expect(checks).toContain("amount");
    expect(checks).toContain("per_user_limit");
  });
});

describe("listReservations", () => {
  it("lists a user's reservations newest first, filters by show, and shows effective status", async () => {
    const show1 = await makeShow(sql, { holdTtlSeconds: 120 });
    const show2 = await makeShow(sql, { holdTtlSeconds: 120 });
    const user = uniq("u");
    const first = created(await book(sql, show1.id, user, ["A1"]));
    const second = created(await book(sql, show2.id, user, ["A1", "A2"]));
    created(await book(sql, show1.id, uniq("other"), ["A5"]));
    await lapse(sql, first.reservation_id);

    const all = await listReservations(sql, user);
    expect(all.map((r) => r.reservation_id)).toEqual([second.reservation_id, first.reservation_id]);
    expect(all.map((r) => r.status)).toEqual(["held", "expired"]);
    expect(all.every((r) => r.user_id === user)).toBe(true);

    const only1 = await listReservations(sql, user, { showId: show1.id });
    expect(only1.map((r) => r.reservation_id)).toEqual([first.reservation_id]);
    expect(only1[0]!.status).toBe("expired");

    expect(await listReservations(sql, user, { showId: "x" })).toEqual([]);
  });
});
