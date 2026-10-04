import type { FastifyPluginAsync } from "fastify";
import { insertRun, listRuns } from "../../engine/runs";
import type { RunReport } from "../../obs/types";
import type { AppContext } from "../app";

/**
 * Burst runs: what the War Room's scorecard shows after the per-second window has moved on.
 *
 *   POST /ops/runs   admin key; a burst's final report. Fields the page doesn't render are
 *                    dropped by the schema; the server audits the show and stores its verdict too.
 *   GET  /ops/runs   public; the newest runs first (?limit=, at most 20)
 */

const count = { type: "integer", minimum: 0 } as const;
const counts = {
  type: "object",
  maxProperties: 50,
  additionalProperties: { type: "integer", minimum: 0 },
} as const;
const ms = { type: "number", minimum: 0 } as const;

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ok",
    "show",
    "durationMs",
    "outcomes",
    "scenarios",
    "status",
    "retries",
    "reserveRequests",
    "throughput",
    "latency",
    "slowest",
    "final",
    "checks",
  ],
  properties: {
    ok: { type: "boolean" },
    show: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "total_seats"],
      properties: {
        id: {
          type: "string",
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        },
        name: { type: "string", minLength: 1, maxLength: 200 },
        total_seats: count,
      },
    },
    durationMs: ms,
    outcomes: counts,
    scenarios: { type: "object", maxProperties: 20, additionalProperties: counts },
    status: {
      type: "object",
      additionalProperties: false,
      required: ["2xx", "4xx", "429", "5xx", "network"],
      properties: { "2xx": count, "4xx": count, "429": count, "5xx": count, network: count },
    },
    retries: count,
    reserveRequests: count,
    throughput: ms,
    latency: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["p50", "p95", "p99", "max"],
      properties: { p50: ms, p95: ms, p99: ms, max: ms },
    },
    slowest: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requestId", "ms", "outcome"],
        properties: {
          requestId: { type: "string", maxLength: 128 },
          ms,
          outcome: { type: "string", maxLength: 64 },
        },
      },
    },
    final: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["total", "available", "held", "confirmed"],
      properties: { total: count, available: count, held: count, confirmed: count },
    },
    checks: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "ok", "detail"],
        properties: {
          name: { type: "string", maxLength: 200 },
          ok: { type: "boolean" },
          detail: { type: "string", maxLength: 1000 },
        },
      },
    },
    settings: {
      type: "object",
      additionalProperties: false,
      required: ["concurrency", "perUserLimit"],
      properties: { concurrency: count, perUserLimit: count },
    },
  },
} as const;

export const runRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { sql, db } = ctx;

    app.post<{ Body: RunReport }>(
      "/ops/runs",
      {
        // Authenticate before validating: no credentials -> 401, never a 400 that leaks the schema.
        onRequest: async (request) => ctx.auth.requireAdmin(request),
        bodyLimit: 64 * 1024,
        schema: { body: reportSchema },
      },
      async (request, reply) => {
        const run = await db(insertRun(sql, request.body));
        reply.header("cache-control", "no-store");
        return reply.code(201).send(run);
      },
    );

    app.get<{ Querystring: { limit?: number } }>(
      "/ops/runs",
      {
        config: { ops: true },
        schema: {
          querystring: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
          },
        },
      },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        return { runs: await db(listRuns(sql, request.query.limit ?? 5)) };
      },
    );
  };
