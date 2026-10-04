import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useParams } from "react-router";
import { BookingCard } from "../components/Bookings";
import { InvariantBadge, Occupancy } from "../components/Occupancy";
import { Button, buttonClass, cx, Notice, Pill, RequestId, Skeleton } from "../components/ui";
import { seatRect, type HallMetrics, type HallPaint } from "../hall/draw";
import { HallCanvas, HallLegend, Screen, type HallInteraction } from "../hall/HallCanvas";
import { hallGeometry, neighbor, type Direction, type HallGeometry } from "../hall/geometry";
import type { AuditFrame, LinkState } from "../hall/live";
import { useLiveShow, type LiveShow } from "../hall/useLiveShow";
import {
  ApiError,
  describeError,
  request,
  type Reservation,
  type SeatCounts,
  type Session,
  type ShowDetail,
} from "../lib/api";
import { isTransient, newIdempotencyKey, seatList, withRetries } from "../lib/booking";
import { serverNow } from "../lib/clock";
import { ago, holdMode, plural, rupees } from "../lib/format";
import { keys, rememberReservation, useMyReservations, useShow } from "../lib/queries";
import { useSession } from "../lib/session";

const RESERVE_ATTEMPTS = 4;
/**
 * Touch needs a 14px seat pitch to be tappable; a mouse is precise at 10px, which fits the
 * 2,000-seat Premiere in the desktop panel instead of hiding its right block behind a scrollbar.
 */
const COARSE_POINTER =
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

function ttlText(seconds: number): string {
  return seconds % 60 === 0 ? plural(seconds / 60, "minute") : plural(seconds, "second");
}

/* ------------------------------------------------------------------------------------------ */
/* Header                                                                                      */

function LiveBadge({ link }: { link: LinkState }) {
  const meta = {
    live: {
      dot: "bg-success",
      text: "Live",
      title: "Seat changes stream in as they happen (GET /stream)",
    },
    connecting: { dot: "bg-line-strong", text: "Connecting…", title: "Opening the live stream" },
    reconnecting: {
      dot: "bg-amber",
      text: "Reconnecting",
      title: "The live stream dropped. The map refreshes every 5s until it is back.",
    },
    gone: { dot: "bg-danger", text: "Show removed", title: "This show was deleted" },
  }[link];
  return (
    <span
      className="inline-flex items-center gap-2 text-xs font-medium text-ink-2"
      title={meta.title}
      role="status"
    >
      <span className="relative flex size-2" aria-hidden>
        {link === "live" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 [animation-duration:2.4s]" />
        )}
        <span className={cx("relative inline-flex size-2 rounded-full", meta.dot)} />
      </span>
      {meta.text}
    </span>
  );
}

/** "3s ago", re-rendered every second. */
function Ago({ iso }: { iso: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

function AuditLine({ audit, counts }: { audit: AuditFrame | null; counts: SeatCounts }) {
  if (audit && !audit.ok) {
    return (
      <p className="text-xs font-medium text-danger" role="alert">
        Audit found {plural(audit.violations, "violation")} · <Ago iso={audit.at} />
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <InvariantBadge ok={counts.invariant_ok} />
      {audit && (
        <span title="The reconciler re-checks every taken seat against its reservation">
          · audited <Ago iso={audit.at} />
        </span>
      )}
    </p>
  );
}

function ShowHeader({
  show,
  counts,
  link,
  audit,
}: {
  show: ShowDetail;
  counts: SeatCounts;
  link: LinkState;
  audit: AuditFrame | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Link to="/shows" className="w-fit text-[0.8125rem] text-muted hover:text-ink">
        ← Shows
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-semibold">{show.name}</h1>
            {show.ephemeral && <Pill tone="amber">Burst</Pill>}
            <LiveBadge link={link} />
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
          <Occupancy counts={counts} compact />
          <AuditLine audit={audit} counts={counts} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Booking state                                                                               */

type Outcome =
  | { kind: "retrying"; attempt: number }
  | { kind: "created"; reservation: Reservation; replayed: boolean }
  | { kind: "failed"; error: unknown; retry: string[] | null }
  | { kind: "seat_taken"; taken: string[]; kept: string[] }
  | { kind: "limit"; limit: number; active: number }
  | { kind: "pick_limit"; limit: number; active: number }
  | { kind: "sign_in" }
  | { kind: "done"; action: "confirm" | "cancel"; reservation: Reservation; replayed: boolean };

/** One reserve attempt: the key is reused for every retry of the same seat set. */
type Attempt = { key: string; seats: string };

function errorDetail<T>(err: ApiError, field: string, fallback: T): T {
  const v = err.details[field];
  return v === undefined ? fallback : (v as T);
}

/* ------------------------------------------------------------------------------------------ */
/* Notices                                                                                     */

function OutcomeNotice({
  outcome,
  show,
  onReserve,
  onDismiss,
}: {
  outcome: Outcome;
  show: ShowDetail;
  onReserve: (labels: string[]) => void;
  onDismiss: () => void;
}) {
  const location = useLocation();
  const dismiss = (
    <Button variant="ghost" size="sm" onClick={onDismiss}>
      Dismiss
    </Button>
  );
  const signIn = (
    <Link
      to={`/login?next=${encodeURIComponent(location.pathname)}`}
      className={buttonClass("secondary", "sm")}
    >
      Sign in
    </Link>
  );
  switch (outcome.kind) {
    case "retrying":
      return (
        <Notice tone="amber" title="The box office is busy">
          Retrying ({outcome.attempt} of {RESERVE_ATTEMPTS}) with the same request key, so this
          can't book twice.
        </Notice>
      );
    case "created": {
      const r = outcome.reservation;
      const held = r.status === "held";
      return (
        <Notice
          tone="success"
          title={`${held ? "Held" : "Booked"} ${seatList(r.seats)}`}
          action={dismiss}
        >
          {held
            ? `Confirm below within ${ttlText(show.hold_ttl_seconds ?? 0)}, or the seats go back on sale.`
            : `${plural(r.seats.length, "seat")} for ${rupees(r.amount_paise)}. They're yours.`}
          {outcome.replayed && (
            <span className="mt-1 block text-muted">
              An earlier try had already gone through, so this is that same booking (an idempotent
              replay).
            </span>
          )}
        </Notice>
      );
    }
    case "failed": {
      const err = outcome.error;
      if (err instanceof ApiError && err.status === 401) {
        return (
          <Notice title="Your session has expired" action={signIn}>
            Sign in again to book. Nothing was reserved.
          </Notice>
        );
      }
      const retry = outcome.retry;
      return (
        <Notice
          title={retry ? "Couldn't reach the box office" : "That didn't go through"}
          action={
            retry ? (
              <Button size="sm" onClick={() => onReserve(retry)}>
                Try again
              </Button>
            ) : (
              dismiss
            )
          }
        >
          {describeError(err)}
          {retry &&
            " Your seats may not be reserved. Trying again is safe: it reuses the same request key, so it can't book twice."}{" "}
          {err instanceof ApiError && <RequestId id={err.requestId} />}
        </Notice>
      );
    }
    case "seat_taken": {
      const { taken, kept } = outcome;
      const verb = taken.length === 1 ? "was" : "were";
      return (
        <Notice
          tone="amber"
          title={`${seatList(taken)} ${verb} just taken`}
          action={
            kept.length > 0 ? (
              <span className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={() => onReserve(kept)}>
                  {show.hold_ttl_seconds ? "Hold" : "Book"} {seatList(kept)}
                </Button>
                {dismiss}
              </span>
            ) : (
              dismiss
            )
          }
        >
          {kept.length > 0
            ? `Someone got there first. Keep ${seatList(kept)}?`
            : "Someone got there first. Pick other seats."}
        </Notice>
      );
    }
    case "limit":
      return (
        <Notice tone="amber" title="That's over the per-person limit" action={dismiss}>
          Up to {outcome.limit} seats per person for this show, and you already have{" "}
          {outcome.active}.
          {outcome.limit > outcome.active && ` Pick ${outcome.limit - outcome.active} or fewer.`}
        </Notice>
      );
    case "pick_limit":
      return (
        <Notice tone="neutral" title={`Up to ${outcome.limit} seats per person`} action={dismiss}>
          {outcome.active > 0
            ? `You already have ${outcome.active} for this show, so you can pick ${Math.max(0, outcome.limit - outcome.active)} more.`
            : "Unpick a seat to choose a different one."}
        </Notice>
      );
    case "sign_in":
      return (
        <Notice tone="neutral" title="Sign in to pick seats" action={signIn}>
          Any username works. Your seats count toward the per-person limit.
        </Notice>
      );
    case "done": {
      const r = outcome.reservation;
      return outcome.action === "confirm" ? (
        <Notice tone="success" title={`Booked ${seatList(r.seats)}`} action={dismiss}>
          {rupees(r.amount_paise)}. They're yours.
        </Notice>
      ) : (
        <Notice tone="neutral" title={`Gave back ${seatList(r.seats)}`} action={dismiss}>
          {outcome.replayed ? "They had already been released." : "They're back on sale."}
        </Notice>
      );
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The hall                                                                                    */

function seatStateText(code: string | undefined, mine: boolean, selected: boolean): string {
  if (selected) return "your pick";
  if (mine && code === "c") return "yours";
  if (mine && code === "h") return "your hold";
  if (code === "c") return "sold";
  if (code === "h") return "held";
  return "available";
}

function SeatTooltip({
  geometry,
  metrics,
  index,
  text,
}: {
  geometry: HallGeometry;
  metrics: HallMetrics;
  index: number;
  text: string;
}) {
  const rect = seatRect(geometry, metrics, index);
  if (!rect) return null;
  const below = rect.y < 36;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-(--z-popover) rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-xs whitespace-nowrap text-ink shadow-lg shadow-black/40"
      style={{
        left: rect.x + rect.size / 2,
        top: below ? rect.y + rect.size + 6 : rect.y - 6,
        transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
      }}
    >
      {text}
    </div>
  );
}

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function LiveHall({
  show,
  geometry,
  live,
  mine,
  selection,
  onToggle,
  onClear,
}: {
  show: ShowDetail;
  geometry: HallGeometry;
  live: LiveShow;
  mine: ReadonlySet<number>;
  selection: readonly number[];
  onToggle: (index: number) => void;
  onClear: () => void;
}) {
  const helpId = useId();
  const [metrics, setMetrics] = useState<HallMetrics | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const status = live.status ?? "";
  const selected = useMemo(() => new Set(selection), [selection]);

  const describe = useCallback(
    (i: number) => {
      const cell = geometry.bySeat[i];
      const state = seatStateText(status[i], mine.has(i), selected.has(i));
      const price =
        state === "available" || state === "your pick" ? ` · ${rupees(show.price_paise)}` : "";
      return `${cell?.label ?? ""} · ${state}${price}`;
    },
    [geometry, status, mine, selected, show.price_paise],
  );

  const paint = useMemo<HallPaint>(
    () => ({
      status,
      mine,
      selected,
      focus: focused ? focus : null,
      flashes: live.flashes,
    }),
    [status, mine, selected, focused, focus, live.flashes],
  );

  // The focus ring and its tooltip are for keyboard users: a mouse click focuses the canvas too.
  const interaction: HallInteraction = {
    onSeatClick: (i) => {
      setFocus(i);
      onToggle(i);
    },
    onSeatHover: setHover,
    clickable: (i) => status[i] === "a",
    describedBy: helpId,
    onFocus: (e) => {
      setFocused(e.currentTarget.matches(":focus-visible"));
      if (focus === null) {
        const start = selection[0] ?? status.indexOf("a");
        setFocus(start >= 0 ? start : (geometry.seats[0]?.index ?? null));
      }
    },
    onBlur: () => setFocused(false),
    onKeyDown: (e: KeyboardEvent<HTMLCanvasElement>) => {
      const dir = ARROWS[e.key];
      if (dir || e.key === "Enter" || e.key === " ") setFocused(true);
      if (dir && focus !== null) {
        e.preventDefault();
        const next = neighbor(geometry, focus, dir);
        if (next !== null) setFocus(next);
      } else if ((e.key === "Enter" || e.key === " ") && focus !== null) {
        e.preventDefault();
        onToggle(focus);
      } else if (e.key === "Escape" && selection.length > 0) {
        e.preventDefault();
        onClear();
      }
    },
  };

  const counts = live.counts ?? show.counts;
  return (
    <section aria-label="Seat map" className="flex min-w-0 flex-col gap-4">
      <div className="rounded-lg border border-line bg-surface/40 px-2 py-6 sm:px-6">
        <Screen />
        <HallCanvas
          geometry={geometry}
          paint={paint}
          minPitch={COARSE_POINTER ? 14 : 10}
          label={`Seat map: ${counts.available} of ${counts.total} seats available`}
          className="overflow-x-auto"
          onMetrics={setMetrics}
          interaction={interaction}
        >
          {metrics && hover !== null && (
            <SeatTooltip
              geometry={geometry}
              metrics={metrics}
              index={hover}
              text={describe(hover)}
            />
          )}
          {metrics && focused && focus !== null && hover === null && (
            <SeatTooltip
              geometry={geometry}
              metrics={metrics}
              index={focus}
              text={describe(focus)}
            />
          )}
        </HallCanvas>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <HallLegend showMine />
        <p id={helpId} className="text-xs text-muted">
          <span className="sm:hidden">Tap free seats to pick them.</span>
          <span className="hidden sm:inline">
            Click seats to pick them. On the keyboard: arrows move, Enter picks, Esc clears.
          </span>
        </p>
      </div>
      <p className="sr-only" aria-live="polite">
        {focused && focus !== null ? describe(focus) : ""}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The booking panel                                                                           */

function PickCard({
  show,
  labels,
  remaining,
  active,
  pending,
  onRemove,
  onClear,
  onReserve,
}: {
  show: ShowDetail;
  labels: string[];
  remaining: number;
  active: number;
  pending: boolean;
  onRemove: (label: string) => void;
  onClear: () => void;
  onReserve: () => void;
}) {
  const hold = show.hold_ttl_seconds !== null;
  const total = labels.length * show.price_paise;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[0.9375rem] font-medium">Your pick</h2>
        <span className="tabular text-xs text-muted">
          {labels.length} / {Math.max(0, remaining)}
        </span>
      </div>
      {labels.length === 0 ? (
        <p className="text-[0.8125rem] text-ink-2">
          {remaining > 0
            ? `Choose free seats on the map, up to ${plural(remaining, "seat")}.`
            : `You have ${active} of ${show.per_user_limit} seats for this show, the most one person can hold.`}
        </p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5" aria-label="Picked seats">
            {labels.map((label) => (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => onRemove(label)}
                  disabled={pending}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/50 bg-primary-soft pr-1.5 pl-2 font-mono text-xs text-primary-ink transition-colors duration-150 hover:border-primary-ink disabled:opacity-50"
                  aria-label={`Unpick ${label}`}
                >
                  {label}
                  <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
                    <path
                      d="M3 3l6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          <div className="tabular flex items-baseline justify-between text-[0.8125rem] text-ink-2">
            <span>
              {labels.length} × {rupees(show.price_paise)}
            </span>
            <span className="text-base font-medium text-ink">{rupees(total)}</span>
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="primary" loading={pending} onClick={onReserve}>
              {pending
                ? "Reserving…"
                : `${hold ? "Hold" : "Book"} ${plural(labels.length, "seat")}`}
            </Button>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted">
                {hold
                  ? `You'll have ${ttlText(show.hold_ttl_seconds!)} to confirm.`
                  : "Confirms instantly. You can cancel later."}
              </p>
              <Button variant="ghost" size="sm" onClick={onClear} disabled={pending}>
                Clear
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The phone's booking bar: the panel sits below the map there, out of reach mid-pick. */
function MobileBar({
  show,
  labels,
  pending,
  hint,
  onReserve,
}: {
  show: ShowDetail;
  labels: string[];
  pending: boolean;
  hint: string | null;
  onReserve: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-line bg-bg/95 px-4 py-3 backdrop-blur-sm lg:hidden">
      {hint && <p className="mx-auto mb-2 max-w-6xl text-xs text-amber">{hint}</p>}
      {labels.length > 0 && (
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-[0.8125rem] text-ink">{labels.join(" ")}</p>
            <p className="tabular text-xs text-muted">{rupees(labels.length * show.price_paise)}</p>
          </div>
          <Button variant="primary" loading={pending} onClick={onReserve}>
            {show.hold_ttl_seconds !== null ? "Hold" : "Book"} {plural(labels.length, "seat")}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The page                                                                                    */

function isActive(r: Reservation, now: number): boolean {
  if (r.status === "confirmed") return true;
  return r.status === "held" && r.expires_at !== null && Date.parse(r.expires_at) > now;
}

function LiveShowPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const { session, signOut } = useSession();
  const [streamUp, setStreamUp] = useState(false);
  const show = useShow(id, { poll: !streamUp });
  const data = show.data;
  const geometry = useMemo(
    () =>
      data
        ? hallGeometry(
            data.seats.map((s) => s.label),
            data.layout,
          )
        : null,
    [data],
  );
  const live = useLiveShow(id, data, geometry, {
    onGone: () => void qc.invalidateQueries({ queryKey: keys.show(id) }),
    // While the stream is down, the REST read polls instead.
    onLink: (link) => setStreamUp(link === "live"),
  });

  const mineQuery = useMyReservations(session, id);
  const myReservations = useMemo(() => mineQuery.data ?? [], [mineQuery.data]);
  const [nowTick, setNowTick] = useState(serverNow);
  const activeMine = useMemo(
    () => myReservations.filter((r) => isActive(r, nowTick)),
    [myReservations, nowTick],
  );
  const mine = useMemo(() => {
    const set = new Set<number>();
    for (const r of activeMine)
      for (const label of r.seats) {
        const i = geometry?.byLabel.get(label);
        if (i !== undefined) set.add(i);
      }
    return set;
  }, [activeMine, geometry]);
  const activeSeats = mine.size;
  const limit = data?.per_user_limit ?? 0;

  const [selection, setSelection] = useState<number[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const noticesRef = useRef<HTMLDivElement>(null);

  // On a phone the notices sit below the map: bring a booking's result into view. On a desktop
  // the panel is sticky beside the map, so "nearest" doesn't move anything.
  useEffect(() => {
    if (!outcome || outcome.kind === "pick_limit" || outcome.kind === "retrying") return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    noticesRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [outcome]);

  const status = live.status ?? "";
  const labelOf = useCallback((i: number) => geometry?.bySeat[i]?.label ?? "", [geometry]);
  const inFlight = useMemo(() => new Set(pending ?? []), [pending]);
  // Picked seats someone else took while we looked: the stream says so before any request.
  const sniped = useMemo(
    () =>
      selection.filter(
        (i) =>
          status[i] !== undefined && status[i] !== "a" && !mine.has(i) && !inFlight.has(labelOf(i)),
      ),
    [selection, status, mine, inFlight, labelOf],
  );
  const picks = useMemo(() => selection.filter((i) => !sniped.includes(i)), [selection, sniped]);
  const pickLabels = picks.map(labelOf);

  // Our own seats changing under us (another tab, the sweeper) or a "taken" seat that may be
  // ours from another tab: our copy of "my reservations" is stale, so re-read it once.
  const staleKey = `${sniped.join(",")}|${[...mine].filter((i) => status[i] === "a").join(",")}`;
  const lastStale = useRef("|");
  useEffect(() => {
    if (staleKey === lastStale.current) return;
    lastStale.current = staleKey;
    if (staleKey !== "|") void qc.invalidateQueries({ queryKey: keys.mine });
  }, [staleKey, qc]);

  const toggle = (i: number) => {
    if (!session) return setOutcome({ kind: "sign_in" });
    if (pending) return;
    if (selection.includes(i)) {
      setSelection((s) => s.filter((x) => x !== i));
      setOutcome((o) => (o?.kind === "pick_limit" ? null : o));
      return;
    }
    if (status[i] !== "a") return;
    if (picks.length >= limit - activeSeats) {
      setOutcome({ kind: "pick_limit", limit, active: activeSeats });
      return;
    }
    setOutcome((o) => (o?.kind === "pick_limit" || o?.kind === "seat_taken" ? null : o));
    // Picking again also drops seats that went to someone else.
    setSelection([...picks, i]);
  };

  const reserve = useCallback(
    async (labels: string[]) => {
      if (!session || labels.length === 0) return;
      const seats = [...labels].sort().join(",");
      if (attemptRef.current?.seats !== seats) {
        attemptRef.current = { key: newIdempotencyKey(), seats };
      }
      const { key } = attemptRef.current;
      setPending(labels);
      setOutcome(null);
      try {
        const res = await withRetries(
          () =>
            request<Reservation>(`/shows/${encodeURIComponent(id)}/reserve`, {
              method: "POST",
              body: { seats: labels },
              bearer: session.token,
              headers: { "idempotency-key": key },
            }),
          {
            attempts: RESERVE_ATTEMPTS,
            onRetry: (attempt) => setOutcome({ kind: "retrying", attempt }),
          },
        );
        attemptRef.current = null;
        const r = res.data;
        rememberReservation(qc, session.userId, r);
        live.assume(r.seats, r.status === "held" ? "h" : "c");
        setSelection([]);
        setOutcome({
          kind: "created",
          reservation: r,
          replayed: res.headers.get("idempotent-replayed") === "true",
        });
      } catch (err) {
        if (isTransient(err)) {
          // It may have gone through; keep the key so "Try again" can only replay it.
          void qc.invalidateQueries({ queryKey: keys.mine });
          setOutcome({ kind: "failed", error: err, retry: labels });
          return;
        }
        attemptRef.current = null;
        if (err instanceof ApiError && err.code === "seat_taken") {
          const taken = errorDetail<string[]>(err, "unavailable_seats", []);
          const kept = labels.filter((l) => !taken.includes(l));
          setSelection((s) => s.filter((i) => !taken.includes(labelOf(i))));
          setOutcome({ kind: "seat_taken", taken, kept });
        } else if (err instanceof ApiError && err.code === "per_user_limit") {
          void qc.invalidateQueries({ queryKey: keys.mine });
          setOutcome({
            kind: "limit",
            limit: errorDetail(err, "limit", limit),
            active: errorDetail(err, "active", activeSeats),
          });
        } else {
          if (err instanceof ApiError && err.status === 401) signOut();
          setOutcome({ kind: "failed", error: err, retry: null });
        }
      } finally {
        setPending(null);
      }
    },
    [session, id, qc, live, labelOf, limit, activeSeats, signOut],
  );

  // Re-evaluate which holds are still live once a second (cheap: a handful of reservations).
  useEffect(() => {
    if (!myReservations.some((r) => r.status === "held")) return;
    const t = setInterval(() => setNowTick(serverNow()), 1_000);
    return () => clearInterval(t);
  }, [myReservations]);

  if (show.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy>
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-3 w-96 max-w-full" />
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }
  if (show.isError || !data || !geometry) {
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

  const counts = live.counts ?? data.counts;
  const remaining = limit - activeSeats;
  // "Held, confirm below" stops being true once that hold is confirmed, released or lapses.
  const mobileHint =
    outcome?.kind === "pick_limit"
      ? `Up to ${outcome.limit} seats per person; you have ${outcome.active}.`
      : null;
  const shownOutcome =
    outcome?.kind === "created" &&
    outcome.reservation.status === "held" &&
    !activeMine.some((r) => r.reservation_id === outcome.reservation.reservation_id)
      ? null
      : outcome;
  const reservePicks = () => void reserve(pickLabels);
  const forShow = myReservations.slice(0, 8);

  return (
    <div
      className={cx(
        "flex flex-col gap-8",
        session && (picks.length > 0 || mobileHint) && "pb-24 lg:pb-0",
      )}
    >
      <ShowHeader show={data} counts={counts} link={live.link} audit={live.audit} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <LiveHall
          show={data}
          geometry={geometry}
          live={live}
          mine={mine}
          selection={selection}
          onToggle={toggle}
          onClear={() => setSelection([])}
        />
        <aside
          aria-label="Booking"
          className="flex flex-col gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
        >
          <div
            ref={noticesRef}
            aria-live="polite"
            className="flex scroll-mt-20 flex-col gap-4 empty:hidden"
          >
            {sniped.length > 0 && !pending && (
              <Notice tone="amber" title={`${seatList(sniped.map(labelOf))} just went`}>
                Someone else took {sniped.length === 1 ? "it" : "them"} while you were choosing.
                {picks.length > 0 ? ` You still have ${seatList(pickLabels)}.` : " Pick another."}
              </Notice>
            )}
            {shownOutcome && (
              <OutcomeNotice
                outcome={shownOutcome}
                show={data}
                onReserve={(labels) => void reserve(labels)}
                onDismiss={() => setOutcome(null)}
              />
            )}
          </div>
          {session ? (
            <PickCard
              show={data}
              labels={pickLabels}
              remaining={remaining}
              active={activeSeats}
              pending={pending !== null}
              onRemove={(label) => setSelection((s) => s.filter((i) => labelOf(i) !== label))}
              onClear={() => setSelection([])}
              onReserve={reservePicks}
            />
          ) : (
            outcome?.kind !== "sign_in" && <SignInCard />
          )}
          {session && forShow.length > 0 && (
            <MyBookings
              reservations={forShow}
              total={myReservations.length}
              session={session}
              show={data}
              onDone={(r, action, replayed) => {
                live.assume(r.seats, action === "confirm" ? "c" : "a");
                setOutcome({ kind: "done", action, reservation: r, replayed });
              }}
              onLapse={() => void qc.invalidateQueries({ queryKey: keys.mine })}
            />
          )}
        </aside>
      </div>
      {session && (picks.length > 0 || mobileHint) && (
        <MobileBar
          show={data}
          labels={pickLabels}
          pending={pending !== null}
          hint={mobileHint}
          onReserve={reservePicks}
        />
      )}
    </div>
  );
}

function SignInCard() {
  const location = useLocation();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface/60 p-4">
      <h2 className="text-[0.9375rem] font-medium">Pick your seats</h2>
      <p className="text-[0.8125rem] text-ink-2">
        Sign in with any username to book. Open a second tab as someone else and race yourself for
        the same seat.
      </p>
      <Link
        to={`/login?next=${encodeURIComponent(location.pathname)}`}
        className={cx(buttonClass("primary", "sm"), "w-fit")}
      >
        Sign in
      </Link>
    </div>
  );
}

function MyBookings({
  reservations,
  total,
  session,
  show,
  onDone,
  onLapse,
}: {
  reservations: Reservation[];
  total: number;
  session: Session;
  show: ShowDetail;
  onDone: (r: Reservation, action: "confirm" | "cancel", replayed: boolean) => void;
  onLapse: () => void;
}): ReactNode {
  return (
    <section aria-label="Your bookings for this show" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[0.9375rem] font-medium">Your bookings here</h2>
        <Link to="/bookings" className="text-xs text-muted hover:text-ink">
          All bookings{total > reservations.length ? ` (${total})` : ""} →
        </Link>
      </div>
      <ul className="flex flex-col gap-2">
        {reservations.map((r) => (
          <BookingCard
            key={r.reservation_id}
            reservation={r}
            session={session}
            holdTtlSeconds={show.hold_ttl_seconds}
            onDone={onDone}
            onLapse={onLapse}
          />
        ))}
      </ul>
    </section>
  );
}

export function ShowPage() {
  const { id = "" } = useParams();
  // A new show is a new page: fresh stream, selection and notices.
  return <LiveShowPage key={id} id={id} />;
}
