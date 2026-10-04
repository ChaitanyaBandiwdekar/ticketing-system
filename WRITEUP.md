# FDFS write-up

How FirstDayFirstShow keeps its guarantees under a stampede, what happens when things break, what pages someone at 2am, how AI was used, and what comes next. [`README.md`](README.md) covers running and testing it; [`Plan.md`](Plan.md) has the full design and the pre-mortem.

## The guarantees, and how they are shown

| Guarantee                              | Enforced by                                                                                                  | Shown by                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| No seat sold twice                     | One row per seat; a conditional update under row locks taken in one global order                             | Burst: final map equals every grant; `fdfs_invariant_violations_total` 0                 |
| `available + held + confirmed = total` | Seats are never inserted or deleted after creation, so the counts are a partition of fixed rows              | Every `GET /shows/:id` derives seats and counts from one snapshot; the reconciler audits |
| Nobody over the per-user limit         | A per-(show, user) advisory lock around an exact count                                                       | `audit()`; the burst's `limit` scenario books exactly 4 of 10, per user                  |
| A retry never books twice              | Idempotency keys scoped per user, with a request fingerprint, claimed in the same transaction as the booking | The burst's `retry` and `keyreuse` scenarios                                             |
| Identity only from the token           | The JWT `sub`; a body `user_id` is ignored and counted                                                       | `fdfs_identity_spoof_ignored_total`; the burst's `spoof` scenario                        |
| No 5xx                                 | Load is shed as 429 with `Retry-After`; a 503 means only an unreachable database; nothing else is a 5xx      | The 20k burst at 0.1 CPU in CI on every push: 0 5xx, 0 network errors                    |

Measured with the server held to Render's free tier (0.1 CPU, 512 MB):

- **Locally:** 21,550 checked reserve requests at ~180 req/s, p50 1.2s, p99 3.1s, 0 5xx.
- **CI:** the Docker image behind PgBouncer, on a slower runner: ~105 req/s, p99 6.1s, 0 5xx, not OOM-killed.
- **Live:** the smoke deploy took 1k and 4k bursts with 0 5xx and a green audit.

## The atomic decision

A reservation is decided by one PL/pgSQL function, `fdfs_reserve()`, called as a single `SELECT`. The statement is its own transaction: no BEGIN/COMMIT round trips, and locks are held for microseconds.

1. **Lock-free snapshot.** One statement reads the user's idempotency key, the requested seats, and the user's active seat count, all in the same snapshot. It answers most requests outright:
   - replay, or key reused with different seats (409);
   - unknown seats;
   - over the limit;
   - a seat already taken.

   Such a decline is linearizable: at that instant the seat really was taken. This is what keeps a 500-user storm on seat A12 from parking every pool connection behind A12's row lock. After the first commit, the losers decline without locking anything.

2. **Claim the key:** `INSERT … ON CONFLICT DO NOTHING`. An in-flight duplicate waits on the unique index, then replays.
3. **Per-(show, user) advisory lock,** then an exact count of the user's active seats against the limit.
4. **Lock the seats,** sorted by id, `FOR UPDATE`. Re-check them all, insert the reservation, update the seats.

**Multi-seat requests are all or nothing.** If any requested seat is taken, nothing is booked and the 409 `seat_taken` lists the taken seats in `unavailable_seats`. Under concurrency this holds because steps 1 and 4 check the whole set, and step 4 holds every seat's lock while it writes them. A buyer asking for a pair wants the pair; the UI then offers to book just the seats that are still free.

**Deadlock freedom comes from one global lock order:** idempotency key → per-user advisory lock → seats by id → reservation rows. Every writer follows it: reserve, confirm, cancel, the sweeper, and the janitor. Two details make the order hold:

- Reserve never touches another user's reservation row. Taking over a lapsed hold rewrites only the seat; the old reservation reads `expired` by derivation.
- Confirm and cancel lock the seats before the reservation.

The crossed-pairs tests (`[X,Y]` against `[Y,X]`, hundreds at once) run with zero deadlock retries.

**There is no hot row.** No counter is updated per booking. Also, the `reservations.show_id` foreign key was dropped in review: every child insert took `FOR KEY SHARE` on the one show row, a known MultiXact cliff. A regression test proves reserve never locks the show; before the fix it blocked for 2.8s.

**Declines are returned, not raised.** A stampede produces no exceptions and no Postgres ERROR lines. A locked-path decline deletes the key it claimed, in the same transaction, so only successes consume a key.

## Idempotency

- Keys are scoped per user: `(user_id, key)`. One user's key can't replay another's booking.
- The request fingerprint is a sha256 of the show and the sorted seat set. The same key with different seats is a 409 `idempotency_key_reused`, as the spec asks (the IETF Idempotency-Key draft would use 422).
- A replay returns the original response: 201 and the original reservation, with its _current_ status. `Idempotent-Replayed: true` tells a client that nothing new was booked.
- A duplicate that arrives while the original is in flight waits for it and replays; it does not get a 409. The original takes milliseconds, so waiting is cheaper than a 409 and a client retry loop.
- A decline doesn't consume the key. A retry after `seat_taken` is evaluated again, which can never double-book.
- Keys expire after 24h (the janitor). A retry after that is a new request.
- A request without a key gets a fresh server key: it is booked or declined on its own, exactly like a keyed one, but a retry of it can't be recognised. A 400 instead would turn a keyless crowd into zero bookings.

The client side matters as much. The UI and the burst reuse a key for every retry of the same seat set: after a timeout, a 429, or a 503. That closes the one gap a deadline opens: a call abandoned at the deadline may still commit, and the same-key retry then replays it instead of booking again.

## Holds

Shows run in one of two modes:

- **Instant (the default, the spec's contract):** reserve → `confirmed`.
- **Hold:** `hold_ttl_seconds` set. Reserve → `held` → confirm before the deadline, or the hold lapses.

Expiry is **derived from the database clock**. A seat is free if it is available, or held with `held_until < now()`. No timer has to fire for a lapsed seat to be sellable, and no app clock is ever consulted.

The sweeper is cleanup, not correctness. It finalizes lapsed holds with `SKIP LOCKED` (so it never waits on a request) and publishes the freed seats to the live maps. A late confirm or cancel of a lapsed hold answers 409 `reservation_expired`. Every seat write is guarded by `reservation_id = <this one>`, so a late call can't touch a seat that was re-sold.

## Under partition: consistency over availability

Postgres is the only source of truth. No cache ever decides a seat. When the database is unreachable, the service refuses rather than guesses:

- **Writes** answer 503 `db_unavailable` with `Retry-After`. Every request-path DB call has a deadline (10s), so a database behind a pooler that silently queues becomes a fast 503, not a hang. CI found this case: PgBouncer queued queries for 120s while Postgres was stopped.
  - The deadline fails a _silent_ database, not a _busy_ one. If the database answered any other call within the window, the call keeps waiting, up to six deadlines. At 0.1 CPU a burst's first wave can queue for 20s, and that must stay slow, not turn into errors.
- **Reads** answer 503 too. The 250 ms micro-cache on `GET /shows/:id` only spares the CPU of serializing; it doesn't serve stale maps through an outage. Every write drops the show's entry, so a client reads its own booking right after the 201.
- **`/readyz`** fails closed on its own one-connection pool. **`/healthz`** stays 200, so the platform doesn't restart a healthy process because its database is away.
- **The live maps** keep their last state. The page says "Reconnecting", polls the REST read every 5s while the stream is down, and converges again on reconnect.

CI proves all of this on every push: it stops Postgres under the running stack, expects `/healthz` 200, `/readyz` 503 and reserve 503 within seconds, restarts it, and expects recovery.

With more than one instance, correctness doesn't change: every decision is in Postgres. What is per-instance today:

- **The SSE fan-out.** A delta reaches the viewers on the instance that took the write; the others converge on their periodic full resync.
- **The metrics**, which Prometheus sums.

## Overload: slow is fine, 5xx is not

A free instance has 0.1 CPU. A 20k burst can't be fast there, but it can stay correct and error-free:

- **Admission control.** Past 8,000 requests in flight, a request is shed with 429. Its `Retry-After` is the in-flight count divided by the recent completion rate, so retries arrive as capacity frees up instead of as a storm. The 8,000 cap comes from a measured ~17.5 KB of memory per request in flight against 512 MB.
- **One round trip per decision**, compiled JSON schemas and serializers, verified JWTs cached, one log line per request.
- **Tuning found by throttled bursts, not guessed:**
  - a 16 MB V8 semi-space: −35% CPU per reserve, because the heap cap had squeezed the young generation;
  - a 4096 listen backlog: the default 511 overflowed into connection resets ~15s later;
  - a deadline that decides after the I/O poll: on a saturated loop a due timer could beat a reply that had already arrived.
- **The burst names the cause of any 5xx** from the server's own error log. That is how CI's last 503s were traced to PgBouncer refusing logins for 15s after the outage test restarted Postgres. That 503 was correct; the CI order was the bug.

## The 2am pages

[`ops/alerts.yml`](ops/alerts.yml) splits alerts into pages (wake someone) and tickets (morning).

**Page:**

- **`FDFSInvariantViolation`:** the reconciler found books that don't balance. This should be impossible by construction, so it means a bug or a manual edit. Freeze the show, then read the audit.
- **`FDFSServerErrors`:** any 5xx. The design maps every expected failure to a 4xx or a 503 with `Retry-After`, so a 5xx is a bug. A burst of 503s means the database is gone.
- **`FDFSTargetDown`** and **`FDFSNotReady`:** customers can't buy, or soon won't be able to.
- **`FDFSSweeperStalled`:** lapsed holds stop being finalized. Seats stay sellable (expiry is derived), but the live maps and the counts drift.
- **`FDFSReconcilerStalled`:** the one check that proves the books has gone quiet.

**Ticket:** p99 over 5s, the pool saturated for 5 minutes, sustained shedding, event-loop lag, memory. These are slowness, which the design accepts under a stampede, and capacity to plan.

Pages are deliberately few, and each is either a broken promise or a broken proof.

Everything an on-call engineer needs is public and free on the free tier:

- `/metrics`
- the War Room
- `/ops/logs`, a redacted ring buffer of recent lines, filterable by `request_id`

A request can be followed from the client's `x-request-id` to its log lines.

## What comes next

- **Horizontal scale.** Fan seat changes out across instances: Postgres `LISTEN/NOTIFY` on a session connection (the transaction pooler can't carry it), or a small broker. Then autoscale on admission in flight.
- **A waiting room in front of the hottest shows.** Admit buyers at the rate the hall can take, and show a position instead of a 429.
- **Payments.** A hold is the right shape for a payment window. Confirm would move behind a payment intent, with an outbox so a paid hold can never lapse unconfirmed.
- **A real identity provider.** The demo login and the open token mint go; the per-user limit then follows real accounts, and the mint is replaced by test fixtures.
- **Per-user rate limits** alongside the per-show limit.
- **Durable telemetry.** Ship metrics and traces (OpenTelemetry) to a hosted backend; the 10-minute in-memory window and log ring are a free-tier stand-in.
- **Longer soak and chaos runs:** kill the instance mid-burst, cut the pooler, and play with clock skew.

## How AI was used

Claude Code wrote most of the code. The human directed the work and made the decisions; [`docs/ai-log.md`](docs/ai-log.md) records both sides, phase by phase.

**The human directed or decided:**

- The working protocol: atomic phases from core engine to API to UI to observability, a review and a commit per phase, and a hard stop between phases.
- The stack (TypeScript, Fastify, React in one container) and the free hosting (Render + Supabase, both in Singapore).
- Instant confirm by default, with optional holds.
- A demo JWT login.
- The product's name and the War Room framing.
- A pre-mortem before any code ("poke it to see where it would break").
- An industry-practice review of the core before building on it.
- The chart library.
- The smoke deploy, and the Supabase and Render accounts.

**The AI proposed, and the human reviewed and accepted:**

- the one-round-trip decision function, its lock order and its lock-free fast path;
- the pre-mortem's failure modes and fixes;
- the metric set, the public log ring and the reconciler;
- the burst's scenarios.

**What the AI did:**

- Implemented every phase with its tests.
- Built the checks that carry most of the weight:
  - concurrency and property tests against a real Postgres;
  - an independent invariant oracle in the tests;
  - a burst that checks every guarantee from outside and fails on a fake server that cheats.
- Found and fixed the bugs those checks surfaced, with the reasoning logged:
  - the MultiXact FK;
  - the pooler hang;
  - the retry storm;
  - the deadline race;
  - PgBouncer's login backoff.

**Where AI output was not taken on trust:**

- Each phase was verified with tests that fail without the fix, not by reading.
- Claims about load were measured: CPU per request, RSS at 2,000 and 4,000 in flight, throttled to the free tier.
- When CI's last 503s had a plausible explanation that couldn't be reproduced, the AI didn't settle for it. The burst was taught to name the server's own error, which found the real cause.
