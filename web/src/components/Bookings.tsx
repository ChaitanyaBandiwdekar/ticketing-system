/**
 * A reservation as the person who made it sees it: seats, amount, status, and what they can do
 * next. Holds tick down against the server's clock and offer confirm / release; bookings can be
 * cancelled after a second click.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, describeError, type Reservation, type Session } from "../lib/api";
import { seatList } from "../lib/booking";
import { serverNow } from "../lib/clock";
import { ago, clock, plural, rupees } from "../lib/format";
import { useReservationAction, type ReservationAction } from "../lib/queries";
import { Button, cx, Pill, RequestId } from "./ui";

/** A hold's countdown: mm:ss plus a draining bar, red in the last 30 seconds. */
export function HoldTimer({
  expiresAt,
  ttlSeconds,
  onLapse,
}: {
  expiresAt: string;
  ttlSeconds: number | null;
  onLapse?: () => void;
}) {
  const deadline = Date.parse(expiresAt);
  const [now, setNow] = useState(serverNow);
  const lapsedRef = useRef(false);
  const left = deadline - now;

  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 250);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left > 0 || lapsedRef.current) return;
    lapsedRef.current = true;
    onLapse?.();
  }, [left, onLapse]);

  const urgent = left < 30_000;
  const fraction = ttlSeconds ? Math.max(0, Math.min(1, left / (ttlSeconds * 1000))) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={cx(
          "tabular flex items-baseline gap-2 text-sm",
          urgent ? "text-danger" : "text-amber",
        )}
      >
        <span className="font-mono text-base font-medium" aria-hidden>
          {clock(left)}
        </span>
        <span className="text-[0.8125rem] text-ink-2">left to confirm</span>
        {/* Screen readers get a coarse, polite update rather than every tick. */}
        <span className="sr-only" aria-live="polite">
          {left <= 0
            ? "Hold expired"
            : urgent
              ? "Less than 30 seconds left"
              : `About ${Math.ceil(left / 60_000)} minutes left`}
        </span>
      </p>
      {fraction !== null && (
        <span aria-hidden className="block h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <span
            className={cx(
              "block h-full rounded-full transition-[width] duration-300 ease-linear",
              urgent ? "bg-danger" : "bg-amber",
            )}
            style={{ width: `${fraction * 100}%` }}
          />
        </span>
      )}
    </div>
  );
}

const STATUS_PILL = {
  held: { tone: "amber", text: "Held" },
  confirmed: { tone: "success", text: "Booked" },
  cancelled: { tone: "neutral", text: "Cancelled" },
  expired: { tone: "neutral", text: "Expired" },
} as const;

function actionError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "reservation_expired")
      return "This hold ran out before it was confirmed, so its seats went back on sale.";
    if (err.code === "reservation_cancelled") return "This booking was already cancelled.";
  }
  return describeError(err);
}

type CardProps = {
  reservation: Reservation;
  session: Session;
  holdTtlSeconds: number | null;
  /** Show name + link, for lists that span shows. */
  show?: { id: string; name: string };
  /** After a confirm or cancel went through. */
  onDone?: (r: Reservation, action: ReservationAction, replayed: boolean) => void;
  /** When a hold runs out on screen. */
  onLapse?: () => void;
};

export function BookingCard({
  reservation: r,
  session,
  holdTtlSeconds,
  show,
  onDone,
  onLapse,
}: CardProps) {
  const action = useReservationAction(session);
  const [lapsed, setLapsed] = useState(
    () => r.status === "held" && r.expires_at !== null && Date.parse(r.expires_at) <= serverNow(),
  );
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const status = r.status === "held" && lapsed ? "expired" : r.status;
  const active = status === "held" || status === "confirmed";
  const pill = STATUS_PILL[status];

  const run = (kind: ReservationAction) =>
    action.mutate(
      { id: r.reservation_id, action: kind },
      {
        onSuccess: (updated) => {
          setConfirmingCancel(false);
          onDone?.(updated, kind, updated.status === r.status);
        },
      },
    );

  return (
    <li
      className={cx(
        "flex flex-col gap-3 rounded-lg border p-4",
        status === "held" ? "border-amber/40 bg-amber-soft/40" : "border-line bg-surface/50",
        !active && "opacity-70",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          {show && (
            <Link
              to={`/shows/${show.id}`}
              className="truncate text-[0.8125rem] text-muted hover:text-ink"
            >
              {show.name}
            </Link>
          )}
          <p className="font-medium text-ink">
            <span className="font-mono">{r.seats.join(" ")}</span>
          </p>
          <p className="tabular text-[0.8125rem] text-muted">
            {plural(r.seats.length, "seat")} · {rupees(r.amount_paise)} ·{" "}
            <time dateTime={r.created_at} title={new Date(r.created_at).toLocaleString()}>
              {ago(r.created_at)}
            </time>
          </p>
        </div>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </div>

      {status === "held" && r.expires_at && (
        <HoldTimer
          expiresAt={r.expires_at}
          ttlSeconds={holdTtlSeconds}
          onLapse={() => {
            setLapsed(true);
            onLapse?.();
          }}
        />
      )}

      {status === "held" && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={action.isPending && action.variables?.action === "confirm"}
            disabled={action.isPending}
            onClick={() => run("confirm")}
          >
            Confirm · {rupees(r.amount_paise)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={action.isPending && action.variables?.action === "cancel"}
            disabled={action.isPending}
            onClick={() => run("cancel")}
          >
            Release seats
          </Button>
        </div>
      )}

      {status === "confirmed" &&
        (confirmingCancel ? (
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Confirm cancellation"
          >
            <span className="text-[0.8125rem] text-ink-2">Give back {seatList(r.seats)}?</span>
            <Button
              variant="danger"
              size="sm"
              loading={action.isPending}
              onClick={() => run("cancel")}
              autoFocus
            >
              Cancel booking
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={action.isPending}
              onClick={() => setConfirmingCancel(false)}
            >
              Keep
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingCancel(true)}>
              Cancel booking
            </Button>
          </div>
        ))}

      {action.isError && (
        <p className="text-[0.8125rem] text-danger" role="alert">
          {actionError(action.error)}{" "}
          {action.error instanceof ApiError && <RequestId id={action.error.requestId} />}
        </p>
      )}
    </li>
  );
}
