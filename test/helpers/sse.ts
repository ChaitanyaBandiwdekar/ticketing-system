/**
 * A minimal client for GET /stream: parses SSE frames off a real HTTP response and keeps a seat
 * map by applying them in arrival order, exactly as a browser would.
 */
import type { SeatCounts } from "../../server/src/engine/types";

export type Frame = { event: string; data: Record<string, unknown> };

export class SeatStream {
  /** label -> a | h | c */
  readonly seats = new Map<string, string>();
  readonly frames: Frame[] = [];
  counts: SeatCounts | null = null;
  seq = 0;
  heartbeats = 0;
  ended = false;
  readonly headers: Headers;
  private readonly waiters = new Set<() => void>();
  private readonly done: Promise<void>;

  private constructor(
    private readonly res: Response,
    private readonly abort: AbortController,
  ) {
    this.headers = res.headers;
    this.done = this.pump();
  }

  static async open(baseUrl: string, showId: string): Promise<SeatStream> {
    const abort = new AbortController();
    const res = await fetch(`${baseUrl}/stream?show=${showId}`, { signal: abort.signal });
    if (res.status !== 200) {
      throw new Error(`stream open failed: ${res.status} ${await res.text()}`);
    }
    return new SeatStream(res, abort);
  }

  count(event: string): number {
    return this.frames.filter((f) => f.event === event).length;
  }

  /** Resolves once `pred` holds (checked after every frame); rejects after `timeoutMs`. */
  async waitFor(pred: () => boolean, timeoutMs = 5_000, what = "condition"): Promise<void> {
    if (pred()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!pred()) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.add(check);
    });
  }

  /** Resolves when the server ends the stream. */
  closed(): Promise<void> {
    return this.done;
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.done;
  }

  private async pump(): Promise<void> {
    const reader = this.res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          this.handle(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
    } catch {
      // aborted by close()
    } finally {
      this.ended = true;
      for (const w of [...this.waiters]) w();
    }
  }

  private handle(raw: string): void {
    this.apply(raw);
    for (const w of [...this.waiters]) w();
  }

  private apply(raw: string): void {
    let event = "message";
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) {
        this.heartbeats++;
        continue;
      }
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) return;
    const parsed = JSON.parse(data) as Record<string, unknown>;
    this.frames.push({ event, data: parsed });
    if (event === "snapshot") {
      const labels = parsed.labels as string[];
      const status = parsed.status as string;
      this.seats.clear();
      labels.forEach((label, i) => this.seats.set(label, status[i]!));
      this.counts = parsed.counts as SeatCounts;
      this.seq = parsed.seq as number;
    } else if (event === "delta") {
      for (const [label, code] of Object.entries(parsed.changes as Record<string, string>)) {
        this.seats.set(label, code);
      }
      this.counts = parsed.counts as SeatCounts;
      this.seq = parsed.seq as number;
    }
  }
}
