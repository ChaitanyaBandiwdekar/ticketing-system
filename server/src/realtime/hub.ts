/**
 * Server-sent seat-map streams: GET /stream?show=<id>.
 *
 * Protocol (one `event:` + JSON `data:` per frame):
 *   snapshot  {seq, show, counts, labels[], status}  on connect, then every STREAM_RESYNC_MS.
 *             `status` is one char per seat in seat order: a=available h=held c=confirmed.
 *   delta     {seq, changes: {label: a|h|c}, counts}  the coalesced changes of the last window.
 *             `counts` are the show's exact totals at that read. They can lead the seat map by
 *             one window: a seat whose commit landed just before the read has its own change
 *             event, and so its entry in `changes`, in the next delta.
 *   audit     {show_id, ok, violations, at}           the reconciler's verdict for this show.
 *   gone      {show_id}                               the show was deleted; the stream ends.
 *   `: hb` comment frames keep idle connections open through proxies.
 * Applying frames in arrival order gives the current state: a delta overwrites the listed seats.
 *
 * Convergence argument. Bus events are only hints that some labels changed. Per show, the hub
 * collects the changed labels for a short window, then re-reads their effective state, together
 * with the show's counts, in ONE statement and ships what it read. Every DB read for a show
 * (connect snapshot, delta read, resync) runs through one serialized queue, and frames go out in
 * queue order. Any committed change is followed by its event, and so by a later read. So the
 * last frame a client gets for a seat always comes from a read made after that seat's last
 * change. A client therefore converges to the database even if commit acks reach Node in a
 * different order than the commits happened, which last-write-wins over event payloads could
 * not guarantee.
 */
import type { ServerResponse } from "node:http";
import type { LogFn } from "pino";
import { withDeadline } from "../db/deadline";
import type { Sql } from "../db/pool";
import { getSeatStates, getShowSnapshot } from "../engine/shows";
import type { AuditReport, SeatStatus, ShowSnapshot } from "../engine/types";
import type { EventBus, SeatChange } from "./bus";

export type HubLog = { info: LogFn; warn: LogFn; error: LogFn };

export type HubOptions = {
  maxClients: number;
  coalesceMs: number;
  heartbeatMs: number;
  resyncMs: number;
  /** A client whose unsent backlog exceeds this is dropped; it reconnects and resyncs. */
  maxBufferedBytes?: number;
  /** Deadline for the hub's own reads, so a dead database can't stall a show's queue. */
  readTimeoutMs?: number;
};

export const SEAT_CODE: Record<SeatStatus, "a" | "h" | "c"> = {
  available: "a",
  held: "h",
  confirmed: "c",
};

const RETRY_AFTER_DB_ERROR_MS = 1_000;
const DEFAULT_MAX_BUFFERED = 4 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 10_000;

type Client = { res: ServerResponse; frames: number; onClose: (frames: number) => void };

type Channel = {
  showId: string;
  clients: Set<Client>;
  /** Subscribers whose connect snapshot is still queued. */
  connecting: number;
  pending: Set<string>;
  flushTimer: NodeJS.Timeout | null;
  resyncTimer: NodeJS.Timeout;
  /** Tail of this show's serialized read-and-send queue. */
  queue: Promise<void>;
  seq: number;
};

export type SubscribeResult = "subscribed" | "not_found" | "gone";
export type AdmitResult = "ok" | "closed" | "full";

export type HubStats = {
  clients: number;
  channels: number;
  framesSent: number;
  deltas: number;
  snapshots: number;
  slowClientsDropped: number;
};

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function snapshotFrame(seq: number, snap: ShowSnapshot): string {
  return frame("snapshot", {
    seq,
    show: snap.show,
    counts: snap.counts,
    labels: snap.seats.map((s) => s.label),
    status: snap.seats.map((s) => SEAT_CODE[s.status]).join(""),
  });
}

export class StreamHub {
  private readonly channels = new Map<string, Channel>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private closed = false;
  private connectingTotal = 0;
  private readonly counters = { framesSent: 0, deltas: 0, snapshots: 0, slowClientsDropped: 0 };

  constructor(
    private readonly sql: Sql,
    bus: EventBus,
    private readonly opts: HubOptions,
    private readonly log: HubLog,
  ) {
    this.unsubscribe = bus.on(this.onChange);
    this.heartbeat = setInterval(() => this.beat(), opts.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Whether a new stream may open right now. */
  admit(): AdmitResult {
    if (this.closed) return "closed";
    return this.clientCount() + this.connectingTotal >= this.opts.maxClients ? "full" : "ok";
  }

  /**
   * Queues the connect snapshot for this show. When it runs: an unknown show resolves
   * "not_found" without touching `res`. Otherwise it calls `open()` (the caller writes the
   * response head), sends the snapshot, and registers the client for deltas. Rejects if the
   * snapshot read fails, before anything was written.
   */
  async subscribe(
    showId: string,
    res: ServerResponse,
    hooks: { open: () => void; onClose: (frames: number) => void },
  ): Promise<SubscribeResult> {
    const ch = this.channel(showId);
    ch.connecting++;
    this.connectingTotal++;
    try {
      return await this.enqueue(ch, async () => {
        const snap = await getShowSnapshot(this.sql, showId);
        if (!snap) return "not_found";
        // Gone, or already answered (e.g. the request's DB deadline fired while this was queued).
        if (this.closed || res.destroyed || res.headersSent) return "gone";
        hooks.open();
        res.write("retry: 2000\n\n");
        const client: Client = { res, frames: 0, onClose: hooks.onClose };
        ch.clients.add(client);
        res.once("close", () => this.drop(ch, client));
        ch.seq++;
        this.counters.snapshots++;
        this.send(client, snapshotFrame(ch.seq, snap));
        return "subscribed";
      });
    } finally {
      ch.connecting--;
      this.connectingTotal--;
      this.retireIfIdle(ch);
    }
  }

  /** Pushes the reconciler's verdict to a show's live clients (no DB read; order-independent). */
  publishAudit(report: AuditReport, at: Date): void {
    const ch = this.channels.get(report.show_id);
    if (!ch || ch.clients.size === 0) return;
    this.broadcast(
      ch,
      frame("audit", {
        show_id: report.show_id,
        ok: report.ok,
        violations: report.violations.length,
        at: at.toISOString(),
      }),
    );
  }

  /** Shows that currently have subscribers (the reconciler audits these). */
  watchedShows(): string[] {
    return [...this.channels.values()].filter((c) => c.clients.size > 0).map((c) => c.showId);
  }

  clientCount(): number {
    let n = 0;
    for (const ch of this.channels.values()) n += ch.clients.size;
    return n;
  }

  stats(): HubStats {
    return { clients: this.clientCount(), channels: this.channels.size, ...this.counters };
  }

  /** Ends every stream (clients reconnect elsewhere) and stops accepting new ones. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.heartbeat);
    for (const ch of this.channels.values()) {
      this.stopTimers(ch);
      for (const client of ch.clients) client.res.end();
    }
  }

  private readonly onChange = (change: SeatChange): void => {
    const ch = this.channels.get(change.showId);
    if (!ch || this.closed) return;
    for (const label of change.labels) ch.pending.add(label);
    this.scheduleFlush(ch, this.opts.coalesceMs);
  };

  private channel(showId: string): Channel {
    let ch = this.channels.get(showId);
    if (!ch) {
      const created: Channel = {
        showId,
        clients: new Set(),
        connecting: 0,
        pending: new Set(),
        flushTimer: null,
        resyncTimer: setInterval(() => {
          void this.enqueue(created, () => this.resync(created));
        }, this.opts.resyncMs),
        queue: Promise.resolve(),
        seq: 0,
      };
      created.resyncTimer.unref();
      this.channels.set(showId, created);
      ch = created;
    }
    return ch;
  }

  /** Runs `job` after every earlier job of this show; a failed job never blocks later ones. */
  private enqueue<T>(ch: Channel, job: () => Promise<T>): Promise<T> {
    const run = ch.queue.then(job);
    ch.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private scheduleFlush(ch: Channel, delayMs: number): void {
    if (ch.flushTimer || this.closed) return;
    ch.flushTimer = setTimeout(() => {
      ch.flushTimer = null;
      void this.enqueue(ch, () => this.flush(ch));
    }, delayMs);
    ch.flushTimer.unref();
  }

  private async flush(ch: Channel): Promise<void> {
    if (ch.pending.size === 0) return;
    if (ch.clients.size === 0) {
      // Nobody to tell. A subscriber still connecting reads its snapshot after these commits.
      ch.pending.clear();
      return;
    }
    const labels = [...ch.pending];
    ch.pending.clear();
    let states: Awaited<ReturnType<typeof getSeatStates>>;
    try {
      states = await this.read(getSeatStates(this.sql, ch.showId, labels));
    } catch (err) {
      for (const label of labels) ch.pending.add(label);
      this.log.warn({ err, show: ch.showId }, "stream delta read failed; retrying");
      this.scheduleFlush(ch, RETRY_AFTER_DB_ERROR_MS);
      return;
    }
    if (!states) return this.gone(ch);
    ch.seq++;
    this.counters.deltas++;
    const changes: Record<string, string> = {};
    for (const s of states.seats) changes[s.label] = SEAT_CODE[s.status];
    this.broadcast(ch, frame("delta", { seq: ch.seq, changes, counts: states.counts }));
  }

  private async resync(ch: Channel): Promise<void> {
    if (ch.clients.size === 0) return;
    let snap: ShowSnapshot | null;
    try {
      snap = await this.read(getShowSnapshot(this.sql, ch.showId));
    } catch (err) {
      this.log.warn({ err, show: ch.showId }, "stream resync read failed");
      return;
    }
    if (!snap) return this.gone(ch);
    ch.seq++;
    this.counters.snapshots++;
    this.broadcast(ch, snapshotFrame(ch.seq, snap));
  }

  private read<T>(work: Promise<T>): Promise<T> {
    return withDeadline(work, this.opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
  }

  private gone(ch: Channel): void {
    this.broadcast(ch, frame("gone", { show_id: ch.showId }));
    for (const client of ch.clients) client.res.end();
  }

  private broadcast(ch: Channel, data: string): void {
    for (const client of ch.clients) this.send(client, data);
  }

  private send(client: Client, data: string): void {
    const { res } = client;
    if (res.destroyed || res.writableEnded) return;
    res.write(data);
    client.frames++;
    this.counters.framesSent++;
    if (res.writableLength > (this.opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED)) {
      // A slow consumer must not make the server buffer without bound. It reconnects and resyncs.
      this.counters.slowClientsDropped++;
      this.log.warn({ buffered: res.writableLength }, "dropping slow stream client");
      res.destroy();
    }
  }

  private beat(): void {
    for (const ch of this.channels.values()) {
      for (const client of ch.clients) {
        if (!client.res.destroyed && !client.res.writableEnded) client.res.write(": hb\n\n");
      }
    }
  }

  private drop(ch: Channel, client: Client): void {
    if (!ch.clients.delete(client)) return;
    client.onClose(client.frames);
    this.retireIfIdle(ch);
  }

  private retireIfIdle(ch: Channel): void {
    if (ch.clients.size > 0 || ch.connecting > 0) return;
    this.stopTimers(ch);
    if (this.channels.get(ch.showId) === ch) this.channels.delete(ch.showId);
  }

  private stopTimers(ch: Channel): void {
    clearInterval(ch.resyncTimer);
    if (ch.flushTimer) clearTimeout(ch.flushTimer);
    ch.flushTimer = null;
  }
}
