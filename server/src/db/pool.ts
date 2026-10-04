import postgres from "postgres";

export type Sql = postgres.Sql;
/** The handle inside sql.begin(): statements on it run in that transaction. */
export type Tx = postgres.TransactionSql;

export type PoolOptions = {
  /** Max connections this pool opens. Keep the sum across pools under the pooler's client limit. */
  max?: number;
  /** Shows up in pg_stat_activity — handy for telling the request pool from the readiness probe. */
  appName?: string;
};

/**
 * One postgres.js pool. Settings are chosen to behave identically against a local Postgres,
 * PgBouncer (CI) and Supabase's Supavisor transaction pooler (production):
 * - prepare:false — transaction-mode poolers hand each transaction to an arbitrary backend,
 *   so named prepared statements would leak across clients.
 * - no session state is ever relied on (only transaction-scoped advisory locks, no LISTEN).
 * SSL comes from the URL (`?sslmode=require` for Supabase).
 */
export function createSql(url: string, opts: PoolOptions = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { application_name: opts.appName ?? "fdfs" },
    onnotice: () => {},
  });
}
