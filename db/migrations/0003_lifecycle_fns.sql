-- Reservation lifecycle: confirm, cancel, and the hold-expiry sweeper.
--
-- All three follow the global lock order from 0002 (seats sorted by id, THEN the reservation row),
-- and every seat write is guarded by `reservation_id = <this reservation>`. So a late confirm or
-- cancel of a hold whose seat was already re-sold matches zero seats and can never resurrect or
-- release someone else's booking.
--
-- Each function first decides from a lock-free read (unknown / foreign / already-final
-- reservations never take a lock), then re-decides under the locks, because a concurrent cancel,
-- confirm, takeover or sweep may have won in between.
--
-- Outcomes ('outcome' key):
--   confirmed | cancelled          -> 'reservation', 'changed' (false = idempotent repeat)
--   reservation_expired | reservation_cancelled -> 'reservation'
--   not_found | forbidden

-- Partial index for the sweeper's seat pass.
create index seats_held_until_idx on seats (held_until) where status = 'held';

create function fdfs_lifecycle_result(p_outcome text, p_res reservations, p_changed boolean)
returns jsonb
language sql stable
as $$
  select jsonb_build_object('outcome', p_outcome, 'changed', p_changed,
                            'reservation', fdfs_reservation_json(p_res))
$$;

create function fdfs_confirm(p_rid uuid, p_user text) returns jsonb
language plpgsql
set lock_timeout = '5s'
as $$
declare
  v_res  reservations;
  v_ids  bigint[];
  v_live integer;
begin
  -- Lock-free pre-check.
  select * into v_res from reservations where id = p_rid;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_res.user_id <> p_user then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  for i in 1..2 loop
    -- i = 1: decide from the snapshot; i = 2: re-decide under the locks.
    if v_res.status = 'confirmed' then
      return fdfs_lifecycle_result('confirmed', v_res, false);
    elsif v_res.status = 'cancelled' then
      return fdfs_lifecycle_result('reservation_cancelled', v_res, false);
    elsif fdfs_reservation_status(v_res.status, v_res.expires_at) = 'expired' then
      return fdfs_lifecycle_result('reservation_expired', v_res, false);
    end if;
    exit when i = 2;

    -- A live hold: lock its seats (id order), then the reservation.
    select array_agg(x.id order by x.id),
           count(*) filter (where x.status = 'held' and x.held_until > now())
      into v_ids, v_live
      from (select s.id, s.status, s.held_until
              from seats s
             where s.reservation_id = p_rid
             order by s.id
               for update) x;
    select * into v_res from reservations where id = p_rid for update;
  end loop;

  -- Every seat must still be ours and live. (Holds lapse together, so a shortfall means the
  -- sweeper or a takeover got here first: the hold is gone.)
  if v_live <> cardinality(v_res.seat_labels) then
    return fdfs_lifecycle_result('reservation_expired', v_res, false);
  end if;

  update seats
     set status = 'confirmed', held_until = null
   where id = any (v_ids) and reservation_id = p_rid and status = 'held';

  update reservations
     set status = 'confirmed', expires_at = null, updated_at = now()
   where id = p_rid
  returning * into v_res;

  return fdfs_lifecycle_result('confirmed', v_res, true);
end
$$;

-- Owner cancel of a live hold or a confirmed booking. Idempotent: a repeat returns the same body
-- with changed=false. A lapsed hold is reported as reservation_expired (there is nothing to undo).
create function fdfs_cancel(p_rid uuid, p_user text) returns jsonb
language plpgsql
set lock_timeout = '5s'
as $$
declare
  v_res reservations;
  v_ids bigint[];
begin
  select * into v_res from reservations where id = p_rid;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_res.user_id <> p_user then
    return jsonb_build_object('outcome', 'forbidden');
  end if;

  for i in 1..2 loop
    if v_res.status = 'cancelled' then
      return fdfs_lifecycle_result('cancelled', v_res, false);
    elsif fdfs_reservation_status(v_res.status, v_res.expires_at) = 'expired' then
      return fdfs_lifecycle_result('reservation_expired', v_res, false);
    end if;
    exit when i = 2;

    select array_agg(x.id order by x.id)
      into v_ids
      from (select s.id
              from seats s
             where s.reservation_id = p_rid
             order by s.id
               for update) x;
    select * into v_res from reservations where id = p_rid for update;
  end loop;

  -- Guarded release: only seats that still belong to this reservation, in its current state.
  update seats
     set status = 'available', reservation_id = null, user_id = null, held_until = null
   where id = any (v_ids) and reservation_id = p_rid and status = v_res.status;

  update reservations
     set status = 'cancelled', updated_at = now()
   where id = p_rid
  returning * into v_res;

  return fdfs_lifecycle_result('cancelled', v_res, true);
end
$$;

-- The sweeper. Correctness never depends on it (expiry is derived), it only tidies:
--   1. releases lapsed held seats back to 'available' (seat-based, so a seat skipped this round,
--      or left pointing at an already-finalized reservation, is picked up next round);
--   2. marks lapsed holds 'expired'.
-- Seats before reservations (the global order), and SKIP LOCKED everywhere: the sweeper never
-- waits on a request, it just leaves busy rows for the next tick.
-- Returns {released: [{show_id, seats[]}], expired: n} so the realtime layer can push deltas.
create function fdfs_expire_holds(p_batch integer default 500) returns jsonb
language plpgsql
set lock_timeout = '5s'
as $$
declare
  v_released jsonb;
  v_expired  integer;
begin
  with due as (
    select id from seats
     where status = 'held' and held_until <= now()
     order by id
     limit p_batch
       for update skip locked
  ), freed as (
    update seats s
       set status = 'available', reservation_id = null, user_id = null, held_until = null
      from due
     where s.id = due.id
    returning s.id, s.show_id, s.label
  )
  select coalesce(jsonb_agg(jsonb_build_object('show_id', g.show_id, 'seats', to_jsonb(g.labels))
                            order by g.show_id), '[]'::jsonb)
    into v_released
    from (select show_id, array_agg(label order by id) as labels from freed group by show_id) g;

  with due as (
    select id from reservations
     where status = 'held' and expires_at <= now()
     order by expires_at
     limit p_batch
       for update skip locked
  )
  update reservations r
     set status = 'expired', updated_at = now()
    from due
   where r.id = due.id;
  get diagnostics v_expired = row_count;

  return jsonb_build_object('released', v_released, 'expired', v_expired);
end
$$;
