-- A one-time fresh start for the War Room: drops every recorded burst run and every ephemeral
-- show (the halls bursts and the Stampede simulator create), with their reservations. The janitor
-- would delete those shows within 24h anyway; regular and demo shows are untouched.
--
-- Same order as the janitor (server/src/engine/maintenance.ts): seats point at reservations, so
-- they go first; idempotency keys cascade from their reservations.
delete from seats where show_id in (select id from shows where ephemeral);
delete from reservations where show_id in (select id from shows where ephemeral);
delete from shows where ephemeral;
delete from burst_runs;
