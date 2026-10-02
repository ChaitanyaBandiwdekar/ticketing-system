import type { FastifyPluginAsync } from "fastify";
import type { AppContext } from "../app";
import { TOKEN_TTL_SECONDS } from "../auth";
import { ApiError } from "../errors";

/** Most tokens one /auth/tokens call mints: plenty for a burst, bounded CPU and response size. */
export const MAX_MINT = 10_000;

/**
 * Demo identity provider (AUTH_DEMO_LOGIN): stands in for a real IdP. Usernames are lowercased
 * into user ids; minting costs zero DB writes because identity is only the token's `sub`.
 */
export const authRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const enabled = () => {
      if (!ctx.config.auth.demoLogin) throw new ApiError(404, "not_found", "demo login disabled");
    };

    app.post<{ Body: { username: string } }>(
      "/auth/login",
      {
        schema: {
          body: {
            type: "object",
            required: ["username"],
            properties: {
              username: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$" },
            },
          },
        },
      },
      async (request) => {
        enabled();
        const userId = request.body.username.toLowerCase();
        return {
          token: ctx.auth.issue(userId),
          token_type: "Bearer",
          user_id: userId,
          expires_in: TOKEN_TTL_SECONDS,
        };
      },
    );

    app.post<{ Body: { count: number; prefix?: string; start?: number } }>(
      "/auth/tokens",
      {
        schema: {
          body: {
            type: "object",
            required: ["count"],
            properties: {
              count: { type: "integer", minimum: 1, maximum: MAX_MINT },
              prefix: { type: "string", pattern: "^[a-z0-9][a-z0-9_.-]{0,40}$" },
              start: { type: "integer", minimum: 0, maximum: 1_000_000_000 },
            },
          },
        },
      },
      async (request) => {
        enabled();
        const { count, prefix = "user", start = 1 } = request.body;
        const tokens = Array.from({ length: count }, (_, i) => {
          const userId = `${prefix}-${start + i}`;
          return { user_id: userId, token: ctx.auth.issue(userId) };
        });
        request.logCtx = { minted: count, prefix };
        return { tokens, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS };
      },
    );
  };
