import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createShow,
  getShowSnapshot,
  ShowValidationError,
  validateShowInput,
  type CreateShowInput,
} from "../../server/src/engine/shows";
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
