import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createShow,
  getShowSnapshot,
  ShowValidationError,
  validateShowInput,
  type CreateShowInput,
} from "../../server/src/engine/shows";
import type { ShowLayout } from "../../server/src/engine/types";
import { uniq, useTestSql } from "../helpers/db";
import { book, makeShow } from "../helpers/engine";

const sql = useTestSql(5);

const MAX_SEATS = 100;

function valid(overrides: Partial<CreateShowInput> = {}): CreateShowInput {
  return {
    name: uniq("show"),
    seats: ["A1", "A2", "A3"],
    pricePaise: 25_000,
    perUserLimit: 4,
    ...overrides,
  };
}

function issuesFor(overrides: Partial<CreateShowInput>, max = MAX_SEATS): string[] {
  return validateShowInput(valid(overrides), max);
}

describe("validateShowInput", () => {
  it("returns no issues for a valid input", () => {
    expect(validateShowInput(valid(), MAX_SEATS)).toEqual([]);
  });

  it("accepts null and undefined hold_ttl_seconds", () => {
    expect(issuesFor({ holdTtlSeconds: null })).toEqual([]);
    expect(issuesFor({ holdTtlSeconds: undefined })).toEqual([]);
  });

  it("accepts the boundary values", () => {
    expect(
      issuesFor({
        name: "n".repeat(200),
        pricePaise: 10_000_000,
        perUserLimit: 100,
        holdTtlSeconds: 3600,
      }),
    ).toEqual([]);
    expect(issuesFor({ pricePaise: 1, perUserLimit: 1, holdTtlSeconds: 1 })).toEqual([]);
    expect(issuesFor({ seats: ["a".repeat(16), "Z-9"] })).toEqual([]);
  });

  it.each([
    ["blank name", { name: "   " }, /name/],
    ["empty name", { name: "" }, /name/],
    ["name over 200 chars", { name: "n".repeat(201) }, /name/],
    ["empty seats", { seats: [] }, /seats must not be empty/],
    ["invalid label with a space", { seats: ["A 1"] }, /invalid seat labels/],
    ["empty label", { seats: [""] }, /invalid seat labels/],
    ["17-char label", { seats: ["A".repeat(17)] }, /invalid seat labels/],
    ["duplicate labels", { seats: ["A1", "A2", "A1"] }, /unique/],
    ["price 0", { pricePaise: 0 }, /price_paise/],
    ["non-integer price", { pricePaise: 10.5 }, /price_paise/],
    ["price over 10_000_000", { pricePaise: 10_000_001 }, /price_paise/],
    ["per_user_limit 0", { perUserLimit: 0 }, /per_user_limit/],
    ["per_user_limit 101", { perUserLimit: 101 }, /per_user_limit/],
    ["hold_ttl_seconds 0", { holdTtlSeconds: 0 }, /hold_ttl_seconds/],
    ["hold_ttl_seconds 3601", { holdTtlSeconds: 3601 }, /hold_ttl_seconds/],
  ] as [string, Partial<CreateShowInput>, RegExp][])("reports %s", (_label, overrides, pattern) => {
    const issues = issuesFor(overrides);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(pattern);
  });

  it("reports too many seats against the maxSeatsPerShow argument", () => {
    const seats = ["A1", "A2", "A3"];
    expect(validateShowInput(valid({ seats }), 3)).toEqual([]);
    const issues = validateShowInput(valid({ seats }), 2);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/at most 2 seats/);
  });

  it("reports multiple problems at once", () => {
    const issues = issuesFor({
      name: " ",
      seats: ["A 1", "A 1"],
      pricePaise: 0,
      perUserLimit: 101,
      holdTtlSeconds: 0,
    });
    expect(issues.length).toBeGreaterThan(1);
    expect(issues).toHaveLength(6);
  });
});

describe("validateShowInput: layout", () => {
  const layout = (l: Partial<ShowLayout>): ShowLayout => ({
    aisles_after: [],
    row_gaps_after: [],
    ...l,
  });

  it("accepts no layout, an empty layout and the boundary values", () => {
    expect(issuesFor({ layout: null })).toEqual([]);
    expect(issuesFor({ layout: undefined })).toEqual([]);
    expect(issuesFor({ layout: layout({}) })).toEqual([]);
    expect(
      issuesFor({
        layout: layout({
          aisles_after: [1, 1000, ...Array.from({ length: 48 }, (_, i) => i + 2)],
          row_gaps_after: ["A", "ZZ", "a1", "ABCDEFGH", ...Array.from({ length: 46 }, () => "E")],
        }),
      }),
    ).toEqual([]);
  });

  it.each([
    ["aisle 0", { aisles_after: [0] }, /aisles_after/],
    ["aisle 1001", { aisles_after: [1001] }, /aisles_after/],
    ["fractional aisle", { aisles_after: [2.5] }, /aisles_after/],
    ["NaN aisle", { aisles_after: [Number.NaN] }, /aisles_after/],
    ["51 aisles", { aisles_after: Array.from({ length: 51 }, (_, i) => i + 1) }, /aisles_after/],
    ["aisles not an array", { aisles_after: 4 as unknown as number[] }, /aisles_after/],
    ["empty row label", { row_gaps_after: [""] }, /row_gaps_after/],
    ["9-char row label", { row_gaps_after: ["ABCDEFGHI"] }, /row_gaps_after/],
    ["row label with a dash", { row_gaps_after: ["A-1"] }, /row_gaps_after/],
    ["non-string row label", { row_gaps_after: [5 as unknown as string] }, /row_gaps_after/],
    ["51 row gaps", { row_gaps_after: Array.from({ length: 51 }, () => "A") }, /row_gaps_after/],
    ["row gaps missing", { row_gaps_after: undefined as unknown as string[] }, /row_gaps_after/],
  ] as [string, Partial<ShowLayout>, RegExp][])("reports %s", (_label, overrides, pattern) => {
    const issues = issuesFor({ layout: layout(overrides) });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(pattern);
  });

  it("reports both layout fields alongside other problems", () => {
    const issues = issuesFor({
      pricePaise: 0,
      layout: layout({ aisles_after: [-1], row_gaps_after: ["?"] }),
    });
    expect(issues).toHaveLength(3);
  });
});

describe("createShow", () => {
  it("throws ShowValidationError with the issues and writes nothing for invalid input", async () => {
    const name = uniq("invalid");
    const input = valid({ name, seats: ["A1", "A1"], pricePaise: 0 });

    const err = await createShow(sql, input, { maxSeatsPerShow: MAX_SEATS }).catch((e) => e);
    expect(err).toBeInstanceOf(ShowValidationError);
    expect((err as ShowValidationError).issues).toEqual(validateShowInput(input, MAX_SEATS));
    expect((err as ShowValidationError).issues.length).toBeGreaterThan(0);

    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from shows where name = ${name}`;
    expect(row!.n).toBe(0);
  });

  it("returns the created show with defaults applied", async () => {
    const input = valid({ seats: ["B2", "A1", "A10", "A2"] });
    const show = await createShow(sql, input, { maxSeatsPerShow: MAX_SEATS });

    expect(show.name).toBe(input.name);
    expect(show.total_seats).toBe(input.seats.length);
    expect(show.ephemeral).toBe(false);
    expect(show.hold_ttl_seconds).toBeNull();
    expect(show.per_user_limit).toBe(4);
    expect(typeof show.price_paise).toBe("number");
    expect(show.price_paise).toBe(25_000);
    expect(show.created_at).toBe(new Date(show.created_at).toISOString());
  });

  it("honours ephemeral and holdTtlSeconds when given", async () => {
    const show = await makeShow(sql, { ephemeral: true, holdTtlSeconds: 90 });
    expect(show.ephemeral).toBe(true);
    expect(show.hold_ttl_seconds).toBe(90);
  });

  it("inserts seats in input order", async () => {
    const seats = ["B2", "A1", "A10", "A2"];
    const show = await makeShow(sql, { seats });

    const rows = await sql<{ label: string }[]>`
      select label from seats where show_id = ${show.id}::uuid order by id`;
    expect(rows.map((r) => r.label)).toEqual(seats);
  });

  it("stores no layout as null", async () => {
    const show = await createShow(sql, valid(), { maxSeatsPerShow: MAX_SEATS });
    expect(show.layout).toBeNull();
  });

  it("stores the layout normalized (aisles sorted and unique, gaps unique in order)", async () => {
    const show = await createShow(
      sql,
      valid({ layout: { aisles_after: [12, 4, 12, 8], row_gaps_after: ["E", "B", "E"] } }),
      { maxSeatsPerShow: MAX_SEATS },
    );
    const expected = { aisles_after: [4, 8, 12], row_gaps_after: ["E", "B"] };
    expect(show.layout).toEqual(expected);

    const [row] = await sql<{ layout: ShowLayout; type: string }[]>`
      select layout, jsonb_typeof(layout) as type from shows where id = ${show.id}::uuid`;
    expect(row!.type).toBe("object");
    expect(row!.layout).toEqual(expected);
    expect((await getShowSnapshot(sql, show.id))!.show.layout).toEqual(expected);
  });

  it("rejects an invalid layout and writes nothing", async () => {
    const name = uniq("bad_layout");
    const err = await createShow(
      sql,
      valid({ name, layout: { aisles_after: [0], row_gaps_after: [] } }),
      { maxSeatsPerShow: MAX_SEATS },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ShowValidationError);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from shows where name = ${name}`;
    expect(row!.n).toBe(0);
  });

  it("the database refuses a non-object layout", async () => {
    const show = await makeShow(sql);
    await expect(
      sql`update shows set layout = '[1, 2]'::jsonb where id = ${show.id}::uuid`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe("getShowSnapshot", () => {
  it("returns null for an unknown show", async () => {
    expect(await getShowSnapshot(sql, randomUUID())).toBeNull();
  });

  it("reads a fresh show as fully available, in seat order", async () => {
    const seats = ["B2", "A1", "A10", "A2"];
    const show = await makeShow(sql, { seats });

    const snap = await getShowSnapshot(sql, show.id);
    expect(snap).not.toBeNull();
    expect(snap!.show).toEqual(show);
    expect(snap!.seats).toEqual(seats.map((label) => ({ label, status: "available" })));
    expect(snap!.counts).toEqual({
      total: 4,
      available: 4,
      held: 0,
      confirmed: 0,
      invariant_ok: true,
    });
  });

  it("reads booked seats as confirmed when the show has no hold ttl", async () => {
    const show = await makeShow(sql);
    const outcome = await book(sql, show.id, "user-1", ["A1", "A2"]);
    expect(outcome.outcome).toBe("created");

    const snap = await getShowSnapshot(sql, show.id);
    const status = (label: string) => snap!.seats.find((s) => s.label === label)!.status;
    expect(status("A1")).toBe("confirmed");
    expect(status("A2")).toBe("confirmed");
    expect(status("A3")).toBe("available");
    expect(snap!.counts).toEqual({
      total: show.total_seats,
      available: show.total_seats - 2,
      held: 0,
      confirmed: 2,
      invariant_ok: true,
    });
  });

  it("reads a lapsed hold as available again while the invariant still holds", async () => {
    const show = await makeShow(sql, { holdTtlSeconds: 60 });
    const outcome = await book(sql, show.id, "user-1", ["A1"]);
    expect(outcome.outcome).toBe("created");

    const held = await getShowSnapshot(sql, show.id);
    expect(held!.seats.find((s) => s.label === "A1")!.status).toBe("held");
    expect(held!.counts.held).toBe(1);
    expect(held!.counts.invariant_ok).toBe(true);

    await sql`
      update seats set held_until = now() - interval '1 second'
       where show_id = ${show.id}::uuid and status = 'held'`;

    const lapsed = await getShowSnapshot(sql, show.id);
    expect(lapsed!.seats.find((s) => s.label === "A1")!.status).toBe("available");
    expect(lapsed!.counts).toEqual({
      total: show.total_seats,
      available: show.total_seats,
      held: 0,
      confirmed: 0,
      invariant_ok: true,
    });
  });
});
