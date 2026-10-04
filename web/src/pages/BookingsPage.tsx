import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, Navigate } from "react-router";
import { BookingCard } from "../components/Bookings";
import { buttonClass, Notice, RequestId, Skeleton } from "../components/ui";
import { ApiError, describeError, type Reservation, type ShowSummary } from "../lib/api";
import { plural } from "../lib/format";
import { keys, useMyReservations, useShows } from "../lib/queries";
import { useSession } from "../lib/session";

type Group = { showId: string; show: ShowSummary | null; reservations: Reservation[] };

/** Reservations grouped by show, in the order of each show's newest reservation. */
function groupByShow(list: Reservation[], shows: ShowSummary[]): Group[] {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const groups = new Map<string, Group>();
  for (const r of list) {
    let g = groups.get(r.show_id);
    if (!g) {
      g = { showId: r.show_id, show: byId.get(r.show_id) ?? null, reservations: [] };
      groups.set(r.show_id, g);
    }
    g.reservations.push(r);
  }
  return [...groups.values()];
}

export function BookingsPage() {
  const qc = useQueryClient();
  const { session } = useSession();
  const mine = useMyReservations(session);
  const shows = useShows();
  const groups = useMemo(
    () => groupByShow(mine.data ?? [], shows.data ?? []),
    [mine.data, shows.data],
  );

  if (!session) return <Navigate to="/login?next=%2Fbookings" replace />;

  const active = (mine.data ?? []).filter(
    (r) => r.status === "held" || r.status === "confirmed",
  ).length;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold">My bookings</h1>
        <p className="text-ink-2">
          Everything <span className="font-medium text-ink">{session.userId}</span> has reserved,
          newest first. Holds count down here too; confirm them before they lapse.
        </p>
      </div>

      {mine.isPending ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : mine.isError ? (
        <Notice
          title="Couldn't load your bookings"
          action={
            <button className={buttonClass("secondary", "sm")} onClick={() => mine.refetch()}>
              Retry
            </button>
          }
        >
          {describeError(mine.error)}{" "}
          {mine.error instanceof ApiError && <RequestId id={mine.error.requestId} />}
        </Notice>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-line px-5 py-10">
          <h2 className="text-base font-medium">Nothing booked yet</h2>
          <p className="max-w-prose text-ink-2">
            Open a show, pick seats on the live map and book them. They'll show up here.
          </p>
          <Link to="/shows" className={buttonClass("secondary", "sm")}>
            Browse shows
          </Link>
        </div>
      ) : (
        <>
          <p className="tabular text-[0.8125rem] text-muted">
            {plural(mine.data.length, "reservation")} · {active} active
          </p>
          {groups.map((g) => (
            <section
              key={g.showId}
              aria-label={g.show?.name ?? "Show"}
              className="flex flex-col gap-3"
            >
              <h2 className="flex items-baseline gap-2 text-[0.9375rem] font-medium">
                {g.show ? (
                  <Link to={`/shows/${g.showId}`} className="hover:text-primary-ink">
                    {g.show.name}
                  </Link>
                ) : (
                  <span className="text-ink-2">
                    Show <span className="font-mono text-[0.8125rem]">{g.showId.slice(0, 8)}</span>
                  </span>
                )}
              </h2>
              <ul className="flex flex-col gap-2">
                {g.reservations.map((r) => (
                  <BookingCard
                    key={r.reservation_id}
                    reservation={r}
                    session={session}
                    holdTtlSeconds={g.show?.hold_ttl_seconds ?? null}
                    onLapse={() => void qc.invalidateQueries({ queryKey: keys.mine })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
