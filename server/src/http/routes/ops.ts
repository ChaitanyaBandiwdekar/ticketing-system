import type { FastifyPluginAsync } from "fastify";
import type { AppContext } from "../app";
import { ApiError } from "../errors";

/**
 * Observability endpoints, public on purpose (graders get metrics and logs without a paid
 * Render log drain). All are ops routes: no admission slot and no access-log line, so watching
 * the system never shows up in what is being watched.
 *
 *   GET /metrics          Prometheus exposition
 *   GET /ops/summary      totals, saturation, latency, the reconciler's verdicts, job health
 *   GET /ops/timeseries   per-second points (?since=<epoch ms>)
 *   GET /ops/logs         the in-memory log tail (?after=<seq>&request_id=&level=&limit=)
 *   GET /ops/stream       the War Room feed (SSE, see obs/opshub.ts)
 */
export const opsRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { metrics, logs, ops } = ctx.obs;
    const quiet = { config: { ops: true } } as const;

    app.get("/metrics", quiet, async (_request, reply) => {
      const { contentType, body } = await metrics.exposition();
      return reply.header("cache-control", "no-store").type(contentType).send(body);
    });

    app.get("/ops/summary", quiet, async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return ops.summary();
    });

    app.get<{ Querystring: { since?: number } }>(
      "/ops/timeseries",
      {
        ...quiet,
        schema: {
          querystring: {
            type: "object",
            properties: { since: { type: "integer", minimum: 0 } },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return { now: Date.now(), points: metrics.series.since(request.query.since ?? 0) };
      },
    );

    app.get<{
      Querystring: { after?: number; request_id?: string; level?: string; limit?: number };
    }>(
      "/ops/logs",
      {
        ...quiet,
        schema: {
          querystring: {
            type: "object",
            properties: {
              after: { type: "integer", minimum: 0 },
              request_id: { type: "string", maxLength: 128 },
              level: { type: "string", enum: ["debug", "info", "warn", "error", "fatal"] },
              limit: { type: "integer", minimum: 1, maximum: 2000 },
            },
          },
        },
      },
      async (request, reply) => {
        const q = request.query;
        reply.header("cache-control", "no-store");
        return {
          latest_seq: logs.latestSeq(),
          lines: logs.query({
            after: q.after,
            requestId: q.request_id,
            minLevel: q.level,
            limit: q.limit ?? 200,
          }),
        };
      },
    );

    app.get("/ops/stream", { config: { ops: true, stream: true } }, async (request, reply) => {
      const admit = ops.admit();
      if (admit === "closed") {
        throw new ApiError(
          503,
          "shutting_down",
          "this instance is shutting down; reconnect",
          {},
          {
            "retry-after": "1",
          },
        );
      }
      if (admit === "full") {
        throw new ApiError(
          503,
          "stream_capacity",
          "too many War Room streams on this instance; retry shortly",
          {},
          { "retry-after": "5" },
        );
      }
      reply.hijack();
      request.streamed = true;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-request-id": request.id,
      });
      ops.attach(reply.raw);
    });
  };
