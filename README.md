# FirstDayFirstShow (FDFS)

> Assigned-seat reservations that stay correct when the whole city storms the first show.

A take-home for Paytm Money's _Deploy & Observe_ round. It sells numbered seats for a show and is built to keep these guarantees under a burst of 20k concurrent requests:

- no seat is sold twice
- no user goes over their limit
- an idempotent retry never charges twice
- no 5xx responses

The service is deployed and observable, with a live seat map, a War Room ops dashboard, and a stampede simulator.

> **Status:** under construction, built phase by phase. See [`Plan.md`](Plan.md) for the design and [`Progress.md`](Progress.md) for where things stand.
>
> **Live:** <https://fdfs-dkyx.onrender.com> (Render free tier, Singapore; the first request after an idle spell cold-starts it). War Room: [`/app/war-room`](https://fdfs-dkyx.onrender.com/app/war-room) · metrics: [`/metrics`](https://fdfs-dkyx.onrender.com/metrics).

## Quick start (local)

Requires Node ≥ 20.19. Docker is **not** required: tests boot an embedded Postgres 17 automatically.

```bash
npm ci
npm test
```

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm test`             | Full suite against an embedded Postgres 17 (or `TEST_DATABASE_URL`) |
| `npm run typecheck`    | `tsc --noEmit`                                                      |
| `npm run lint`         | ESLint, zero warnings allowed                                       |
| `npm run format:check` | Prettier check                                                      |
| `npm run db:migrate`   | Apply SQL migrations to `DATABASE_URL_SESSION` (or `DATABASE_URL`)  |
| `npm run dev`          | Run the API with reload (needs a `.env`, see below)                 |
| `npm run build`        | Bundle the server to `dist/server.js` (esbuild)                     |
| `npm start`            | Run the bundle                                                      |

Configuration is documented in [`.env.example`](.env.example). Copy it to `.env` for local runs.

### Full stack with Docker

`docker compose up --build` starts the same shape as production: the app talks to Postgres 17 through **PgBouncer in transaction mode** (Supabase's Supavisor in production), and migrations go straight to Postgres (Supabase's session pooler). The API listens on <http://localhost:8080>. The compose file carries throwaway local secrets only (admin key `local-dev-admin-key`).

```bash
docker compose up --build -d
scripts/smoke.sh http://localhost:8080 local-dev-admin-key
```

Add the observability profile for Prometheus on <http://localhost:9090> (scraping the app and evaluating [`ops/alerts.yml`](ops/alerts.yml)) and Grafana on <http://localhost:3000> (the provisioned **FDFS overview** dashboard, anonymous read-only):

```bash
docker compose --profile obs up -d
```

### The UI

The same process serves the UI at `/app/` (`/` redirects there). Open a show for its **live hall**: seats change colour as they are taken, through server-sent events (`GET /stream`), with no polling. Sign in with any username, pick seats on the map (mouse, touch or keyboard) and book them. In a hold-mode show a countdown runs until you confirm. Each reserve carries a client-generated `Idempotency-Key`, and retries after a timeout or a 503 reuse it, so a retry can't double-book.

The sign-in is per tab: open a second tab, sign in there as someone else, and race yourself for one seat. The loser's tab drops the seat the moment the winner gets it, or shows "A12 was just taken; keep A13?" if both requests were already in flight.

### The War Room

`/app/war-room` shows this instance second by second, from one server-sent-events feed (`GET /ops/stream`):

- the reconciler's verdict (books balance or not) for every recently active show
- reserve outcomes per second, by outcome
- p50/p95/p99 latency
- DB calls in flight against the pool size, event-loop lag, and memory
- the background jobs' health
- a log tail where clicking a request id shows every line of that one request

Every chart has a table view.

## Observability

Everything is public on purpose, so graders get metrics and logs without a paid log drain. None of it takes an admission slot or writes an access-log line.

| Endpoint              | What it serves                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /metrics`        | Prometheus exposition (below), plus Node's process and event-loop metrics                                  |
| `GET /ops/summary`    | Totals, latency over the last minute, saturation, the reconciler's latest verdicts, job health             |
| `GET /ops/timeseries` | One point per second for the last 10 minutes (`?since=<epoch ms>`)                                         |
| `GET /ops/logs`       | The in-memory log tail: `?request_id=`, `?level=warn`, `?after=<seq>`, `?limit=` (redacted, no stacks)     |
| `GET /ops/stream`     | The War Room feed (SSE): `hello` with the last 5 minutes, then a `tick` a second with new points and lines |

Key metrics:

- `fdfs_reserve_responses_total{outcome}`: every reserve response, labeled `created`, `replayed`, or the error code a client saw (`seat_taken`, `per_user_limit`, `unauthorized`, `overloaded`, `db_unavailable`, ...). Its delta over a burst equals what the burst observed, outcome by outcome.
- `fdfs_reservations_confirmed_total`, `fdfs_reservations_held_total`, `fdfs_reservations_declined_total{reason}`, `fdfs_reservations_cancelled_total`, `fdfs_holds_expired_total`.
- `fdfs_invariant_violations_total`: counted by the reconciler's audits. It must read 0 forever.
- `fdfs_identity_spoof_ignored_total`, `fdfs_db_retries_total{sqlstate}`, `fdfs_admission_shed_total`.
- `fdfs_reservation_duration_seconds{outcome}` and `fdfs_http_request_duration_seconds{route}` histograms (buckets up to 30s), and `fdfs_http_responses_total{route,status_class}`. Routes are templates, never raw URLs.
- Gauges: `fdfs_db_calls_in_flight` vs `fdfs_db_pool_max`, `fdfs_admission_in_flight`, `fdfs_stream_clients`, `fdfs_ready`, `fdfs_seats{show,status}` (only the shows audited last), `fdfs_job_last_success_timestamp_seconds{job}`.

Logs are one JSON line per request (pino) carrying `request_id`, route, status, latency, and for reserves the outcome, decision path and user. Stdout is the platform log. A ring of the last 2,000 lines, plus the last 500 warnings and errors kept separately so request noise can't push them out, backs `/ops/logs`. [`ops/alerts.yml`](ops/alerts.yml) holds the 2am pages: invariant violation, any 5xx, not ready, stalled sweeper or reconciler, p99 over the SLO, pool saturation, shedding, event-loop lag, memory.

## API

The paths are exactly the spec's. Every error has the shape `{"error": {"code", "message", "request_id", ...}}`, and every response echoes `x-request-id`.

| Method & path                    | Auth        | Notes                                                                                                                      |
| -------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`               | none        | `{username}` → `{token, user_id}`. Demo IdP: an HS256 JWT valid for 24h; `sub` is the user id                              |
| `POST /auth/tokens`              | none        | `{count ≤ 10000, prefix?, start?}` → tokens for `prefix-start…`; for load tests                                            |
| `POST /shows`                    | admin key   | `{name, seats[], price_paise, per_user_limit?=4, hold_ttl_seconds?, ephemeral?}` → 201                                     |
| `GET /shows`                     | none        | Newest first, with counts; `?include_ephemeral=true`                                                                       |
| `GET /shows/:id`                 | none        | Show + `seats[{label,status}]` + `counts{total,available,held,confirmed,invariant_ok}` from one snapshot (cached ≤ 250 ms) |
| `GET /shows/:id/audit`           | none        | Books-balance proof: `{ok, counts, violations[]}`                                                                          |
| `POST /shows/:id/reserve`        | user token  | `{seats[]}` + `Idempotency-Key` header (or `idempotency_key`). 201 new · 200 + `Idempotent-Replayed: true` replay          |
| `POST /reservations/:id/confirm` | owner token | Hold → confirmed. Idempotent                                                                                               |
| `POST /reservations/:id/cancel`  | owner token | Releases the seats. Idempotent                                                                                             |
| `GET /me/reservations`           | user token  | `?show_id=`                                                                                                                |
| `GET /stream?show=:id`           | none        | Live seat map as server-sent events: `snapshot`, then coalesced `delta`s, `audit` verdicts, heartbeats (see below)         |
| `GET /healthz` · `GET /readyz`   | none        | Liveness (no I/O) · readiness (DB check on its own pool; fails closed, 503 while draining)                                 |
| `GET /metrics` · `GET /ops/*`    | none        | Prometheus metrics and the War Room's data (see [Observability](#observability))                                           |

**Live seat map (`GET /stream`).** An SSE stream that opens with `event: snapshot` `{seq, show, counts, labels[], status}`, where `status` has one character per seat (`a` available, `h` held, `c` confirmed). Seat changes then arrive as `event: delta` `{seq, changes: {label: a|h|c}, counts}`, coalesced per show every `STREAM_COALESCE_MS` (100 ms). The reconciler's verdicts arrive as `event: audit` `{ok, violations, at}`. Apply frames in order and the map equals the database. The hub re-reads every changed seat from Postgres before sending it, so the stream converges even when events arrive out of order. A full snapshot every `STREAM_RESYNC_MS` is only a safety net. Past `STREAM_MAX_CLIENTS` streams, it answers 503 `stream_capacity`.

**Background jobs.** These run in the API process:

- **sweeper:** finalizes lapsed holds and publishes the freed seats.
- **reconciler:** runs `audit()` every 5s on recently active and watched shows. A violation is logged as `invariant_violation` and counted in `fdfs_invariant_violations_total`.
- **janitor:** deletes ephemeral shows after 24h and idempotency keys after 24h.

**Status codes:** 400 validation / `unknown_seats` / missing key · 401 no or bad token · 403 not the owner or not admin · 404 unknown show or reservation · 409 `seat_taken`, `per_user_limit`, `reservation_expired`, `reservation_cancelled` · 422 `idempotency_key_reused` · 429 `overloaded` (only past `MAX_QUEUE` in flight) · 503 `db_unavailable` / `contention` (with `Retry-After`). Every request-path DB call has a deadline (`DB_REQUEST_TIMEOUT_MS`, 10s), so an unreachable database is a fast 503, never a hang. A `user_id` in a request body is ignored: identity comes only from the token.

## Repository layout

```
server/src/     Fastify service (config, db, engine, http, observability, jobs)
db/migrations/  Forward-only SQL migrations (schema + PL/pgSQL decision functions)
web/            Vite + React UI (served under /app)
ops/            Prometheus config, alert rules, Grafana provisioning + dashboard
scripts/        Smoke, CI and (Phase 8) burst tooling
test/           Concurrency, property and API tests (real Postgres)
docs/           AI usage log and supporting notes
```
