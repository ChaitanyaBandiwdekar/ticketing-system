import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { errorOf, useTestApp } from "../helpers/api";
import { uniq } from "../helpers/db";
import { seatRow } from "../helpers/engine";

const t = useTestApp();

function create(body: Record<string, unknown>, headers: Record<string, string> = t.admin) {
  return t.app.inject({ method: "POST", url: "/shows", headers, payload: body });
}

const valid = () => ({ name: uniq("show"), seats: seatRow("A", 5), price_paise: 25_000 });

describe("POST /shows", () => {
  it("401 without credentials, 403 for a user token or a wrong admin key", async () => {
    const anon = await create(valid(), {});
    expect(anon.statusCode).toBe(401);
    expect(errorOf(anon).code).toBe("unauthorized");

    const { headers } = await t.user();
    const user = await create(valid(), headers);
    expect(user.statusCode).toBe(403);
    expect(errorOf(user).code).toBe("forbidden");

    const wrongKey = await create(valid(), { authorization: "Bearer not-the-admin-key-000000" });
    expect(wrongKey.statusCode).toBe(403);
  });

  it("201 with defaults applied and all seats available", async () => {
    const body = valid();
    const res = await create(body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: expect.any(String),
      name: body.name,
      price_paise: 25_000,
      total_seats: 5,
      per_user_limit: t.config.reservations.defaultPerUserLimit,
      hold_ttl_seconds: null,
      ephemeral: false,
      counts: { total: 5, available: 5, held: 0, confirmed: 0, invariant_ok: true },
    });
    expect(t.config.reservations.defaultPerUserLimit).toBe(4);
    expect(res.json().id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honours explicit per_user_limit, hold_ttl_seconds and ephemeral", async () => {
    const res = await create({
      ...valid(),
      per_user_limit: 7,
      hold_ttl_seconds: 90,
      ephemeral: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ per_user_limit: 7, hold_ttl_seconds: 90, ephemeral: true });
  });

  it("400 validation_error for invalid bodies", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      "missing name": { seats: ["A1"], price_paise: 100 },
      "empty seats": { ...valid(), seats: [] },
      "bad label": { ...valid(), seats: ["A 1"] },
      "price 0": { ...valid(), price_paise: 0 },
      "limit 101": { ...valid(), per_user_limit: 101 },
      "ttl 0": { ...valid(), hold_ttl_seconds: 0 },
      "empty name": { ...valid(), name: "" },
    };
    for (const [label, body] of Object.entries(cases)) {
      const res = await create(body);
      expect(res.statusCode, label).toBe(400);
      expect(errorOf(res).code, label).toBe("validation_error");
    }
  });

  it("400 with an issues list for duplicate seat labels and bad labels", async () => {
    const dup = await create({ ...valid(), seats: ["A1", "A2", "A1"] });
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).code).toBe("validation_error");
    expect(errorOf(dup).issues).toEqual(expect.arrayContaining(["seat labels must be unique"]));

    const bad = await create({ ...valid(), seats: ["A 1"] });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).issues).toEqual([expect.stringMatching(/invalid seat labels/)]);
  });

  it("layout: stored normalized, returned on create, list and read; absent means null", async () => {
    const res = await create({
      ...valid(),
      layout: { aisles_after: [3, 1, 3], row_gaps_after: ["A", "A"] },
    });
    expect(res.statusCode).toBe(201);
    const layout = { aisles_after: [1, 3], row_gaps_after: ["A"] };
    expect(res.json().layout).toEqual(layout);

    const id = res.json<{ id: string }>().id;
    expect((await t.app.inject({ url: `/shows/${id}` })).json().layout).toEqual(layout);
    const listed = (await t.app.inject({ url: "/shows?limit=500" }))
      .json<{ shows: { id: string; layout: unknown }[] }>()
      .shows.find((s) => s.id === id);
    expect(listed?.layout).toEqual(layout);

    for (const body of [valid(), { ...valid(), layout: null }]) {
      const plain = await create(body);
      expect(plain.statusCode).toBe(201);
      expect(plain.json().layout).toBeNull();
    }
  });

  it("layout: unknown keys are dropped, like everywhere else in the API", async () => {
    const res = await create({ ...valid(), layout: { aisles_after: [2], stage: "north" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().layout).toEqual({ aisles_after: [2], row_gaps_after: [] });
  });

  it("layout: a missing field defaults to empty", async () => {
    const res = await create({ ...valid(), layout: { aisles_after: [2] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().layout).toEqual({ aisles_after: [2], row_gaps_after: [] });

    const empty = await create({ ...valid(), layout: {} });
    expect(empty.json().layout).toEqual({ aisles_after: [], row_gaps_after: [] });
  });

  it("layout: 400 validation_error for bad shapes and values", async () => {
    const cases: Record<string, unknown> = {
      "not an object": [4, 12],
      "a string": "aisles",
      "aisle 0": { aisles_after: [0] },
      "aisle 1001": { aisles_after: [1001] },
      "fractional aisle": { aisles_after: [2.5] },
      "51 aisles": { aisles_after: Array.from({ length: 51 }, (_, i) => i + 1) },
      "bad row label": { row_gaps_after: ["A B"] },
      "long row label": { row_gaps_after: ["ABCDEFGHI"] },
      "51 row gaps": { row_gaps_after: Array.from({ length: 51 }, () => "A") },
    };
    for (const [label, layout] of Object.entries(cases)) {
      const res = await create({ ...valid(), layout });
      expect(res.statusCode, label).toBe(400);
      expect(errorOf(res).code, label).toBe("validation_error");
    }
  });

  it("authenticates before validating: an invalid body without credentials is 401", async () => {
    const res = await create({ nonsense: true }, {});
    expect(res.statusCode).toBe(401);
    const asUser = await create({ nonsense: true }, (await t.user()).headers);
    expect(asUser.statusCode).toBe(403);
  });
});

describe("GET /shows", () => {
  it("lists a newly created show with its counts", async () => {
    const show = await t.show({ seats: seatRow("B", 3) });
    const res = await t.app.inject({ url: "/shows?limit=500" });
    expect(res.statusCode).toBe(200);
    const found = res
      .json<{ shows: ({ id: string } & Record<string, unknown>)[] }>()
      .shows.find((s) => s.id === show.id);
    expect(found).toMatchObject({
      name: show.name,
      total_seats: 3,
      counts: { total: 3, available: 3, held: 0, confirmed: 0, invariant_ok: true },
    });
  });

  it("hides ephemeral shows unless include_ephemeral=true", async () => {
    const show = await t.show({ ephemeral: true });
    const ids = (url: string) =>
      t.app
        .inject({ url })
        .then((r) => r.json<{ shows: { id: string }[] }>().shows.map((s) => s.id));

    expect(await ids("/shows?limit=500")).not.toContain(show.id);
    expect(await ids("/shows?limit=500&include_ephemeral=true")).toContain(show.id);
  });

  it("400 for an out-of-range limit", async () => {
    expect((await t.app.inject({ url: "/shows?limit=0" })).statusCode).toBe(400);
    expect((await t.app.inject({ url: "/shows?limit=501" })).statusCode).toBe(400);
  });
});

describe("GET /shows/:id", () => {
  it("returns the show, counts and the seat map in creation order", async () => {
    const seats = ["C3", "C1", "C2"];
    const show = await t.show({ seats });
    const res = await t.app.inject({ url: `/shows/${show.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json()).toMatchObject({
      id: show.id,
      name: show.name,
      total_seats: 3,
      per_user_limit: 4,
      hold_ttl_seconds: null,
      ephemeral: false,
      counts: { total: 3, available: 3, held: 0, confirmed: 0, invariant_ok: true },
      seats: [
        { label: "C3", status: "available" },
        { label: "C1", status: "available" },
        { label: "C2", status: "available" },
      ],
    });
  });

  it("404 show_not_found for an unknown uuid and for a non-uuid", async () => {
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const res = await t.app.inject({ url: `/shows/${id}` });
      expect(res.statusCode, id).toBe(404);
      expect(errorOf(res).code).toBe("show_not_found");
    }
  });

  it("reads a reserved seat as confirmed", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    const reserve = await t.app.inject({
      method: "POST",
      url: `/shows/${show.id}/reserve`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { seats: ["A2"] },
    });
    expect(reserve.statusCode).toBe(201);

    const snap = (await t.app.inject({ url: `/shows/${show.id}` })).json<{
      counts: Record<string, unknown>;
      seats: { label: string; status: string }[];
    }>();
    expect(snap.seats.find((s) => s.label === "A2")?.status).toBe("confirmed");
    expect(snap.seats.find((s) => s.label === "A1")?.status).toBe("available");
    expect(snap.counts).toMatchObject({ available: 19, confirmed: 1, invariant_ok: true });
  });
});

describe("GET /shows/:id/audit", () => {
  it("reports ok with no violations for a healthy show", async () => {
    const show = await t.show();
    const res = await t.app.inject({ url: `/shows/${show.id}/audit` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      show_id: show.id,
      ok: true,
      counts: { total: 20, available: 20, held: 0, confirmed: 0, invariant_ok: true },
      violations: [],
    });
  });

  it("404 show_not_found for an unknown show", async () => {
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const res = await t.app.inject({ url: `/shows/${id}/audit` });
      expect(res.statusCode, id).toBe(404);
      expect(errorOf(res).code).toBe("show_not_found");
    }
  });
});
