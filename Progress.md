# Progress

Phase-by-phase tracker for [`Plan.md`](Plan.md). Every phase ends with its checks run, this file updated, a commit, and a **hard stop** until the go-ahead ("continue").

| Phase | Scope                                   | Status         |
| ----- | --------------------------------------- | -------------- |
| 0     | Foundation                              | ✅ done        |
| 1     | Core engine I: atomic reserve           | ✅ done        |
| 2     | Core engine II: lifecycle + audit       | ✅ done        |
| 3     | API service                             | ✅ done        |
| 3b    | Smoke deploy (Render free + Supabase)   | ✅ done        |
| 4     | Realtime layer (SSE, jobs)              | ✅ done        |
| 5     | UI I: shell + shows                     | ✅ done        |
| 6     | UI II: live hall                        | ✅ done        |
| 7     | Observability + War Room                | ✅ done        |
| 8     | Burst CLI + Stampede simulator + tuning | ✅ done        |
| 9     | Final deploy + docs                     | ⬜ not started |

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

---

## Phase 6: UI II (live hall) ✅

**Deliverables**

- [x] `web/src/hall/live.ts`: the live seat map as a pure reducer over `/stream` frames.
  - Snapshots replace the map; deltas overwrite only the seats they list, in arrival order (the server's convergence argument).
  - Frames are laid onto the hall's own seat order by label, so a frame in any order still lands correctly.
  - A REST read seeds the first paint and stands in while the stream is down, but a late REST response never overwrites a live stream.
  - Changed seats get a fading glow (off under `prefers-reduced-motion`). `assume` paints our own just-reserved seats before the delta lands.
- [x] `web/src/hall/useLiveShow.ts`: drives the reducer from `EventSource`.
  - The browser reconnects a dropped stream by itself (the server sends `retry: 2000`). When the server refuses a stream (503 at capacity, a deploy), the hook reopens it with backoff.
  - While the stream is down, the show's REST read polls every 5s. A `gone` frame ends the stream and the page shows "No such show".
  - The header shows the link state (Live / Connecting / Reconnecting / Show removed) and the reconciler's latest audit verdict ("audited 3s ago").
- [x] Interactive canvas (`HallCanvas`):
  - click and tap to pick; hover tooltips ("E9 · available · ₹250");
  - keyboard: arrow keys move across aisles and cross-aisles (`neighbor()` in `geometry.ts`), Enter or Space picks, Esc clears, with a polite live region;
  - the focus ring follows `:focus-visible`, so it shows for the keyboard only;
  - a minimum seat pitch, so a wide hall on a phone scrolls sideways instead of shrinking past tappable;
  - the glow animation runs only while a glow is visible.
- [x] Booking (`pages/ShowPage.tsx`, `lib/booking.ts`):
  - **Idempotent reserve.** The client generates an `Idempotency-Key` per attempt and reuses it for every retry of the same seat set. Transient failures (network, 429, 502–504) are retried up to 4 tries, honouring `Retry-After`. "Try again" after that still reuses the key, so a retry can only replay. A 200 replay says so.
  - **Picked seats taken live.** If someone else takes a seat you picked, the stream shows it before you send anything: "F8 just went", and you keep the rest.
  - **409 `seat_taken`.** "G8 was just taken. Keep F7?" with a one-click rebook.
  - **409 `per_user_limit`** shows the numbers. Picking past your limit is stopped before any request, counting the seats you already hold.
  - **401.** The session is dropped and you are asked to sign in again.
  - **Instant mode** confirms on the spot. **Hold mode** shows a countdown against the server's clock (estimated from response `Date` headers, `lib/clock.ts`) with Confirm / Release. When the hold lapses on screen, the card turns Expired and the sweeper's delta frees the seats.
  - On phones, a sticky bottom bar holds the pick and the book button. The result notice scrolls into view, and the limit hint shows in the bar.
- [x] My bookings:
  - on the show page, your bookings for that show;
  - `/bookings` lists all your bookings grouped by show;
  - each card: status, hold countdown, confirm/release, and cancel behind a second click.
  - Confirm and cancel retry transient failures, since both are idempotent on the server.
- [x] **Per-tab sessions** (`lib/session.tsx`): each tab keeps its own session in sessionStorage. localStorage holds the last sign-in as the default for new tabs. So two tabs can be two people racing for one seat.
- [x] The header fits phones: the wordmark collapses to its logo under 420px, and the nav reads "Bookings" there.
- [x] README: a short section on the UI and the two-tab race.

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅ · `npm run build` ✅
- `npm test` ✅: 22 files, 266 tests (+21)
  - **Reducer (9)**, `test/web/live.test.ts`:
    - remap and changes;
    - snapshot then deltas; a REST seed vs a live stream, including a late REST response; an early delta;
    - flashes (pruning, resync differences, off); `assume`; audit and link states;
    - fast-check: any snapshot plus delta sequence, in any label order, equals a plain label → code model.
  - **Keyboard movement (4):** across aisles, ends of rows, cross-aisles, centred short rows, and every seat in a generated hall reachable from the first.
  - **Booking retries (5):** what counts as transient, `Retry-After` vs jittered backoff, retry then success, give-up after the last try, no retry on a 409.
  - **Clock (2):** skew adopted from `Date` headers, noise and garbage ignored; countdown format.
  - **UI reducer over the real stream** (`test/realtime/ui-live.test.ts`): 16 users run reserve / confirm / cancel / lapse rounds against a 1s-hold show with the sweeper. The UI reducer folds the stream's actual frames, into a hall order reversed on purpose, and lands exactly on the database's seat map. This guards against protocol drift between `hub.ts` and the UI.
- **Visual check** in the browser pane: the production bundle on `:18080` against the embedded dev Postgres, at 1280×860 and 375×812.
  - priya booked E7+E8; seats flipped to "Yours", counts reconciled, and the booking card appeared.
  - **Two tabs, two users:**
    - arjun picked F7+F8; priya booked F8 in the other tab. Arjun's tab dropped F8 at once ("F8 just went") and kept F7.
    - arjun picked G8 while a third user took it through the API in the same tick as arjun's click. The server answered 409, and the panel showed "G8 was just taken. Keep F7?".
  - Hold flow on a 90s show: countdown, then confirm. On a 10s show, the hold lapsed on screen: the card turned Expired, the seat came free through the sweeper's delta, and the quota came back.
  - Keyboard picking (arrows, then Enter) with the focus tooltip; two-step cancel on `/bookings`.
  - Mobile: the sticky bar, the limit hint, and the result notice scrolling into view.
  - `GET /shows/:id/audit` stayed `ok` on all three shows, and the server logged no errors.

**Fixed while testing**

- A mouse click focused the canvas and drew the keyboard focus ring on A1. The ring now follows `:focus-visible` (or a key press).
- The header wrapped at ~780px ("My bookings", "Signed in as …" broke across lines), and at 375px it pushed "Sign out" off-screen.
- The "Held B3, confirm within 10 seconds" notice outlived the hold. It now disappears once that hold is confirmed, released or lapses.
- On phones, the booking result and the limit message rendered below the map, out of sight. The result now scrolls into view and the limit hint shows in the bar.

**Deviations from plan**

- The session moved from localStorage-only to per tab (sessionStorage, with localStorage as the default for new tabs). This makes the plan's two-tab race possible in one browser.
- Picking seats someone else just took is handled before any request (the stream says so first). The server's 409 path remains for genuinely simultaneous requests.
- `@fastify/static` lists the build's files at startup (`wildcard: false`), so a rebuilt UI needs a server restart. That is fine for a deploy, which ships a fixed build. Noted for local work.

**Open items / needs you**

- **Phase 3b** still needs the Supabase project (Singapore) and the pooler URLs/password, plus a Render account connected to the repo.

**Commits:** see `git log`. Phase 6 is a feature commit and a docs commit.

---

## Phase 3b: Smoke deploy ✅

You created the Supabase project (Singapore) and deployed the `render.yaml` blueprint: <https://fdfs-dkyx.onrender.com>.

**Verification** (against the live URL, from India)

- `/healthz` and `/readyz` 200 in ~0.25s; `/app/` served with its CSP; `GET /shows` from Supabase.
- **1k mini-burst** (100 in flight, 500 seats, 20% of requests on 5 hot seats): 294 created, 706 `seat_taken`, **0 5xx, 0 network errors**. About 75 req/s; p50 1.2s, p95 2.0s, p99 2.7s. `invariant_ok` and `/audit` were both green.
- **4k burst** (400 in flight): about 105 req/s; p50 4.2s, p99 7.1s. Again **0 5xx**, and the audit was green. Its 294 × 422 `idempotency_key_reused` were correct. The script reused run 1's users and keys against a new show, and the request fingerprint includes the show, so a reused key with a different request is refused.
- Throughput is CPU-bound on the 0.1-CPU free instance. Every step is latency, never errors: "slow is fine, 5xx is not" holds. Phase 8 tunes this.

**Deviations from plan**

- `npm run test:remote` was **not** run against Supabase. It is the live database, and the suite creates non-ephemeral test shows that would clutter the live show list. Burst shows from the mini-bursts are ephemeral (the janitor deletes them after 24h). The same suite runs on Postgres 17 in CI and behind PgBouncer in the compose job.
- The bursts created their show directly in the database: `ADMIN_API_KEY` exists only in Render (`generateValue`). Memory could not be read on Render without the dashboard; Phase 7's `/metrics` and War Room now expose RSS publicly.

**Open items / needs you**

- To run `scripts/smoke.sh` against the live URL, pass the admin key from the Render dashboard: `scripts/smoke.sh https://fdfs-dkyx.onrender.com <ADMIN_API_KEY>`.

---

## Phase 7: Observability + War Room ✅

**Deliverables**

- [x] `server/src/obs/metrics.ts`: a Prometheus registry on `@prometheus-io/client` (prom-client was renamed and deprecated).
  - One recording call per event feeds the Prometheus instrument, the `/ops/summary` totals, and the open second of the time series together.
  - `fdfs_reserve_responses_total{outcome}` covers every reserve response: `created`, `replayed`, or the error code the client saw. It is recorded once, in the shared `onResponse` hook.
  - Plus the plan's counters (confirmed, held, declined by reason, cancelled, holds expired, seats released, spoof ignored, invariant violations, audits, DB retries, shed) and latency histograms by outcome and by route template.
  - Gauges: DB calls in flight vs pool size, admission, streams, readiness, `fdfs_seats{show,status}` from the reconciler's last audits, and job last-success and failure counts. Node's default process and event-loop metrics are included.
- [x] `server/src/obs/timeseries.ts`: one point per second for 10 minutes.
  - Reserve outcomes, HTTP status classes, and confirmed/held/cancelled/expired.
  - Reserve latency p50/p95/p99, from a 1,024-sample reservoir per second.
  - The peak of DB calls in flight during the second, plus sampled gauges.
- [x] `server/src/obs/logbuffer.ts` + `logger.ts`: one process logger (pino multistream) writes to stdout and to a ring of 2,000 lines plus 500 warn/error lines.
  - Public lines are an allow-list of fields with stacks dropped, on top of pino's redaction.
  - Query by `after`, `request_id`, `level`, `limit`.
- [x] `server/src/obs/opshub.ts`: one 1s timer closes the second, rebuilds the summary, and pushes one `tick` per second to every `/ops/stream`. `hello` on connect carries 5 minutes of history. It caps 50 dashboards and drops one that stops reading. The wire types live in `obs/types.ts`, shared with the UI.
- [x] Routes (`server/src/http/routes/ops.ts`): `GET /metrics`, `/ops/summary`, `/ops/timeseries`, `/ops/logs`, `/ops/stream`. All are ops routes: no admission slot and no access-log line.
- [x] Wiring:
  - reserve and lifecycle routes record outcomes, spoofs and DB retries (via the engine's `onRetry` hook);
  - the sweeper reports releases and expiries, and the reconciler reports every audit;
  - `Periodic` exposes last success and consecutive failures;
  - `Readiness.peek()` reads the cached verdict without probing.
- [x] **War Room** (`/app/war-room`, nav "War Room" / "Ops" on phones):
  - headline tiles: invariant, reserve req/s, confirmed, p99, 5xx, DB pool;
  - charts (dependency-free SVG `TimeChart`, crosshair tooltip, arrow-key stepping, table twin): reserve outcomes per second (stacked), latency (ordinal ramp, direct labels), DB in flight vs a pool-size line, event-loop lag, memory;
  - the reconciler's verdict per show with its arithmetic, and job health;
  - a log tail: level filter, pause, click a request id to follow that request (its older lines are fetched from the server).
  - Palettes were validated with the dataviz validator on the dark surface. Outcomes: worst adjacent CVD ΔE 8.4, normal vision 19.3, all ≥ 3:1. Latency: monotone ordinal ramp.
- [x] `ops/`: `prometheus.yml`, `alerts.yml` (11 rules: page on invariant violation, any 5xx, target down, not ready, stalled sweeper/reconciler; ticket on p99 > 5s, pool saturation, shedding, loop lag, memory), Grafana datasource + dashboard provisioning, and the generated "FDFS overview" dashboard. `docker compose --profile obs up -d` runs Prometheus v3.15.0 and Grafana 13.2.3.
- [x] CI:
  - `promtool check config` (config + rules) and `docker compose --profile obs config`;
  - the compose job starts Prometheus, waits for the app target to be `up`, and checks that the alert rules loaded.
- [x] `scripts/smoke.sh` now also checks `/metrics` (created reserves counted, 0 violations), `/ops/summary` (invariant ok) and that the log tail holds the spoofed request's warning.

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅ · `npm run build` ✅
- `npm test` ✅: 25 files, 287 tests (+21)
  - **The phase check** (`test/api/ops.test.ts`): a concurrent mixed burst runs while the seat map is polled. It covers a hot seat, a spread, one user ×6 at limit 2, same-key retries, key reuse, a spoof, an unknown seat, an unknown show, no token and no key. Every snapshot during the burst reconciles. For each of the 9 outcomes, the delta of `fdfs_reserve_responses_total` equals the count clients observed, and the total equals the request count. Declined-by-reason, confirmed, spoof and histogram counts agree. Reserve 5xx = 0. After a reconciler tick: `fdfs_invariant_violations_total` 0, `fdfs_seats` equals the DB counts, and `/ops/summary` says `invariant_ok`.
  - The hold lifecycle counts each transition once (repeat confirm or cancel adds nothing), and the sweeper's expiries are counted.
  - Route labels are templates: no show id ever appears in `/metrics`, and ops routes are never counted.
  - `/ops/timeseries` points, and the `/ops/stream` `hello` + `tick` frames over real HTTP.
  - Log tail: a request's lines found by its `x-request-id` (spoof warning + request line), nothing that looks like a token, ops traffic never logged, the level filter, and a bad level → 400.
  - Unit: time-series rollover, peak tracking, bounds, reservoir sampling, window latency. Log buffer: capacity, paging, filters, field allow-list, stack stripping, warn/error lines surviving request noise, the real pino logger's redacted lines.
- **Local burst against the production bundle:** 2,350 mixed reserves. The load script's observed outcomes and `/metrics` agreed exactly (684 created, 1,373 `seat_taken`, 166 `per_user_limit`, 87 key reused, 28 unknown seats, 12 replays). 0 violations, 0 5xx.
- **Visual check** in the browser pane (1280×900 and 375×812, no horizontal scroll) while that load ran: tiles, all five charts with tooltips, verdicts, jobs, and the request filter.

**Fixed while testing**

- Under load (~300 lines/s), the 2,000-line ring covered seconds, so a clicked request's lines were already gone. Warn/error lines now have their own ring, and the page keeps the lines it already held for that request.
- The first `tick` after `hello` could repeat log lines; duplicate React keys then left stale rows of another request in the filtered view. The client now appends only newer `seq`s.
- Event-loop lag included the monitor's 20ms sampling interval (an idle loop read ~20ms); it is now subtracted.
- Tile captions truncated at six columns; the pool-size label sat on top of the live data; the latency labels vanished whenever the last second had no reserves; x-axis labels collided on phones.
- **Found on the live deploy:** `fdfs_ready` read 0 on a healthy instance. Nothing had probed readiness yet (Render's health check is `/healthz`), and an unset gauge exports 0, so `FDFSNotReady` would have paged falsely. The gauge now runs the same 1s-cached probe as `/readyz` at scrape time, and a test asserts it reads 1.
- Local tooling: `.pg/serve.sh` now pins `DATABASE_URL_SESSION` too. With real Supabase URLs in `.env`, migrations otherwise went to Supabase (a no-op there) while the app used the empty local DB.

**Deviations from plan**

- `@prometheus-io/client` instead of `prom-client` (renamed upstream; the old package is deprecated).
- The log tail streams over the War Room's `/ops/stream`, not `/stream?logs=1`: one feed for dashboards, and the seat-map stream stays seat-only.
- Pool saturation is "DB calls in flight vs pool size", measured around each request-path call: postgres.js exposes no pool statistics.
- Alert rules are checked with `promtool check config` rather than `promtool test rules`: annotations with templated values make exact-match rule tests brittle.

**Open items / needs you**

- **Pushing this phase redeploys the live service** (`autoDeployTrigger: commit`). The War Room is then at <https://fdfs-dkyx.onrender.com/app/war-room>.
- Supabase's free tier pauses after 7 idle days. The keepalive cron is in the Phase 9 plan; until then, any visit to the live URL keeps it awake.

**Commits:** see `git log`. Phase 7 is a feature commit and a docs commit.

---

## Phase 7 follow-up: War Room charts on TradingView Lightweight Charts ✅

You asked for the charts to use [Lightweight Charts](https://www.tradingview.com/lightweight-charts/).

- `TimeChart` keeps its props and renders with `lightweight-charts` 5.2:
  - outcomes are stacked areas, drawn top of the stack first so each lower layer paints over it;
  - latency lines label their latest value on the price axis;
  - the pool size is a price line;
  - the y axis starts at zero with a floor (`minMax`) and room over the reference line.
- `warroom/chartData.ts` gives the window one slot per second. A missing second is whitespace, so lines break across gaps; the library spaces bars by index, so this also keeps x proportional to time.
- Canvas colors are resolved from the theme tokens (OKLCH) by painting one pixel.
- The window is live, so scroll and zoom are off (page scrolling passes through on phones). The crosshair tooltip, arrow-key stepping and the table twins are unchanged.
- The War Room route is lazy-loaded: the main bundle stays at 366 kB, and the chart library ships only in the War Room chunk (191 kB, 62 kB gzipped).
- Attribution (Apache-2.0): the NOTICE text sits in `TimeChart.tsx`, and the page carries one "Charts by TradingView Lightweight Charts™" link instead of a logo inside each of the five plots, where it covered data.

**Verification:** typecheck, lint, format, `npm test` (+8 tests for the slot builder and the y-axis top). Visual check in Chromium under load at 1280×900 and 375×812: no console errors, no horizontal scroll, hover tooltips and keyboard stepping work.

---

## Phase 8: Burst CLI + Stampede simulator + tuning ✅

The previous session ended after Phase 7's commits; nothing of Phase 8 had been started, so it began fresh.

**Deliverables**

- [x] `scripts/burst/core.ts`: the burst engine, shared by the CLI and the simulator. It uses only fetch, `crypto.randomUUID` and `performance.now`, and never prints.
  - Creates an ephemeral show (2,000 seats, limit 4, confirm mode, so every expectation is exact) and batch-mints tokens.
  - Fires the scenarios interleaved through one bounded pool (256 in flight by default): hot-seat storm (500 users on A12 + 5), Zipf stampede (20k requests, 5k users, 20% pairs), same-key copies (100 × 5), key reuse (50), one user over the limit (20 × 10 parallel), crossed pairs (50), spoofed `user_id` (50), foreign cancel (50).
  - Every scenario except the stampede and the storm gets its own seats and users, so its outcome is exact.
  - 429, 503 and network errors are retried with the same key, honoring `Retry-After`. A replay after a failed attempt counts as that attempt's booking.
  - Polls `GET /shows/:id` during the run: every snapshot must balance, and sold seats never decrease.
  - Afterwards it checks: the final map equals every grant; no seat in two reservations; nobody over the limit; the audit; each scenario's exact result; `fdfs_reserve_responses_total` deltas equal the observed outcomes.
  - Every request carries `x-request-id`; the five slowest are reported, for the War Room's log tail.
- [x] `scripts/burst/burst.ts` (`npm run burst -- <URL>`): flags for size, concurrency, `--small`, `--no-metrics`, `--json`; progress every 2s; the report; **exit 1 on any violation**. Also `scripts/burst/burst.sh` and a `Makefile` (`make burst URL=...`).
- [x] **Stampede simulator** (`/app/stampede`, nav "Stampede" / "Sim"): crowd, requests, hot-seat storm, same-key and spoof shares, over-limit users, edge cases and concurrency as settings. It shows the live hall filling over the seat-map stream, progress with outcome counts, then the verdict, the outcome bar and every check. The outcome palette moved to `warroom/outcomes.ts` so both pages color outcomes alike.
- [x] Tuning, all measured with the server in a 0.1 CPU / 512 MB cgroup (the free tier's ~90 req/s reproduced) and Postgres unthrottled, as on Render + Supabase:
  - `--max-semi-space-size=16` (Dockerfile): CPU per reserve ≈620 → ≈400 µs, from cgroup `cpuacct` over 3 × 2,500 requests per variant, repeated. Capping the heap at 384 MB had shrunk V8's young generation. 64 MB was no better and cost ~55 MB of RSS.
  - Listen backlog 4096: at 2,000 in flight the default 511 overflowed (`ListenOverflows` 34k), and the kernel reset connections ~15s later (16 `ECONNRESET`). After the fix: 0.
  - `MAX_QUEUE` 20,000 → 8,000. Peak RSS was 172 MB at 4,000 in flight against 102 MB idle (~17.5 KB per request), so 20k in flight could approach 512 MB.
  - Adaptive `Retry-After`: in flight ÷ the last 5s completion rate, 1–30s.
  - The DB deadline decides one loop turn after its timer (`setImmediate`, after the I/O poll).
  - Kept: info logging (~9 µs a line, benchmarked); DB pool 20 (CPU-bound, not pool-bound).
- [x] CI: the compose job throttles the app container (`docker update --cpus 0.1 --memory 512m`), runs the full 20k burst through PgBouncer, uploads `burst-report.json`, asserts the container was not OOM-killed, then drains it on SIGTERM while throttled.

**Verification**

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅ · `npm run build` ✅
- `npm test` ✅: 27 files, 308 tests (+13 since the chart follow-up)
  - `test/burst/burst.test.ts`: a scaled run of every scenario against the real app over HTTP passes every check, including the metrics diff. Against a fake server that grants everything, exactly the checks it breaks fail. Plus the seat plan, the Zipf sampler, quantiles and the metrics parser.
  - `Retry-After` follows in-flight ÷ completion rate and forgets an old rate.
  - The deadline race, reproduced with a real socket: the reply lands, the loop stays busy past the deadline, and the call must still resolve. It fails without the fix.
- **`npm run burst -- http://localhost:8080`, unthrottled:** 21,550 reserve requests in 19s (1,119 req/s), p99 472ms, 0 5xx, all 16 checks green, metrics equal on all 5 outcomes.
- **The same, throttled to 0.1 CPU / 512 MB, after tuning:** 21,550 requests in 118s (**182 req/s**), p50 1.19s, p99 3.10s, **0 5xx, 0 network errors**, 69 balanced snapshots, all checks green. Before tuning the same setup managed ~90–100 req/s, with p99 10–20s.
- **CI, the Docker image throttled to 0.1 CPU / 512 MB, through PgBouncer:** 21,550 requests in 206s (105 req/s, the CI runner's slower CPU), p50 2.1s, p99 6.1s, **0 5xx, 0 network errors**, every check green, metrics equal on all 5 outcomes, not OOM-killed. Fail-closed and the SIGTERM drain then pass while still throttled.
- **2,000 and 4,000 in flight, throttled:** 0 5xx, 0 network errors, all checks green; peak RSS 150 / 172 MB.
- **Overload (`MAX_QUEUE=500`, 2,000 in flight, throttled):** before the two fixes, 770 503s among admitted requests, and seats sold that the client never learned of (it didn't retry 503s yet). After: **0 5xx**, 687 shed with 429 and retried, every guarantee held.
- **Simulator** in Chromium at 1280×900 and 375×812: 3,540 requests from the browser at ~500 req/s, the hall filling live, 16/16 checks passed, no horizontal scroll.

**Found and fixed**

- **Overload turned into 503s.** A 429 retry storm starved the admitted requests, and a due deadline timer ran before the poll that would have delivered their answers. Fixed by the adaptive `Retry-After` and by the deadline deciding after the poll.
- **Found by CI's throttled burst** (the image behind PgBouncer): 5–10 of ~21,560 requests got 503 `db_unavailable`, while every booking guarantee held and the client's same-key retries succeeded.
  - First hypothesis: the deadline firing on calls queued behind a cold pool on a starved CPU. That led to a real improvement: the deadline now consults `DbProgress` (when the database last answered a request-path call). It keeps waiting while the database answers others, up to 6 deadlines (60s), and still fails at 10s when nothing has answered lately. Tested: busy, silent, cap. But CI still failed, and the hypothesis could not be reproduced locally, even with PgBouncer + SCRAM, a cold pool, 0.05 CPU and a database restart.
  - So the burst learned to name the server-side cause of any 5xx: it reads `/ops/logs?level=error` for the burst's own window. CI then answered: `08P01 server login has been failing, cached error: server DNS lookup failed (server_login_retry)`. The fail-closed step had just stopped and restarted Postgres, and for `server_login_retry` (15s) after a failed login PgBouncer refuses new server connections. The burst's first wave needed fresh ones about 14s later.
  - The app's 503 was correct there: the pooler reported a database it had just seen die. The fix is the CI order: the throttled burst now runs on a healthy stack, before the outage test, which then runs throttled.
- **The image build missed the shared engine:** the simulator imports `scripts/burst/core.ts`, which the Dockerfile didn't copy. Reproduced with the build stage's exact file set and fixed.
- **The 2,000-connection accept-queue overflow** (listen backlog).
- **The young-generation squeeze** from the heap cap.
- In the burst itself:
  - an abort-listener leak in `sleep`;
  - undici caps listeners on a shared signal (so the signal is no longer handed to each fetch);
  - 503s must be retried with the same key, or a committed booking looks like a seat "sold but never granted".

**Deviations from plan**

- The CI throttle uses `docker update` on the compose stack's app container, not a separate `docker run --cpus=0.1`: one image, through PgBouncer, plus the drain step while throttled.
- The local throttled runs used a cgroup around the built server, not the Docker image: the sandbox could start Docker but could not install Alpine packages through its proxy. CI runs the image.
- `MAX_QUEUE` default lowered and `Retry-After` made adaptive: both changes are written into Plan.md.

**Open items / needs you**

- **The live burst is Phase 9:** `npm run burst -- https://fdfs-dkyx.onrender.com --admin-key <ADMIN_API_KEY>`, with the key from the Render dashboard. Pushing to the deployed branch also redeploys the tuned image.
- The simulator needs the admin key too, because it creates a show. Anyone with the key can create shows, but they are ephemeral (deleted after 24h) and capped at `MAX_SEATS_PER_SHOW`.

**Commits:** see `git log`. The chart follow-up is one feature commit; Phase 8 is a tuning commit, the burst, the simulator, the CI job and a docs commit.
