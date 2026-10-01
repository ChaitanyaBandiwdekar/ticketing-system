# FirstDayFirstShow (FDFS)

> Assigned-seat reservations that stay correct when the whole city storms the first show.

A take-home for Paytm Money's _Deploy & Observe_ round. It sells numbered seats for a show and is built to keep these guarantees under a burst of 20k concurrent requests:

- no seat is sold twice
- no user goes over their limit
- an idempotent retry never charges twice
- no 5xx responses

The service is deployed and observable, with a live seat map, a War Room ops dashboard, and a stampede simulator.

> **Status:** under construction, built phase by phase. See [`Plan.md`](Plan.md) for the design and [`Progress.md`](Progress.md) for where things stand.

## Quick start (local)

Requires Node ≥ 20.19. Docker is **not** required: tests boot an embedded Postgres 17 automatically.

```bash
npm ci
npm test
```

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm test`             | Full suite against an embedded Postgres 17 (or `TEST_DATABASE_URL`) |
| `npm run typecheck`    | `tsc --noEmit`                                                      |
| `npm run lint`         | ESLint, zero warnings allowed                                       |
| `npm run format:check` | Prettier check                                                      |
| `npm run db:migrate`   | Apply SQL migrations to `DATABASE_URL_SESSION` (or `DATABASE_URL`)  |

Configuration is documented in [`.env.example`](.env.example). Copy it to `.env` for local runs.

## Repository layout

```
server/src/     Fastify service (config, db, engine, http, observability, jobs)
db/migrations/  Forward-only SQL migrations (schema + PL/pgSQL decision functions)
web/            Vite + React UI (served under /app)
scripts/        Burst / stampede tooling
test/           Concurrency, property and API tests (real Postgres)
docs/           AI usage log and supporting notes
```
