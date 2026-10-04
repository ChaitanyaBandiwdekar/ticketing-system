-- Burst runs: the final report of each burst (CLI or the Stampede simulator), so the War Room can
-- show the last run's verdict after the in-memory per-second window has moved on or the instance
-- has restarted. Written only with the admin key.
--
-- `report` is what the client measured (outcomes, latency, its checks). `server_audit` is the
-- server's own audit of the show taken when the report arrived, so the page can tell a reader
-- that the books were verified server-side, not only reported by the client.
--
-- show_id has no foreign key: burst shows are ephemeral and the janitor deletes them after 24h,
-- while the report stays readable on its own. The janitor keeps only the newest runs.
create table burst_runs (
  id           uuid        primary key default gen_random_uuid(),
  show_id      uuid        not null,
  ok           boolean     not null,
  report       jsonb       not null,
  server_audit jsonb,
  created_at   timestamptz not null default now()
);

create index burst_runs_created_idx on burst_runs (created_at desc);
