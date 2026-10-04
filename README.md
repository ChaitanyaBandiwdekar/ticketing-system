# FirstDayFirstShow (FDFS)

> Assigned-seat reservations that stay correct when the whole city storms the first show.

A take-home for Paytm Money's _Deploy & Observe_ round. It sells numbered seats for a show and is built to keep these guarantees under a burst of 20k concurrent requests:

- no seat is sold twice
- no user goes over their limit
- an idempotent retry never charges twice
- no 5xx responses

The service is deployed and observable, with a live seat map, a War Room ops dashboard, and a stampede simulator.

> **Status:** under construction, built phase by phase. See [`Plan.md`](Plan.md) for the design and [`Progress.md`](Progress.md) for where things stand.

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

**Live seat map (`GET /stream`).** An SSE stream that opens with `event: snapshot` `{seq, show, counts, labels[], status}`, where `status` has one character per seat (`a` available, `h` held, `c` confirmed). Seat changes then arrive as `event: delta` `{seq, changes: {label: a|h|c}, counts}`, coalesced per show every `STREAM_COALESCE_MS` (100 ms). The reconciler's verdicts arrive as `event: audit` `{ok, violations, at}`. Apply frames in order and the map equals the database. The hub re-reads every changed seat from Postgres before sending it, so the stream converges even when events arrive out of order. A full snapshot every `STREAM_RESYNC_MS` is only a safety net. Past `STREAM_MAX_CLIENTS` streams, it answers 503 `stream_capacity`.

**Background jobs.** These run in the API process:

- **sweeper:** finalizes lapsed holds and publishes the freed seats.
- **reconciler:** runs `audit()` every 5s on recently active and watched shows. A violation is logged as `invariant_violation`.
- **janitor:** deletes ephemeral shows after 24h and idempotency keys after 24h.

**Status codes:** 400 validation / `unknown_seats` / missing key · 401 no or bad token · 403 not the owner or not admin · 404 unknown show or reservation · 409 `seat_taken`, `per_user_limit`, `reservation_expired`, `reservation_cancelled` · 422 `idempotency_key_reused` · 429 `overloaded` (only past `MAX_QUEUE` in flight) · 503 `db_unavailable` / `contention` (with `Retry-After`). Every request-path DB call has a deadline (`DB_REQUEST_TIMEOUT_MS`, 10s), so an unreachable database is a fast 503, never a hang. A `user_id` in a request body is ignored: identity comes only from the token.

## Repository layout

```
server/src/     Fastify service (config, db, engine, http, observability, jobs)
db/migrations/  Forward-only SQL migrations (schema + PL/pgSQL decision functions)
web/            Vite + React UI (served under /app)
scripts/        Burst / stampede tooling
test/           Concurrency, property and API tests (real Postgres)
docs/           AI usage log and supporting notes
```
