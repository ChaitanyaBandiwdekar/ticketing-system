import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { cancel, confirm, listReservations } from "../../engine/lifecycle";
import { reserve } from "../../engine/reserve";
import type { LifecycleOutcome, ReserveOutcome } from "../../engine/types";
import type { AppContext } from "../app";
import { ApiError, sendError } from "../errors";
import { reservationSchema, uuidParam } from "../schemas";

type ReserveBody = { seats: string[]; idempotency_key?: string; user_id?: unknown };

const REPLAY_HEADER = "idempotent-replayed";

/**
 * Resolves the idempotency key. The IETF Idempotency-Key header is preferred; a body field is
 * accepted for clients that can't set headers. Both present and different is ambiguous -> 400.
 */
function idempotencyKey(request: FastifyRequest<{ Body: ReserveBody }>): string {
  const header = request.headers["idempotency-key"];
  if (Array.isArray(header)) {
    throw new ApiError(400, "validation_error", "send exactly one Idempotency-Key header");
  }
  const fromBody = request.body.idempotency_key;
  if (header !== undefined && fromBody !== undefined && header !== fromBody) {
    throw new ApiError(
      400,
      "validation_error",
      "Idempotency-Key header and body idempotency_key differ",
    );
  }
  const key = header ?? fromBody;
  if (key === undefined || key.length === 0) {
    throw new ApiError(400, "validation_error", "an Idempotency-Key header is required");
  }
  if (key.length > 200) {
    throw new ApiError(400, "validation_error", "Idempotency-Key must be at most 200 characters");
  }
  return key;
}

function sendReserveOutcome(request: FastifyRequest, reply: FastifyReply, o: ReserveOutcome) {
  switch (o.outcome) {
    case "created":
      return reply.code(201).send(o.reservation);
    case "replayed":
      return reply.code(200).header(REPLAY_HEADER, "true").send(o.reservation);
    case "seat_taken":
      return sendError(
        request,
        reply,
        new ApiError(
          409,
          "seat_taken",
          `seat(s) no longer available: ${o.unavailable_seats.join(", ")}`,
          { unavailable_seats: o.unavailable_seats },
        ),
      );
    case "per_user_limit":
      return sendError(
        request,
        reply,
        new ApiError(
          409,
          "per_user_limit",
          `limit is ${o.limit} seats per user; you hold ${o.active} and asked for ${o.requested}`,
          { limit: o.limit, active: o.active, requested: o.requested },
        ),
      );
    case "idempotency_key_reused":
      return sendError(
        request,
        reply,
        new ApiError(
          422,
          "idempotency_key_reused",
          "this Idempotency-Key was already used for a different request",
        ),
      );
    case "invalid":
      return o.unknown_seats.length > 0
        ? sendError(
            request,
            reply,
            new ApiError(400, "unknown_seats", o.message, { unknown_seats: o.unknown_seats }),
          )
        : sendError(request, reply, new ApiError(400, "validation_error", o.message));
    case "show_not_found":
      return sendError(request, reply, new ApiError(404, "show_not_found", "no such show"));
  }
}

function sendLifecycleOutcome(request: FastifyRequest, reply: FastifyReply, o: LifecycleOutcome) {
  switch (o.outcome) {
    case "confirmed":
    case "cancelled":
      if (!o.changed) reply.header(REPLAY_HEADER, "true");
      return reply.code(200).send(o.reservation);
    case "reservation_expired":
      return sendError(
        request,
        reply,
        new ApiError(
          409,
          "reservation_expired",
          "the hold expired before this request; its seats may have been re-sold",
        ),
      );
    case "reservation_cancelled":
      return sendError(
        request,
        reply,
        new ApiError(409, "reservation_cancelled", "the reservation was cancelled"),
      );
    case "forbidden":
      return sendError(
        request,
        reply,
        new ApiError(403, "forbidden", "this reservation belongs to another user"),
      );
    case "not_found":
      return sendError(
        request,
        reply,
        new ApiError(404, "reservation_not_found", "no such reservation"),
      );
  }
}

export const reservationRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { sql, bus, db } = ctx;
    // Identity comes from the token only, resolved before the body is even validated.
    const authenticate = async (request: FastifyRequest) => {
      request.userId = ctx.auth.userFrom(request);
    };
    const replyBody = { 200: reservationSchema, 201: reservationSchema };

    app.post<{ Params: { id: string }; Body: ReserveBody }>(
      "/shows/:id/reserve",
      {
        onRequest: authenticate,
        schema: {
          params: uuidParam,
          body: {
            type: "object",
            required: ["seats"],
            properties: {
              seats: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
              idempotency_key: { type: "string" },
              // Accepted so clients that send it aren't rejected; it is never trusted.
              user_id: {},
            },
          },
          response: replyBody,
        },
      },
      async (request, reply) => {
        const userId = request.userId;
        const showId = request.params.id.toLowerCase();
        const key = idempotencyKey(request);
        const claimed = request.body.user_id;
        const spoofed = claimed !== undefined && claimed !== userId;
        if (spoofed) {
          request.log.warn({ user: userId, claimed_user: claimed }, "identity_spoof_ignored");
        }

        const o = await db(
          reserve(sql, { showId, userId, seats: request.body.seats, idempotencyKey: key }),
        );
        request.logCtx = {
          user: userId,
          show: showId,
          seats: request.body.seats,
          outcome: o.outcome,
          path: o.path,
          ...(spoofed && { spoof_ignored: true }),
        };
        // After commit: the engine call is one autocommitted statement.
        if (o.outcome === "created") {
          const r = o.reservation;
          bus.emit({ showId: r.show_id, labels: r.seats, cause: "reserve" });
        }
        return sendReserveOutcome(request, reply, o);
      },
    );

    for (const [action, fn] of [
      ["confirm", confirm],
      ["cancel", cancel],
    ] as const) {
      app.post<{ Params: { id: string } }>(
        `/reservations/:id/${action}`,
        {
          onRequest: authenticate,
          schema: { params: uuidParam, response: { 200: reservationSchema } },
        },
        async (request, reply) => {
          const reservationId = request.params.id.toLowerCase();
          const o = await db(fn(sql, { reservationId, userId: request.userId }));
          request.logCtx = {
            user: request.userId,
            reservation: reservationId,
            outcome: o.outcome,
            ...("changed" in o && { changed: o.changed }),
          };
          if ((o.outcome === "confirmed" || o.outcome === "cancelled") && o.changed) {
            bus.emit({ showId: o.reservation.show_id, labels: o.reservation.seats, cause: action });
          }
          return sendLifecycleOutcome(request, reply, o);
        },
      );
    }

    app.get<{ Querystring: { show_id?: string; limit?: number } }>(
      "/me/reservations",
      {
        onRequest: authenticate,
        schema: {
          querystring: {
            type: "object",
            properties: {
              show_id: { type: "string", maxLength: 64 },
              limit: { type: "integer", minimum: 1, maximum: 500 },
            },
          },
          response: {
            200: {
              type: "object",
              properties: { reservations: { type: "array", items: reservationSchema } },
            },
          },
        },
      },
      async (request) => ({
        reservations: await db(
          listReservations(sql, request.userId, {
            showId: request.query.show_id?.toLowerCase(),
            limit: request.query.limit,
          }),
        ),
      }),
    );
  };
