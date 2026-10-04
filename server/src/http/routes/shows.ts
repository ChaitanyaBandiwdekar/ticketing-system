import type { FastifyPluginAsync } from "fastify";
import { audit } from "../../engine/audit";
import { createShow, getShowSnapshot, listShows, ShowValidationError } from "../../engine/shows";
import type { AppContext } from "../app";
import { ApiError } from "../errors";
import { countsSchema, showProperties, uuidParam } from "../schemas";

type CreateShowBody = {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
  hold_ttl_seconds?: number | null;
  ephemeral?: boolean;
};

const showNotFound = () => new ApiError(404, "show_not_found", "no such show");

/** Bounded so a burst creating thousands of ephemeral shows can't grow the cache without limit. */
const SNAPSHOT_CACHE_MAX_ENTRIES = 256;

export const showRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { config, sql, db } = ctx;

    app.post<{ Body: CreateShowBody }>(
      "/shows",
      {
        // Authenticate before validating: no credentials -> 401, never a 400 that leaks the schema.
        onRequest: async (request) => ctx.auth.requireAdmin(request),
        schema: {
          body: {
            type: "object",
            required: ["name", "seats", "price_paise"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 200 },
              seats: {
                type: "array",
                minItems: 1,
                maxItems: config.reservations.maxSeatsPerShow,
                items: { type: "string" },
              },
              price_paise: { type: "integer", minimum: 1 },
              per_user_limit: { type: "integer", minimum: 1, maximum: 100 },
              hold_ttl_seconds: { type: ["integer", "null"], minimum: 1, maximum: 3600 },
              ephemeral: { type: "boolean" },
            },
          },
          response: {
            201: { type: "object", properties: showProperties },
          },
        },
      },
      async (request, reply) => {
        const b = request.body;
        try {
          const show = await db(
            createShow(
              sql,
              {
                name: b.name,
                seats: b.seats,
                pricePaise: b.price_paise,
                perUserLimit: b.per_user_limit ?? config.reservations.defaultPerUserLimit,
                holdTtlSeconds: b.hold_ttl_seconds ?? null,
                ephemeral: b.ephemeral ?? false,
              },
              { maxSeatsPerShow: config.reservations.maxSeatsPerShow },
            ),
          );
          request.logCtx = { show: show.id, seats: show.total_seats };
          const n = show.total_seats;
          return reply.code(201).send({
            ...show,
            counts: { total: n, available: n, held: 0, confirmed: 0, invariant_ok: true },
          });
        } catch (err) {
          if (err instanceof ShowValidationError) {
            throw new ApiError(400, "validation_error", err.message, { issues: err.issues });
          }
          throw err;
        }
      },
    );

    app.get<{ Querystring: { include_ephemeral?: boolean; limit?: number } }>(
      "/shows",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              include_ephemeral: { type: "boolean" },
              limit: { type: "integer", minimum: 1, maximum: 500 },
            },
          },
          response: {
            200: {
              type: "object",
              properties: {
                shows: { type: "array", items: { type: "object", properties: showProperties } },
              },
            },
          },
        },
      },
      async (request) => ({
        shows: await db(
          listShows(sql, {
            includeEphemeral: request.query.include_ephemeral ?? false,
            limit: request.query.limit,
          }),
        ),
      }),
    );

    // The seat map. Under a stampede thousands of clients poll this; the micro-cache serializes
    // each show's snapshot at most once per window. Every cached body is still ONE consistent
    // snapshot, just up to SNAPSHOT_CACHE_MS old.
    const cache = new Map<string, { at: number; json: string }>();
    app.get<{ Params: { id: string } }>(
      "/shows/:id",
      { schema: { params: uuidParam } },
      async (request, reply) => {
        const id = request.params.id.toLowerCase();
        const ttl = config.http.snapshotCacheMs;
        const hit = cache.get(id);
        let json: string;
        if (ttl > 0 && hit && Date.now() - hit.at < ttl) {
          json = hit.json;
        } else {
          const snap = await db(getShowSnapshot(sql, id));
          if (!snap) throw showNotFound();
          json = JSON.stringify({ ...snap.show, counts: snap.counts, seats: snap.seats });
          if (ttl > 0) {
            if (cache.size >= SNAPSHOT_CACHE_MAX_ENTRIES) cache.clear();
            cache.set(id, { at: Date.now(), json });
          }
        }
        return reply.type("application/json; charset=utf-8").send(json);
      },
    );

    app.get<{ Params: { id: string } }>(
      "/shows/:id/audit",
      {
        schema: {
          params: uuidParam,
          response: {
            200: {
              type: "object",
              properties: {
                show_id: { type: "string" },
                ok: { type: "boolean" },
                counts: countsSchema,
                violations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { check: { type: "string" }, detail: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      async (request) => {
        const report = await db(audit(sql, request.params.id.toLowerCase()));
        if (!report) throw showNotFound();
        return report;
      },
    );
  };
