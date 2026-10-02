import { describe, expect, it } from "vitest";
import { errorOf, useTestApp } from "../helpers/api";

const t = useTestApp();

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("health endpoints", () => {
  it("GET /healthz is 200 {status: ok}", async () => {
    const res = await t.app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /readyz is 200 {status: ready} and never cached", async () => {
    const res = await t.app.inject({ url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("x-request-id", () => {
  it("keeps a valid incoming id: echoed in the header and the error body", async () => {
    const res = await t.app.inject({
      url: "/no/such/route",
      headers: { "x-request-id": "abc-123" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-request-id"]).toBe("abc-123");
    expect(errorOf(res).request_id).toBe("abc-123");
  });

  it("replaces an invalid incoming id with a generated uuid", async () => {
    for (const bad of ["bad id with spaces", "x".repeat(200), "semi;colon"]) {
      const res = await t.app.inject({ url: "/no/such/route", headers: { "x-request-id": bad } });
      const id = res.headers["x-request-id"] as string;
      expect(id, bad).toMatch(UUID_SHAPE);
      expect(errorOf(res).request_id).toBe(id);
    }
  });

  it("accepts a 128 character id but not a 129 character one", async () => {
    const ok = await t.app.inject({
      url: "/healthz",
      headers: { "x-request-id": "a".repeat(128) },
    });
    expect(ok.headers["x-request-id"]).toBe("a".repeat(128));
    const tooLong = await t.app.inject({
      url: "/healthz",
      headers: { "x-request-id": "a".repeat(129) },
    });
    expect(tooLong.headers["x-request-id"]).toMatch(UUID_SHAPE);
  });

  it("generates an id when none is sent, and a different one per request", async () => {
    const a = await t.app.inject({ url: "/healthz" });
    const b = await t.app.inject({ url: "/healthz" });
    expect(a.headers["x-request-id"]).toMatch(UUID_SHAPE);
    expect(b.headers["x-request-id"]).toMatch(UUID_SHAPE);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});

describe("not found and body handling", () => {
  it("unknown route -> 404 not_found in the standard error shape", async () => {
    const res = await t.app.inject({ url: "/definitely-not-here" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: "not_found",
        message: "no such route",
        request_id: res.headers["x-request-id"],
      },
    });
  });

  it("malformed JSON -> 400 validation_error", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("validation_error");
  });

  it("unsupported content type -> 415 unsupported_media_type", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/xml" },
      payload: "<username>alice</username>",
    });
    expect(res.statusCode).toBe(415);
    expect(errorOf(res).code).toBe("unsupported_media_type");
  });

  it("text/plain is parsed by Fastify as a string, then rejected by the schema -> 400", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "text/plain" },
      payload: "username=alice",
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe("validation_error");
  });

  it("body over 1 MiB -> 413 payload_too_large", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/shows",
      headers: { ...t.admin, "content-type": "application/json" },
      payload: JSON.stringify({
        name: "x".repeat(1024 * 1024 + 1024),
        seats: ["A1"],
        price_paise: 1,
      }),
    });
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).code).toBe("payload_too_large");
  });
});
