-- FirstDayFirstShow schema. Postgres is the only source of truth; constraints make illegal states
-- unrepresentable rather than merely unlikely.
--
-- Invariant by construction: one `seats` row per physical seat, created with its show and never
-- inserted or deleted afterwards, each with exactly one NOT NULL status. Hence
-- available + held + confirmed == shows.total_seats always holds. There is deliberately no counter
-- row to keep in sync (and no hot row for every reservation to update).
--
-- There is no users table: identity is the JWT `sub`, so minting tokens costs zero DB writes.

create table shows (
  id               uuid primary key default gen_random_uuid(),
  name             text        not null check (length(name) between 1 and 200),
  price_paise      bigint      not null check (price_paise > 0),
  per_user_limit   integer     not null check (per_user_limit between 1 and 100),
  -- NULL: reserve -> confirmed (instant). Set: reserve -> held, then confirm or auto-expire.
  hold_ttl_seconds integer     check (hold_ttl_seconds between 1 and 3600),
  total_seats      integer     not null check (total_seats > 0),
  -- Burst/simulator shows: removed by the janitor after 24h.
  ephemeral        boolean     not null default false,
  created_at       timestamptz not null default now()
);

-- reservations.show_id deliberately has NO foreign key to shows. Every reservation insert would
-- take FOR KEY SHARE on the one show row that the whole stampede targets; concurrent key-share
-- lockers on a single row are tracked as MultiXacts, a well-known Postgres throughput cliff
-- (MultiXact SLRU contention) on hot parent rows. Integrity is kept without it:
--   - fdfs_reserve reads the show before inserting, and only inserts after locking the show's
--     seats (seats.show_id *is* a foreign key, checked once at show creation, never on reserve);
--   - while a reservation holds seats, the composite FK below pins its show_id to theirs;
--   - the janitor deletes a show's reservations explicitly, before the show.
create table reservations (
  id           uuid        primary key default gen_random_uuid(),
  show_id      uuid        not null,
  user_id      text        not null check (length(user_id) between 1 and 128),
  seat_labels  text[]      not null check (cardinality(seat_labels) > 0),
  amount_paise bigint      not null check (amount_paise > 0),
  -- 'held' past expires_at is *effectively* expired (derived); the sweeper finalizes it later.
  status       text        not null check (status in ('held', 'confirmed', 'cancelled', 'expired')),
  expires_at   timestamptz,
  idem_key     text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (status <> 'held' or expires_at is not null),
  -- Target of the composite FK below: a seat can only point at a reservation of its own show
  -- *and* its own user.
  unique (id, show_id, user_id)
);

create index reservations_show_user_idx on reservations (show_id, user_id);
create index reservations_held_expiry_idx on reservations (expires_at) where status = 'held';

create table seats (
  id             bigserial   primary key,
  show_id        uuid        not null references shows (id) on delete cascade,
  label          text        not null check (label ~ '^[A-Za-z0-9-]{1,16}$'),
  status         text        not null default 'available'
                             check (status in ('available', 'held', 'confirmed')),
  reservation_id uuid,
  user_id        text,
  held_until     timestamptz,
  unique (show_id, label),
  check ((status = 'available') = (reservation_id is null and user_id is null)),
  check ((status = 'held') = (held_until is not null)),
  foreign key (reservation_id, show_id, user_id) references reservations (id, show_id, user_id)
);

create index seats_reservation_idx on seats (reservation_id) where reservation_id is not null;
-- Per-user active-seat count (limit check) without scanning the whole hall.
create index seats_show_user_idx on seats (show_id, user_id) where user_id is not null;

-- Keys are scoped per user: one user's key can never replay another user's reservation.
create table idempotency_keys (
  user_id        text        not null,
  key            text        not null check (length(key) between 1 and 200),
  -- sha256 of (show, sorted seat set): same key + different request -> idempotency_key_reused.
  request_hash   text        not null,
  -- Deferred: the key row is claimed first (it is the first lock in the global order) and the
  -- reservation it names is inserted later in the same transaction.
  reservation_id uuid        not null references reservations (id) on delete cascade
                             deferrable initially deferred,
  created_at     timestamptz not null default now(),
  primary key (user_id, key)
);

-- TTL reaping (keys are retry protection, not an archive; 24h like Stripe's).
create index idempotency_keys_created_idx on idempotency_keys (created_at);
-- The cascade from a deleted reservation must not scan the whole key table.
create index idempotency_keys_reservation_idx on idempotency_keys (reservation_id);

-- A seat is free if nobody holds it, or its hold has lapsed. Expiry is derived from DB time, so
-- correctness never waits on the sweeper. Plain SQL + STABLE: the planner inlines it.
create function fdfs_seat_free(p_status text, p_held_until timestamptz) returns boolean
language sql stable
as $$ select p_status = 'available' or (p_status = 'held' and p_held_until <= now()) $$;

-- Effective status as clients see it ('held' past its deadline reads as 'expired').
create function fdfs_reservation_status(p_status text, p_expires_at timestamptz) returns text
language sql stable
as $$ select case when p_status = 'held' and p_expires_at <= now() then 'expired' else p_status end $$;

-- The reservation body every API response uses (create, replay, confirm, cancel, list).
create function fdfs_reservation_json(r reservations) returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'reservation_id', r.id,
    'show_id',        r.show_id,
    'user_id',        r.user_id,
    'seats',          to_jsonb(r.seat_labels),
    'amount_paise',   r.amount_paise,
    'status',         fdfs_reservation_status(r.status, r.expires_at),
    'expires_at',     r.expires_at,
    'created_at',     r.created_at
  )
$$;
