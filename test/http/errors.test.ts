import { describe, expect, it } from "vitest";
import { ContentionError } from "../../server/src/db/retry";
import { ApiError, isDbUnavailable, toApiError } from "../../server/src/http/errors";

describe("toApiError", () => {
  it("passes an ApiError through untouched", () => {
    const err = new ApiError(409, "seat_taken", "nope", { a: 1 }, { "x-h": "v" });
    expect(toApiError(err)).toBe(err);
  });

  it("maps ContentionError to 503 contention with Retry-After", () => {
    const api = toApiError(new ContentionError("40P01", 4));
    expect(api.statusCode).toBe(503);
    expect(api.code).toBe("contention");
    expect(api.headers["retry-after"]).toBe("1");
  });

  it.each(["ECONNREFUSED", "CONNECT_TIMEOUT", "08006", "57P03", "53300", "ECONNRESET", "57P01"])(
    "maps connection-level error %s to 503 db_unavailable",
    (code) => {
      const api = toApiError(Object.assign(new Error("connect failed"), { code }));
      expect(api.statusCode).toBe(503);
      expect(api.code).toBe("db_unavailable");
      expect(api.headers["retry-after"]).toBe("2");
    },
  );

  it("maps a plain {code} object too", () => {
    expect(toApiError({ code: "ECONNREFUSED" }).code).toBe("db_unavailable");
  });

  it("maps other SQLSTATEs and plain errors to 500 internal without leaking the message", () => {
    for (const err of [
      Object.assign(new Error("duplicate key value violates unique constraint secret_idx"), {
        code: "23505",
      }),
      new Error("password=hunter2 leaked"),
    ]) {
      const api = toApiError(err);
      expect(api.statusCode).toBe(500);
      expect(api.code).toBe("internal");
      expect(api.message).toBe("internal error");
      expect(JSON.stringify(api.details)).not.toMatch(/hunter2|secret_idx/);
    }
  });

  it("maps a fastify validation error to 400 validation_error", () => {
    const api = toApiError({ validation: [{ keyword: "type" }], message: "body/x bad" });
    expect(api.statusCode).toBe(400);
    expect(api.code).toBe("validation_error");
    expect(api.message).toBe("body/x bad");
  });

  it("maps body-too-large to 413 payload_too_large", () => {
    const api = toApiError({ code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 });
    expect(api.statusCode).toBe(413);
    expect(api.code).toBe("payload_too_large");
  });

  it("maps an invalid media type to 415 unsupported_media_type", () => {
    const api = toApiError({ code: "FST_ERR_CTP_INVALID_MEDIA_TYPE", statusCode: 415 });
    expect(api.statusCode).toBe(415);
    expect(api.code).toBe("unsupported_media_type");
  });

  it("maps other fastify 4xx errors (e.g. malformed JSON) to 400 validation_error", () => {
    const api = toApiError({
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
      statusCode: 400,
      message: "bad json",
    });
    expect(api.statusCode).toBe(400);
    expect(api.code).toBe("validation_error");
  });
});

describe("isDbUnavailable", () => {
  it("is true for connection errors and unavailable SQLSTATE classes", () => {
    for (const code of [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "CONNECTION_CLOSED",
      "08006",
      "53300",
      "57P02",
    ]) {
      expect(isDbUnavailable({ code }), code).toBe(true);
    }
  });

  it("is false for ordinary query errors and non-errors", () => {
    for (const err of [
      { code: "23505" },
      { code: "42P01" },
      { code: "57014" },
      new Error("x"),
      {},
    ]) {
      expect(isDbUnavailable(err)).toBe(false);
    }
    expect(isDbUnavailable(null)).toBe(false);
    expect(isDbUnavailable(undefined)).toBe(false);
  });

  it("maps a thrown null/undefined to 500 instead of crashing the handler", () => {
    for (const thrown of [null, undefined]) {
      expect(toApiError(thrown)).toMatchObject({ statusCode: 500, code: "internal" });
    }
  });
});
