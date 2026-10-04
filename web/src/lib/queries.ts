import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  get,
  post,
  request,
  type Reservation,
  type ShowDetail,
  type ShowLayout,
  type ShowSummary,
} from "./api";
import { withRetries } from "./booking";

export const keys = {
  shows: (includeEphemeral: boolean) => ["shows", { includeEphemeral }] as const,
  show: (id: string) => ["show", id] as const,
  /** Every "my reservations" list (per show and all shows) shares this prefix. */
  mine: ["me", "reservations"] as const,
  mineFor: (userId: string, showId: string | null) =>
    ["me", "reservations", userId, showId ?? "all"] as const,
  ready: ["readyz"] as const,
};

export function useShows(includeEphemeral: boolean) {
  return useQuery({
    queryKey: keys.shows(includeEphemeral),
    queryFn: ({ signal }) =>
      get<{ shows: ShowSummary[] }>(
        `/shows?limit=100${includeEphemeral ? "&include_ephemeral=true" : ""}`,
        { signal },
      ).then((r) => r.shows),
    // The list's counts move during a burst; a light poll keeps them honest.
    refetchInterval: 5_000,
  });
}

/**
 * The REST seat map. While the live stream is up it is read once (for the show's details and a
 * first paint); when the stream is down, `poll` keeps the map fresh every 5s instead.
 */
export function useShow(id: string, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: keys.show(id),
    queryFn: ({ signal }) => get<ShowDetail>(`/shows/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: poll ? 5_000 : false,
    refetchOnWindowFocus: poll,
  });
}

/** The signed-in user's reservations (effective statuses), newest first; optionally one show's. */
export function useMyReservations(
  session: { token: string; userId: string } | null,
  showId: string | null = null,
) {
  return useQuery({
    queryKey: keys.mineFor(session?.userId ?? "", showId),
    queryFn: ({ signal }) =>
      get<{ reservations: Reservation[] }>(
        `/me/reservations?limit=100${showId ? `&show_id=${encodeURIComponent(showId)}` : ""}`,
        { signal, bearer: session?.token },
      ).then((r) => r.reservations),
    enabled: !!session,
  });
}

/** Puts a reservation the server just returned into every cached list it belongs to. */
export function rememberReservation(qc: QueryClient, userId: string, r: Reservation): void {
  for (const showId of [r.show_id, null]) {
    qc.setQueryData<Reservation[]>(keys.mineFor(userId, showId), (list) => {
      if (!list) return list;
      const i = list.findIndex((x) => x.reservation_id === r.reservation_id);
      if (i < 0) return [r, ...list];
      const next = list.slice();
      next[i] = r;
      return next;
    });
  }
  void qc.invalidateQueries({ queryKey: keys.mine });
}

export type ReservationAction = "confirm" | "cancel";

/** Confirm or cancel. Both are idempotent on the server, so transient failures are retried. */
export function useReservationAction(session: { token: string; userId: string } | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ReservationAction }) =>
      withRetries(() =>
        request<Reservation>(`/reservations/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          bearer: session?.token,
        }),
      ).then((r) => r.data),
    onSuccess: (r) => {
      if (session) rememberReservation(qc, session.userId, r);
    },
    // A 409 (lapsed, cancelled) means our copy is stale.
    onError: () => qc.invalidateQueries({ queryKey: keys.mine }),
  });
}

/** The API's readiness, shown in the top bar: is the box office able to sell right now? */
export function useReadiness() {
  return useQuery({
    queryKey: keys.ready,
    queryFn: async ({ signal }) => {
      try {
        const res = await fetch("/readyz", { signal, cache: "no-store" });
        return res.ok ? ("ready" as const) : ("unavailable" as const);
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        return "offline" as const;
      }
    },
    refetchInterval: 10_000,
    retry: false,
  });
}

export type CreateShowInput = {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit: number;
  hold_ttl_seconds: number | null;
  ephemeral: boolean;
  layout: ShowLayout;
};

export function useCreateShow(adminKey: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateShowInput) =>
      post<ShowSummary>("/shows", input, { bearer: adminKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shows"] }),
  });
}
