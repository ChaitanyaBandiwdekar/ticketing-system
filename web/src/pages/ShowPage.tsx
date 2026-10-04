import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { InvariantBadge, Occupancy } from "../components/Occupancy";
import { buttonClass, Notice, Pill, RequestId, Skeleton } from "../components/ui";
import { SEAT_CODE } from "../hall/codes";
import { HallCanvas, HallLegend, Screen } from "../hall/HallCanvas";
import { hallGeometry } from "../hall/geometry";
import { ApiError, describeError, type ShowDetail } from "../lib/api";
import { holdMode, plural, rupees } from "../lib/format";
import { useShow } from "../lib/queries";

function ShowHeader({ show }: { show: ShowDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Link to="/shows" className="w-fit text-[0.8125rem] text-muted hover:text-ink">
        ← Shows
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{show.name}</h1>
            {show.ephemeral && <Pill tone="amber">Burst</Pill>}
          </div>
          <p className="tabular flex flex-wrap gap-x-2 text-[0.8125rem] text-muted">
            <span className="text-ink-2">{rupees(show.price_paise)} a seat</span>
            <span aria-hidden>·</span>
            <span>{plural(show.total_seats, "seat")}</span>
            <span aria-hidden>·</span>
            <span>up to {show.per_user_limit} per person</span>
            <span aria-hidden>·</span>
            <span>{holdMode(show.hold_ttl_seconds)}</span>
          </p>
        </div>
        <div className="flex w-full max-w-xs flex-col gap-1.5">
          <Occupancy counts={show.counts} compact />
          <InvariantBadge ok={show.counts.invariant_ok} />
        </div>
      </div>
    </div>
  );
}

export function ShowPage() {
  const { id = "" } = useParams();
  const show = useShow(id);
  const geometry = useMemo(
    () =>
      show.data
        ? hallGeometry(
            show.data.seats.map((s) => s.label),
            show.data.layout,
          )
        : null,
    [show.data],
  );
  const paint = useMemo(
    () => ({ status: show.data ? show.data.seats.map((s) => SEAT_CODE[s.status]).join("") : "" }),
    [show.data],
  );

  if (show.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy>
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-3 w-96 max-w-full" />
        <Skeleton className="mt-6 h-80 w-full" />
      </div>
    );
  }
  if (show.isError) {
    const notFound = show.error instanceof ApiError && show.error.status === 404;
    return (
      <div className="flex max-w-xl flex-col gap-4 pt-6">
        <Notice
          title={notFound ? "No such show" : "Couldn't load this show"}
          tone={notFound ? "neutral" : "danger"}
          action={
            <Link to="/shows" className={buttonClass("secondary", "sm")}>
              All shows
            </Link>
          }
        >
          {notFound
            ? "It may have been a burst show that has since been cleaned up."
            : describeError(show.error)}{" "}
          {show.error instanceof ApiError && <RequestId id={show.error.requestId} />}
        </Notice>
      </div>
    );
  }

  const data = show.data;
  return (
    <div className="flex flex-col gap-8">
      <ShowHeader show={data} />
      <section aria-label="Seat map" className="flex flex-col gap-5">
        <div className="rounded-lg border border-line bg-surface/40 px-3 py-6 sm:px-6">
          <Screen />
          {geometry && (
            <HallCanvas
              geometry={geometry}
              paint={paint}
              label={`Seat map: ${data.counts.available} of ${data.counts.total} seats available`}
            />
          )}
        </div>
        <HallLegend />
      </section>
    </div>
  );
}
