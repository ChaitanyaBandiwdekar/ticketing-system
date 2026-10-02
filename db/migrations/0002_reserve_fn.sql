-- fdfs_reserve: the whole reservation decision in ONE round trip.
--
-- Called as a single `select fdfs_reserve(...)`, so the statement is its own transaction: no
-- BEGIN/COMMIT round trips, and row locks live for microseconds. Every outcome, including a
-- decline, is returned as jsonb rather than raised, so a stampede of declines produces no error
-- churn (and no ERROR lines in the Postgres log).
--
-- GLOBAL LOCK ORDER (every function in this schema follows it, which is the deadlock-freedom
-- argument):
--   1. idempotency key (unique-index slot on (user_id, key))
--   2. per-(show, user) transaction advisory lock
--   3. seat rows, sorted by seats.id (an integer, so collation can never change the order)
--   4. reservation rows
-- reserve never touches another user's reservation row: taking over a lapsed hold rewrites only
-- the seat, and the old reservation reads as 'expired' by derivation until the sweeper finalizes
-- it. (Updating it here would take seat -> reservation while cancel takes reservation -> seat.)
--
-- Outcomes ('outcome' key):
--   created | replayed                    -> 'reservation' body
--   seat_taken                            -> 'unavailable_seats'
--   per_user_limit                        -> 'limit', 'active', 'requested'
--   idempotency_key_reused | show_not_found
--   invalid                               -> 'message', 'unknown_seats'
-- plus 'path' = 'fast' (decided from a lock-free snapshot) or 'locked'.
--
-- Only successes consume an idempotency key: a decline on the locked path deletes the key row it
-- claimed, in the same transaction, so a retry after a decline is evaluated afresh.
create function fdfs_reserve(
  p_show     uuid,
  p_user     text,
  p_labels   text[],
  p_idem_key text,
  p_req_hash text
) returns jsonb
language plpgsql
-- With the fast path, real lock waits are a few ms; this only bounds pathological ones. The app
-- retries 55P03 (and 40P01/40001) a bounded number of times and never reports contention as a 500.
set lock_timeout = '10s'
as $$
declare
  v_n         integer := coalesce(cardinality(p_labels), 0);
  v_found     boolean;
  v_price     bigint;
  v_limit     integer;
  v_ttl       integer;
  v_key_hash  text;
  v_key_rid   uuid;
  v_unknown   text[];
  v_taken     text[];
  v_active    integer;
  v_rid       uuid;
  v_seat_ids  bigint[];
  v_ordered   text[];
  v_status    text;
  v_expires   timestamptz;
  v_res       reservations;
begin
  -- Shape checks (the API validates too; this keeps the function safe to call directly).
  if v_n = 0 or v_n > 100
     or array_position(p_labels, null) is not null
     or (select count(distinct l) from unnest(p_labels) l) <> v_n then
    return jsonb_build_object('outcome', 'invalid', 'path', 'fast',
      'message', 'seats must be 1-100 distinct labels', 'unknown_seats', '[]'::jsonb);
  end if;

  ------------------------------------------------------------------------------------------------
  -- 1. Snapshot fast path: no locks.
  -- ONE statement reads the show, this user's key, the requested seats and the user's active-seat
  -- count, all in the same snapshot. Same snapshot matters: a concurrent same-key retry can never
  -- see "seat taken" by its own original without also seeing the original's key.
  -- After the first commit on a hot seat, every loser declines here without touching a row lock,
  -- so a 500-way storm on A12 cannot park the pool behind one row.
  ------------------------------------------------------------------------------------------------
  select true, sh.price_paise, sh.per_user_limit, sh.hold_ttl_seconds,
         k.request_hash, k.reservation_id,
         (select coalesce(array_agg(l order by l), '{}')
            from unnest(p_labels) l
           where not exists (select 1 from seats s where s.show_id = p_show and s.label = l)),
         (select coalesce(array_agg(s.label order by s.id), '{}')
            from seats s
           where s.show_id = p_show and s.label = any (p_labels)
             and not fdfs_seat_free(s.status, s.held_until)),
         (select count(*)
            from seats s
           where s.show_id = p_show and s.user_id = p_user
             and not fdfs_seat_free(s.status, s.held_until))
    into v_found, v_price, v_limit, v_ttl, v_key_hash, v_key_rid, v_unknown, v_taken, v_active
    from shows sh
    left join idempotency_keys k on k.user_id = p_user and k.key = p_idem_key
   where sh.id = p_show;

  if v_found is null then
    return jsonb_build_object('outcome', 'show_not_found', 'path', 'fast');
  end if;

  if v_key_hash is not null then
    return fdfs_reserve_key_outcome(v_key_hash, v_key_rid, p_req_hash, 'fast');
  end if;

  if cardinality(v_unknown) > 0 then
    return jsonb_build_object('outcome', 'invalid', 'path', 'fast',
      'message', 'unknown seats for this show', 'unknown_seats', to_jsonb(v_unknown));
  end if;

  -- Declining from a snapshot is linearizable: at that instant the user really held v_active
  -- seats / the seats really were taken. Limit is checked before seats, as on the locked path.
  if v_active + v_n > v_limit then
    return jsonb_build_object('outcome', 'per_user_limit', 'path', 'fast',
      'limit', v_limit, 'active', v_active, 'requested', v_n);
  end if;

  if cardinality(v_taken) > 0 then
    return jsonb_build_object('outcome', 'seat_taken', 'path', 'fast',
      'unavailable_seats', to_jsonb(v_taken));
  end if;

  ------------------------------------------------------------------------------------------------
  -- 2. Claim the idempotency key. An in-flight duplicate blocks on the unique index until the
  -- original finishes: then it replays (original committed) or proceeds (original declined and
  -- removed its claim).
  ------------------------------------------------------------------------------------------------
  v_rid := gen_random_uuid();
  insert into idempotency_keys (user_id, key, request_hash, reservation_id)
  values (p_user, p_idem_key, p_req_hash, v_rid)
  on conflict do nothing;

  if not found then
    select k.request_hash, k.reservation_id into v_key_hash, v_key_rid
      from idempotency_keys k
     where k.user_id = p_user and k.key = p_idem_key;
    if v_key_hash is null then
      -- The conflicting row vanished between our insert and this read (only possible if the
      -- janitor deleted its show). Ask the caller to retry from scratch.
      raise exception using errcode = '40001', message = 'idempotency key changed underfoot';
    end if;
    return fdfs_reserve_key_outcome(v_key_hash, v_key_rid, p_req_hash, 'locked');
  end if;

  ------------------------------------------------------------------------------------------------
  -- 3. Per-user limit. The advisory lock serializes this user's reserves on this show, so the
  -- count below is exact: a user's seat count only ever grows while this lock is held. (It can
  -- shrink concurrently via cancel/expiry, which only makes the check conservative.)
  -- A hashtext collision merely serializes two users; it can never admit an extra seat.
  ------------------------------------------------------------------------------------------------
  perform pg_advisory_xact_lock(hashtext(p_show::text), hashtext(p_user));

  select count(*) into v_active
    from seats s
   where s.show_id = p_show and s.user_id = p_user
     and not fdfs_seat_free(s.status, s.held_until);

  if v_active + v_n > v_limit then
    delete from idempotency_keys where user_id = p_user and key = p_idem_key;
    return jsonb_build_object('outcome', 'per_user_limit', 'path', 'locked',
      'limit', v_limit, 'active', v_active, 'requested', v_n);
  end if;

  ------------------------------------------------------------------------------------------------
  -- 4. Lock the requested seats in id order and re-check them under the lock. All-or-nothing:
  -- one unavailable seat declines the whole request.
  ------------------------------------------------------------------------------------------------
  select array_agg(x.id order by x.id),
         array_agg(x.label order by x.id),
         coalesce(array_agg(x.label order by x.id)
                    filter (where not fdfs_seat_free(x.status, x.held_until)), '{}')
    into v_seat_ids, v_ordered, v_taken
    from (select s.id, s.label, s.status, s.held_until
            from seats s
           where s.show_id = p_show and s.label = any (p_labels)
           order by s.id
             for update) x;

  if coalesce(cardinality(v_seat_ids), 0) <> v_n then
    -- Seats are never deleted while their show exists, so this means the show just went away.
    delete from idempotency_keys where user_id = p_user and key = p_idem_key;
    return jsonb_build_object('outcome', 'show_not_found', 'path', 'locked');
  end if;

  if cardinality(v_taken) > 0 then
    delete from idempotency_keys where user_id = p_user and key = p_idem_key;
    return jsonb_build_object('outcome', 'seat_taken', 'path', 'locked',
      'unavailable_seats', to_jsonb(v_taken));
  end if;

  if v_ttl is null then
    v_status := 'confirmed';
  else
    v_status := 'held';
    v_expires := now() + make_interval(secs => v_ttl);
  end if;

  insert into reservations (id, show_id, user_id, seat_labels, amount_paise, status, expires_at, idem_key)
  values (v_rid, p_show, p_user, v_ordered, v_price * v_n, v_status, v_expires, p_idem_key)
  returning * into v_res;

  -- Conditional by construction: these rows are locked by us and were just verified free.
  update seats
     set status = v_status, reservation_id = v_rid, user_id = p_user, held_until = v_expires
   where id = any (v_seat_ids);

  return jsonb_build_object('outcome', 'created', 'path', 'locked',
    'reservation', fdfs_reservation_json(v_res));
end
$$;

-- Same key seen again: replay the original's *current* state if the request matches, refuse it
-- otherwise. Split out because both the fast path and the locked path need it.
create function fdfs_reserve_key_outcome(
  p_key_hash text, p_key_rid uuid, p_req_hash text, p_path text
) returns jsonb
language sql stable
as $$
  select case
    when p_key_hash = p_req_hash then
      jsonb_build_object('outcome', 'replayed', 'path', p_path,
        'reservation', (select fdfs_reservation_json(r) from reservations r where r.id = p_key_rid))
    else
      jsonb_build_object('outcome', 'idempotency_key_reused', 'path', p_path)
  end
$$;
