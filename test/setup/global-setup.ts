/**
 * One Postgres for the whole test run.
 *
 * - TEST_DATABASE_URL unset (local dev): boots a throwaway embedded Postgres 17 cluster on a free
 *   port under .pg/, creates a fresh database, and deletes the cluster afterwards.
 * - TEST_DATABASE_URL set (CI service container, `npm run test:remote` against Supabase): uses it
 *   as-is. Tests never truncate or drop shared tables — every test creates its own show/users —
 *   so the suite is safe to run against a database that already holds data.
 *
 * Either way the app's real migrations are applied first, then the URL is handed to tests via
 * vitest's provide/inject.
 */
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { migrate } from "../../server/src/db/migrate";
import { createSql } from "../../server/src/db/pool";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function startEmbedded(): Promise<{ url: string; stop: () => Promise<void> }> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = await freePort();
  const databaseDir = join(process.cwd(), ".pg", `test-${port}`);
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    // Headroom for the concurrency suites (hundreds of parallel clients across pools).
    postgresFlags: ["-c", "max_connections=300"],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("fdfs_test");
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/fdfs_test`,
    stop: async () => {
      await pg.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}

export default async function setup(project: TestProject) {
  const external = process.env.TEST_DATABASE_URL;
  const db = external ? { url: external, stop: async () => {} } : await startEmbedded();

  const sql = createSql(db.url, { max: 1, appName: "fdfs-test-migrate" });
  try {
    await migrate(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }

  project.provide("databaseUrl", db.url);
  return db.stop;
}
