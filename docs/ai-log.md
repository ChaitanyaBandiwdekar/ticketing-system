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
