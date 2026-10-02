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
