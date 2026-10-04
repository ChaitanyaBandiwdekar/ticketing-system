/**
 * The War Room feed: GET /ops/stream (server-sent events) folded into state.
 *
 * `hello` replaces everything (the last five minutes of points and the recent log lines), so a
 * reconnect after a deploy or a dropped connection starts clean instead of splicing two
 * processes' series together. Each `tick` appends one point, the fresh summary and the new log
 * lines. The browser reconnects a dropped stream on its own (the server sends `retry: 2000`);
 * when the server refuses one outright (503 at capacity, draining), the hook reopens it with
 * backoff.
 */
import { useEffect, useState } from "react";
import type {
  HelloFrame,
  LogEntry,
  Point,
  Summary,
  TickFrame,
} from "../../../server/src/obs/types";

export type { LogEntry, Point, Summary };

export type FeedLink = "connecting" | "live" | "reconnecting";

export type OpsFeed = {
  link: FeedLink;
  summary: Summary | null;
  points: Point[];
  logs: LogEntry[];
  /** Lines the server produced but did not send (more than it ships per second). */
  logsSkipped: number;
};

/** Points kept: the server's hello window (5 minutes at one per second). */
const MAX_POINTS = 300;
const MAX_LOGS = 1_000;

const initial: OpsFeed = {
  link: "connecting",
  summary: null,
  points: [],
  logs: [],
  logsSkipped: 0,
};

export function useOpsFeed(): OpsFeed {
  const [feed, setFeed] = useState<OpsFeed>(initial);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      source = new EventSource("/ops/stream");
      source.addEventListener("hello", (e) => {
        attempt = 0;
        const hello = JSON.parse((e as MessageEvent<string>).data) as HelloFrame;
        setFeed({
          link: "live",
          summary: hello.summary,
          points: hello.points.slice(-MAX_POINTS),
          logs: hello.logs.slice(-MAX_LOGS),
          logsSkipped: 0,
        });
      });
      source.addEventListener("tick", (e) => {
        const tick = JSON.parse((e as MessageEvent<string>).data) as TickFrame;
        setFeed((prev) => {
          // The first tick after `hello` can repeat lines hello already carried: keep only
          // lines newer than the last one held (seq is monotonic per process).
          const held = prev.logs.at(-1)?.seq ?? 0;
          const fresh = tick.logs.filter((l) => l.seq > held);
          return {
            link: "live",
            summary: tick.summary,
            points: [...prev.points, tick.point].slice(-MAX_POINTS),
            logs: fresh.length ? [...prev.logs, ...fresh].slice(-MAX_LOGS) : prev.logs,
            logsSkipped: prev.logsSkipped + tick.logs_skipped,
          };
        });
      });
      source.onerror = () => {
        if (stopped || !source) return;
        if (source.readyState === EventSource.CLOSED) {
          // Refused (non-200): the browser won't retry by itself. Back off and reopen.
          source.close();
          const delay = Math.min(15_000, 1_000 * 2 ** attempt++);
          retryTimer = setTimeout(open, delay + Math.random() * 500);
        }
        setFeed((prev) =>
          prev.link === "reconnecting" ? prev : { ...prev, link: "reconnecting" },
        );
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return feed;
}
