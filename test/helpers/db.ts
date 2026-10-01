import { randomBytes } from "node:crypto";
import { afterAll, inject } from "vitest";
import { createSql, type Sql } from "../../server/src/db/pool";

/** A pool against the run's test database, closed automatically after the file's tests. */
export function useTestSql(max = 10): Sql {
  const sql = createSql(inject("databaseUrl"), { max, appName: "fdfs-test" });
  afterAll(() => sql.end({ timeout: 5 }));
  return sql;
}

/** Short random suffix for names that must not collide with other tests or earlier runs. */
export function uniq(prefix = "t"): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}
