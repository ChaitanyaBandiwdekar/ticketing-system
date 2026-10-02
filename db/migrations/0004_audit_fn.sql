-- fdfs_audit: proves a show's books balance, from ONE statement (one snapshot), using effective
-- (derived) states so it is exact even before the sweeper has run. Backs GET /shows/:id/audit,
-- the reconciler job and the burst script's final verdict.
--
-- Checks:
--   seat_count       seats rows == shows.total_seats (seats are never inserted/deleted later)
--   counts           available + held + confirmed == total
--   orphan_seat      every taken seat -> an active reservation of the same user, in the same state,
--                    that lists that seat
--   missing_seats    every active reservation owns exactly its listed seats
--   amount           amount_paise == price_paise x seats, for every reservation
--   per_user_limit   no user holds more active seats than the show allows
-- Returns {show_id, ok, counts{...}, violations[{check, detail}]} (violations capped at 100), or
-- NULL for an unknown show.
create function fdfs_audit(p_show uuid) returns jsonb
language sql stable
as $$
  with sh as (
    select * from shows where id = p_show
  ),
  eff as (
    select s.id, s.label, s.reservation_id, s.user_id,
           case when fdfs_seat_free(s.status, s.held_until) then 'available' else s.status end
             as status
      from seats s
     where s.show_id = p_show
  ),
  active as (
    select r.id, r.user_id, r.seat_labels,
           fdfs_reservation_status(r.status, r.expires_at) as status
      from reservations r
     where r.show_id = p_show
       and fdfs_reservation_status(r.status, r.expires_at) in ('held', 'confirmed')
  ),
  counts as (
    select count(*)                                        as seats,
           count(*) filter (where status = 'available')    as available,
           count(*) filter (where status = 'held')         as held,
           count(*) filter (where status = 'confirmed')    as confirmed
      from eff
  ),
  violations as (
    select 'seat_count' as check_name,
           format('%s seat rows for %s total seats', c.seats, sh.total_seats) as detail
      from counts c, sh
     where c.seats <> sh.total_seats
    union all
    select 'counts',
           format('available %s + held %s + confirmed %s <> total %s',
                  c.available, c.held, c.confirmed, sh.total_seats)
      from counts c, sh
     where c.available + c.held + c.confirmed <> sh.total_seats
    union all
    select 'orphan_seat',
           format('seat %s (%s, user %s) has no matching active reservation',
                  e.label, e.status, e.user_id)
      from eff e
     where e.status <> 'available'
       and not exists (
         select 1 from active a
          where a.id = e.reservation_id and a.user_id = e.user_id and a.status = e.status
            and e.label = any (a.seat_labels))
    union all
    select 'missing_seats',
           format('reservation %s (%s) owns %s of its %s seats',
                  a.id, a.status, coalesce(n.owned, 0), cardinality(a.seat_labels))
      from active a
      left join lateral (
        select count(*) as owned from eff e
         where e.reservation_id = a.id and e.status = a.status
           and e.label = any (a.seat_labels)) n on true
     where coalesce(n.owned, 0) <> cardinality(a.seat_labels)
    union all
    select 'amount',
           format('reservation %s charges %s, expected %s',
                  r.id, r.amount_paise, sh.price_paise * cardinality(r.seat_labels))
      from reservations r, sh
     where r.show_id = p_show and r.amount_paise <> sh.price_paise * cardinality(r.seat_labels)
    union all
    select 'per_user_limit',
           format('user %s holds %s seats, limit %s', e.user_id, count(*), max(sh.per_user_limit))
      from eff e, sh
     where e.status <> 'available'
     group by e.user_id
    having count(*) > max(sh.per_user_limit)
  )
  select jsonb_build_object(
           'show_id', sh.id,
           'ok', not exists (select 1 from violations),
           'counts', jsonb_build_object(
             'total', sh.total_seats,
             'available', c.available,
             'held', c.held,
             'confirmed', c.confirmed,
             'invariant_ok', c.seats = sh.total_seats
                             and c.available + c.held + c.confirmed = sh.total_seats),
           'violations', coalesce(
             (select jsonb_agg(jsonb_build_object('check', v.check_name, 'detail', v.detail))
                from (select * from violations order by check_name, detail limit 100) v),
             '[]'::jsonb))
    from sh, counts c
$$;
