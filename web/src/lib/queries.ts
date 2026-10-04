import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, type ShowDetail, type ShowLayout, type ShowSummary } from "./api";

export const keys = {
  shows: (includeEphemeral: boolean) => ["shows", { includeEphemeral }] as const,
  show: (id: string) => ["show", id] as const,
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

export function useShow(id: string) {
  return useQuery({
    queryKey: keys.show(id),
    queryFn: ({ signal }) => get<ShowDetail>(`/shows/${encodeURIComponent(id)}`, { signal }),
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
