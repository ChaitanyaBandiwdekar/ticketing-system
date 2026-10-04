import { Link } from "react-router";
import { InvariantBadge, Occupancy } from "../components/Occupancy";
import { buttonClass, Notice, Pill, RequestId, Skeleton } from "../components/ui";
import { ApiError, describeError, type ShowSummary } from "../lib/api";
import { ago, holdMode, plural, rupees } from "../lib/format";
import { useShows } from "../lib/queries";

function ShowRow({ show }: { show: ShowSummary }) {
  const soldOut = show.counts.available === 0;
  return (
    <li className="group relative grid gap-x-8 gap-y-3 px-4 py-4 transition-colors duration-150 hover:bg-surface sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] md:items-center">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link
            to={`/shows/${show.id}`}
            className="truncate text-[0.9375rem] font-medium text-ink after:absolute after:inset-0 after:content-['']"
          >
            {show.name}
          </Link>
          {soldOut && <Pill tone="neutral">Sold out</Pill>}
        </div>
        <p className="tabular flex flex-wrap gap-x-2 text-[0.8125rem] text-muted">
          <span className="text-ink-2">{rupees(show.price_paise)}</span>
          <span aria-hidden>·</span>
          <span>{plural(show.total_seats, "seat")}</span>
          <span aria-hidden>·</span>
          <span>{show.per_user_limit} per person</span>
          <span aria-hidden>·</span>
          <span>{holdMode(show.hold_ttl_seconds)}</span>
          <span aria-hidden>·</span>
          <time dateTime={show.created_at} title={new Date(show.created_at).toLocaleString()}>
            {ago(show.created_at)}
          </time>
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Occupancy counts={show.counts} compact />
        <InvariantBadge ok={show.counts.invariant_ok} />
      </div>
    </li>
  );
}

function LoadingRows() {
  return (
    <ul aria-hidden className="divide-y divide-line">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="grid gap-4 px-5 py-5 md:grid-cols-[1fr_18rem]">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-1.5 w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ShowsPage() {
  const shows = useShows();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-2xl flex-col gap-1.5">
          <h1 className="text-2xl font-semibold">Shows</h1>
          <p className="text-ink-2">
            Every count below comes from one database snapshot, so sold, held and free always add up
            to the hall. Open a show to watch its seats change live.
          </p>
        </div>
        <Link to="/shows/new" className={buttonClass("primary")}>
          New show
        </Link>
      </div>

      {shows.data && (
        <p className="tabular text-[0.8125rem] text-muted" aria-live="polite">
          {plural(shows.data.length, "show")} · refreshed every 5s
        </p>
      )}

      <section aria-label="Show list" className="overflow-hidden rounded-lg border border-line">
        {shows.isPending ? (
          <LoadingRows />
        ) : shows.isError ? (
          <div className="p-4">
            <Notice
              title="Couldn't load shows"
              action={
                <button className={buttonClass("secondary", "sm")} onClick={() => shows.refetch()}>
                  Retry
                </button>
              }
            >
              {describeError(shows.error)}{" "}
              {shows.error instanceof ApiError && <RequestId id={shows.error.requestId} />}
            </Notice>
          </div>
        ) : shows.data.length === 0 ? (
          <div className="flex flex-col items-start gap-3 px-5 py-10">
            <h2 className="text-base font-medium">No shows yet</h2>
            <p className="max-w-prose text-ink-2">
              Create a show to get a hall: pick rows, seats per row and aisles, set a price, then
              choose whether reserving confirms instantly or places a timed hold.
            </p>
            <Link to="/shows/new" className={buttonClass("secondary", "sm")}>
              Create the first show
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {shows.data.map((s) => (
              <ShowRow key={s.id} show={s} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
