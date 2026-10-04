/**
 * The Fastify app, without listen(): main.ts serves it, tests drive it with inject().
 *
 * Cross-cutting behaviour lives here:
 * - request id: a sane incoming `x-request-id` is kept, anything else replaced; echoed on every
 *   response and in every error body and log line
 * - admission control on everything except ops routes (health checks must never be shed) and
 *   streams (long-lived; they have their own connection cap in the hub)
 * - ONE log line per request (Fastify's default is two), enriched by handlers via `logCtx`
 * - every error mapped to the one error shape; only genuine bugs become 500
 */
import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Config } from "../config";
import { withDeadline } from "../db/deadline";
import type { Sql } from "../db/pool";
import { loggerOptions } from "../obs/logger";
import { EventBus } from "../realtime/bus";
import { StreamHub } from "../realtime/hub";
import { Admission } from "./admission";
import { createAuth, type Auth } from "./auth";
import { ApiError, sendError, toApiError } from "./errors";
import type { Readiness } from "./readiness";
import { authRoutes } from "./routes/auth";
import { healthRoutes } from "./routes/health";
import { reservationRoutes } from "./routes/reservations";
import { showRoutes } from "./routes/shows";
import { streamRoutes } from "./routes/stream";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Ops endpoints (health): no admission control, no access log. */
    ops?: boolean;
    /** Long-lived streams: no admission slot (the hub caps connections itself). */
    stream?: boolean;
  }
  interface FastifyRequest {
    /** The verified token's subject; set by the `authenticate` hook on user routes. */
    userId: string;
    /** Extra fields merged into this request's single access-log line. */
    logCtx?: Record<string, unknown>;
    /** Set once a stream took over the socket; the stream writes its own log line on close. */
    streamed: boolean;
  }
  interface FastifyInstance {
    realtime: { bus: EventBus; hub: StreamHub };
  }
}

export type AppDeps = {
  config: Config;
  sql: Sql;
  readiness: Readiness;
  /** Overrides config.logLevel (tests pass "silent"). */
  logLevel?: Config["logLevel"];
  /** Seat-change events; shared with the background jobs. Created if omitted. */
  bus?: EventBus;
};

export type AppContext = AppDeps & {
  auth: Auth;
  admission: Admission;
  bus: EventBus;
  hub: StreamHub;
  /** Every request-path DB call goes through this: a deadline, then 503 instead of a hang. */
  db: <T>(work: Promise<T>) => Promise<T>;
};

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const KEEP_ALIVE_MS = 65_000;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: loggerOptions(deps.logLevel ?? config.logLevel),
    // Fastify's own two lines per request are off; onResponse below writes one richer line.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "request_id",
    }),
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    // Behind Render's proxy: client IPs come from X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    // Longer than any upstream proxy's idle timeout, so the proxy never reuses a socket that Node
    // has just closed (a classic source of sporadic 502s).
    keepAliveTimeout: KEEP_ALIVE_MS,
    return503OnClosing: true,
    ajv: { customOptions: { allErrors: false } },
  });
  app.server.headersTimeout = KEEP_ALIVE_MS + 1_000;
  app.decorateRequest("userId", "");
  app.decorateRequest("logCtx", undefined);
  app.decorateRequest("streamed", false);

  const bus = deps.bus ?? new EventBus();
  bus.onListenerError = (err) => app.log.error({ err }, "event listener failed");
  const hub = new StreamHub(
    deps.sql,
    bus,
    { ...config.realtime, readTimeoutMs: config.db.requestTimeoutMs },
    app.log,
  );
  app.decorate("realtime", { bus, hub });
  // Streams never finish on their own: end them first, or close() would wait for them forever.
  app.addHook("preClose", async () => hub.close());

  const ctx: AppContext = {
    ...deps,
    auth: createAuth(config.auth),
    admission: new Admission(config.admission.maxQueue),
    bus,
    hub,
    db: (work) => withDeadline(work, config.db.requestTimeoutMs),
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const { ops, stream } = request.routeOptions.config;
    if (ops || stream) return;
    const release = ctx.admission.tryEnter();
    if (!release) {
      throw new ApiError(
        429,
        "overloaded",
        "server is at capacity; retry shortly",
        {},
        {
          "retry-after": "1",
        },
      );
    }
    // "close" fires exactly once whether the response finished or the client went away.
    reply.raw.once("close", release);
  });

  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.config.ops || request.streamed) return;
    const status = reply.statusCode;
    const line = {
      method: request.method,
      route: request.routeOptions.url ?? "(unmatched)",
      status,
      ms: Math.round(reply.elapsedTime * 10) / 10,
      ...request.logCtx,
    };
    if (status >= 500) request.log.error(line, "request");
    else request.log.info(line, "request");
  });

  app.setErrorHandler(async (error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.statusCode >= 500) {
      request.logCtx = { ...request.logCtx, err: error, code: apiError.code };
    }
    return sendError(request, reply, apiError);
  });

  app.setNotFoundHandler(async (request, reply) =>
    sendError(request, reply, new ApiError(404, "not_found", "no such route")),
  );

  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(showRoutes(ctx));
  await app.register(reservationRoutes(ctx));
  await app.register(streamRoutes(ctx));
  return app;
}
