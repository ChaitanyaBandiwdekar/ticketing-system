/**
 * The one way the UI talks to the API: same origin, JSON, the API's own error shape surfaced as
 * ApiError (code + message + request id), so screens can react to codes, not status numbers.
 */
import type {
  Reservation,
  SeatCounts,
  SeatStatus,
  Show,
  ShowLayout,
} from "../../../server/src/engine/types";
import { noteServerDate } from "./clock";

export type { Reservation, SeatCounts, SeatStatus, Show, ShowLayout };
export type ShowSummary = Show & { counts: SeatCounts };
export type ShowDetail = ShowSummary & { seats: { label: string; status: SeatStatus }[] };
export type Session = { token: string; userId: string; expiresAt: number };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details: Record<string, unknown> = {},
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  /** Bearer credential: a user token or the admin key. */
  bearer?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export type ApiResponse<T> = { data: T; status: number; headers: Headers };

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection.", null);
  }

  noteServerDate(res.headers.get("date"));
  const requestId = res.headers.get("x-request-id");
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const e = (json as { error?: Record<string, unknown> } | null)?.error;
    const { code, message, request_id: _rid, ...details } = e ?? {};
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(
      res.status,
      typeof code === "string" ? code : `http_${res.status}`,
      typeof message === "string" ? message : `Request failed (${res.status})`,
      requestId,
      details,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return { data: json as T, status: res.status, headers: res.headers };
}

export async function get<T>(path: string, opts: Omit<RequestOptions, "method"> = {}): Promise<T> {
  return (await request<T>(path, opts)).data;
}

export async function post<T>(
  path: string,
  body: unknown,
  opts: Omit<RequestOptions, "method" | "body"> = {},
): Promise<T> {
  return (await request<T>(path, { ...opts, method: "POST", body })).data;
}

/** Human copy for the codes a person can hit in the UI. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  switch (err.code) {
    case "network_error":
      return err.message;
    case "unauthorized":
      return "Your session has expired. Sign in again.";
    case "forbidden":
      return err.message.includes("admin") ? "That admin key isn't valid." : err.message;
    case "overloaded":
    case "contention":
    case "db_unavailable":
    case "stream_capacity":
    case "shutting_down":
      return `The box office is busy right now. Try again${err.retryAfterS ? ` in ${err.retryAfterS}s` : " shortly"}.`;
    default:
      return err.message;
  }
}
