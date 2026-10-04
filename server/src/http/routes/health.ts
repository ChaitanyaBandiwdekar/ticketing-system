import type { FastifyPluginAsync } from "fastify";
import type { AppContext } from "../app";

/**
 * /healthz: liveness, no I/O. The process only listen()s after the DB connected and migrations
 * ran, so "responding" already implies "booted". This is Render's health check: it must stay
 * cheap so a saturated instance is never pulled mid-burst.
 * /readyz: readiness, fails closed (see readiness.ts). /health and /ready are aliases.
 */
export const healthRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    // The unsuffixed names too, for probes that expect them.
    for (const path of ["/healthz", "/health"]) {
      app.get(path, { config: { ops: true } }, async () => ({ status: "ok" }));
    }

    for (const path of ["/readyz", "/ready"]) {
      app.get(path, { config: { ops: true } }, async (_request, reply) => {
        const state = await ctx.readiness.check();
        reply.header("cache-control", "no-store");
        if (state.ready) return { status: "ready" };
        return reply.code(503).send({ status: "unavailable", reason: state.reason });
      });
    }
  };
