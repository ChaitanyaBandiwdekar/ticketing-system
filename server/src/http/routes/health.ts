import type { FastifyPluginAsync } from "fastify";
import type { AppContext } from "../app";

/**
 * /healthz: liveness, no I/O. The process only listen()s after the DB connected and migrations
 * ran, so "responding" already implies "booted". This is Render's health check: it must stay
 * cheap so a saturated instance is never pulled mid-burst.
 * /readyz: readiness, fails closed (see readiness.ts).
 */
export const healthRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/healthz", { config: { ops: true } }, async () => ({ status: "ok" }));

    app.get("/readyz", { config: { ops: true } }, async (_request, reply) => {
      const state = await ctx.readiness.check();
      reply.header("cache-control", "no-store");
      if (state.ready) return { status: "ready" };
      return reply.code(503).send({ status: "unavailable", reason: state.reason });
    });
  };
