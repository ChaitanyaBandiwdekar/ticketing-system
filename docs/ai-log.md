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

## Phase 4: Realtime layer

**AI implemented:** the event bus, the SSE hub, the stream route, the jobs (Periodic runner, sweeper, reconciler, janitor + maintenance SQL), the request deadline, and all tests (stream, jobs, deadline), with no subagents. It checked Fastify 5's `reply.hijack()` / `onResponse` / `preClose` semantics against the docs (Context7) and the PgBouncer image's `QUERY_WAIT_TIMEOUT` support against its entrypoint script.

**Decisions made during the phase:**

- Events are hints and the hub re-reads the truth through a per-show serialized queue. Forwarding event payloads last-write-wins would diverge when two commits on one seat are acknowledged to Node in the opposite order.
- Streams bypass admission control and have their own cap.
- A DB deadline on every request path, after diagnosing the CI fail-closed timeout (PgBouncer queueing for a stopped Postgres). The AI diagnosed the CI failures from the public check-run annotations (exit codes 126 and 28), since job logs need repo-admin access.
- A flaky convergence assertion was traced to counts leading the seat map by one window. The test was fixed and the behaviour documented, rather than retrying the test.

**Human:** said to continue and finish today, keeping quality up. The phase's hard stop was folded into that instruction: Phase 3b is blocked on credentials, so work moved on to Phase 4.

## Phase 5: UI I (shell + shows)

**AI implemented:** `PRODUCT.md`, the design pass (dark theme, type, components), the SPA (shell, demo login, shows list, create-show with the hall generator, the static show page), the canvas hall modules, the `layout` column, static serving under `/app/`, and all tests. No subagents were used. The visual check ran in the built-in browser pane at desktop and mobile widths against the production bundle.

**Decisions made during the phase:**

- The admin key is kept in sessionStorage only, and the user token in localStorage.
- Static files bypass admission control and the access log, as health checks do. A test holds the only admission slot open to prove it.
- A missing asset is a JSON 404, not the SPA shell, so a stale script tag fails loudly.
- Hall geometry is optional data on the show; the engine never reads it.
- UI module tests live in `test/web/`, typechecked by the web tsconfig, so `draw.ts`'s DOM types stay out of the server's typecheck.
- A randomized test that pipes the generator into the server's validator found that the form could build layouts the API rejects (more than 50 aisles). The generator now caps each list at the API's limit.
- The missing `web/` copy in the Docker build stage was caught by reviewing the build against the Dockerfile; there is no Docker on the dev machine.

**Human:** started the phase with "continue". After a session break, asked for the Phase 5 tests (layout validation, static serving, the pure hall modules), and then for the AI to recheck whether the UI check had already been done and carry on.

## Phase 6: UI II (live hall)

**AI implemented:** the stream reducer, `useLiveShow`, canvas interaction (pointer, keyboard, glow), the booking flow with idempotent retries, the server-clock estimate, the hold countdown, My bookings (per show and `/bookings`), per-tab sessions, and all tests. No subagents were used. The visual check ran in the built-in browser pane against the production bundle, with two tabs signed in as two users.

**Decisions made during the phase:**

- The live map is a pure reducer over stream frames, mapped by label onto the hall's order. A REST read seeds it and stands in while the stream is down, but can never overwrite a live stream.
- One idempotency key per reserve attempt (per seat set), reused across automatic retries and the manual "Try again", so any retry can only replay.
- Hold countdowns run on the server's clock, estimated from `Date` headers, because `expires_at` is stamped by the database.
- Picked seats that someone else takes are dropped from the pick as soon as the stream shows it, before any request.
- Sessions are per tab, so one browser can hold two users for the race demo.
- An integration test folds the real server's frames through the UI reducer, to catch protocol drift between `hub.ts` and the UI.
- Fixed from the visual pass: the keyboard focus ring showing on mouse clicks; the header overflowing on tablets and phones; a stale "held" notice after the hold lapsed; phone notices rendering out of sight.

**Human:** said to check status and continue with the next phase while they get the Supabase and Render credentials (Phase 3b stays blocked).
