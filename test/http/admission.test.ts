import { describe, expect, it } from "vitest";
import { Admission } from "../../server/src/http/admission";
import { useTestApp } from "../helpers/api";

describe("Admission", () => {
  it("admits up to the limit, sheds the rest and counts them", () => {
    const admission = new Admission(2);
    const a = admission.tryEnter();
    const b = admission.tryEnter();
    const c = admission.tryEnter();
    expect(a).toBeTypeOf("function");
    expect(b).toBeTypeOf("function");
    expect(c).toBeNull();
    expect(admission.stats()).toEqual({ inFlight: 2, maxInFlight: 2, shed: 1 });
  });

  it("release frees exactly one slot and is idempotent", () => {
    const admission = new Admission(2);
    const a = admission.tryEnter()!;
    admission.tryEnter();
    a();
    a();
    expect(admission.stats().inFlight).toBe(1);

    expect(admission.tryEnter()).toBeTypeOf("function");
    expect(admission.tryEnter()).toBeNull();
    expect(admission.stats()).toMatchObject({ inFlight: 2, shed: 1 });
  });
});

describe("Retry-After", () => {
  it("is the time to drain what is in flight at the recent completion rate, 1–30s", () => {
    let now = 1_000_000_000;
    const admission = new Admission(10_000, () => now);
    // No completions yet: the drain rate is unknown, so the longest wait.
    const slots = Array.from({ length: 1_000 }, () => admission.tryEnter()!);
    expect(admission.retryAfterSeconds()).toBe(30);

    // 100 completions in each of the last 5 seconds: 100/s.
    for (let s = 0; s < 5; s++) {
      for (const release of slots.splice(0, 100)) release();
      now += 1_000;
    }
    // 500 still in flight at 100/s: 5s.
    expect(admission.stats().inFlight).toBe(500);
    expect(admission.retryAfterSeconds()).toBe(5);

    // Nearly drained: never below 1s.
    for (const release of slots.splice(0, 499)) release();
    now += 1_000;
    expect(admission.retryAfterSeconds()).toBe(1);

    // A long quiet spell forgets the old rate.
    now += 60_000;
    expect(admission.retryAfterSeconds()).toBe(30);
  });
});

describe("admission control in the app (MAX_QUEUE=1)", () => {
  const t = useTestApp({ MAX_QUEUE: "1" });

  it("ops routes bypass admission: concurrent health checks are never shed", async () => {
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        t.app.inject({ url: i % 2 === 0 ? "/readyz" : "/healthz" }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(responses.map(() => 200));
  });

  it("releases the slot when a request completes: sequential requests keep succeeding", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await t.app.inject({ url: "/shows?limit=1" });
      expect(res.statusCode).toBe(200);
    }
  });
});
