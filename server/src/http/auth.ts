/**
 * Identity. Users carry a self-issued HS256 JWT whose `sub` is the user id; it is the ONLY source
 * of identity (a user_id in a request body is ignored). Admin calls carry the ADMIN_API_KEY as a
 * bearer token. Verification is CPU-only: no DB lookup, and verified tokens are LRU-cached so a
 * burst reusing a few thousand tokens pays the HMAC once per token.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createSigner, createVerifier } from "fast-jwt";
import type { FastifyRequest } from "fastify";
import { ApiError } from "./errors";

const ISSUER = "fdfs";
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** user ids: what the demo login accepts and what reaches the engine. */
export const USER_ID_PATTERN = "^[a-z0-9][a-z0-9_.-]{0,63}$";
const USER_ID = new RegExp(USER_ID_PATTERN);

export type Auth = {
  issue(userId: string): string;
  /** Returns the verified user id, or throws 401. */
  userFrom(request: FastifyRequest): string;
  /** Throws 401 without credentials, 403 with anything but the admin key. */
  requireAdmin(request: FastifyRequest): void;
};

function bearer(request: FastifyRequest): string | null {
  const h = request.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

const unauthorized = (message: string) =>
  new ApiError(401, "unauthorized", message, {}, { "www-authenticate": 'Bearer realm="fdfs"' });

export function createAuth(opts: { jwtSecret: string; adminApiKey: string }): Auth {
  const sign = createSigner({
    key: opts.jwtSecret,
    algorithm: "HS256",
    iss: ISSUER,
    expiresIn: TOKEN_TTL_SECONDS * 1000,
  });
  const verify = createVerifier({
    key: opts.jwtSecret,
    algorithms: ["HS256"], // never "none", never an attacker-chosen algorithm
    allowedIss: ISSUER,
    requiredClaims: ["sub", "exp", "iss"],
    cache: 20_000,
  });
  // Compare digests so the comparison is constant-time regardless of input length.
  const adminDigest = createHash("sha256").update(opts.adminApiKey).digest();
  const isAdminKey = (candidate: string) =>
    timingSafeEqual(createHash("sha256").update(candidate).digest(), adminDigest);

  return {
    issue(userId) {
      if (!USER_ID.test(userId)) throw new Error(`invalid user id: ${userId}`);
      return sign({ sub: userId });
    },

    userFrom(request) {
      const token = bearer(request);
      if (!token) throw unauthorized("missing bearer token");
      let sub: unknown;
      try {
        sub = (verify(token) as { sub?: unknown }).sub;
      } catch {
        throw unauthorized("invalid or expired token");
      }
      if (typeof sub !== "string" || !USER_ID.test(sub)) {
        throw unauthorized("invalid token subject");
      }
      return sub;
    },

    requireAdmin(request) {
      const token = bearer(request);
      if (!token) throw unauthorized("missing admin bearer key");
      if (!isAdminKey(token)) throw new ApiError(403, "forbidden", "admin key required");
    },
  };
}
