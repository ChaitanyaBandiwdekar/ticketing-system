import { describe, expect, it } from "vitest";
import { ContentionError, withContentionRetry } from "../../server/src/db/retry";

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe("withContentionRetry", () => {
  it("retries deadlock / serialization / lock-timeout errors, then succeeds", async () => {
    const seen: string[] = [];
    let calls = 0;
    const result = await withContentionRetry(
      async () => {
        calls++;
        if (calls === 1) throw pgError("40P01");
        if (calls === 2) throw pgError("55P03");
        return "ok";
      },
      { baseDelayMs: 1, onRetry: (state) => seen.push(state) },
    );
    expect(result).toBe("ok");
    expect(seen).toEqual(["40P01", "55P03"]);
  });

  it("gives up after the budget with a ContentionError carrying the cause", async () => {
    let calls = 0;
    const err = await withContentionRetry(
      async () => {
        calls++;
        throw pgError("40001");
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentionError);
    expect(err).toMatchObject({ sqlState: "40001", attempts: 3 });
    expect(calls).toBe(3);
  });

  it("maps a statement timeout to ContentionError without retrying", async () => {
    let calls = 0;
    const err = await withContentionRetry(async () => {
      calls++;
      throw pgError("57014");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentionError);
    expect(calls).toBe(1);
  });

  it("passes every other error through untouched", async () => {
    const boom = pgError("23505");
    await expect(withContentionRetry(() => Promise.reject(boom))).rejects.toBe(boom);
    await expect(withContentionRetry(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
  });
});
