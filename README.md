# FirstDayFirstShow (FDFS)

> Assigned-seat reservations that stay correct when the whole city storms the first show.

A take-home for Paytm Money's _Deploy & Observe_ round. It sells numbered seats for a show and is built to keep these guarantees under a burst of 20k concurrent requests:

- no seat is sold twice
- no user goes over their limit
- an idempotent retry never charges twice
- no 5xx responses

The service is deployed and observable, with a live seat map, a War Room ops dashboard, a stampede simulator, and a burst CLI that checks every guarantee from the outside.

> **Live:** <https://fdfs-dkyx.onrender.com> (Render free tier, Singapore; the first request after 15 idle minutes cold-starts it in about a minute). War Room: [`/app/war-room`](https://fdfs-dkyx.onrender.com/app/war-room) · metrics: [`/metrics`](https://fdfs-dkyx.onrender.com/metrics).
>
> The design and its trade-offs are in [`WRITEUP.md`](WRITEUP.md). [`Plan.md`](Plan.md) and [`Progress.md`](Progress.md) record how it was built, phase by phase.

## Evaluating FDFS

Everything below works against the live URL with no credentials, except the two runs marked **admin key**. The instance is a single free Render instance (0.1 CPU, 512 MB), so expect seconds of latency under a burst. Expect neither errors nor wrong answers.

### A five-minute tour

1. Open <https://fdfs-dkyx.onrender.com>. The server keeps two public halls open:
   - **FDFS Premiere #n**: 2,000 seats, limit 4 per user, a reservation is confirmed at once (the spec's contract).
   - **FDFS Late Show #n**: 288 seats, hold mode, so a reservation is held for 2 minutes until you confirm it.

   When one is 90% sold, the next screening (`#n+1`) opens within a minute, so a burst never leaves the box office empty.

2. Sign in with any username and book seats. Then open a second tab, sign in as someone else, and race yourself for one seat: the loser's map drops the seat as the winner gets it.
3. Open the **War Room** (`/app/war-room`) in another tab while you book or burst:
   - the last burst's verdict: every guarantee it checked, seats sold, where every request went, latency
   - requests per second (booked / declined correctly / failed) and latency, live
   - the reconciler's books-balance verdict per show
   - under Internals: the DB pool, event loop, memory, background jobs, and a log tail where clicking a `request_id` shows that one request's lines
4. `GET /shows/:id/audit` proves a show's books balance. `fdfs_invariant_violations_total` on `/metrics` must read 0.

### The API from a shell

With `curl` and `jq`:

```bash
URL=https://fdfs-dkyx.onrender.com
# A user token (any username). Identity comes only from the token's `sub`.
TOKEN=$(curl -s -X POST $URL/auth/login -H 'content-type: application/json' -d '{"username":"grader"}' | jq -r .token)
# The open Premiere screening (newest first).
SHOW=$(curl -s $URL/shows | jq -r '[.shows[] | select(.name | startswith("FDFS Premiere"))][0].id')
# Reserve. With an Idempotency-Key, the same key again returns the original 201, never a second booking.
curl -s -X POST $URL/shows/$SHOW/reserve -H "authorization: Bearer $TOKEN"   -H 'content-type: application/json' -H 'idempotency-key: grader-1' -d '{"seats":["C7","C8"]}'
curl -si -X POST $URL/shows/$SHOW/reserve -H "authorization: Bearer $TOKEN"   -H 'content-type: application/json' -H 'idempotency-key: grader-1' -d '{"seats":["C7","C8"]}' | grep -i replayed
curl -s $URL/shows/$SHOW/audit
```

`POST /auth/tokens {"count": 5000, "prefix": "load"}` mints up to 10,000 user tokens in one call (`load-1` … `load-5000`) for load tests.

### Bursting it with your own tool

Point your script at an open demo show and use the minted tokens. What you should see, and what the service promises:

- **201** for a new booking. A repeated key gets the original reservation back, also **201**, with `Idempotent-Replayed: true` to tell the two apart.
- **409** `seat_taken` (with `unavailable_seats`), `per_user_limit` (with the numbers), or `idempotency_key_reused` when a key is sent again with different seats.
- **All or nothing** for multi-seat requests: if any requested seat is taken, nothing is booked and the 409 lists the taken seats in `unavailable_seats`.
- **429** only past 8,000 requests in flight on the instance, with a `Retry-After` sized to drain the queue. Retry with the same key.
- **No 5xx.** A 503 would mean the database is unreachable, and it comes with `Retry-After`.

Afterwards, check the books:

- `GET /shows/:id/audit` must return `ok: true` and no violations.
- `GET /shows/:id` counts must satisfy `available + held + confirmed = total`.
- On `/metrics`, `fdfs_invariant_violations_total` must be 0. The delta of `fdfs_reserve_responses_total{outcome}` should equal what your tool observed.

Every response carries `x-request-id` (send your own to trace a request), and `GET /ops/logs?request_id=<id>` returns that request's log lines.

### Our burst and the Stampede simulator (admin key)

Both create a fresh show per run so that every expected result is exact, and creating a show needs the admin key:

- `npm run burst -- https://fdfs-dkyx.onrender.com --admin-key <key>` runs 20k checked requests (see [The burst](#the-burst)) and exits non-zero on any 5xx or broken guarantee.
- `/app/stampede` runs the same engine from your browser and fills a hall live as it goes.

### The admin key

`ADMIN_API_KEY` authorizes exactly one call: `POST /shows`, sent as `Authorization: Bearer <ADMIN_API_KEY>`. It is not a user identity (reserving with it is a 401), and it unlocks nothing else. Render generated it for the deploy, so it is not in this repository. It is shared with the submission.

```bash
curl -s -X POST $URL/shows -H "authorization: Bearer $ADMIN_API_KEY" -H 'content-type: application/json' -d '{"name":"friday-night","seats":["A1","A2","A3","A12"],"price_paise":25000}'
```

Shows are capped at 20,000 seats. Add `"ephemeral": true` for a load-test show: it is hidden from `GET /shows` by default and deleted after 24h. Our burst and the simulator create theirs that way.

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
| `npm run burst -- URL` | The full stampede against a running instance (see below)            |

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

`/app/war-room` answers, top to bottom: is the box office correct, and how did it hold up?

- **One verdict line:** books balanced across the audited shows, server errors since start, and the last burst's result.
- **The last burst's scorecard.** Every burst (the CLI and the simulator) posts its final report to `POST /ops/runs` with the admin key; the server re-audits the show from its own snapshot as the report arrives and stores both. So the verdict is still there after the live window has moved on or the free instance has slept: pass/fail with every check, seats sold against the hall, where every request went (booked, declined correctly, failed), throughput, and p50/p95/p99/max.
- **Right now:** this instance's reserve requests per second, split into booked (blue), declined correctly (gray: seat taken, over the limit, idempotent replays) and failed (red: 429 or 5xx), with p50/p99 latency below on the same time axis, over the last 1, 5 or 10 minutes. Seconds are grouped into columns wide enough to read.
- **Books per show:** the reconciler's latest verdict and seat split for every recently active show.
- **Internals** (folded): DB calls in flight against the pool size, event-loop lag, memory against the 512 MB limit, the background jobs, and a log tail where clicking a request id shows every line of that one request.

The live parts come from one server-sent-events feed (`GET /ops/stream`). Every live chart has a table view. The charts are plain SVG.

### The Stampede simulator

`/app/stampede` is the burst below, fired from your browser at a fresh show: set the crowd, the requests, the hot-seat storm on A12, the share of same-key retries and spoofed `user_id`s, and how many users try to exceed the limit. The hall fills live beside the progress, and the run ends with the outcome distribution and every check. The **Full · 20k** preset is the CLI's scale (about 21,600 requests at a 2,000-seat hall, 256 in flight), so nothing needs cloning or installing. It needs the admin key, because it creates the show.

## The burst

```bash
npm run burst -- http://localhost:8080 --admin-key local-dev-admin-key      # 20k requests, ~2 min at 0.1 CPU
npm run burst -- https://fdfs-dkyx.onrender.com --admin-key <ADMIN_API_KEY> # the live service
npm run burst -- <URL> --small                                              # ~2.6k requests
```

(`scripts/burst/burst.sh <URL>` and `make burst URL=...` do the same.) It creates an ephemeral show (2,000 seats, limit 4, deleted after 24h), mints tokens, and fires these scenarios interleaved, 256 requests in flight:

| Scenario   | What                                                     | Expected, exactly                              |
| ---------- | -------------------------------------------------------- | ---------------------------------------------- |
| `hot`      | 500 users on A12 and 5 more front-center seats           | one winner per hot seat                        |
| `stampede` | 20,000 Zipf-skewed single and pair requests, 5,000 users | only bookings, `seat_taken`, `per_user_limit`  |
| `retry`    | 100 keys, each sent 5 times at once                      | at most one booking per key; the rest replay   |
| `keyreuse` | one key for other seats, then the original seats again   | 409 `idempotency_key_reused`, then a replay    |
| `limit`    | 20 users × 10 parallel single-seat requests, limit 4     | exactly 4 booked, 6 `per_user_limit`, per user |
| `crossed`  | 50 pairs: `[X,Y]` vs `[Y,X]` at once                     | exactly one winner, no deadlock                |
| `spoof`    | a body `user_id` naming someone else                     | booked for the token's user                    |
| `foreign`  | cancelling another user's reservation                    | 403, and the booking stands                    |

A 429, a 503 or a dropped connection is retried with the same key, honoring `Retry-After`, as the API asks. During the run it polls `GET /shows/:id`: every snapshot must balance and sold seats never decrease. Afterwards it checks the final seat map against every reservation it was granted (no seat in two, nobody over the limit, nothing sold that wasn't granted), runs the audit, and diffs `fdfs_reserve_responses_total` against what it observed. **It exits non-zero on any 5xx, network error or broken guarantee.** Every request carries an `x-request-id`; the slowest are printed, and the War Room's log tail finds them. On any 5xx it reads the server's error lines for the run and names the cause.

Measured with the server throttled to Render's free tier (0.1 CPU, 512 MB): 21,550 reserve requests at ~180 req/s, p50 1.2s, p99 3.1s, 0 5xx, every check green. CI runs the same burst against the Docker image throttled the same way, through PgBouncer.

## Observability

Everything is public on purpose, so graders get metrics and logs without a paid log drain. None of the reads takes an admission slot or writes an access-log line.

| Endpoint              | What it serves                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /metrics`        | Prometheus exposition (below), plus Node's process and event-loop metrics                                    |
| `GET /ops/summary`    | Totals, latency over the last minute, saturation, the reconciler's latest verdicts, job health               |
| `GET /ops/timeseries` | One point per second for the last 10 minutes (`?since=<epoch ms>`)                                           |
| `GET /ops/logs`       | The in-memory log tail: `?request_id=`, `?level=warn`, `?after=<seq>`, `?limit=` (redacted, no stacks)       |
| `GET /ops/stream`     | The War Room feed (SSE): `hello` with the last 10 minutes, then a `tick` a second with new points and lines  |
| `GET /ops/runs`       | The last recorded bursts, newest first (`?limit=`, at most 20), each with the server's own audit of its show |
| `POST /ops/runs`      | Admin key. Records a burst's final report (the burst CLI and the simulator do this when they finish)         |

Key metrics:

- `fdfs_reserve_responses_total{outcome}`: every reserve response, labeled `created`, `replayed`, or the error code a client saw (`seat_taken`, `per_user_limit`, `unauthorized`, `overloaded`, `db_unavailable`, ...). Its delta over a burst equals what the burst observed, outcome by outcome.
- `fdfs_reservations_confirmed_total`, `fdfs_reservations_held_total`, `fdfs_reservations_declined_total{reason}`, `fdfs_reservations_cancelled_total`, `fdfs_holds_expired_total`.
- `fdfs_invariant_violations_total`: counted by the reconciler's audits. It must read 0 forever.
- `fdfs_identity_spoof_ignored_total`, `fdfs_db_retries_total{sqlstate}`, `fdfs_admission_shed_total`.
- `fdfs_reservation_duration_seconds{outcome}` and `fdfs_http_request_duration_seconds{route}` histograms (buckets up to 30s), and `fdfs_http_responses_total{route,status_class}`. Routes are templates, never raw URLs.
- Gauges: `fdfs_db_calls_in_flight` vs `fdfs_db_pool_max`, `fdfs_admission_in_flight`, `fdfs_stream_clients`, `fdfs_ready`, `fdfs_seats{show,status}` (the open demo halls, plus every show changed in the last 10 minutes or watched live; refreshed by the reconciler every 5s), `fdfs_job_last_success_timestamp_seconds{job}`.

Logs are one JSON line per request (pino) carrying `request_id`, route, status, latency, and for reserves the outcome, decision path and user. Stdout is the platform log. A ring of the last 2,000 lines, plus the last 500 warnings and errors kept separately so request noise can't push them out, backs `/ops/logs`. [`ops/alerts.yml`](ops/alerts.yml) holds the 2am pages: invariant violation, any 5xx, not ready, stalled sweeper or reconciler, p99 over the SLO, pool saturation, shedding, event-loop lag, memory.

## API

The paths are exactly the spec's. Every error has the shape `{"error": {"code", "message", "request_id", ...}}`, and every response echoes `x-request-id`.

| Method & path                    | Auth        | Notes                                                                                                                                                   |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`               | none        | `{username}` → `{token, user_id}`. Demo IdP: an HS256 JWT valid for 24h; `sub` is the user id                                                           |
| `POST /auth/tokens`              | none        | `{count ≤ 10000, prefix?, start?}` → tokens for `prefix-start…`; for load tests                                                                         |
| `POST /shows`                    | admin key   | `{name, seats[], price_paise, per_user_limit?=4, hold_ttl_seconds?, ephemeral?}` → 201                                                                  |
| `GET /shows`                     | none        | Newest first, with counts; `?include_ephemeral=true`                                                                                                    |
| `GET /shows/:id`                 | none        | Show + `seats[{label,status}]` + `counts{total,available,held,confirmed,invariant_ok}` from one snapshot (cached ≤ 250 ms, dropped on every write)      |
| `GET /shows/:id/audit`           | none        | Books-balance proof: `{ok, counts, violations[]}`                                                                                                       |
| `POST /shows/:id/reserve`        | user token  | `{seats[]}` + optional `Idempotency-Key` header (or `idempotency_key`). 201; a replay is the original 201 + `Idempotent-Replayed: true`. All or nothing |
| `POST /reservations/:id/confirm` | owner token | Hold → confirmed. Idempotent                                                                                                                            |
| `POST /reservations/:id/cancel`  | owner token | Releases the seats. Idempotent                                                                                                                          |
| `GET /me/reservations`           | user token  | `?show_id=`                                                                                                                                             |
| `GET /stream?show=:id`           | none        | Live seat map as server-sent events: `snapshot`, then coalesced `delta`s, `audit` verdicts, heartbeats (see below)                                      |
| `GET /healthz` · `GET /readyz`   | none        | Liveness (no I/O) · readiness (DB check on its own pool; fails closed, 503 while draining). Aliases: `/health`, `/ready`                                |
| `GET /metrics` · `GET /ops/*`    | none        | Prometheus metrics and the War Room's data (see [Observability](#observability))                                                                        |

**Live seat map (`GET /stream`).** An SSE stream that opens with `event: snapshot` `{seq, show, counts, labels[], status}`, where `status` has one character per seat (`a` available, `h` held, `c` confirmed). Seat changes then arrive as `event: delta` `{seq, changes: {label: a|h|c}, counts}`, coalesced per show every `STREAM_COALESCE_MS` (100 ms). The reconciler's verdicts arrive as `event: audit` `{ok, violations, at}`. Apply frames in order and the map equals the database. The hub re-reads every changed seat from Postgres before sending it, so the stream converges even when events arrive out of order. A full snapshot every `STREAM_RESYNC_MS` is only a safety net. Past `STREAM_MAX_CLIENTS` streams, it answers 503 `stream_capacity`.

**Background jobs.** These run in the API process:

- **sweeper:** finalizes lapsed holds and publishes the freed seats.
- **reconciler:** runs `audit()` every 5s on recently active and watched shows. A violation is logged as `invariant_violation` and counted in `fdfs_invariant_violations_total`.
- **janitor:** deletes ephemeral shows after 24h and idempotency keys after 24h.

**Status codes:** 400 validation / `unknown_seats` / empty or over-long key · 401 no or bad token · 403 not the owner or not admin · 404 unknown show or reservation · 409 `seat_taken`, `per_user_limit`, `idempotency_key_reused`, `reservation_expired`, `reservation_cancelled` · 429 `overloaded` (only past `MAX_QUEUE`, 8,000, in flight; `Retry-After` is the time to drain what is in flight at the recent completion rate) · 503 `db_unavailable` / `contention` (with `Retry-After`). Every request-path DB call has a deadline (`DB_REQUEST_TIMEOUT_MS`, 10s), so an unreachable database is a fast 503, never a hang. A `user_id` in a request body is ignored: identity comes only from the token.

## Repository layout

```
server/src/     Fastify service (config, db, engine, http, observability, jobs)
db/migrations/  Forward-only SQL migrations (schema + PL/pgSQL decision functions)
web/            Vite + React UI (served under /app)
ops/            Prometheus config, alert rules, Grafana provisioning + dashboard
scripts/        Smoke and CI checks; burst/ (the burst CLI and the engine the simulator shares)
test/           Concurrency, property and API tests (real Postgres)
docs/           AI usage log and supporting notes
```
