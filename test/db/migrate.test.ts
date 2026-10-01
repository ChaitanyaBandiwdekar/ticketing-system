import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, MigrationDriftError } from "../../server/src/db/migrate";
import { uniq, useTestSql } from "../helpers/db";

const sql = useTestSql(10);

/**
 * Every case uses its own migrations table and table names, so the suite is safe on a shared
 * database (CI, Supabase) and leaves nothing behind.
 */
async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "fdfs-mig-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function scratch() {
  const table = uniq("mig_log");
  const thing = uniq("mig_thing");
  cleanups.push(() => sql.unsafe(`drop table if exists ${table}, ${thing}`));
  return { table, thing };
}

describe("migrate", () => {
  it("applies pending files in order, multi-statement bodies included, and is idempotent", async () => {
    const { table, thing } = scratch();
    const dir = await fixture({
      "0002_add_column.sql": `alter table ${thing} add column note text; insert into ${thing} (id, note) values (2, 'b');`,
      "0001_create.sql": `create table ${thing} (id int primary key); insert into ${thing} (id) values (1);`,
      "README.md": "not a migration",
    });
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const first = await migrate(sql, { dir, table });
    expect(first).toEqual({ applied: ["0001_create", "0002_add_column"], alreadyApplied: 0 });

    const second = await migrate(sql, { dir, table });
    expect(second).toEqual({ applied: [], alreadyApplied: 2 });

    const rows = await sql.unsafe(`select id, note from ${thing} order by id`);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("rolls back every pending file when one fails", async () => {
    const { table, thing } = scratch();
    const dir = await fixture({
      "0001_ok.sql": `create table ${thing} (id int primary key);`,
      "0002_broken.sql": `select * from definitely_not_a_table_${thing};`,
    });
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    await expect(migrate(sql, { dir, table })).rejects.toThrow();
    const [exists] = await sql`select to_regclass(${thing}) as t`;
    expect(exists!.t).toBeNull();
  });

  it("refuses to run when an applied file was edited (checksum drift)", async () => {
    const { table, thing } = scratch();
    const dir = await fixture({ "0001_create.sql": `create table ${thing} (id int);` });
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await migrate(sql, { dir, table });

    await writeFile(join(dir, "0001_create.sql"), `create table ${thing} (id bigint);`);
    await expect(migrate(sql, { dir, table })).rejects.toBeInstanceOf(MigrationDriftError);
  });

  it("serializes concurrent runners: exactly one applies, the rest see it done", async () => {
    const { table, thing } = scratch();
    const dir = await fixture({ "0001_create.sql": `create table ${thing} (id int);` });
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const results = await Promise.all(
      Array.from({ length: 8 }, () => migrate(sql, { dir, table })),
    );
    expect(results.filter((r) => r.applied.length === 1)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyApplied === 1)).toHaveLength(7);
  });
});
