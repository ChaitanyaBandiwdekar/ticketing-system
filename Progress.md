# Progress

Phase-by-phase tracker for [`Plan.md`](Plan.md). Every phase ends with its checks run, this file updated, a commit, and a **hard stop** until the go-ahead ("continue").

| Phase | Scope                                   | Status         |
| ----- | --------------------------------------- | -------------- |
| 0     | Foundation                              | ✅ done        |
| 1     | Core engine I: atomic reserve           | ⬜ not started |
| 2     | Core engine II: lifecycle + audit       | ⬜ not started |
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
