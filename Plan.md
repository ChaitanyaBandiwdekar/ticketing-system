# FirstDayFirstShow (FDFS): Seat Reservation at Scale (Paytm Money take-home)

## Context

Paytm Money's "Deploy & Observe" take-home asks for a seat-reservation service that stays correct under a stampede of about 20k concurrent requests. The bar is no double-sell, zero 5xx, a reconciliation invariant that always holds, idempotent retries, a per-user limit, and identity taken from the token. It also has to be deployed, containerized, and observable through health checks, Prometheus metrics, structured logs, and a one-command burst script. Graders hit the live URL with their own bursts. Our extra goal is to look like a full-stack engineer built it: the service is correct by construction, it has a polished live UI (seat map, **War Room** ops dashboard, stampede simulator), and correctness can be proven at runtime, not only claimed.

The app is named **FirstDayFirstShow (FDFS)**, after the Indian ritual of storming the first show on release day. That is exactly the stampede we're engineering for.

Project dir: `C:\Users\chait\Projects\Paytm-Assignment` (empty, not yet a git repo). Machine: Node 20.19, git, **no Docker**.

### Decisions (confirmed)

| Topic                | Decision                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stack                | TypeScript: Fastify API + Vite/React/Tailwind SPA, one container, one URL                                                                                                                        |
| Reservation model    | Per show. Default: reserve → `confirmed` (the spec contract) plus owner cancel. Optional `hold_ttl_seconds`: reserve → `held` → confirm or auto-expire                                           |
| Hosting              | **Render free** (graders cold-start it), Docker runtime, Singapore                                                                                                                               |
| Database             | **New Supabase project, Singapore**, Postgres 17, reached via the Supavisor pooler                                                                                                               |
| Local DB             | `embedded-postgres` 17 via npm (real binaries, real concurrency)                                                                                                                                 |
| Docker/pooler parity | GitHub Actions on every push: image build, compose (PG17 + **PgBouncer transaction mode**), tests, burst under `--cpus=0.1 --memory=512m`. `npm run test:remote` against Supabase at checkpoints |
| Auth                 | Self-issued HS256 JWT demo login + batch mint; admin via `ADMIN_API_KEY`                                                                                                                         |
| Deploy timing        | Smoke deploy after Phase 3; full deploy + docs in the final phase                                                                                                                                |

### What makes this stand out

1. **Correctness you can check while it runs.**
   - A live invariant badge and an `/audit` endpoint.
   - `invariant_violations_total`, which should always read 0.
   - A burst script that exits non-zero on any violation and proves metric deltas equal the API outcomes.
2. **Database design a reviewer can respect.**
   - The whole decision is one round-trip PL/pgSQL function, with a single documented global lock order.
   - Lock-free fast-path declines keep a hot seat from starving the pool.
   - Constraints make illegal states impossible, and there is deliberately no hot counter row.
3. **The stampede, visible.**
   - A live seat map and a browser stampede simulator.
   - The **War Room** shows rates by decline reason, latency percentiles, pool saturation, and a log tail you can filter by request id.
4. **Operational maturity.**
   - Readiness that fails closed and a graceful drain.
   - A Prometheus + Grafana compose profile and alert rules.
   - A CI burst under free-tier CPU limits.
   - An honest per-phase AI log.

---

## 1. Architecture

```
Browser (SPA at /app/*) ──HTTP/2──► Render web service (Docker, 1 instance, free)
                                     ├─ API at the SPEC's root paths: /shows, /shows/:id/reserve, /reservations/:id/cancel ...
                                     ├─ /auth/*, /ops/* (War Room data), /stream (SSE), /metrics, /healthz, /readyz
                                     ├─ jobs: hold-expiry sweeper, invariant reconciler, test-show janitor
                                     └─ static SPA (Vite build)            ── postgres.js ──► Supabase PG17 (pooler :6543)
```

- **API paths are exactly the spec's**, because graders' scripts call `/shows/...` directly. The UI therefore lives under `/app/*` and `/` redirects there. Otherwise `GET /shows/:id` would collide between the SPA route and the API.
- **Postgres is the only source of truth.** No cache ever decides a seat. Only SSE fan-out and the counter metrics are per instance, and that is documented for horizontal scale.
- **One round-trip per mutation.** `reserve`, `confirm`, `cancel`, and `expire_holds` are PL/pgSQL functions called as a single `SELECT fn(...)`. That statement is its own transaction, so there are no BEGIN/COMMIT round-trips and locks are held for microseconds. Plans are cached per backend, which makes up for `prepare:false` on the pooler.

## 2. The atomic decision

**Tables:**

- `shows (id, name, price_paise bigint, per_user_limit, hold_ttl_seconds, total_seats, ephemeral, created_at)`
- `seats (id bigserial, show_id, label, status, reservation_id, user_id, held_until)` with `UNIQUE (show_id, label)`. There is one row per physical seat.
- `reservations (id uuid, show_id, user_id, seat_labels[], amount_paise bigint, status, expires_at, idem_key)`
- `idempotency_keys (user_id, key) PK → request_hash, reservation_id`

There is **no users table**: identity is the JWT `sub`, so minting tokens costs zero DB writes.

**Constraints:**

- `CHECK ((status='available') = (reservation_id IS NULL AND user_id IS NULL))`
- `CHECK (status<>'held' OR held_until IS NOT NULL)`
- `price_paise > 0`, and every amount is a `bigint`
- The composite FK `seats (reservation_id, show_id, user_id) → reservations (id, show_id, user_id)`: a taken seat can only point at a reservation of its own show **and** its own user

**Global lock order (the deadlock-freedom argument):**
idempotency key → per-(show,user) advisory lock → **seat rows sorted by `seats.id`** → reservation rows.
Every function acquires locks in this order. `ORDER BY seats.id`, an integer, is used instead of label text so collation can never affect ordering.

**`reserve(show, user, labels[], idem_key, req_hash)`:**

1. **Snapshot fast path, no locks.** One statement reads the user's idempotency row _and_ the requested seats' effective states in the **same snapshot**:
   - Key present with the same hash → **replay** (200 + `Idempotent-Replayed: true`, original body with its current status).
   - Key present with a different hash → **409 `idempotency_key_reused`**.
   - Unknown labels → 400.
   - The user's active seats + n > limit → **409 `per_user_limit`** (checked before seats, as on the locked path).
   - Any seat taken → **409 `seat_taken`** with `unavailable_seats`.

   A decline from the snapshot is linearizable: at that instant the seat really was taken / the user really held that many seats.

   This step keeps a 500-way hot-seat storm from parking every pool connection on A12's row lock: after the first commit, losers decline without locking anything. Reading key and seats in one snapshot means a concurrent same-key retry can never observe "seat taken by my own original" without also seeing the key.

2. `INSERT idempotency_keys ... ON CONFLICT DO NOTHING`. An in-flight duplicate waits on the unique index, then replays, or proceeds if the original rolled back.
3. `pg_advisory_xact_lock(hashtext(show), hashtext(user))`. Count the user's active seats (confirmed + unexpired holds) and check `+n ≤ limit`; otherwise **409 `per_user_limit`**. A hash collision only adds serialization and never breaks correctness.
4. `SELECT ... WHERE show_id=$1 AND label=ANY($2) ORDER BY id FOR UPDATE`. Re-check that every seat is available (an expired hold counts as available). If not, **409 `seat_taken`** (all-or-nothing). Otherwise insert the reservation (`amount = price × n`) and run the conditional `UPDATE` on the seats.

**Notes:**

- `reserve` **never touches another user's reservation row**. A takeover of an expired hold only rewrites the seat, and the old reservation becomes "expired" by derivation (`status='held' AND expires_at<now()`); the sweeper finalizes it later. This removes a real deadlock: reserve (seat → old reservation) against cancel (reservation → seat).
- Declines are **returned, not raised** (no exception churn or Postgres ERROR log lines in a stampede). A locked-path decline deletes the key row it claimed in the same transaction, so **only successes consume a key**, and a retry after a decline is re-evaluated (documented).
- Every outcome carries `path: fast|locked`, so tests (and later metrics) can prove that hot-seat losers decline lock-free.
- The function sets `lock_timeout='10s'`. The app retries 40P01/40001/55P03 a bounded number of times and never surfaces a 500 for contention.

**`confirm` / `cancel` / `expire_holds`:**

- **Lock order:** `confirm` and `cancel` lock the seats `WHERE reservation_id=$r ORDER BY id FOR UPDATE` first, then the reservation row. The sweeper uses the same order with `SKIP LOCKED` batches.
- **Guarded updates:** every release is conditioned on `reservation_id=$r AND status=<expected>`. A late cancel or confirm of an expired hold therefore matches zero seats that were re-sold to someone else, so nothing is resurrected.
- **Confirm:** requires `held_until > now()` and that all n seats still belong to the reservation.
- **Cancel:** idempotent (a second cancel → 200 with the same body). Cancelling an expired hold → 409 `reservation_expired`. A non-owner → 403.
- **Time:** only DB `now()` is used, never app time.

**Invariant:** one row per seat with one NOT NULL status, and seats are never inserted or deleted after creation. That makes `available+held+confirmed == total` true by construction. `GET /shows/:id` derives the per-seat list _and_ the counts from **one query**, applying effective expiry, so both come from one snapshot and always reconcile.

`audit(show)` checks:

- every non-available seat → an active reservation of the **same user**
- each user's active seats ≤ the limit
- reservation amounts = price × seats
- no active reservation is missing seats

## 3. Pre-mortem: poking the plan (breaks found → fixes, now folded in above)

| #   | Where it would have broken                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Spec paths vs SPA routes**: the UI at `/shows/:id` would shadow the graders' `GET /shows/:id`                                                                                | API at root spec paths; SPA under `/app/*`                                                                                                                                                                                                                                                            |
| 2   | **Hot seat starves the pool**: 500 waiters on A12's row lock occupy all ~20 connections, and the other 19k requests queue behind a serial commit chain                         | Lock-free snapshot fast-path decline; only possible winners take locks                                                                                                                                                                                                                                |
| 3   | **Replay misreported as `seat_taken`**: a concurrent same-key retry sees the seat taken by its own original before seeing the key                                              | Key and seat states read in one snapshot; key re-checked on the conflict path                                                                                                                                                                                                                         |
| 4   | **Deadlock reserve↔cancel**: lazy expiry in reserve updates the old reservation (seat→reservation) while cancel goes reservation→seat                                          | Reserve never touches others' reservations; expired status is derived; global order is seats before reservations                                                                                                                                                                                      |
| 5   | **Render health check pulls the instance mid-burst**: `/readyz` queued behind a saturated pool (and a 0.1 CPU event loop) times out, Render stops routing, and edge 5xx follow | Render's `healthCheckPath=/healthz` (cheap, no DB). The server only `listen()`s after DB connect + migrations, so live implies booted. `/readyz` uses a **dedicated 1-connection pool** with a 1s cached result and still fails closed for graders. Health routes bypass auth, admission, and logging |
| 6   | **Sporadic 502s from keep-alive races**: Node's 5s `keepAliveTimeout` is shorter than the proxy's idle timeout, so the proxy reuses a socket Node just closed                  | `keepAliveTimeout=65s`, `headersTimeout=66s`                                                                                                                                                                                                                                                          |
| 7   | **OOM at 512 MB** with thousands of queued requests                                                                                                                            | Admission limiter (bounded in-flight, large-but-capped queue → 429 only at the extreme); `--max-old-space-size=384`; small bodies (1 MB limit); CI burst under `--memory=512m` measures it                                                                                                            |
| 8   | **Metric cardinality leak**: a `show` label on counters grows with every burst's fresh show                                                                                    | Counters carry only `reason`/`outcome`; `seats{status}` gauges only for the N most recent active shows                                                                                                                                                                                                |
| 9   | **`GET /shows/:id` polling burns CPU** (10k-seat JSON on 0.1 CPU)                                                                                                              | 250 ms micro-cache of the serialized snapshot (still one consistent snapshot), plus a compact seat encoding                                                                                                                                                                                           |
| 10  | **Public admin key in a public repo** lets anyone create million-seat shows and fill the 500 MB free DB                                                                        | Key shared in the submission, not the repo; `MAX_SEATS_PER_SHOW=20000` (configurable); burst/simulator shows are `ephemeral` and deleted by the janitor after 24h; idempotency rows get a TTL cleanup                                                                                                 |
| 11  | **Supabase free project pauses after 7 idle days** and graders hit a dead DB                                                                                                   | Daily GitHub Actions cron → `/readyz` (touches the DB); verify the week before submission                                                                                                                                                                                                             |
| 12  | **Direct DB host is IPv6-only** and Render can't reach it                                                                                                                      | Pooler host only: transaction 6543 for the app, session 5432 for migrations; `sslmode=require`                                                                                                                                                                                                        |
| 13  | **Version drift** between local, CI, and Supabase                                                                                                                              | Pin PG 17 everywhere (embedded-postgres 17, `postgres:17` in CI/compose)                                                                                                                                                                                                                              |
| 14  | **Lock wait → 55P03 → 500**                                                                                                                                                    | `lock_timeout` 10s plus bounded retry; with the fast path, real waits are only a few ms                                                                                                                                                                                                               |
| 15  | **Seat-map rendering at 10k seats** (10k SVG nodes)                                                                                                                            | Canvas renderer with hit-testing                                                                                                                                                                                                                                                                      |
| 16  | **embedded-postgres on Windows** may need the VC++ runtime                                                                                                                     | Fallback is `npm run test:remote` against a Supabase dev schema; CI is unaffected                                                                                                                                                                                                                     |

Plus the classics, all covered:

- read-then-write double sell (conditional update + one row per seat)
- per-user limit race (advisory lock + true count)
- cross-user idempotency leak (keys scoped per user)
- spoofed body `user_id` (ignored, logged, `identity_spoof_ignored_total`)
- foreign cancel (403)
- duplicate, empty, or unknown seats (400)
- clock skew (DB `now()`)
- DB down (`/readyz` 503, writes 503, CP over AP)
- deploy SIGTERM mid-burst (drain)

### Free-tier engineering (slow is fine, 5xx is not)

- **Expected throughput.** At 0.1 CPU, a few hundred req/s, so a 20k burst takes ~1–2 min. The smoke deploy measures the real number.
- **Minimal CPU per request.**
  - Fastify's compiled JSON-schema validation and fast-json-stringify serializers on the hot path.
  - One log line per request instead of Fastify's default pair.
  - An LRU cache of verified JWTs and no API compression.
- **One DB round-trip**, with the pool sized to the pooler (~20 clients).
- **Fast cold start.** `node:22-alpine` multi-stage image with production deps only and a prebuilt SPA; migrations no-op when already applied.

## 4. API contract

- **Auth:** `POST /auth/login {username}` → `{token, user_id}` (HS256 JWT, 24h, `sub`). `POST /auth/tokens {count, prefix}` batch-mints tokens for load tests (capped, CPU-only).
- **Create show:** `POST /shows` (admin: `Authorization: Bearer <ADMIN_API_KEY>`). Body `{name, seats[], price_paise, per_user_limit?=4, hold_ttl_seconds?, ephemeral?}` → 201 with every seat available.
- **Reserve:** `POST /shows/:id/reserve` with `{seats, idempotency_key}` or the `Idempotency-Key` header. The key is required; a header/body mismatch → 400. Returns 201 `{reservation_id, show_id, user_id, seats, amount_paise, status, expires_at?}`.
- **Lifecycle:** `POST /reservations/:id/confirm` (hold mode), `POST /reservations/:id/cancel` (owner only), `GET /me/reservations?show_id=`.
- **Reads:** `GET /shows`; `GET /shows/:id` (seats + `{total, available, held, confirmed, invariant_ok}`); `GET /shows/:id/audit`.
- **Status codes:** 201 created · 200 idempotent replay · 400 validation · 401 bad/missing token · 403 not owner/admin · 404 unknown show/reservation · 409 domain decline (`seat_taken`, `per_user_limit`, `idempotency_key_reused`, `reservation_expired`) · 429 only on extreme overload · 503 DB unreachable.
- **Error shape:** `{error:{code,message,request_id,...}}`.
- **Health & metrics:** `GET /healthz` (liveness), `GET /readyz` (dedicated DB check, fails closed), `GET /metrics`.

## 5. Observability

- **Counters** (prom-client):
  - `fdfs_reservations_confirmed_total`
  - `fdfs_reservations_declined_total{reason=seat_taken|per_user_limit|idempotent_replay|idempotency_key_reused|invalid|not_found}`
  - `fdfs_holds_expired_total`, `fdfs_reservations_cancelled_total`
  - `fdfs_identity_spoof_ignored_total`
  - `fdfs_invariant_violations_total`
  - `fdfs_http_responses_total{route,status_class}`
- **Gauges:** `fdfs_seats{show,status}` (DB-derived, recent shows only), pool in-use/waiting, admission queue depth, and event-loop lag.
- **Histograms:** `fdfs_reservation_duration_seconds{outcome}`, with buckets up to 30s for the free tier.
- **Logs:** pino JSON. `request_id` comes from an incoming `x-request-id` or is generated, and is echoed in the response header and in error bodies. Each reservation logs one outcome line (user, show, seats, code, latency). A redacted ring buffer (last ~2k lines) is exposed at `/ops/logs` and `/stream?logs=1`, giving **public log access** without paid Render log streams.
- **Reconciler:** every few seconds it runs the invariant + `audit` for active shows → `fdfs_invariant_violations_total`. A 1s time-series ring buffer at `/ops/timeseries` feeds the War Room.
- **Ops:**
  - `docker compose --profile obs up` brings up Prometheus + a provisioned Grafana dashboard.
  - `ops/alerts.yml` defines the 2am pages: invariant violation >0, 5xx >0, readiness failing, p99 > SLO, pool saturation sustained, sweeper lag.

## 6. UI: FirstDayFirstShow

A dark "opening night" box-office console, built with the design skill during the UI phases.

1. **Shows:** a list plus admin "create show" with a hall-layout generator (rows × seats, aisles, price).
2. **Live hall:** a canvas cinema hall with the screen glowing at the top; seats flip colour live via SSE deltas with snapshot resync. Select → reserve with a client-generated idempotency key → hold countdown → confirm/cancel. Graceful 409 UX ("A12 was just taken; keep A13?") and My bookings.
3. **War Room:**
   - live per-second confirmed vs declined-by-reason
   - p50/p95/p99 latency
   - pool and queue saturation
   - a live invariant badge (`available+held+confirmed == total ✓`) with audit status
   - a log tail where clicking a `request_id` filters to it
4. **Stampede simulator:** choose N users, hot seats, retry %, spoof %, and over-limit users, then fire from the browser and watch the hall fill. It ends with the outcome distribution and the audit verdict.

## 7. Burst script: `npm run burst -- <BASE_URL>` (+ `burst.sh`, Makefile)

- Creates an ephemeral show and batch-mints tokens.
- Runs these scenarios concurrently:
  - a hot-seat storm (500 users → A12 + 5 more hot seats)
  - a Zipf-skewed stampede (~20k requests)
  - same-key retries
  - same key with different seats
  - one user ×10 parallel at limit 4
  - crossed multi-seat pairs
  - a spoofed body `user_id`
  - a foreign cancel
- Polls `GET /shows/:id` _during_ the burst to check the invariant live.
- Prints the outcome distribution (confirmed / declined by reason / other 4xx / 5xx / network errors), p50/p95/p99, throughput, the final reconciliation, and the audit result.
- Diffs `/metrics` before and after against the observed outcomes, and **exits non-zero on any violation**.

## 8. Repo layout (single package.json, one lockfile)

```
server/src/{config.ts, main.ts, db/{pool,migrate}.ts, engine/{reserve,lifecycle,audit,types}.ts,
            http/{app,auth,errors,admission}.ts + routes/, obs/{logger,metrics,events,logbuffer,timeseries}.ts,
            jobs/{sweeper,reconciler,janitor}.ts}
db/migrations/0001_schema.sql, 0002_reserve_fn.sql, 0003_lifecycle_fns.sql, 0004_audit_fn.sql
web/            Vite React app (routes under /app)
scripts/burst/  burst.ts + scenarios; burst.sh
test/           engine concurrency + property tests, API integration tests
ops/            prometheus.yml, alerts.yml, grafana/ ; pgbouncer config for CI/compose
Dockerfile, docker-compose.yml (pg17 + pgbouncer + app [+ obs profile]), render.yaml, Makefile,
.github/workflows/{ci,keepalive}.yml, .env.example, README.md, WRITEUP.md, Plan.md, Progress.md, docs/ai-log.md
```

**`.env.example` placeholders** (Zerodha-clone style):

- `PORT`, `NODE_ENV`, `LOG_LEVEL`
- `DATABASE_URL` (pooler 6543), `DATABASE_URL_SESSION` (pooler 5432, migrations), `DB_POOL_MAX`
- `JWT_SECRET`, `ADMIN_API_KEY`, `AUTH_DEMO_LOGIN`
- `DEFAULT_PER_USER_LIMIT`, `MAX_SEATS_PER_SHOW`, `HOLD_SWEEP_INTERVAL_MS`, `MAX_QUEUE`
- `SUPABASE_PROJECT_REF`

Real values live only in `.env` (gitignored) and in Render (`sync:false`). You provide them at Phase 3b.

## 9. Phases

### Working protocol

- **`Plan.md`** (repo root) holds this plan, committed in Phase 0. It is the living source of truth; any design change during execution is edited there and noted in that phase's commit.
- **`Progress.md`** (repo root) is the phase-by-phase tracker. Each phase has a status (`not started / in progress / done`), a checklist of its deliverables, the verification results (test/burst output summaries), the commit hashes, deviations from the plan, open issues, and the AI-usage notes that feed WRITEUP.md. It is updated as work happens and finalized at the end of each phase.
- **Hard stop after every phase.** At the end of a phase I:
  1. run its ✔ checks
  2. update `Progress.md`
  3. commit
  4. give a short review: what was built, the decisions to defend, and anything that needs you
  5. **stop and wait**

  The next phase starts only after you say **"continue"**. Phase 3b also waits on you for the Supabase/Render credentials.

- Small commits happen inside each phase so the history shows how the work was done.

**Phase 0: Foundation.**

- `git init` (you create the public GitHub repo; I push once you confirm). TS, eslint/prettier, vitest, layout, `.env.example`, zod config.
- Migration runner (idempotent, guarded by an advisory xact lock).
- embedded-postgres 17 harness (a fresh DB per run).
- CI workflow (typecheck + tests on `postgres:17`), README skeleton, `docs/ai-log.md`.
- **`Plan.md`** (this plan) and **`Progress.md`** (the tracker, with all phases listed and Phase 0 filled in).

✔ typecheck + tests green locally and in CI.

**Phase 1: Core engine I (atomic reserve).**

- Schema + constraints, the `reserve()` function (fast path, idempotency, advisory limit lock, sorted all-or-nothing seat locks).
- A TS wrapper returning a discriminated-union outcome, plus a bounded retry for 40P01/40001/55P03.

✔ Tests on real PG:

- 500 parallel requests on one seat → exactly 1 winner, and the pool is never fully parked
- 10 parallel requests from one user at limit 4 → ≤4 seats
- same key ×50 → 1 reservation plus 49 replays (never `seat_taken`)
- same key with different seats → `idempotency_key_reused`
- crossed multi-seat pairs → zero deadlock errors
- fast-check randomized stress with the invariant checked after each batch

**Phase 2: Core engine II (lifecycle + audit).**

- Holds/TTL, `confirm`, `cancel`, the `expire_holds` sweeper (SKIP LOCKED), derived expiry, `audit()`.

✔ Tests:

- A's hold expires → B re-books → A's late confirm/cancel leaves B untouched
- cancel↔confirm race
- reserve-takeover vs cancel race → no deadlock
- audit stays green under stress

**Phase 3: API service.**

- Fastify app at the spec paths; JWT + admin auth; schemas; error model; DB error → HTTP mapping.
- request-id + pino; `/healthz`, `/readyz` (dedicated pool); admission limiter; keep-alive tuning; SIGTERM drain; batch mint.
- Multi-stage Dockerfile + compose (PG17 + PgBouncer transaction mode).
- CI builds the image and smoke-tests the compose stack.

✔ API integration tests pass (spoofed body ignored, foreign cancel 403, replay 200 with the same body, unknown seat 400). The CI compose job is green.

**Phase 3b: Smoke deploy.**

- You create the Supabase project (Singapore) and share the pooler URLs and secrets. I write `render.yaml` (Docker, free, Singapore, `healthCheckPath: /healthz`) and you connect the repo.
- Cold start → `/readyz` 200; `npm run test:remote` against Supabase; a 1k mini-burst against the live URL; record free-tier throughput and memory.

**Phase 4: Realtime layer.**

- After-commit event bus.
- SSE `/stream?show=` with 100 ms coalesced deltas, heartbeats, and snapshot resync.
- Sweeper, reconciler, and janitor jobs wired into the server lifecycle.

✔ Two SSE clients converge to identical state after a burst.

**Phase 5: UI I (shell + shows).**

- Design system and dark theme (design skill), app shell under `/app`, demo login, show list, admin create-show with a layout generator.
- TanStack Query client; Vite build served by Fastify.

✔ Visual check in the browser pane at desktop and mobile widths.

**Phase 6: UI II (live hall).**

- Canvas seat map with live SSE updates and animations.
- Reserve → hold countdown → confirm/cancel; 409 UX; My bookings.

✔ Two tabs as different users racing for one seat; visual pass.

**Phase 7: Observability + War Room.**

- All metrics, DB-derived gauges, reconciler metric.
- Log ring buffer + SSE tail, `/ops/*` JSON, the War Room page.
- Prometheus/Grafana compose profile, `alerts.yml`.

✔ After a local burst, metric deltas equal API outcomes and the badge stays green throughout.

**Phase 8: Burst + Stampede.**

- The burst CLI (all scenarios, live invariant polling, metrics diff, exit code).
- The Stampede Simulator page.
- A tuning pass (pool size, admission limits, logging cost) plus a CI throttled-burst job.

✔ `npm run burst -- http://localhost:8080` is green; the CI `--cpus=0.1` burst shows 0 5xx.

**Phase 9: Final deploy + docs.**

- Redeploy and verify the cold-start → healthy path; keepalive cron.
- Live burst against the public URL (output captured) plus a recording of the War Room/log tail under load.
- README (run, tokens, burst, metrics/logs access) and WRITEUP.md (atomic decision, idempotency, holds, CAP under partition, 2am pages, AI usage directed vs decided, next steps).

✔ A fresh clone works; `npm run burst -- https://<app>.onrender.com` is green.

## 10. Verification (end to end)

- `npm test` covers the engine concurrency/property suite and API integration tests: embedded PG locally, `postgres:17` + PgBouncer in CI. `npm run test:remote` runs the same suite against Supabase.
- Local: `npm run dev`, then `npm run burst -- http://localhost:8080` → exit 0, 0 5xx, invariant ✓ during and after, audit ✓, metrics delta ✓.
- CI: image build, compose up, throttled burst, all green on every push.
- Browser pane: the hall and War Room update live during a burst.
- Live: `/healthz` and `/readyz` 200; the burst against the Render URL is green. Fail-closed `/readyz` is demonstrated in CI by stopping the DB container → 503.
