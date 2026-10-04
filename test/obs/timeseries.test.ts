import { describe, expect, it } from "vitest";
import { latencyOf, percentile, TimeSeries, type Gauges } from "../../server/src/obs/timeseries";

const gauges = (db = 0): Gauges => ({
  admission: 0,
  db,
  streams: 0,
  loopMs: 0,
  rssMb: 0,
  heapMb: 0,
});

describe("percentile / latencyOf", () => {
  it("uses nearest rank", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarizes unsorted samples and is null when empty", () => {
    expect(latencyOf([])).toBeNull();
    expect(latencyOf([30, 10, 20])).toEqual({ p50: 20, p95: 30, p99: 30, max: 30, n: 3 });
  });
});

describe("TimeSeries", () => {
  it("closes each second into a point and starts the next one empty", () => {
    const ts = new TimeSeries();
    ts.reserve("created", 12);
    ts.reserve("seat_taken", 3);
    ts.reserve("seat_taken", 5);
    ts.http("2xx");
    ts.http("4xx");
    ts.http("4xx");
    ts.add("confirmed");
    ts.add("expired", 4);
    const p = ts.roll(1_000, gauges(2));
    expect(p.t).toBe(1_000);
    expect(p.reserve).toEqual({ created: 1, seat_taken: 2 });
    expect(p.http).toEqual({ "2xx": 1, "3xx": 0, "4xx": 2, "5xx": 0 });
    expect(p.confirmed).toBe(1);
    expect(p.expired).toBe(4);
    expect(p.latency).toMatchObject({ p50: 5, max: 12, n: 3 });
    expect(p.gauges.db).toBe(2);

    const empty = ts.roll(2_000, gauges());
    expect(empty.reserve).toEqual({});
    expect(empty.latency).toBeNull();
    expect(empty.confirmed).toBe(0);
  });

  it("keeps the peak of DB calls in flight seen during the second, not just the closing sample", () => {
    const ts = new TimeSeries();
    ts.dbInFlight(3);
    ts.dbInFlight(17);
    ts.dbInFlight(5);
    expect(ts.roll(1, gauges(0)).dbPeak).toBe(17);
    expect(ts.roll(2, gauges(4)).dbPeak).toBe(4);
  });

  it("is bounded: oldest points fall off, and since() returns points strictly after t", () => {
    const ts = new TimeSeries(5);
    for (let t = 1; t <= 8; t++) ts.roll(t * 1000, gauges());
    expect(ts.since().map((p) => p.t)).toEqual([4000, 5000, 6000, 7000, 8000]);
    expect(ts.since(6000).map((p) => p.t)).toEqual([7000, 8000]);
    expect(ts.since(9000)).toEqual([]);
  });

  it("samples at most 1024 latencies per second however many requests it saw", () => {
    let seed = 1;
    const ts = new TimeSeries(
      10,
      60,
      () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646,
    );
    for (let i = 0; i < 20_000; i++) ts.reserve("seat_taken", i % 100);
    const p = ts.roll(1, gauges());
    expect(p.reserve.seat_taken).toBe(20_000);
    expect(p.latency!.n).toBe(1024);
    // A uniform sample of 0..99 has its median near 50.
    expect(p.latency!.p50).toBeGreaterThan(35);
    expect(p.latency!.p50).toBeLessThan(65);
  });

  it("summarizes latency over the last window of seconds only", () => {
    const ts = new TimeSeries(100, 2);
    ts.reserve("created", 1000);
    ts.roll(1, gauges());
    ts.reserve("created", 10);
    ts.roll(2, gauges());
    ts.reserve("created", 20);
    ts.roll(3, gauges());
    expect(ts.windowLatency()).toMatchObject({ max: 20, n: 2 });
  });
});
