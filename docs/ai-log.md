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

## Phase 3b: Smoke deploy

**AI implemented:** the checks against the live Render URL (health, readiness, UI headers, a 1k and a 4k mini-burst with outcome, latency and audit summaries) using a scratch script. Since the admin key exists only in Render, the script created its ephemeral show directly in the database.

**Decisions made during the phase:**

- The full test suite was not pointed at Supabase: it is the live database, and the suite's non-ephemeral test shows would clutter the live show list. CI already runs the suite on Postgres 17 and behind PgBouncer.
- The 4k run's 422s were traced to the script reusing run 1's keys for a different show: correct engine behaviour, not a bug.

**Human:** deployed the project to Render with the Supabase credentials and said to check whatever was needed and continue with the next phase.

## Phase 7: Observability + War Room

**AI implemented:** the metrics registry, the per-second time series, the log ring and process logger, the ops hub and routes, the instrumentation of routes and jobs, the War Room page and its SVG chart component, the Prometheus/Grafana compose profile, the alert rules, the CI checks, the smoke-script additions, and all tests. No subagents were used. Before adding the metrics library it checked the current client docs (Context7) and found that `prom-client` has been renamed to `@prometheus-io/client` and deprecated. It ran the dataviz palette validator on the chart colours for the dark surface. The visual check ran in the built-in browser pane against the production bundle under a scripted mixed load, at desktop and phone widths.

**Decisions made during the phase:**

- Each recording call feeds the Prometheus counter, the summary totals and the time series together, and reserve outcomes are labeled exactly as a client sees them (`created`, `replayed`, or the error code). A burst can then diff the metric against its own observations, outcome by outcome. The phase's test does exactly that.
- Ops routes skip admission control and the access log, so watching the system never shows up in what is watched; a test asserts no ops route appears in `/metrics` or the log tail.
- Public log lines are an allow-list of fields with stack traces dropped, on top of pino's redaction.
- One timer and one summary per second, however many dashboards are open.
- Found during the visual pass under load:
  - at ~300 lines/s the log ring covered seconds, so warnings and errors got their own ring;
  - repeated log lines between `hello` and the first `tick` produced duplicate React keys and stale rows in the request filter;
  - event-loop lag included the monitor's sampling interval;
  - layout fixes for tiles, the pool-size label, direct labels and phone axes.
- Alert rules are validated with `promtool check config` in CI. Exact-match `promtool test rules` was dropped as brittle against templated annotations.

**Human:** said to continue with the next phase after deploying.

## Phase 7 follow-up: Lightweight Charts

**Human:** asked for the War Room charts to use TradingView Lightweight Charts, and said the previous session had been cut off: check completeness and continue.

**AI implemented:** a completeness check (everything through Phase 7 was committed and pushed; Phase 8 had not started), then the chart swap. It kept `TimeChart`'s props, so the page barely changed, and moved the per-second slot building into a tested module. It lazy-loaded the War Room route to keep the library out of the main bundle, and checked the result in Chromium under load at desktop and phone widths.

**Decisions made during the phase:**

- Missing seconds are whitespace slots, because the library spaces bars by index: that keeps x proportional to time and breaks lines across gaps.
- Theme tokens are OKLCH and canvas needs concrete colors, so each one is resolved by painting a pixel.
- Scroll and zoom are off on a live window, so phones can scroll the page past the charts.
- One credit link on the page meets the Apache-2.0 NOTICE. The library's logo inside every plot covered data.

## Phase 8: Burst + Stampede + tuning

**AI implemented:**

- one burst engine shared by the CLI and the browser simulator, its tests (including a rule-breaking fake server that must fail the right checks), the simulator page, `burst.sh`, the Makefile and the CI throttled-burst job;
- a tuning pass with the server in a 0.1 CPU / 512 MB cgroup: CPU per request read from `cpuacct`, a V8 CPU profile, a logger micro-benchmark, RSS sampling at 2,000 and 4,000 in flight, and an overload run with a small admission cap;
- each server fix got a test that fails without it, where one was practical (the deadline race uses a real socket and a blocked loop).

**Decisions made during the phase:**

- Each exact scenario gets its own seats and users, so a result can be checked to the request ("limit": exactly 4 of 10), not just "no 5xx".
- Retries follow the API's own contract (same key, honor `Retry-After`, 503 included). A replay after a failed attempt is that attempt's booking: without that, the burst reported seats "sold but never granted" that had in fact committed.
- Tuning was driven by measurements, not guesses:
  - the A/B on logging level was noisy in wall-clock time, so CPU per request became the measure;
  - the profile's 27% in socket writes was judged a sandbox syscall artifact and not chased;
  - the GC share was real (16 MB semi-space, −35% CPU);
  - logging measured at ~9 µs a line, so the per-request line stays.
- Two failure modes surfaced only under overload, both fixed at the root: a 1s `Retry-After` that invited a retry storm, and a deadline timer that could beat an already-arrived DB reply on a saturated loop.
- `MAX_QUEUE` was lowered to 8,000 from a measured ~17.5 KB per request in flight.

**Human:** asked for the chart library and for the interrupted work to be continued.

## Phase 9: Final deploy + docs

**Human:**

- Asked how an evaluator is supposed to test the app, how the stampede simulator works, and what the admin key is for. Asked for those answers before the phase continued.

**AI:**

- Checked the live service as a grader would: healthy, but `GET /shows` was empty, and every way to get a show needed the admin key.
- Proposed and implemented standing demo shows: reopened when 90% sold, guarded by an advisory lock against overlapping deploys, with tests.
- Added the keepalive cron, the README's evaluator guide (its shell walkthrough run against the production bundle as written), and `WRITEUP.md`, distilled from the plan, the progress log and this file.
- Ran the fresh-clone check.

**Decisions made during the phase:**

- Demo shows instead of a public, keyless `POST /shows`. Show creation stays admin-only, as the spec has it, while a grader with only their own script still has a hall to burst.
- Old screenings stay listed with their books intact, rather than being reused or reset. A hall a grader sold out stays auditable.
- The live burst waits for the live admin key, which exists only in Render. It is read from a gitignored file, never from chat.

### Evaluator audit

**Human:** asked for one pass over the whole application against the assignment email, from the evaluator's side: the API contract, the UI and UX, and the other flows.

**AI:**

- Ran the spec's contract against the live URL from a script: reserve, replay, key reuse, seat taken, a partial pair, spoofed fields, a foreign cancel, over-limit, no key, no token, a cancel and rebook, counts, the audit and `/metrics`. Walked the UI in a browser.
- Found two places where the contract differed from the email's wording, and fixed them with tests:
  - A key reused with different seats answered 422, following the IETF draft. The email says 409, so it is now 409.
  - A replay answered 200. The email defines only 201 and says a retry "returns the original reservation", so a replay now returns the original 201, and the `Idempotent-Replayed` header marks it. The burst and the smoke test now read the header instead of the status code.
- Found that `fdfs_seats` was empty on an idle instance: only shows with recent activity were audited. The open demo halls are now pinned into the reconciler.
- Found that `GET /shows/:id` could answer up to 250 ms behind a client's own 201. Every write now drops the show's cached snapshot, and a generation stamp keeps a read that raced a commit out of the cache.
- Added `/health` and `/ready` as aliases, for probes that expect those names.
- Found that the 2,000-seat hall overflowed the desktop panel by 74 px, which hid the right-hand block behind a scrollbar. The 14 px minimum seat pitch is now used only for coarse pointers.
- Stated the all-or-nothing rule for multi-seat requests explicitly in the README and the write-up, and spelled out the admin key's header with a `curl` example.

**Decisions made during the audit:**

- Replays return 201, not 200 (the human chose this). It is the reading of the email that's safest against a grader's script, and it is how Stripe-style replays behave.
- The live 20k burst is run by the human with the live admin key, after this redeploys.
