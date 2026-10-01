/** `npm run db:migrate` — applies pending migrations to DATABASE_URL_SESSION (or DATABASE_URL). */
import { loadDotEnv, loadMigrationUrl } from "../config";
import { migrate } from "./migrate";
import { createSql } from "./pool";

loadDotEnv();
const sql = createSql(loadMigrationUrl(), { max: 1, appName: "fdfs-migrate" });
try {
  const { applied, alreadyApplied } = await migrate(sql);
  console.log(
    applied.length
      ? `applied ${applied.length} migration(s): ${applied.join(", ")}`
      : `up to date (${alreadyApplied} already applied)`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
