import { describe, expect, it } from "vitest";
import { useTestApp } from "../helpers/api";
import { uniq } from "../helpers/db";

// The micro-cache on: long enough that only a write can explain a fresh read.
const t = useTestApp({ SNAPSHOT_CACHE_MS: "10000" });

const getShow = async (id: string) => (await t.app.inject({ url: `/shows/${id}` })).json();
const seat = (snap: { seats: { label: string; status: string }[] }, label: string) =>
  snap.seats.find((s) => s.label === label)?.status;

describe("GET /shows/:id snapshot cache", () => {
  it("serves cached snapshots, yet a client reads its own write right after the 201", async () => {
    const show = await t.show();
    const { headers } = await t.user();
    expect(seat(await getShow(show.id), "A1")).toBe("available");

    // A change no write path announced (a rename) stays hidden: the cache is in play.
    await t.sql`update shows set name = ${uniq("renamed")} where id = ${show.id}`;
    expect((await getShow(show.id)).name).toBe(show.name);

    const res = await t.app.inject({
      method: "POST",
      url: `/shows/${show.id}/reserve`,
      headers: { ...headers, "idempotency-key": uniq("k") },
      payload: { seats: ["A1"] },
    });
    expect(res.statusCode).toBe(201);

    const after = await getShow(show.id);
    expect(seat(after, "A1")).toBe("confirmed");
    expect(after.counts).toMatchObject({ confirmed: 1, available: after.counts.total - 1 });
    expect(after.name).not.toBe(show.name);

    const cancel = await t.app.inject({
      method: "POST",
      url: `/reservations/${res.json().reservation_id}/cancel`,
      headers,
    });
    expect(cancel.statusCode).toBe(200);
    expect(seat(await getShow(show.id), "A1")).toBe("available");
  });
});
