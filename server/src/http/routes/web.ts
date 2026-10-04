import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { AppContext } from "../app";
import { ApiError } from "../errors";

/**
 * The UI: a Vite SPA under /app/ (the API owns the spec's root paths, e.g. GET /shows/:id), and
 * `/` redirects there.
 * - Hashed build assets (/app/assets/*) are immutable for a year; index.html is never cached, so a
 *   deploy is picked up on the next navigation.
 * - Any other /app/* path without a file extension is a client route and gets index.html.
 * - index.html carries a strict same-origin CSP: the UI only ever talks to this origin.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React writes dynamic style attributes (seat-map sizing, progress widths).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const webRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    app.get("/", { config: { ops: true } }, async (_request, reply) => reply.redirect("/app/"));

    const root = resolve(ctx.config.http.webDir);
    if (!existsSync(join(root, "index.html"))) {
      // API-only process (tests, `npm run dev` with the Vite dev server serving the UI).
      app.get("/app/*", { config: { ops: true } }, async () => {
        throw new ApiError(404, "not_found", "the UI is not built here; run `npm run build`");
      });
      return;
    }

    await app.register(fastifyStatic, {
      root,
      prefix: "/app/",
      // Routes are registered per built file at boot; the client-route fallback below handles the rest.
      wildcard: false,
      index: false,
      // Our own Cache-Control below, not the plugin's default max-age.
      cacheControl: false,
      setHeaders(reply, path) {
        reply.header("x-content-type-options", "nosniff");
        reply.header(
          "cache-control",
          /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
        );
        if (path.endsWith(".html")) reply.header("content-security-policy", CSP);
      },
    });

    const sendIndex = (reply: FastifyReply) =>
      reply
        .header("cache-control", "no-cache")
        .header("content-security-policy", CSP)
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "same-origin")
        .sendFile("index.html", { cacheControl: false });

    app.get("/app", { config: { ops: true } }, async (_request, reply) => reply.redirect("/app/"));
    app.get<{ Params: { "*": string } }>(
      "/app/*",
      { config: { ops: true } },
      async (request, reply) => {
        // A missing asset is a real 404, not the SPA shell (which would fail as a script).
        if (extname(request.params["*"]) !== "") {
          throw new ApiError(404, "not_found", "no such file");
        }
        return sendIndex(reply);
      },
    );
  };
