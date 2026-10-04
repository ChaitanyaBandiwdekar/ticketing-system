# Progress

Phase-by-phase tracker for [`Plan.md`](Plan.md). Every phase ends with its checks run, this file updated, a commit, and a **hard stop** until the go-ahead ("continue").

| Phase | Scope                                   | Status                       |
| ----- | --------------------------------------- | ---------------------------- |
| 0     | Foundation                              | ✅ done                      |
| 1     | Core engine I: atomic reserve           | ✅ done                      |
| 2     | Core engine II: lifecycle + audit       | ✅ done                      |
| 3     | API service                             | ✅ done                      |
| 3b    | Smoke deploy (Render free + Supabase)   | ⏸ blocked: needs credentials |
| 4     | Realtime layer (SSE, jobs)              | ✅ done                      |
| 5     | UI I: shell + shows                     | ✅ done                      |
| 6     | UI II: live hall                        | ⬜ not started               |
| 7     | Observability + War Room                | ⬜ not started               |
| 8     | Burst CLI + Stampede simulator + tuning | ⬜ not started               |
| 9     | Final deploy + docs                     | ⬜ not started               |

---

## Phase 0: Foundation ✅

**Deliverables**

- [x] `git init` (branch `main`), `.gitignore`, `.gitattributes` (LF everywhere), `.editorconfig`
- [x] TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, bundler resolution), ESLint 10 flat config, Prettier
- [x] `server/src/config.ts`: zod-validated env that reports every issue at once; `loadMigrationUrl` for tooling; `loadDotEnv` using Node's built-in `process.loadEnvFile` (no dotenv dependency)
- [x] `server/src/db/pool.ts`: postgres.js pool tuned for transaction poolers (`prepare:false`, no session state)
- [x] `server/src/db/migrate.ts` + `npm run db:migrate`: forward-only and all-or-nothing in a single transaction, serialized by an advisory xact lock, with checksum drift detection
- [x] Test harness: embedded Postgres 17 by default, or `TEST_DATABASE_URL` (CI / Supabase); app migrations applied before tests; vitest `provide/inject`
- [x] `.env.example` with every placeholder (Supabase pooler URLs, secrets, tuning knobs)
- [x] CI workflow `.github/workflows/ci.yml`: format, lint, typecheck, and tests on a `postgres:17` service
- [x] `README.md` skeleton, `Plan.md`, `Progress.md`, `docs/ai-log.md`

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ (0 warnings) · `npm run format:check` ✅
- `npm test` ✅: 2 files, 8 tests, ~13s locally (most of it is embedded-PG `initdb`)
  - config: defaults, coercion, session-URL fallback, all errors reported at once
  - migrate: ordered multi-statement apply + idempotent re-run; full rollback when one file fails; checksum drift refused; **8 concurrent runners → exactly 1 applies**
- CI: ⏳ runs on the first push (GitHub repo not created yet)

**Deviations from plan**

- vitest **4.1** (not 5) and TypeScript **5.9** (not 7). vitest 5 needs Node ≥ 22.12 and this machine has 20.19; typescript-eslint supports TS < 6.1. Docker/CI/production use Node 22.
- `dotenv` dropped in favor of Node's built-in `process.loadEnvFile`.

**Open items / needs you**

- Create an empty **public** GitHub repo and share its URL; I'll add the remote and push once you confirm.

**Commits:** see `git log`. Phase 0 is a single foundation commit.

---

## Phase 1: Core engine I (atomic reserve) ✅

**Deliverables**

- [x] `db/migrations/0001_schema.sql`: `shows`, `seats` (one row per seat, `UNIQUE (show_id, label)`), `reservations`, `idempotency_keys` (PK `(user_id, key)`, deferred FK to the reservation)
  - CHECKs: available ⇔ no reservation/user; held ⇔ `held_until` set; `price_paise > 0`; label format
  - Composite FK `seats (reservation_id, show_id, user_id) → reservations (id, show_id, user_id)`, so a taken seat can only belong to a reservation of the same show and user
  - Helper SQL functions `fdfs_seat_free` (derived expiry from DB `now()`), `fdfs_reservation_status`, `fdfs_reservation_json`
- [x] `db/migrations/0002_reserve_fn.sql`: `fdfs_reserve()`, one round trip
  - lock-free snapshot fast path (show, key, unknown seats, user's active count, taken seats in one statement)
  - key claim via `INSERT … ON CONFLICT DO NOTHING`
  - per-(show,user) advisory xact lock + exact count
  - seats locked `ORDER BY id FOR UPDATE`, all-or-nothing
  - instant confirm or hold with TTL; `lock_timeout = 10s`
  - global lock order documented in the file header
- [x] `server/src/engine/reserve.ts`: input guards, request fingerprint (sha256 of show + sorted seat set), discriminated-union `ReserveOutcome` (`server/src/engine/types.ts`)
- [x] `server/src/db/retry.ts`: bounded jittered retry on 40P01/40001/55P03 → `ContentionError` (the API will map it to 503, never 500); `onRetry` hook
- [x] `server/src/engine/shows.ts`: `createShow` (validated, one transaction, seat ids in input order) and `getShowSnapshot` (seat list + counts from one statement, so they always reconcile)
- [x] `test/helpers/engine.ts`: show/booking helpers and an independent SQL invariant oracle (taken seat ↔ active reservation of the same user/state, reservation owns exactly its seats, amount = price × seats, per-user ≤ limit, counts reconcile)

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅
- `npm test` ✅: 6 files, 60 tests, ~12–30s locally (mostly embedded-PG `initdb`)
  - 500 parallel requests for one seat → exactly 1 created, 499 `seat_taken`; fewer than 20 (the pool size) declines took the locked path, the rest declined lock-free; 0 retries
  - one user × 10 parallel at limit 4 → exactly 4 created, 6 `per_user_limit`
  - same key × 50 → 1 created + 49 replays of the same reservation, never `seat_taken`
  - same key with different seats × 40 in parallel → 1 created, the rest replayed or `idempotency_key_reused`, never `seat_taken`
  - 300 crossed multi-seat requests (opposite orders on overlapping pairs) → 0 deadlock retries, no seat sold twice
  - fast-check: 25 randomized scenarios of up to 4 concurrent batches × 30 requests (shared/reused keys, overlapping seats, limit pressure, instant and hold mode); DB invariants + an outcome model checked after every batch
  - hold mode: TTL deadline, lapsed hold reads `expired` on replay, frees the user's quota, and another user can take the seat
  - the invariant oracle itself is shown to catch corruption the constraints allow (wrong amount, over-limit)
  - show creation/validation and snapshot tests (28)
- CI: runs on push to GitHub

**Industry alignment review** (requested before building on the core; table in Plan.md §2)

Checked against Stripe/brandur idempotency keys, the IETF Idempotency-Key draft, the Ticketmaster/Hello Interview hold design, and pganalyze/Azure write-ups on advisory locks and MultiXacts. Changes:

- **Fixed a real scaling issue:** the `reservations.show_id → shows` FK made every reserve take `FOR KEY SHARE` on the one hot show row (MultiXact contention under a stampede). The FK is dropped; integrity is kept by the function's show check, the seat composite FK, and explicit janitor deletes. A regression test holds `FOR UPDATE` on the show and asserts reserve still completes immediately. It was blocked 2.8s before the fix.
- `idempotency_key_reused` is now **422** (IETF draft); every other domain decline stays 409.
- `lock_timeout` 10s → 5s; 57014 (`statement_timeout`) maps to `ContentionError` without a retry (never a 500); retry-helper unit tests added.
- Added an index on `idempotency_keys.reservation_id` (so cascade deletes don't scan); `userId` length guarded in the wrapper.
- Kept, as documented deviations: in-flight duplicates wait-then-replay instead of 409, and declines don't consume a key.

**Deviations from plan** (Plan.md updated accordingly)

- Declines are returned as jsonb instead of raised; a locked-path decline deletes the key row it claimed in the same transaction. Same guarantee (only successes consume a key) without exception churn or ERROR log lines in Postgres during a stampede.
- The fast path also checks the per-user limit from the snapshot (linearizable decline), so a greedy user's extra requests never take the advisory lock.
- Every outcome reports `path: fast|locked`, used by tests now and by metrics later.
- Composite FK added (seat → reservation of the same show and user), stronger than the plain `reservation_id` FK in the plan.

**Open items / needs you**

- None. Pushed to https://github.com/ChaitanyaBandiwdekar/ticketing-system.

**Commits:** see `git log`. Phase 1 is a feature commit, a docs commit, and a review-hardening commit.

---

## Phase 2: Core engine II (lifecycle + audit) ✅

**Deliverables**

- [x] `db/migrations/0003_lifecycle_fns.sql`:
  - `fdfs_confirm` and `fdfs_cancel`: a lock-free pre-check (not_found / forbidden / already final), then lock seats `WHERE reservation_id ORDER BY id FOR UPDATE` → the reservation row, then re-decide under the locks. Every seat write is guarded by `reservation_id = <this reservation>`. Both are idempotent: a repeat gives `changed: false`.
  - `fdfs_expire_holds`: a seat-based sweeper. Pass 1 releases lapsed held seats; pass 2 marks lapsed holds `expired`. It uses `SKIP LOCKED` throughout and never waits, and it returns the released seats per show for realtime deltas.
  - A partial index on `seats (held_until) WHERE status='held'`.
- [x] `db/migrations/0004_audit_fn.sql`: `fdfs_audit(show)` is one statement (one snapshot) over effective states. Checks: seat_count, counts, orphan_seat (taken seat → active reservation of the same user, state, and seat), missing_seats, amount, per_user_limit. Returns `{ok, counts, violations[]}`.
- [x] `server/src/engine/lifecycle.ts`: `confirm`, `cancel`, `expireHolds`, `listReservations` (newest first, optional show filter, effective statuses). `server/src/engine/audit.ts`: `audit`. `server/src/engine/ids.ts`: a shared `isUuid` guard. Typed outcomes are in `types.ts`.
- [x] `test/helpers/engine.ts`: `lapse()` rewinds a hold's deadline. It locks in engine order, so it is safe amid concurrent calls.

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅
- `npm test` ✅: 8 files, 80 tests, ~40s locally
  - A's hold lapses → B takes over a seat → A's late confirm and cancel both give `reservation_expired`. The sweeper releases only A's untaken seat, and B's seats and booking are untouched.
  - confirm vs cancel raced on 60 holds → cancel always wins the final state (confirm either ran first or got `reservation_cancelled`). All seats are free and there were 0 retries.
  - 25 rounds of takeovers + cancel + late confirm + sweeper + crossing pair reserves, all concurrent → 0 deadlock retries, audit green every round.
  - fast-check: 12 randomized scenarios of concurrent reserve/confirm/cancel/sweep batches (owner and intruder) with **real 1s hold expiry** and pauses. After every batch, `audit()`, the independent test oracle, and the snapshot counts all agree. Each final reservation status matches what the calls reported, and there were 0 retries.
  - lifecycle unit tests (16):
    - confirm/cancel happy paths, idempotency, and forbidden/not_found
    - lapsed and cancelled cases
    - sweeper grouping per show, and that it skips locked seats without waiting
    - audit counts and corruption detection
    - listReservations
- CI ✅ green on GitHub for the Phase 1 push (Phase 2 runs on this push)

**Deviations from plan** (Plan.md updated accordingly)

- Confirm is idempotent (`changed: false` on repeat), and confirming a cancelled reservation is a new 409 `reservation_cancelled`.
- The sweeper is seat-based rather than reservation-based, so a seat skipped under `SKIP LOCKED` (or left pointing at an already-finalized hold) is always picked up on a later tick.

**Open items / needs you**

- None for this phase. Phase 3b will need the Supabase project and a Render account.

**Commits:** see `git log`. Phase 2 is a feature commit and a docs commit.

---

## Phase 3: API service ✅

**Deliverables**

- [x] `server/src/http/app.ts`: Fastify app factory.
  - request id: a sane incoming `x-request-id` is kept, anything else is replaced; it is echoed on every response, error body and log line
  - admission control (429 + Retry-After past `MAX_QUEUE` in flight; ops routes bypass it)
  - one enriched log line per request via `LogController` + `onResponse`
  - one error shape for every response, and `keepAliveTimeout` 65s / `headersTimeout` 66s
- [x] `server/src/http/errors.ts`: the `{error:{code,message,request_id,...}}` model. Contention → 503 `contention`; connection failures and SQLSTATE 08/53/57P01-03 → 503 `db_unavailable` (with Retry-After); only genuine bugs → 500, with no message leak.
- [x] `server/src/http/auth.ts`: HS256 JWTs via fast-jwt (algorithm pinned, issuer checked, 20k-entry verified-token LRU cache), identity only from `sub`, and a constant-time admin key check. Auth runs in `onRequest`, before body validation (no credentials → 401, never a 400).
- [x] Routes at the spec's paths:
  - `/auth/login`, `/auth/tokens` (batch mint ≤ 10k)
  - `POST /shows` (admin), `GET /shows`, `GET /shows/:id` (one-snapshot seat map with a 250 ms micro-cache), `GET /shows/:id/audit`
  - `POST /shows/:id/reserve` (`Idempotency-Key` header or body field; a mismatch → 400; replay → 200 + `Idempotent-Replayed: true`; key reuse → 422; spoofed body `user_id` ignored and logged as `identity_spoof_ignored`)
  - `POST /reservations/:id/confirm|cancel`, `GET /me/reservations`
- [x] `server/src/http/readiness.ts`: `/readyz` on a dedicated 1-connection pool, single-flight, cached 1s, 2s timeout, fails closed, and 503 while draining. `/healthz` does no I/O.
- [x] `server/src/main.ts`: migrate (retrying while the DB comes up) → listen. On SIGTERM: readiness 503 → Fastify close (in-flight requests finish) → pools drain, with a 25s watchdog.
- [x] Container: a multi-stage `Dockerfile` (node:22-alpine, esbuild bundle, prod deps only, tini as PID 1, non-root, heap capped at 384 MB). `docker-compose.yml` runs Postgres 17 + **PgBouncer 1.25 in transaction mode** + the app; migrations go direct, like Supabase's session pooler.
- [x] `scripts/smoke.sh` (reusable against compose, CI or the live URL) and `scripts/ci/fail-closed.sh`. A CI `compose` job builds the image, starts the stack, smoke-tests through PgBouncer, stops the DB (expects `/healthz` 200, `/readyz` 503 and reserve 503 `db_unavailable`), restarts it (expects recovery), smoke-tests again, and checks that SIGTERM gives exit code 0.
- [x] `npm run dev | build | start`; README now documents the Docker stack, the API table and the status codes.

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅
- `npm test` ✅: 15 files, 165 tests, ~45s locally
  - Reserve contract (15):
    - 201 body shape; replay 200 with the identical body + header
    - key via body; header/body mismatch 400; missing key 400; key reuse 422
    - spoofed `user_id` ignored; 409 `seat_taken` with `unavailable_seats` and `request_id`; 409 `per_user_limit` with the numbers
    - unknown seats 400; unknown or malformed show 404; 401 before body validation (the admin key is not a user identity)
    - a 60-user stampede through HTTP gives 1×201 + 59×409, and the audit is ok
    - confirm/cancel replay headers; foreign cancel 403; lapsed hold 409
  - Auth (15): forged secret, `alg:none`, expired, wrong issuer and bad `sub` → 401; batch mint bounds
  - Shows (14), platform (11: health, request-id rules, 404 shape, malformed JSON 400, 413, 415), error mapping (18), admission (4), readiness (8)
- The production bundle (`npm run build`) was booted locally against an embedded Postgres, and `scripts/smoke.sh` passed end to end. It confirmed one log line per request carrying outcome and decision path, the spoof warning, and that re-running migrations is a no-op.
- CI: the Docker/compose job runs on this push (there is no Docker on the dev machine, so CI is its first real run).

**Deviations from plan**

- fast-jwt rather than a hand-rolled HS256, for its built-in verified-token cache (the plan's "LRU cache of verified JWTs").
- An esbuild bundle instead of a `tsc` emit: the source uses extensionless ESM imports; the bundle is ~40 KB.
- Fastify 5.12 deprecates the top-level `disableRequestLogging`/`requestIdLogLabel`, so `LogController` is used.
- Fastify's default Ajv type coercion is kept (e.g. `"4"` → 4, a single string → a one-item array). It is harmless here because identity never comes from the body and every value is re-validated by the engine.
- The `text/plain` body gets a 400 (Fastify parses it, then the schema rejects it); 415 is for media types with no parser.

**Open items / needs you**

- **Phase 3b (smoke deploy) needs you:** create the Supabase project (Singapore) and share the pooler URLs (transaction :6543 and session :5432) and the DB password via `.env`/Render only; create a Render account and connect the GitHub repo. I'll add `render.yaml`.

**Commits:** see `git log`. Phase 3 is a feature commit and a docs commit.

---

## Phase 3 follow-up: CI compose job

The Phase 3 push failed CI's compose job, and the first fix revealed a second failure:

1. **Exit 126:** `scripts/smoke.sh` and `scripts/ci/fail-closed.sh` were committed from Windows with mode 100644. Fixed with `git update-index --chmod=+x` (`07f15ea`); after that, the smoke step passed in CI.
2. **The fail-closed step timed out (curl exit 28):** with Postgres stopped, a reserve hung for more than 30s instead of answering 503. The app's connections are to PgBouncer, which stays up and queues each query until `query_wait_timeout` (default 120s). Fixed in Phase 4 at two layers (pre-mortem #17 in Plan.md):
   - Every request-path DB call now has a deadline (`DB_REQUEST_TIMEOUT_MS`, default 10s) → 503 `db_unavailable`.
   - Compose sets PgBouncer `QUERY_WAIT_TIMEOUT=10`.

   A test runs the app against a TCP "black hole" (accepts, never answers): reserve, reads, stream and cancel all return 503 in under 2s, `/healthz` stays 200, and `/readyz` returns 503.

---

## Phase 4: Realtime layer ✅

**Deliverables**

- [x] `server/src/realtime/bus.ts`: an in-process, after-commit event bus. Each engine mutation is one autocommitted statement, so routes emit after the call returns. Events are hints `{showId, labels, cause}`, not state. Emitted on reserve `created`, confirm/cancel with `changed: true`, and sweeper releases.
- [x] `server/src/realtime/hub.ts`: the SSE hub behind `GET /stream?show=<id>`.
  - **Frames:** `snapshot` (compact: `labels[]` + a one-char-per-seat `status` string), `delta` (`changes {label: a|h|c}` + `counts`), `audit`, `gone`, and `: hb` heartbeats.
  - **Convergence by construction:** per show, changed labels are coalesced for `STREAM_COALESCE_MS`, then re-read together with the counts in one statement (`getSeatStates`). The connect snapshot, delta reads and resyncs share one serialized queue per show, and frames go out in queue order.
  - Periodic full resync (`STREAM_RESYNC_MS`) as a safety net for multi-instance setups.
  - Connection cap → 503 `stream_capacity`. A slow consumer is dropped once its buffer passes 4 MB. Reads have a deadline. One log line per stream on close.
- [x] `server/src/http/routes/stream.ts`: errors before the stream opens use the normal JSON shape (404 unknown show, 400 missing `show`, 503 capacity/draining/DB). Streams bypass admission control (they would hold a slot forever) and end on `preClose`, so drain never waits on them.
- [x] Jobs (`server/src/jobs/`):
  - `Periodic`: single-flight ticks; logs the first failure of a streak, then "recovered"; `stop()` waits for the in-flight tick.
  - **sweeper:** sweeps again while a full batch comes back; publishes released seats.
  - **reconciler:** audits shows that changed in the last 10 min plus watched shows (≤ 25 per tick). Counts violations, logs `invariant_violation`, and pushes `audit` frames.
  - **janitor:** `server/src/engine/maintenance.ts`. Deletes 24h-old ephemeral shows in global lock order (seats sorted `FOR UPDATE` → seats → reservations → show) and expires idempotency keys in batches.
- [x] `main.ts`: jobs start after `listen`. On SIGTERM: readiness 503 → jobs stop → streams end → in-flight requests finish → pools drain.
- [x] Config: `STREAM_*`, `RECONCILE_INTERVAL_MS`, `JANITOR_INTERVAL_MS`, `EPHEMERAL_SHOW_TTL_HOURS`, `IDEMPOTENCY_KEY_TTL_HOURS`, `DB_REQUEST_TIMEOUT_MS` (all in `.env.example`).
- [x] `scripts/smoke.sh` now also opens `/stream` and checks the snapshot (runs in the CI compose job).

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅
- `npm test` ✅: 18 files, 188 tests, ~40s locally
  - **Two SSE clients converge:** 30 users run 4 rounds each of reserve (sometimes with a replayed retry) → confirm / cancel / let lapse, against a 40-seat, 1s-hold show. The sweeper runs every 50 ms, and a second client joins mid-burst. Both maps equal the DB's effective state and each other's, with counts matching. Each client got **only its connect snapshot** (resync disabled), so convergence came from deltas alone.
  - Snapshot shape + SSE headers; reserve → confirm → cancel deltas with reconciled counts; idempotent repeats publish nothing; 40 parallel reserves → fewer than 40 deltas; heartbeats; JSON errors before open; `gone` after the janitor deletes a watched show; capacity 503 + Retry-After and recovery; periodic resync; `app.close()` ends streams in < 2s.
  - Jobs (9): Periodic never overlaps, survives failures, and `stop()` waits. The sweeper releases per show, spares live holds, and loops for 1,200 lapsed seats in one tick. The reconciler covers active and watched shows only, counts and logs violations, and forgets deleted shows. The janitor deletes only old ephemeral shows with all their rows; expired keys turn a late retry into a new request. **A purge mid-stampede** (120 concurrent reserves) gives only `created`/`seat_taken`/`show_not_found` and leaves zero orphan rows.
  - Deadline (4), including the black-hole database test above.
- The production bundle ran locally against embedded Postgres. `curl /stream` received the snapshot, a hold delta, the sweeper's release delta after the 2s TTL, and an `audit` verdict every second, then logged one `stream closed` line.
- One flaky run surfaced and was fixed in the test: a delta's `counts` can lead the seat map by one window (documented in hub.ts).

**Deviations from plan**

- The hub re-reads changed seats instead of forwarding event payloads (see above): one extra read per show per window, in exchange for guaranteed convergence.
- Seat states on the stream use a compact `a/h/c` encoding (the plan's "compact seat encoding" for 10k-seat halls). `GET /shows/:id` keeps full words.
- Reconciler and janitor stats are plain counters for now; Phase 7 exports them as Prometheus metrics.

**Open items / needs you**

- **Phase 3b** still needs the Supabase project (Singapore) and the pooler URLs/password, plus a Render account connected to the repo. Nothing in Phases 4–8 depends on it.

**Commits:** see `git log`. Phase 4 is a feature commit and a docs commit.

---

## Phase 5: UI I (shell + shows) ✅

**Deliverables**

- [x] `PRODUCT.md`: users, purpose and brand ("theatrical but precise"), which the design pass worked from.
- [x] `web/`: a Vite + React 19 + Tailwind 4 SPA under `/app/`, dark theme, Geist / Geist Mono (self-hosted).
  - App shell with the readiness indicator ("box office open") and the signed-in user.
  - **Demo login:** the user token is kept in localStorage. The admin key for creating shows is kept in sessionStorage only, so it is gone when the tab closes.
  - **Shows list:** occupancy, the invariant badge, and a toggle that shows the ephemeral burst shows. Counts are polled every 5s.
  - **Create show:** a hall generator (rows × seats per row, aisles, cross-aisles, price, per-user limit, hold TTL) with a live seat-map preview.
  - **Show page:** a static seat map from the REST snapshot (it goes live in Phase 6).
  - TanStack Query client: 4xx responses are not retried, and the cache is invalidated after a create.
- [x] Hall modules (`web/src/hall/`), all pure except the canvas component:
  - `generator`: seat labels and the layout.
  - `geometry`: labels + layout → positions (rows, aisles, cross-aisles, centred short rows, wrapping, grid fallback).
  - `draw`: canvas metrics, painting and the hit test. Seat state is shown by shape as well as colour.
- [x] `layout` on shows (`db/migrations/0005_show_layout.sql`): optional jsonb `{aisles_after, row_gaps_after}`. It is validated (≤ 50 entries each, aisles 1–1000, row labels `[A-Za-z0-9]{1,8}`), stored sorted with duplicates removed, and returned by create, list and read. The engine never reads it.
- [x] `server/src/http/routes/web.ts`: serves the SPA.
  - `/` and `/app` redirect to `/app/`.
  - Hashed assets are `immutable` for a year. `index.html` is `no-cache` with a strict same-origin CSP.
  - Paths without an extension get the shell. A missing file is a JSON 404, so a stale script tag fails loudly instead of loading HTML.
  - Static files bypass admission control and the access log.
  - A process with no UI build answers `/app/*` with a 404 that says to run `npm run build`.
- [x] Build: `npm run build` = server bundle + `vite build` → `dist/web` (`WEB_DIST_DIR`). `typecheck` also checks `web/`. The react-hooks lint rules apply to `web/`.
- [x] Dockerfile: copies `web/` into the build stage, so the image ships the UI. `scripts/smoke.sh` now checks the shell, the referenced script (`immutable`) and a client route.

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅ · `npm run build` ✅
- `npm test` ✅: 20 files, 245 tests (+57)
  - **Layout (22):**
    - engine validation (bounds, types, list caps, several issues at once);
    - stored sorted with duplicates removed; null when absent; nothing written when invalid; the DB `check` refuses non-objects;
    - over the API: returned by create, list and read; unknown keys dropped (Fastify's default, as elsewhere); a missing list defaults to empty; 400 for bad shapes.
  - **Static serving (10)**, against a temporary build folder:
    - redirects; the shell's headers and CSP; client routes; asset caching and content types; JSON 404s for missing files;
    - path traversal (plain and encoded) never leaves the build folder;
    - **UI still served when the API is at capacity:** a POST whose body never finishes holds the only slot. `/app/*` is still 200 while `/shows` gets 429; the slot frees when the client goes away.
    - the API-only process answers `/app/*` with the 404.
  - **Hall modules (25)**, in `test/web/`, typechecked by `web/tsconfig.json` (DOM lib):
    - row lettering (A…Z, AA…), generator cleanup, parsing;
    - geometry for generated, unordered, lower-case/dashed, straggler, wrapped and grid halls;
    - `measure`/`seatRect`/`seatAt`: every seat's centre hits that seat at 120–1600px, and aisles and cross-aisles miss.
    - Two randomized (fast-check) tests: **every hall the form can describe is a show the API accepts**, and generated halls never overlap and stay inside their extent.
- **Visual check** (previous session): the production bundle on `:18080` against embedded Postgres, every page at desktop and at 375×812 mobile. After this session's changes, the rebuilt bundle was rechecked on the create-show page.
- `scripts/smoke.sh` passed end to end against the production bundle, including the new UI steps.

**Fixed while testing**

- The form could build a layout the API rejects: 60 seats per row allows 59 aisles (and 52 rows allows 51 cross-aisles), against the API's cap of 50. `normalizeSpec` now caps each list at `LIMITS.maxLayoutEntries`, so the preview is exactly what gets stored.
- The Docker build stage did not copy `web/`, so the CI compose build would have failed (and the image would have had no UI).
- A wrong comment in `geometry.ts`: `S-0001`-style labels read as one wrapped row, not a grid.

**Deviations from plan**

- Hall geometry is stored on the show (`layout` jsonb) rather than inferred from labels. Shows created by scripts without a layout still render, through label parsing or the grid fallback.
- The canvas renderer (planned for Phase 6) arrived early, for the create-show preview and the static show page. Phase 6 adds live SSE updates, animations and the booking flow.

**Open items / needs you**

- **Phase 3b** still needs the Supabase project (Singapore) and the pooler URLs/password, plus a Render account connected to the repo.

**Commits:** see `git log`. Phase 5 is a feature commit and a docs commit.
