/**
 * Forward-only SQL migrations, applied on boot and by `npm run db:migrate`.
 *
 * - Files: `NNNN_name.sql` in lexical order. Each file may hold many statements (simple protocol).
 * - All pending files apply in ONE transaction behind a transaction-scoped advisory lock, so two
 *   instances booting together (Render's zero-downtime deploy overlap) can't race: the second
 *   waits, then sees everything applied and does nothing. Works through transaction poolers.
 * - Each applied file's checksum is recorded; editing an already-applied file is drift and fails
 *   loudly instead of silently diverging from what's in the database.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Sql } from "./pool";

/** Arbitrary constant: ASCII "FDFS". Shared by every instance so they serialize migrations. */
const MIGRATION_LOCK_KEY = 0x46444653;
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

export type Migration = { version: string; file: string; body: string; checksum: string };
export type MigrateResult = { applied: string[]; alreadyApplied: number };

export class MigrationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDriftError";
  }
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const body = await readFile(join(dir, file), "utf8");
      return {
        version: file.replace(/\.sql$/, ""),
        file,
        body,
        checksum: createHash("sha256").update(body).digest("hex"),
      };
    }),
  );
}

export async function migrate(
  sql: Sql,
  opts: { dir?: string; table?: string } = {},
): Promise<MigrateResult> {
  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR;
  const table = opts.table ?? "schema_migrations";
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`invalid migrations table name: ${table}`);
  const migrations = await loadMigrations(dir);

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await tx.unsafe(
      `create table if not exists ${table} (
         version    text primary key,
         checksum   text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const rows = await tx.unsafe<{ version: string; checksum: string }[]>(
      `select version, checksum from ${table}`,
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const m of migrations) {
      const recorded = applied.get(m.version);
      if (recorded !== undefined && recorded !== m.checksum) {
        throw new MigrationDriftError(
          `migration ${m.file} was edited after being applied (checksum mismatch); add a new migration instead`,
        );
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const m of pending) {
      await tx.unsafe(m.body).simple();
      await tx.unsafe(`insert into ${table} (version, checksum) values ($1, $2)`, [
        m.version,
        m.checksum,
      ]);
    }
    return {
      applied: pending.map((m) => m.version),
      alreadyApplied: migrations.length - pending.length,
    };
  });
}
