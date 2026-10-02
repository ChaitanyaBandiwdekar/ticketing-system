# AI usage log

An honest, per-phase record of how AI (Claude Code) was used. It separates what the human **directed or decided** from what the AI **proposed or implemented**. WRITEUP.md's "AI usage" section is distilled from this file.

## Planning

**Human directed / decided**

- Work in atomic phases: core engine → backend services → UI → observability/perf, then deploy. Review and commit each phase, and hard-stop between phases until told "continue".
- Stack: TypeScript, with a Fastify API and a Vite/React SPA in one container.
- Hosting: Render **free** tier, because graders cold-start the service themselves. Database: a new Supabase project in Singapore.
- Reservation model: per-show, instant-confirm by default with an optional hold TTL.
- Auth: self-issued JWT demo login.
- Local DB: embedded Postgres, with Docker verified in CI rather than on the dev machine.
- Smoke deploy after the API phase.
- Product name **FirstDayFirstShow** and the "War Room" framing.
- Asked for a pre-mortem ("poke it to see where it would break") before approving the plan, and for `Plan.md` / `Progress.md` as living documents.

**AI proposed (accepted after review)**

- The core mechanism: a single-round-trip PL/pgSQL `reserve()`.
  - A global lock order (idempotency key → per-user advisory lock → seats sorted by id → reservations).
  - A lock-free snapshot fast path for declines.
  - Derived expiry.
  - No hot counter row.
- The pre-mortem's 16 failure modes and their fixes. Examples:
  - The SPA routes collided with the spec's API paths.
  - A hot seat could park every pool connection.
  - A Render health check could pull the instance mid-burst.
  - Keep-alive timeouts could cause 502s.
  - A reserve↔cancel deadlock was possible.
- The observability design (metric set, public log ring buffer, reconciler) and the burst-script scenarios.

## Phase 0: Foundation

**AI implemented:** repo scaffold, zod config loader, postgres.js pool settings for transaction poolers, the migration runner (one transaction, advisory lock, checksum drift detection), the embedded-Postgres test harness, and CI.

**Decisions made during the phase:** tool versions were pinned to what runs on the dev machine's Node 20.19:

- vitest 4.1 instead of 5, which needs Node ≥ 22.12.
- TypeScript 5.9 instead of 7, which typescript-eslint doesn't support yet.

Production still runs Node 22 in Docker.

## Phase 1: Core engine I (atomic reserve)

**AI implemented:** the schema and constraints, `fdfs_reserve()` and its fast path, the TS wrapper and retry helper, show creation/snapshot, the concurrency suite, the fast-check stress test with an outcome model, and the invariant oracle. Routine test writing (show validation/snapshot tests) and these doc updates were delegated to a smaller model (Claude Sonnet) subagent and reviewed.

**Decisions made during the phase:**

- Declines are returned as jsonb instead of raised, and a locked-path decline deletes the key row it claimed.
- The fast path also checks the per-user limit from the snapshot, so a greedy user never takes the advisory lock.
- Every outcome reports `path: fast|locked`, for tests now and metrics later.
- Composite FK (seat → reservation of the same show and user) instead of the plain `reservation_id` FK in the plan.

**Human:** directed the phase to start ("continue") and asked for trivial work to be delegated to Sonnet subagents.

**Review (human-directed):** before building on the core, the human asked for it to be checked against industry practice. The AI researched Stripe/brandur idempotency keys, the IETF Idempotency-Key draft, the Ticketmaster hold design, and Postgres advisory-lock and MultiXact pitfalls, then compared them with the implementation. It found and fixed a hot-parent FK lock on the show row, proved first by a failing regression test. Status codes were aligned with the IETF draft (422 for key reuse), and two deviations were kept and documented, with reasons.

## Phase 2: Core engine II (lifecycle + audit)

**AI implemented:** the confirm/cancel/sweeper/audit SQL functions, the TS wrappers, the race tests, and the real-expiry randomized stress test. The routine lifecycle unit tests (16) and these doc updates were delegated to a smaller model (Claude Sonnet) subagent and reviewed.

**Decisions made during the phase:**

- Confirm is idempotent (`changed: false` on repeat), and confirming a cancelled reservation is a new 409 `reservation_cancelled`.
- The sweeper is seat-based rather than reservation-based, so a seat skipped under `SKIP LOCKED` (or left pointing at an already-finalized hold) is picked up on a later tick.
- Confirm and cancel decide lock-free first, then re-decide under the locks.

**Human:** said to commit, push and continue after the Phase 1 industry review.

## Phase 3: API service

**AI implemented:** the Fastify app, error model, auth, admission, readiness, routes, main/drain, Dockerfile, compose, smoke/fail-closed scripts, the CI compose job, and the reserve-contract API tests. It checked the current Fastify 5.12 and fast-jwt APIs against the docs (Context7) before using them, and the PgBouncer image's env contract against its entrypoint script. The auth/shows/platform API tests and the error/admission/readiness unit tests (69 tests) were delegated to a smaller model (Claude Sonnet) subagent and reviewed. It flagged that `toApiError(null)` could crash the error handler, and that was fixed with a test.

**Decisions made during the phase:**

- fast-jwt rather than a hand-rolled HS256, for its built-in verified-token cache.
- An esbuild bundle instead of a `tsc` emit, because the source uses extensionless ESM imports.
- `LogController` instead of Fastify 5.12's deprecated top-level `disableRequestLogging`/`requestIdLogLabel`.
- Fastify's default Ajv type coercion is kept, since identity never comes from the body and the engine re-validates every value.
- A `text/plain` body gets a 400 (the schema rejects it); 415 is for media types with no parser.

**Human:** said "continue" after Phase 2.
