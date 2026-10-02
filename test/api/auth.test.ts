import { createSigner } from "fast-jwt";
import { describe, expect, it } from "vitest";
import { errorOf, useTestApp } from "../helpers/api";

const t = useTestApp();

const REAL_SECRET = "test-jwt-secret-0123456789abcdef0123456789";
const OTHER_SECRET = "another-secret-of-sufficient-length-123";
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function me(token: string) {
  return t.app.inject({
    method: "GET",
    url: "/me/reservations",
    headers: { authorization: `Bearer ${token}` },
  });
}

function login(payload?: unknown) {
  return t.app.inject({ method: "POST", url: "/auth/login", payload: payload as object });
}

describe("POST /auth/login", () => {
  it("lowercases the username into the user id and issues a working bearer token", async () => {
    const res = await login({ username: "Alice_1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      token: expect.any(String),
      token_type: "Bearer",
      user_id: "alice_1",
      expires_in: 86_400,
    });
    expect((await me(body.token)).statusCode).toBe(200);
  });

  it("400 validation_error for invalid usernames", async () => {
    const bodies: unknown[] = [
      { username: "" },
      { username: "-bad" },
      { username: "has space" },
      { username: "a".repeat(65) },
      { username: {} },
      {},
    ];
    for (const body of bodies) {
      const res = await login(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe("validation_error");
    }
  });

  it("400 validation_error when the body is missing entirely", async () => {
    const res = await login(undefined);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("validation_error");
  });

  it("accepts a 64 character username", async () => {
    const res = await login({ username: "a".repeat(64) });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /auth/tokens", () => {
  it("mints count tokens with prefix-start numbering; each token works", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/tokens",
      payload: { count: 3, prefix: "load", start: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      tokens: { user_id: string; token: string }[];
      token_type: string;
      expires_in: number;
    }>();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(86_400);
    expect(body.tokens.map((x) => x.user_id)).toEqual(["load-10", "load-11", "load-12"]);
    for (const { token } of body.tokens) {
      expect((await me(token)).statusCode).toBe(200);
    }
  });

  it("defaults to prefix 'user' and start 1", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/tokens",
      payload: { count: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokens.map((x: { user_id: string }) => x.user_id)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("400 validation_error for out-of-range or malformed input", async () => {
    const bodies: unknown[] = [
      { count: 0 },
      { count: 10_001 },
      { count: 1.5 },
      {},
      { count: 1, prefix: "Bad Prefix" },
      { count: 1, start: -1 },
    ];
    for (const body of bodies) {
      const res = await t.app.inject({
        method: "POST",
        url: "/auth/tokens",
        payload: body as object,
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(errorOf(res).code).toBe("validation_error");
    }
  });

  it("mints the maximum of 10000 tokens in one call", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/tokens",
      payload: { count: 10_000, prefix: "bulk" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tokens).toHaveLength(10_000);
  });
});

describe("token forgery and misuse", () => {
  it("401 for a token signed with a different secret", async () => {
    const forged = createSigner({
      key: OTHER_SECRET,
      algorithm: "HS256",
      iss: "fdfs",
      expiresIn: 60_000,
    })({ sub: "x" });
    const res = await me(forged);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("unauthorized");
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer/);
  });

  it("401 for an alg:none token", async () => {
    const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
      sub: "x",
      iss: "fdfs",
      exp: FAR_FUTURE,
    })}.`;
    const res = await me(token);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("unauthorized");
  });

  it("401 for an expired token", async () => {
    const expired = createSigner({ key: REAL_SECRET, algorithm: "HS256", iss: "fdfs" })({
      sub: "x",
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await me(expired);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).code).toBe("unauthorized");
  });

  it("401 for a wrong issuer", async () => {
    const token = createSigner({
      key: REAL_SECRET,
      algorithm: "HS256",
      iss: "other",
      expiresIn: 60_000,
    })({ sub: "x" });
    expect((await me(token)).statusCode).toBe(401);
  });

  it("401 for a validly signed token whose subject is not a legal user id", async () => {
    const sign = createSigner({
      key: REAL_SECRET,
      algorithm: "HS256",
      iss: "fdfs",
      expiresIn: 60_000,
    });
    for (const sub of ["UPPER", "has space", "-lead"]) {
      expect((await me(sign({ sub }))).statusCode, sub).toBe(401);
    }
    expect((await me(sign({}))).statusCode).toBe(401);
  });

  it("a correctly signed token is accepted (control for the cases above)", async () => {
    const token = createSigner({
      key: REAL_SECRET,
      algorithm: "HS256",
      iss: "fdfs",
      expiresIn: 60_000,
    })({ sub: "control-user" });
    expect((await me(token)).statusCode).toBe(200);
  });

  it("401 for a missing or non-bearer Authorization header", async () => {
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }]) {
      const res = await t.app.inject({ url: "/me/reservations", headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });
});

// Not covered: AUTH_DEMO_LOGIN=false (-> 404 not_found on /auth/*). useTestApp builds one app per
// test file with a fixed config, so that case would need a second file-level app.
