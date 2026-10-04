import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { errorOf, useTestApp } from "../helpers/api";
import { lapse } from "../helpers/engine";

const t = useTestApp();

function reserve(
  showId: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  key: string | null = randomUUID(),
) {
  return t.app.inject({
    method: "POST",
    url: `/shows/${showId}/reserve`,
    headers: key === null ? headers : { ...headers, "idempotency-key": key },
    payload,
  });
}

describe("POST /shows/:id/reserve", () => {
  it("201 with the reservation body; identity comes from the token", async () => {
    const show = await t.show({ price_paise: 30_000 });
    const { userId, headers } = await t.user();
    const res = await reserve(show.id, headers, { seats: ["A2", "A1"] });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      show_id: show.id,
      user_id: userId,
      seats: ["A1", "A2"],
      amount_paise: 60_000,
      status: "confirmed",
      expires_at: null,
    });
    expect(Object.keys(res.json()).sort()).toEqual([
      "amount_paise",
      "created_at",
      "expires_at",
      "reservation_id",
      "seats",
      "show_id",
      "status",
      "user_id",
    ]);
  });

  it("replays a retry: the original 201 and body, Idempotent-Replayed header, no second booking", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    const first = await reserve(show.id, headers, { seats: ["A1"] }, "retry-1");
    const again = await reserve(show.id, headers, { seats: ["A1"] }, "retry-1");

    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    const snap = await t.app.inject({ url: `/shows/${show.id}` });
    expect(snap.json().counts.confirmed).toBe(1);
  });

  it("accepts the key in the body too; header and body must agree", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    const viaBody = await reserve(show.id, headers, { seats: ["A1"], idempotency_key: "b1" }, null);
    expect(viaBody.statusCode).toBe(201);

    const both = await reserve(show.id, headers, { seats: ["A2"], idempotency_key: "x" }, "y");
    expect(both.statusCode).toBe(400);
    expect(errorOf(both).code).toBe("validation_error");
  });

  it("without a key, each request stands alone: booked or declined, never replayed", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    const first = await reserve(show.id, headers, { seats: ["A1"] }, null);
    expect(first.statusCode).toBe(201);
    const again = await reserve(show.id, headers, { seats: ["A1"] }, null);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe("seat_taken");
    const other = await reserve(show.id, headers, { seats: ["A2"] }, null);
    expect(other.statusCode).toBe(201);
    expect(other.json().reservation_id).not.toBe(first.json().reservation_id);

    const empty = await reserve(show.id, headers, { seats: ["A3"] }, "");
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).message).toMatch(/Idempotency-Key/);
  });

  it("409 when a key is reused for a different request", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    await reserve(show.id, headers, { seats: ["A1"] }, "k");
    const res = await reserve(show.id, headers, { seats: ["A2"] }, "k");
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe("idempotency_key_reused");
  });

  it("ignores a spoofed body user_id: the booking belongs to the token's user", async () => {
    const show = await t.show();
    const victim = await t.user();
    const attacker = await t.user();
    const res = await reserve(show.id, attacker.headers, { seats: ["A1"], user_id: victim.userId });
    expect(res.statusCode).toBe(201);
    expect(res.json().user_id).toBe(attacker.userId);

    const mine = await t.app.inject({ url: "/me/reservations", headers: victim.headers });
    expect(mine.json().reservations).toEqual([]);
  });

  it("409 seat_taken lists the unavailable seats; nothing partial is booked", async () => {
    const show = await t.show();
    await reserve(show.id, (await t.user()).headers, { seats: ["A3"] });
    const res = await reserve(show.id, (await t.user()).headers, { seats: ["A2", "A3"] });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "seat_taken", unavailable_seats: ["A3"] });
    expect(errorOf(res).request_id).toBe(res.headers["x-request-id"]);
    const snap = await t.app.inject({ url: `/shows/${show.id}` });
    expect(snap.json().counts.confirmed).toBe(1);
  });

  it("409 per_user_limit with the numbers", async () => {
    const show = await t.show({ per_user_limit: 2 });
    const { headers } = await t.user();
    await reserve(show.id, headers, { seats: ["A1"] });
    const res = await reserve(show.id, headers, { seats: ["A2", "A3"] });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: "per_user_limit",
      limit: 2,
      active: 1,
      requested: 2,
    });
  });

  it("400 for unknown or malformed seats, 404 for an unknown show", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    const unknown = await reserve(show.id, headers, { seats: ["A1", "Z99"] });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown)).toMatchObject({ code: "unknown_seats", unknown_seats: ["Z99"] });

    for (const payload of [{ seats: [] }, { seats: ["A1", "A1"] }, {}, { seats: "A1,A2" }]) {
      const res = await reserve(show.id, headers, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    for (const id of [randomUUID(), "not-a-uuid"]) {
      const res = await reserve(id, headers, { seats: ["A1"] });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe("show_not_found");
    }
  });

  it("401 without a valid token, before looking at the body", async () => {
    const show = await t.show();
    for (const headers of [
      {},
      { authorization: "Bearer nope" },
      { authorization: `Bearer ${"x".repeat(20)}.${"y".repeat(20)}.${"z".repeat(20)}` },
      t.admin, // the admin key is not a user identity
    ]) {
      const res = await reserve(show.id, headers, { not: "even valid" });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
    }
  });

  it("survives a concurrent stampede through the HTTP layer: one winner, no 5xx", async () => {
    const show = await t.show();
    const users = await Promise.all(Array.from({ length: 60 }, () => t.user()));
    const responses = await Promise.all(
      users.map((u) => reserve(show.id, u.headers, { seats: ["A7"] })),
    );
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(59);
    const audit = await t.app.inject({ url: `/shows/${show.id}/audit` });
    expect(audit.json()).toMatchObject({ ok: true, violations: [] });
  });
});

describe("POST /reservations/:id/confirm and /cancel", () => {
  it("confirms a hold, replays a repeat confirm, then cancels", async () => {
    const show = await t.show({ hold_ttl_seconds: 120 });
    const { headers } = await t.user();
    const held = (await reserve(show.id, headers, { seats: ["A1"] })).json();
    expect(held.status).toBe("held");
    expect(held.expires_at).not.toBeNull();

    const url = (action: string) => `/reservations/${held.reservation_id}/${action}`;
    const confirmed = await t.app.inject({ method: "POST", url: url("confirm"), headers });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "confirmed", expires_at: null });
    expect(confirmed.headers["idempotent-replayed"]).toBeUndefined();

    const again = await t.app.inject({ method: "POST", url: url("confirm"), headers });
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");

    const cancelled = await t.app.inject({ method: "POST", url: url("cancel"), headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");
    const twice = await t.app.inject({ method: "POST", url: url("cancel"), headers });
    expect(twice.statusCode).toBe(200);
    expect(twice.json()).toEqual(cancelled.json());

    const reconfirm = await t.app.inject({ method: "POST", url: url("confirm"), headers });
    expect(reconfirm.statusCode).toBe(409);
    expect(errorOf(reconfirm).code).toBe("reservation_cancelled");
  });

  it("403 for someone else's reservation, 404 for an unknown one", async () => {
    const show = await t.show();
    const owner = await t.user();
    const other = await t.user();
    const r = (await reserve(show.id, owner.headers, { seats: ["A1"] })).json();

    const foreign = await t.app.inject({
      method: "POST",
      url: `/reservations/${r.reservation_id}/cancel`,
      headers: other.headers,
    });
    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe("forbidden");

    for (const id of [randomUUID(), "junk"]) {
      const res = await t.app.inject({
        method: "POST",
        url: `/reservations/${id}/confirm`,
        headers: owner.headers,
      });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).code).toBe("reservation_not_found");
    }
  });

  it("409 reservation_expired for a lapsed hold", async () => {
    const show = await t.show({ hold_ttl_seconds: 120 });
    const { headers } = await t.user();
    const r = (await reserve(show.id, headers, { seats: ["A1"] })).json();
    await lapse(t.sql, r.reservation_id);
    const res = await t.app.inject({
      method: "POST",
      url: `/reservations/${r.reservation_id}/confirm`,
      headers,
    });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe("reservation_expired");
  });
});

describe("GET /me/reservations", () => {
  it("lists only the caller's reservations, optionally per show", async () => {
    const [s1, s2] = [await t.show(), await t.show()];
    const me = await t.user();
    const other = await t.user();
    await reserve(s1.id, me.headers, { seats: ["A1"] });
    await reserve(s2.id, me.headers, { seats: ["A1"] });
    await reserve(s1.id, other.headers, { seats: ["A2"] });

    const all = await t.app.inject({ url: "/me/reservations", headers: me.headers });
    expect(
      all
        .json()
        .reservations.map((r: { show_id: string }) => r.show_id)
        .sort(),
    ).toEqual([s1.id, s2.id].sort());
    const one = await t.app.inject({
      url: `/me/reservations?show_id=${s1.id}`,
      headers: me.headers,
    });
    expect(one.json().reservations).toHaveLength(1);
    expect((await t.app.inject({ url: "/me/reservations" })).statusCode).toBe(401);
  });
});
