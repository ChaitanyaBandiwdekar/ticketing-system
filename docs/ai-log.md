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
