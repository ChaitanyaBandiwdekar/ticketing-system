/**
 * One error shape for every non-2xx response: {error: {code, message, request_id, ...details}}.
 * Domain declines are deliberate 4xx; anything the client could not have caused is 503 (database
 * unreachable or contended: retry later) or, only for genuine bugs, 500.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ContentionError, sqlStateOf } from "../db/retry";

export type ErrorCode =
  | "validation_error"
  | "unknown_seats"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "show_not_found"
  | "reservation_not_found"
  | "seat_taken"
  | "per_user_limit"
  | "reservation_expired"
  | "reservation_cancelled"
  | "idempotency_key_reused"
  | "payload_too_large"
  | "unsupported_media_type"
  | "overloaded"
  | "stream_capacity"
  | "contention"
  | "db_unavailable"
  | "shutting_down"
  | "internal";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(request: FastifyRequest, err: ApiError) {
  return {
    error: { code: err.code, message: err.message, request_id: request.id, ...err.details },
  };
}

export function sendError(request: FastifyRequest, reply: FastifyReply, err: ApiError) {
  request.errorCode = err.code;
  for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
  return reply.code(err.statusCode).send(errorBody(request, err));
}

/** postgres.js connection-level failures (no SQLSTATE) that mean "database unreachable". */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  // db/deadline.ts: no answer within DB_REQUEST_TIMEOUT_MS (e.g. a pooler queueing for a dead DB).
  "DB_DEADLINE",
]);

/**
 * SQLSTATEs meaning the database (or the pooler in front of it) can't serve us right now:
 * class 08 connection exceptions, 53 insufficient resources (e.g. too_many_connections),
 * 57P01-57P03 admin/crash shutdown or "cannot connect now".
 */
function isUnavailableSqlState(state: string): boolean {
  return state.startsWith("08") || state.startsWith("53") || /^57P0[1-3]$/.test(state);
}

/** True when the error means "database (or pooler) unreachable / not accepting us right now". */
export function isDbUnavailable(err: unknown): boolean {
  const state = sqlStateOf(err);
  return state !== undefined && (CONNECTION_ERROR_CODES.has(state) || isUnavailableSqlState(state));
}

/** Maps any thrown error to the ApiError we answer with. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ContentionError) {
    return new ApiError(
      503,
      "contention",
      "the database is busy; retry shortly",
      {},
      {
        "retry-after": "1",
      },
    );
  }

  // `throw null` is legal JS; never let the error handler itself crash on it.
  const fe = (err ?? {}) as Partial<FastifyError>;
  if (fe.validation) {
    return new ApiError(400, "validation_error", fe.message ?? "invalid request");
  }
  if (fe.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new ApiError(413, "payload_too_large", "request body is too large");
  }
  if (fe.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return new ApiError(415, "unsupported_media_type", "send application/json");
  }
  if (typeof fe.statusCode === "number" && fe.statusCode >= 400 && fe.statusCode < 500) {
    // Fastify's own client errors (malformed JSON, empty JSON body, bad headers...).
    return new ApiError(400, "validation_error", fe.message ?? "bad request");
  }

  if (isDbUnavailable(err)) {
    return new ApiError(
      503,
      "db_unavailable",
      "the database is unavailable; retry shortly",
      {},
      {
        "retry-after": "2",
      },
    );
  }
  return new ApiError(500, "internal", "internal error");
}
