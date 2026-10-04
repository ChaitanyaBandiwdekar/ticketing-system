/**
 * The last ~2k log lines in memory, so logs are publicly readable (GET /ops/logs, the War Room's
 * tail) without a paid log drain. Under a stampede ~2k info lines are only seconds of traffic, so
 * warnings and errors are ALSO kept in a ring of their own: request noise can't evict the lines
 * someone would be paged about. It is a pino destination: pino writes each JSON line to stdout
 * AND here (logger.ts). Lines are already redacted by pino; this adds a second, structural pass
 * for public display: stack traces are dropped and only an allow-list of top-level fields is
 * kept, so a field added to some log call later can't leak by accident.
 */

export type LogEntry = {
  /** Monotonic per process; clients page with `after=<seq>`. */
  seq: number;
  time: string;
  level: string;
  msg: string;
  request_id?: string;
  /** The line's other allow-listed fields (route, status, ms, outcome, show, user, ...). */
  fields: Record<string, unknown>;
};

/** Top-level fields that may appear in a public log line, besides time/level/msg/request_id. */
const PUBLIC_FIELDS = new Set([
  "method",
  "route",
  "status",
  "ms",
  "outcome",
  "path",
  "state",
  "code",
  "show",
  "user",
  "seats",
  "reservation",
  "changed",
  "spoof_ignored",
  "claimed_user",
  "frames",
  "job",
  "signal",
  "violations",
  "counts",
  "shows_deleted",
  "keys_deleted",
  "attempt",
  "applied",
  "already_applied",
  "buffered",
]);

const LEVEL_RANK: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export function levelRank(level: string): number {
  return LEVEL_RANK[level] ?? 0;
}

/** An error object reduced to what is safe and useful on a public page. */
function publicError(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { type?: unknown; message?: unknown; code?: unknown };
  return {
    ...(typeof e.type === "string" && { type: e.type }),
    ...(typeof e.message === "string" && { message: e.message.slice(0, 300) }),
    ...(typeof e.code === "string" && { code: e.code }),
  };
}

export type LogQuery = { after?: number; requestId?: string; minLevel?: string; limit?: number };

export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  /** warn and above, kept longer than the main ring under heavy traffic. */
  private readonly notable: LogEntry[] = [];
  private seq = 0;
  private readonly listeners = new Set<(entry: LogEntry) => void>();

  constructor(
    private readonly capacity = 2000,
    private readonly notableCapacity = 500,
  ) {}

  /** pino destination interface: one JSON line per call. */
  write(line: string): void {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (PUBLIC_FIELDS.has(k)) fields[k] = v;
    }
    const err = publicError(raw.err);
    if (err) fields.err = err;
    const entry: LogEntry = {
      seq: ++this.seq,
      time: typeof raw.time === "string" ? raw.time : new Date().toISOString(),
      level: typeof raw.level === "string" ? raw.level : "info",
      msg: typeof raw.msg === "string" ? raw.msg : "",
      ...(typeof raw.request_id === "string" && { request_id: raw.request_id }),
      fields,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    if (levelRank(entry.level) >= LEVEL_RANK.warn!) {
      this.notable.push(entry);
      if (this.notable.length > this.notableCapacity) this.notable.shift();
    }
    for (const listener of this.listeners) listener(entry);
  }

  /** Newest `limit` matching entries with seq > after, oldest first. */
  query(q: LogQuery = {}): LogEntry[] {
    const after = q.after ?? 0;
    const min = q.minLevel ? levelRank(q.minLevel) : 0;
    const limit = q.limit ?? 200;
    // Oldest first: notable lines that already left the main ring, then the main ring.
    const oldestMain = this.entries[0]?.seq ?? Infinity;
    const older = this.notable.filter((e) => e.seq < oldestMain);
    const all = older.length ? [...older, ...this.entries] : this.entries;
    const out: LogEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = all[i]!;
      if (e.seq <= after) break;
      if (q.requestId && e.request_id !== q.requestId) continue;
      if (min && levelRank(e.level) < min) continue;
      out.push(e);
    }
    return out.reverse();
  }

  latestSeq(): number {
    return this.seq;
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
