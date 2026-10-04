/**
 * The UI's live seat map (web/src/hall/live.ts) driven by the real server's /stream frames:
 * whatever the wire says, folding it through the browser's reducer must land on the database's
 * state. Guards against protocol drift between hub.ts and the UI.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getShowSnapshot } from "../../server/src/engine/shows";
import { createSweeper } from "../../server/src/jobs/sweeper";
import { SEAT_CODE } from "../../server/src/realtime/hub";
import {
  initialLive,
  liveReducer,
  type LiveAction,
  type LiveState,
  type SeatIndex,
} from "../../web/src/hall/live";
import { useTestApp } from "../helpers/api";
import { seatRow } from "../helpers/engine";
import { SeatStream } from "../helpers/sse";

const t = useTestApp({
  STREAM_COALESCE_MS: "20",
  STREAM_HEARTBEAT_MS: "100",
  STREAM_RESYNC_MS: "3600000",
});

const streams: SeatStream[] = [];
afterAll(async () => {
  await Promise.all(streams.map((s) => s.close()));
});

function fold(stream: SeatStream, index: SeatIndex): LiveState {
  let s = initialLive;
  stream.frames.forEach((f, i) => {
    const action: LiveAction | null =
      f.event === "snapshot"
        ? { type: "snapshot", frame: f.data as never, at: i }
        : f.event === "delta"
          ? { type: "delta", frame: f.data as never, at: i }
          : f.event === "audit"
            ? { type: "audit", frame: f.data as never }
            : null;
    if (action) s = liveReducer(s, action, index, 700);
  });
  return s;
}

describe("the UI's live map over the real stream", () => {
  it("folds a mixed burst's frames into exactly the database's seat map", async () => {
    const seats = seatRow("A", 30);
    const show = await t.show({ seats, hold_ttl_seconds: 1, per_user_limit: 3 });
    const users = await Promise.all(Array.from({ length: 16 }, () => t.user()));
    const sweeper = createSweeper(t.sql, t.app.realtime.bus);
    const stream = await SeatStream.open(await t.listen(), show.id);
    streams.push(stream);
    await stream.waitFor(() => stream.count("snapshot") === 1);

    const call = (url: string, headers: Record<string, string>, payload?: unknown) =>
      t.app.inject({ method: "POST", url, headers, payload: payload as never });
    const actor = async (u: { headers: { authorization: string } }, i: number) => {
      for (let round = 0; round < 4; round++) {
        const start = (i * 3 + round * 7) % (seats.length - 2);
        const res = await call(
          `/shows/${show.id}/reserve`,
          { ...u.headers, "idempotency-key": randomUUID() },
          { seats: seats.slice(start, start + 1 + (round % 2)) },
        );
        if (res.statusCode !== 201) continue;
        const id = res.json<{ reservation_id: string }>().reservation_id;
        if ((i + round) % 3 === 0) await call(`/reservations/${id}/confirm`, u.headers);
        else if ((i + round) % 3 === 1) await call(`/reservations/${id}/cancel`, u.headers);
        await sweeper.tick();
      }
    };
    await Promise.all(users.map(actor));
    // Let the remaining holds lapse and release them.
    await new Promise((r) => setTimeout(r, 1_100));
    await sweeper.tick();

    const snap = (await getShowSnapshot(t.sql, show.id))!;
    const truth = snap.seats.map((s) => SEAT_CODE[s.status]).join("");
    await stream.waitFor(
      () => [...stream.seats.values()].join("") === truth,
      5_000,
      "stream convergence",
    );

    // The hall's own order (here: reversed) must not matter.
    const hallOrder = [...seats].reverse();
    const index: SeatIndex = {
      byLabel: new Map(hallOrder.map((l, i) => [l, i])),
      size: hallOrder.length,
    };
    const state = fold(stream, index);
    expect(state.link).toBe("live");
    expect(state.status).toBe(hallOrder.map((l) => truth[seats.indexOf(l)]).join(""));
    expect(stream.count("delta")).toBeGreaterThan(0);
  });
});
