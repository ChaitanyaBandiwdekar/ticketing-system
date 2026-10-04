import type { FastifyPluginAsync } from "fastify";
import { isUuid } from "../../engine/ids";
import type { AppContext } from "../app";
import { ApiError } from "../errors";

/**
 * GET /stream?show=<id>: the live seat map as server-sent events (protocol in realtime/hub.ts).
 * Public, like GET /shows/:id. Errors before the stream opens (unknown show, capacity, DB down)
 * use the normal JSON error shape; once open, the stream logs one line when it closes.
 */
export const streamRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { show: string } }>(
      "/stream",
      {
        config: { stream: true },
        schema: {
          querystring: {
            type: "object",
            required: ["show"],
            properties: { show: { type: "string", maxLength: 64 } },
          },
        },
      },
      async (request, reply) => {
        const showId = request.query.show.toLowerCase();
        if (!isUuid(showId)) throw new ApiError(404, "show_not_found", "no such show");
        const draining = () =>
          new ApiError(
            503,
            "shutting_down",
            "this instance is shutting down; reconnect",
            {},
            {
              "retry-after": "1",
            },
          );
        const admit = ctx.hub.admit();
        if (admit === "closed") throw draining();
        if (admit === "full") {
          throw new ApiError(
            503,
            "stream_capacity",
            "too many live streams on this instance; retry shortly",
            {},
            { "retry-after": "5" },
          );
        }

        // Under the deadline too: a stream must not hang on a dead database either. If the deadline
        // wins, the queued snapshot later finds the response already answered and backs off.
        const result = await ctx.db(
          ctx.hub.subscribe(showId, reply.raw, {
            open: () => {
              reply.hijack();
              request.streamed = true;
              reply.raw.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                // Disables response buffering in nginx-style proxies.
                "x-accel-buffering": "no",
                "x-request-id": request.id,
              });
            },
            onClose: (frames) => {
              request.log.info(
                {
                  method: request.method,
                  route: "/stream",
                  status: 200,
                  ms: Math.round(reply.elapsedTime * 10) / 10,
                  show: showId,
                  frames,
                },
                "stream closed",
              );
            },
          }),
        );
        if (result === "not_found") throw new ApiError(404, "show_not_found", "no such show");
        if (result === "gone") {
          // Shut down while the snapshot was queued: tell a still-connected client to go elsewhere.
          if (!reply.raw.destroyed) throw draining();
          reply.hijack(); // the client already left; there is nobody to answer
        }
      },
    );
  };
