import { describe, expect, it } from "vitest";
import { LogBuffer } from "../../server/src/obs/logbuffer";
import { createLogger } from "../../server/src/obs/logger";

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ level: "info", time: "2026-10-04T00:00:00.000Z", msg: "request", ...o });

describe("LogBuffer", () => {
  it("keeps the newest lines up to its capacity with increasing seq", () => {
    const buf = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) buf.write(line({ ms: i }));
    const all = buf.query();
    expect(all.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(all.map((e) => e.fields.ms)).toEqual([3, 4, 5]);
    expect(buf.latestSeq()).toBe(5);
  });

  it("pages with after, filters by request id and level, and keeps the newest when limited", () => {
    const buf = new LogBuffer();
    buf.write(line({ request_id: "a", status: 201 }));
    buf.write(line({ request_id: "b", status: 409 }));
    buf.write(line({ request_id: "a", level: "warn", msg: "identity_spoof_ignored" }));
    buf.write(line({ request_id: "c", level: "error", status: 503 }));

    expect(buf.query({ after: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(buf.query({ requestId: "a" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(buf.query({ minLevel: "warn" }).map((e) => e.level)).toEqual(["warn", "error"]);
    expect(buf.query({ limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(buf.query({ after: 4 })).toEqual([]);
  });

  it("publishes only allow-listed fields and strips stack traces", () => {
    const buf = new LogBuffer();
    buf.write(
      line({
        request_id: "r1",
        route: "/shows/:id/reserve",
        authorization: "Bearer secret",
        token: "secret",
        headers: { authorization: "Bearer secret" },
        hostname: "box",
        pid: 42,
        err: {
          type: "Error",
          message: "boom",
          stack: "Error: boom\n    at secret.ts:1",
          code: "XX",
        },
      }),
    );
    const [e] = buf.query();
    expect(e!.request_id).toBe("r1");
    expect(e!.fields).toEqual({
      route: "/shows/:id/reserve",
      err: { type: "Error", message: "boom", code: "XX" },
    });
    expect(JSON.stringify(e)).not.toContain("secret");
  });

  it("keeps warnings and errors after info traffic has rolled them out of the main ring", () => {
    const buf = new LogBuffer(3, 2);
    buf.write(line({ level: "warn", msg: "identity_spoof_ignored", request_id: "a" }));
    buf.write(line({ level: "error", msg: "request", request_id: "b", status: 500 }));
    buf.write(line({ level: "warn", msg: "job tick failed" }));
    for (let i = 0; i < 5; i++) buf.write(line({ request_id: "a" }));
    // seq 1 is gone from both rings (notable keeps the newest 2 warn+ lines); 2 and 3 survive.
    expect(buf.query({ minLevel: "warn" }).map((e) => e.seq)).toEqual([2, 3]);
    expect(buf.query({ requestId: "b" }).map((e) => e.seq)).toEqual([2]);
    expect(buf.query().map((e) => e.seq)).toEqual([2, 3, 6, 7, 8]);
    expect(buf.query({ after: 2 }).map((e) => e.seq)).toEqual([3, 6, 7, 8]);
  });

  it("ignores lines that are not JSON and notifies subscribers of the rest", () => {
    const buf = new LogBuffer();
    const seen: number[] = [];
    const off = buf.subscribe((e) => seen.push(e.seq));
    buf.write("not json\n");
    buf.write(line({}));
    off();
    buf.write(line({}));
    expect(seen).toEqual([1]);
    expect(buf.latestSeq()).toBe(2);
  });

  it("receives the process logger's redacted lines", () => {
    const buf = new LogBuffer();
    const log = createLogger("info", { buffer: buf, stdout: false });
    log.info({ authorization: "Bearer abc", route: "/x", status: 200 }, "request");
    log.debug({ route: "/hidden" }, "below level");
    log.child({ request_id: "rid-1" }).warn({ user: "u1" }, "identity_spoof_ignored");
    const lines = buf.query();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "info", msg: "request", fields: { route: "/x" } });
    expect(lines[1]).toMatchObject({ request_id: "rid-1", level: "warn", fields: { user: "u1" } });
    expect(JSON.stringify(lines)).not.toContain("abc");
  });
});
