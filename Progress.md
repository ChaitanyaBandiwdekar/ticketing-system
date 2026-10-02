# Progress

Phase-by-phase tracker for [`Plan.md`](Plan.md). Every phase ends with its checks run, this file updated, a commit, and a **hard stop** until the go-ahead ("continue").

| Phase | Scope                                   | Status         |
| ----- | --------------------------------------- | -------------- |
| 0     | Foundation                              | ✅ done        |
| 1     | Core engine I: atomic reserve           | ✅ done        |
| 2     | Core engine II: lifecycle + audit       | ✅ done        |
| 3     | API service                             | ⬜ not started |
| 3b    | Smoke deploy (Render free + Supabase)   | ⬜ not started |
| 4     | Realtime layer (SSE, jobs)              | ⬜ not started |
| 5     | UI I: shell + shows                     | ⬜ not started |
| 6     | UI II: live hall                        | ⬜ not started |
| 7     | Observability + War Room                | ⬜ not started |
| 8     | Burst CLI + Stampede simulator + tuning | ⬜ not started |
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
