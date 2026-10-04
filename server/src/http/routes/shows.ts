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
  layout?: { aisles_after?: number[]; row_gaps_after?: string[] } | null;
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
              layout: {
                type: ["object", "null"],
                additionalProperties: false,
                properties: {
                  aisles_after: { type: "array", maxItems: 50, items: { type: "integer" } },
                  row_gaps_after: { type: "array", maxItems: 50, items: { type: "string" } },
                },
              },
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
                layout: b.layout
                  ? {
                      aisles_after: b.layout.aisles_after ?? [],
                      row_gaps_after: b.layout.row_gaps_after ?? [],
                    }
                  : null,
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
    // snapshot, up to SNAPSHOT_CACHE_MS old, and never older than this instance's last write to
    // the show: a client that just got a 201 reads its own seat back.
    const cache = new Map<string, { at: number; gen: number; json: string }>();
    // Bumped on every seat change this instance commits (the bus fans out before the reply).
    const generation = new Map<string, number>();
    const unsubscribe = ctx.bus.on(({ showId }) => {
      if (generation.size >= SNAPSHOT_CACHE_MAX_ENTRIES * 16) {
        // Dropping both together is safe: no cached entry is left to be judged by a lost count.
        generation.clear();
        cache.clear();
      }
      generation.set(showId, (generation.get(showId) ?? 0) + 1);
      cache.delete(showId);
    });
    app.addHook("onClose", async () => void unsubscribe());

    app.get<{ Params: { id: string } }>(
      "/shows/:id",
      { schema: { params: uuidParam } },
      async (request, reply) => {
        const id = request.params.id.toLowerCase();
        const ttl = config.http.snapshotCacheMs;
        const gen = generation.get(id) ?? 0;
        const hit = cache.get(id);
        let json: string;
        if (ttl > 0 && hit && hit.gen === gen && Date.now() - hit.at < ttl) {
          json = hit.json;
        } else {
          const snap = await db(getShowSnapshot(sql, id));
          if (!snap) throw showNotFound();
          json = JSON.stringify({ ...snap.show, counts: snap.counts, seats: snap.seats });
          // A write that committed during the read bumped the generation: don't cache what may
          // predate it.
          if (ttl > 0 && (generation.get(id) ?? 0) === gen) {
            if (cache.size >= SNAPSHOT_CACHE_MAX_ENTRIES) cache.clear();
            cache.set(id, { at: Date.now(), gen, json });
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
