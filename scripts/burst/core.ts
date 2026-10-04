/**
 * The burst: a first-day-first-show stampede against a running FDFS, with every guarantee
 * checked from the outside.
 *
 * Shared by the CLI (scripts/burst/burst.ts) and the UI's Stampede simulator, so it uses only
 * what Node 20+ and browsers both have (fetch, crypto.randomUUID, performance.now) and never
 * prints: progress and the final report go to the caller.
 *
 * One run:
 * 1. Creates an ephemeral show (confirm mode: a created reservation is final, so a seat once
 *    sold stays sold and every expectation below is exact) and batch-mints tokens.
 * 2. Fires all scenarios interleaved, through one bounded pool of requests in flight:
 *    - hot:      many users storm A12 and a few more front-center seats;
 *    - stampede: Zipf-skewed single and pair requests from a crowd over the rest of the hall;
 *    - retry:    the same request (same key) sent several times at once;
 *    - keyreuse: one key used for different seats, then for the original seats again;
 *    - limit:    one user, many parallel requests, more seats than the per-user limit;
 *    - crossed:  two users want the same pair of seats in opposite order;
 *    - spoof:    a body `user_id` naming somebody else;
 *    - foreign:  cancelling another user's reservation.
 *    429 (shed) and network errors are retried with the same key, as a real client would.
 *    A connection dropped in transit is not a broken guarantee if the retry is answered; a
 *    request still unanswered at the end, or a server that restarted mid-run, is.
 * 3. Meanwhile polls GET /shows/:id: every snapshot must reconcile, and sold never goes down.
 * 4. Afterwards compares the final seat map with every reservation it was granted, runs the
 *    audit, and diffs /metrics against what it observed, outcome by outcome.
 *
 * Every scenario except the stampede and the hot storm uses its own seats and users, so its
 * result is exactly predictable (e.g. "limit": exactly `limit` created out of 10).
 */

// ---------------------------------------------------------------------------------------------
// Options

export type BurstOptions = {
  /** API origin, e.g. http://localhost:8080 ("" for same-origin in the browser). */
  base: string;
  /** Creates the show (POST /shows is admin-only). */
  adminKey: string;
  /** Hall size. Row-major labels A1..A<n>, B1.. (the UI's generator). */
  rows: number;
  seatsPerRow: number;
  perUserLimit: number;
  /** Most requests in flight at once, across all scenarios. */
  concurrency: number;
  /** Stampede: requests and the crowd they come from. */
  requests: number;
  users: number;
  /** Share of stampede requests asking for two seats instead of one. */
  pairShare: number;
  /** Hot storm: seats (A12 first) and users, one request each. */
  hotSeats: number;
  hotUsers: number;
  /** Same-key groups and how many copies each sends at once. */
  retryGroups: number;
  retryCopies: number;
  keyReuseGroups: number;
  /** Users who each send `limitParallel` single-seat requests at once. */
  limitUsers: number;
  limitParallel: number;
  crossedPairs: number;
  spoofs: number;
  foreignCancels: number;
  /** Seat-map poll period during the burst (0 = off). */
  pollMs: number;
  /** Diff /metrics before and after (off when another client may be booking on the same instance). */
  metrics: boolean;
  showName?: string;
  signal?: AbortSignal;
  onShow?: (show: { id: string; name: string; total_seats: number }) => void;
  onProgress?: (p: Progress) => void;
  /** Free-form status lines ("minting 6,000 tokens…"). */
  onStatus?: (line: string) => void;
};

export const DEFAULTS: Omit<BurstOptions, "base" | "adminKey"> = {
  rows: 40,
  seatsPerRow: 50,
  perUserLimit: 4,
  concurrency: 256,
  requests: 20_000,
  users: 5_000,
  pairShare: 0.2,
  hotSeats: 6,
  hotUsers: 500,
  retryGroups: 100,
  retryCopies: 5,
  keyReuseGroups: 50,
  limitUsers: 20,
  limitParallel: 10,
  crossedPairs: 50,
  spoofs: 50,
  foreignCancels: 50,
  pollMs: 250,
  metrics: true,
};

export const SCENARIOS = [
  "hot",
  "stampede",
  "retry",
  "keyreuse",
  "limit",
  "crossed",
  "spoof",
  "foreign",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

// ---------------------------------------------------------------------------------------------
// Results

export type Check = { name: string; ok: boolean; detail: string };

export type Progress = {
  elapsedMs: number;
  /** Requests answered (reserve + cancel), including retried attempts. */
  done: number;
  /** Requests the plan will send at least (retries add to it). */
  planned: number;
  inFlight: number;
  outcomes: Record<string, number>;
  polls: number;
  pollViolations: number;
};

export type Counts = {
  total: number;
  available: number;
  held: number;
  confirmed: number;
  invariant_ok: boolean;
};

export type Slow = { requestId: string; ms: number; outcome: string };
const SLOWEST = 5;
/** Tries per logical request when it is shed (429) or gets no answer: ~2 minutes of backoff. */
const MAX_ATTEMPTS = 10;

export type BurstReport = {
  ok: boolean;
  show: { id: string; name: string; total_seats: number };
  base: string;
  durationMs: number;
  /** Reserve responses only (what fdfs_reserve_responses_total counts), retries included. */
  outcomes: Record<string, number>;
  /** Final outcome per scenario (after retries). */
  scenarios: Record<Scenario, Record<string, number>>;
  status: { "2xx": number; "4xx": number; "429": number; "5xx": number; network: number };
  retries: number;
  /** Reserves and cancels still without an answer after every retry. */
  unanswered: number;
  /**
   * Requests that reached the server twice through one fetch, with no failure the client saw: the
   * browser or an edge proxy re-sent it after the connection dropped. The first copy booked, its
   * answer was lost, and the client got the replay. Each one is still that request's booking.
   */
  resent: number;
  reserveRequests: number;
  throughput: number;
  latency: { p50: number; p95: number; p99: number; max: number } | null;
  /** The slowest reserve requests, by x-request-id (searchable in the War Room's log tail). */
  slowest: Slow[];
  polls: { count: number; violations: string[]; failed: number };
  final: Counts | null;
  audit: { ok: boolean; violations: unknown[] } | null;
  metrics: { outcome: string; observed: number; delta: number }[] | null;
  checks: Check[];
};

// ---------------------------------------------------------------------------------------------
// Small pieces

type Reservation = {
  reservation_id: string;
  user_id: string;
  seats: string[];
  status: string;
};

type Resp = {
  status: number;
  /** created / replayed / the error code / http_<status> / network_error. */
  outcome: string;
  body: unknown;
  ms: number;
  /** Sent as x-request-id: the War Room's log tail finds the request's server lines by it. */
  requestId: string;
  /** Retry-After (seconds) on 429/503. */
  retryAfter?: number;
  /** An earlier attempt of this request failed (503 or no answer), so it may have committed. */
  afterFailure?: boolean;
  /** Its idempotency key was also sent by another request, so a replay may be that one's booking. */
  sharedKey?: boolean;
};

/** 0 -> "A", 25 -> "Z", 26 -> "AA" (same lettering as the UI's hall generator). */
export function rowLabel(index: number): string {
  let label = "";
  let i = index;
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

/** Deterministic PRNG (mulberry32), so a run's plan is reproducible from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Zipf(s) sampler over ranks 0..n-1 (rank 0 most popular). */
export function zipf(n: number, s: number, rand: () => number): () => number {
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) cdf[k] = acc += 1 / (k + 1) ** s;
  return () => {
    const u = rand() * acc;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

class Semaphore {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(n: number) {
    this.free = n;
  }
  get busy() {
    return this.waiters.length;
  }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiters.push(r));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/** Prometheus text → `name{labels}` → value. */
export function parseMetrics(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" ");
    m.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return m;
}

export function reserveCounters(m: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of m) {
    const hit = /^fdfs_reserve_responses_total\{outcome="([^"]+)"\}$/.exec(k);
    if (hit) out.set(hit[1]!, v);
  }
  return out;
}

const bump = (rec: Record<string, number>, k: string, n = 1) => (rec[k] = (rec[k] ?? 0) + n);

// ---------------------------------------------------------------------------------------------
// The plan: which seats and users each scenario gets

export type SeatPlan = {
  all: string[];
  hot: string[];
  /** Stampede seats, most desirable first (the Zipf ranks). */
  crowd: string[];
  /** Seats reserved for the exact scenarios, handed out in order. */
  exact: string[];
};

/**
 * Splits the hall: hot seats (A12 first, then front-center), the exact scenarios' seats (the
 * least wanted, back corners), and the crowd's seats in between, ranked by how good they are
 * (center seats of the rows about 60% back).
 */
export function planSeats(
  o: Pick<BurstOptions, "rows" | "seatsPerRow" | "hotSeats">,
  exactNeeded: number,
): SeatPlan {
  const all: string[] = [];
  const score = new Map<string, number>();
  for (let r = 0; r < o.rows; r++) {
    for (let s = 1; s <= o.seatsPerRow; s++) {
      const label = `${rowLabel(r)}${s}`;
      all.push(label);
      const rowDist = Math.abs(r - (o.rows - 1) * 0.6) / Math.max(1, o.rows);
      const seatDist = Math.abs(s - (o.seatsPerRow + 1) / 2) / Math.max(1, o.seatsPerRow);
      score.set(label, rowDist + seatDist);
    }
  }
  const front = [...all].sort((a, b) => {
    const ra = a.replace(/\d+$/, "");
    const rb = b.replace(/\d+$/, "");
    const rowCmp = ra.length - rb.length || ra.localeCompare(rb);
    if (rowCmp) return rowCmp;
    const c = (o.seatsPerRow + 1) / 2;
    return Math.abs(Number(a.slice(ra.length)) - c) - Math.abs(Number(b.slice(rb.length)) - c);
  });
  const hot = all.includes("A12") ? ["A12"] : [];
  for (const s of front) {
    if (hot.length >= o.hotSeats) break;
    if (!hot.includes(s)) hot.push(s);
  }
  const rest = all.filter((s) => !hot.includes(s)).sort((a, b) => score.get(a)! - score.get(b)!);
  if (exactNeeded > rest.length - 1) {
    throw new Error(
      `the hall is too small: the exact scenarios need ${exactNeeded} seats and the crowd at least 1`,
    );
  }
  const exact = rest.slice(rest.length - exactNeeded).reverse();
  const crowd = rest.slice(0, rest.length - exactNeeded);
  return { all, hot: hot.slice(0, o.hotSeats), crowd, exact };
}

export function exactSeatsNeeded(o: BurstOptions): number {
  return (
    o.keyReuseGroups * 2 +
    o.limitUsers * o.limitParallel +
    o.crossedPairs * 2 +
    o.spoofs +
    o.foreignCancels
  );
}

/** Requests the plan sends before any retry. */
export function plannedRequests(o: BurstOptions): number {
  return (
    o.hotUsers +
    o.requests +
    o.retryGroups * o.retryCopies +
    o.keyReuseGroups * 3 +
    o.limitUsers * o.limitParallel +
    o.crossedPairs * 2 +
    o.spoofs +
    o.foreignCancels * 2
  );
}

function usersNeeded(o: BurstOptions): number {
  return (
    o.hotUsers +
    o.users +
    o.retryGroups +
    o.keyReuseGroups +
    o.limitUsers +
    o.crossedPairs * 2 +
    o.spoofs +
    o.foreignCancels * 2
  );
}

// ---------------------------------------------------------------------------------------------
// The run

type User = { id: string; token: string };

export async function runBurst(
  input: Partial<BurstOptions> & Pick<BurstOptions, "base" | "adminKey">,
): Promise<BurstReport> {
  const o: BurstOptions = { ...DEFAULTS, ...input };
  const base = o.base.replace(/\/+$/, "");
  const status = (line: string) => o.onStatus?.(line);
  const signal = o.signal;
  const seed = Date.now();
  const rand = rng(seed);
  const run = `b${seed.toString(36)}${Math.floor(rand() * 1296).toString(36)}`;

  const seats = planSeats(o, exactSeatsNeeded(o));

  // ---- HTTP

  const outcomes: Record<string, number> = {};
  const httpStatus = { "2xx": 0, "4xx": 0, "429": 0, "5xx": 0, network: 0 };
  const latencies: number[] = [];
  let reserveRequests = 0;
  let retries = 0;
  let resent = 0;
  /** Reserve attempts that got no answer: the server may have answered (and counted) them. */
  let droppedAttempts = 0;
  /** Logical requests (reserve, cancel) with no answer even after every retry. */
  let unanswered = 0;
  /** How long failed connections took to fail: a few ms means it never left the browser/edge. */
  let netMin = Infinity;
  let netMax = 0;
  let sent = 0;
  /** A few distinct network-error causes, for the report. */
  const networkErrors: string[] = [];
  /** The slowest reserve responses, kept sorted, at most SLOWEST long. */
  const slowest: Slow[] = [];
  let done = 0;
  const pool = new Semaphore(Math.max(1, o.concurrency));
  let inFlight = 0;

  async function send(
    method: "GET" | "POST",
    path: string,
    init: { bearer?: string; body?: unknown; key?: string } = {},
  ): Promise<Resp> {
    const requestId = `${run}-${++sent}`;
    const headers: Record<string, string> = { "x-request-id": requestId };
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    if (init.key) headers["idempotency-key"] = init.key;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    // Stopping issues no new requests (the run then rejects); the few in flight just finish.
    // The signal is not handed to fetch: thousands of requests listening on one signal trip
    // undici's listener cap.
    if (signal?.aborted) throw new DOMException("The burst was stopped", "AbortError");
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await res.text();
      const ms = performance.now() - t0;
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const code = (body as { error?: { code?: string } } | null)?.error?.code;
      // A replay is the original 201, told apart only by its header.
      const outcome =
        res.status === 201
          ? res.headers.get("idempotent-replayed") === "true"
            ? "replayed"
            : "created"
          : (code ?? `http_${res.status}`);
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      return { status: res.status, outcome, body, ms, requestId, retryAfter };
    } catch (err) {
      const ms = performance.now() - t0;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (err as Error).message;
      if (networkErrors.length < 5 && !networkErrors.some((e) => e.startsWith(why))) {
        networkErrors.push(
          `${why} after ${Math.round(ms)}ms (${method} ${path.replace(/[0-9a-f-]{36}/, ":id")})`,
        );
      }
      netMin = Math.min(netMin, ms);
      netMax = Math.max(netMax, ms);
      return { status: 0, outcome: "network_error", body: why, ms, requestId };
    }
  }

  const tally = (r: Resp, reserve: boolean) => {
    done++;
    if (r.status === 0) httpStatus.network++;
    else if (r.status === 429) httpStatus["429"]++;
    else if (r.status >= 500) httpStatus["5xx"]++;
    else if (r.status >= 400) httpStatus["4xx"]++;
    else httpStatus["2xx"]++;
    if (reserve) {
      reserveRequests++;
      if (r.status === 0) droppedAttempts++;
      else {
        bump(outcomes, r.outcome);
        latencies.push(r.ms);
        if (slowest.length < SLOWEST || r.ms > slowest.at(-1)!.ms) {
          slowest.push({ requestId: r.requestId, ms: r.ms, outcome: r.outcome });
          slowest.sort((a, b) => b.ms - a.ms);
          slowest.length = Math.min(slowest.length, SLOWEST);
        }
      }
    }
  };

  /** One logical request through the pool; 429 and network errors retry with the same key. */
  async function call(
    method: "POST",
    path: string,
    init: { bearer: string; body?: unknown; key?: string },
    reserve: boolean,
  ): Promise<Resp> {
    let failedBefore = false;
    for (let attempt = 0; ; attempt++) {
      const release = await pool.acquire();
      inFlight++;
      let r: Resp;
      try {
        r = await send(method, path, init);
      } finally {
        inFlight--;
        release();
      }
      tally(r, reserve);
      // Shed (429), unavailable (503: the DB deadline passed, and the booking may still have
      // committed) or never answered: try again with the same key, as the API asks, honoring
      // Retry-After. The retry replays a booking that did commit. A shed queue drains at the
      // server's pace, so be patient. A 503 still fails "no 5xx".
      const retryable = r.status === 429 || r.status === 503 || r.status === 0;
      r.afterFailure = failedBefore;
      if (!retryable || attempt >= MAX_ATTEMPTS - 1 || signal?.aborted) {
        if (r.status === 0) unanswered++;
        return r;
      }
      if (r.status !== 429) failedBefore = true;
      retries++;
      const backoff = Math.max((r.retryAfter ?? 0) * 1000, Math.min(15_000, 500 * 2 ** attempt));
      await sleep(backoff * (0.75 + rand() / 2), signal);
    }
  }

  // ---- Setup: the show and the crowd's tokens

  const name = o.showName ?? `Burst ${new Date(seed).toISOString().slice(0, 19).replace("T", " ")}`;
  status(`creating show "${name}" (${seats.all.length.toLocaleString("en")} seats)…`);
  const created = await send("POST", "/shows", {
    bearer: o.adminKey,
    body: {
      name,
      seats: seats.all,
      price_paise: 25_000,
      per_user_limit: o.perUserLimit,
      hold_ttl_seconds: null,
      ephemeral: true,
    },
  });
  if (created.status !== 201) {
    throw new Error(
      `could not create the show: HTTP ${created.status} ${created.outcome}` +
        (created.status === 401 || created.status === 403 ? " (check the admin key)" : ""),
    );
  }
  const show = created.body as { id: string; name: string; total_seats: number };
  o.onShow?.(show);
  const showPath = `/shows/${show.id}`;

  const need = usersNeeded(o);
  status(`minting ${need.toLocaleString("en")} tokens…`);
  const users: User[] = [];
  for (let start = 1; users.length < need;) {
    const count = Math.min(10_000, need - users.length);
    const r = await send("POST", "/auth/tokens", { body: { count, prefix: run, start } });
    if (r.status !== 200) throw new Error(`could not mint tokens: HTTP ${r.status} ${r.outcome}`);
    for (const t of (r.body as { tokens: { user_id: string; token: string }[] }).tokens) {
      users.push({ id: t.user_id, token: t.token });
    }
    start += count;
  }
  let nextUser = 0;
  const takeUsers = (n: number) => users.slice(nextUser, (nextUser += n));
  let nextExact = 0;
  const takeSeats = (n: number) => seats.exact.slice(nextExact, (nextExact += n));

  // Which server process answered: a restart mid-run is a crash, whatever the client saw.
  type Instance = { instance: string; started_at: string };
  const instanceNow = async (): Promise<Instance | null> => {
    const r = await send("GET", "/ops/summary");
    const b = r.body as Partial<Instance> | null;
    return r.status === 200 && b?.instance && b.started_at
      ? { instance: b.instance, started_at: b.started_at }
      : null;
  };
  const serverBefore = await instanceNow();

  let metricsBefore: Map<string, number> | null = null;
  if (o.metrics) {
    const m = await fetch(`${base}/metrics`, { signal }).catch(() => null);
    metricsBefore = m?.ok ? reserveCounters(parseMetrics(await m.text())) : null;
    if (!metricsBefore) status("note: /metrics unreachable; skipping the metrics diff");
  }

  // ---- Scenarios. Each task is one user's (or group's) script; tasks run interleaved.

  const scen = Object.fromEntries(SCENARIOS.map((s) => [s, {}])) as BurstReport["scenarios"];
  const granted: (Reservation & { scenario: Scenario })[] = [];
  const failures: Record<Scenario, string[]> = Object.fromEntries(
    SCENARIOS.map((s) => [s, []]),
  ) as unknown as Record<Scenario, string[]>;
  const fail = (s: Scenario, msg: string) => {
    if (failures[s].length < 5) failures[s].push(msg);
    else if (failures[s].length === 5) failures[s].push("…");
  };
  const key = () => crypto.randomUUID();

  /**
   * One reserve. Without `key` it gets a fresh one of its own. Pass `shared` when the key is (or
   * was) also sent by another request: only then can a replay be somebody else's booking.
   */
  const reserve = async (
    s: Scenario,
    u: User,
    seatList: string[],
    opts: { key?: string; shared?: boolean; extra?: Record<string, unknown> } = {},
  ): Promise<Resp> => {
    const r = await call(
      "POST",
      `${showPath}/reserve`,
      { bearer: u.token, key: opts.key ?? key(), body: { seats: seatList, ...opts.extra } },
      true,
    );
    r.sharedKey = opts.shared === true;
    if (r.outcome === "replayed" && !r.sharedKey && !r.afterFailure) resent++;
    const won = isWin(r);
    bump(scen[s], won ? "created" : r.outcome);
    if (won) granted.push({ ...(r.body as Reservation), scenario: s });
    return r;
  };
  // A replay of a key nobody else sent is this request's own booking: an earlier attempt that
  // failed, or a copy re-sent in transit, committed it and its answer was lost. A replay of a
  // shared key is a win only after a failed attempt (the shared-key scenarios check the rest).
  const isWin = (r: Resp) =>
    r.outcome === "created" ||
    (r.outcome === "replayed" && (r.afterFailure === true || !r.sharedKey));
  const idOf = (r: Resp) => (r.body as Reservation | null)?.reservation_id;

  const tasks: (() => Promise<void>)[] = [];

  // Hot storm: each user one request, half of them on A12.
  const hotWanted = new Set<string>();
  for (const u of takeUsers(seats.hot.length ? o.hotUsers : 0)) {
    const seat = rand() < 0.5 ? seats.hot[0]! : seats.hot[Math.floor(rand() * seats.hot.length)]!;
    hotWanted.add(seat);
    tasks.push(async () => void (await reserve("hot", u, [seat])));
  }

  // Stampede: Zipf over the crowd's seats, from a crowd of users.
  const crowd = takeUsers(o.users);
  const pick = zipf(seats.crowd.length, 0.9, rand);
  for (let i = 0; i < o.requests; i++) {
    const u = crowd[Math.floor(rand() * crowd.length)]!;
    const a = seats.crowd[pick()]!;
    let want = [a];
    if (rand() < o.pairShare && seats.crowd.length > 1) {
      let b = seats.crowd[pick()]!;
      for (let tries = 0; b === a && tries < 5; tries++) b = seats.crowd[pick()]!;
      if (b !== a) want = [a, b];
    }
    tasks.push(async () => void (await reserve("stampede", u, want)));
  }

  // Same key, several copies at once: at most one creates and every other copy replays it.
  for (const u of takeUsers(o.retryGroups)) {
    const k = key();
    const want = [seats.crowd[pick()]!];
    tasks.push(async () => {
      const rs = await Promise.all(
        Array.from({ length: o.retryCopies }, () =>
          reserve("retry", u, want, { key: k, shared: true }),
        ),
      );
      // Every copy replayed and none saw a failure: the copy that booked was re-sent in transit
      // and its answer lost. The booking is still the group's.
      const replay = rs.find((r) => r.outcome === "replayed");
      if (replay && !rs.some(isWin)) {
        resent++;
        granted.push({ ...(replay.body as Reservation), scenario: "retry" });
      }
      const ids = new Set(rs.filter((r) => r.status === 201).map(idOf));
      const createdN = rs.filter((r) => r.outcome === "created").length;
      const declined = rs.filter((r) => r.status === 409).length;
      if (createdN > 1) fail("retry", `key ${k}: ${createdN} copies created`);
      if (ids.size > 1)
        fail("retry", `key ${k}: copies returned ${ids.size} different reservations`);
      if (createdN === 1 && declined > 0) {
        fail("retry", `key ${k}: created once, yet ${declined} copies were declined, not replayed`);
      }
    });
  }

  // One key, different seats: refused (409); the original seats again: the same reservation.
  for (const u of takeUsers(o.keyReuseGroups)) {
    const [x, y] = takeSeats(2) as [string, string];
    tasks.push(async () => {
      const k = key();
      const first = await reserve("keyreuse", u, [x], { key: k });
      if (!isWin(first)) {
        return fail("keyreuse", `${u.id}: first request ${first.outcome}`);
      }
      const other = await reserve("keyreuse", u, [y], { key: k, shared: true });
      if (other.outcome !== "idempotency_key_reused") {
        fail(
          "keyreuse",
          `${u.id}: same key, other seat → ${other.outcome}, not idempotency_key_reused`,
        );
      }
      const again = await reserve("keyreuse", u, [x], { key: k, shared: true });
      if (again.outcome !== "replayed" || idOf(again) !== idOf(first)) {
        fail(
          "keyreuse",
          `${u.id}: same key, same seat → ${again.outcome}, not a replay of the original`,
        );
      }
    });
  }

  // One user, many parallel single-seat requests: exactly the limit is granted.
  for (const u of takeUsers(o.limitUsers)) {
    const own = takeSeats(o.limitParallel);
    tasks.push(async () => {
      const rs = await Promise.all(own.map((s) => reserve("limit", u, [s])));
      const ok = rs.filter(isWin).length;
      const over = rs.filter((r) => r.outcome === "per_user_limit").length;
      const expect = Math.min(o.perUserLimit, own.length);
      if (ok !== expect || over !== own.length - expect) {
        fail(
          "limit",
          `${u.id}: ${ok} created, ${over} per_user_limit (expected ${expect} and ${own.length - expect})`,
        );
      }
    });
  }

  // Crossed pairs: [X,Y] vs [Y,X] at once. Exactly one wins both seats; no deadlock surfaces.
  for (let i = 0; i < o.crossedPairs; i++) {
    const [a, b] = takeUsers(2) as [User, User];
    const [x, y] = takeSeats(2) as [string, string];
    tasks.push(async () => {
      const [ra, rb] = await Promise.all([
        reserve("crossed", a, [x, y]),
        reserve("crossed", b, [y, x]),
      ]);
      const wins = [ra, rb].filter(isWin).length;
      const lost = [ra, rb].filter((r) => r.outcome === "seat_taken").length;
      if (wins !== 1 || lost !== 1) fail("crossed", `${x}+${y}: ${ra.outcome} / ${rb.outcome}`);
    });
  }

  // A body user_id naming someone else is ignored: the booking belongs to the token's user.
  for (const u of takeUsers(o.spoofs)) {
    const [seat] = takeSeats(1) as [string];
    tasks.push(async () => {
      const r = await reserve("spoof", u, [seat], { extra: { user_id: `${run}-victim` } });
      if (!isWin(r)) return fail("spoof", `${u.id}: ${r.outcome}`);
      const owner = (r.body as Reservation).user_id;
      if (owner !== u.id) fail("spoof", `${u.id}: booking recorded for ${owner}`);
    });
  }

  // Cancelling someone else's reservation: 403, and the booking stands.
  for (let i = 0; i < o.foreignCancels; i++) {
    const [owner, intruder] = takeUsers(2) as [User, User];
    const [seat] = takeSeats(1) as [string];
    tasks.push(async () => {
      const r = await reserve("foreign", owner, [seat]);
      if (!isWin(r)) return fail("foreign", `${owner.id}: ${r.outcome}`);
      const c = await call(
        "POST",
        `/reservations/${idOf(r)}/cancel`,
        { bearer: intruder.token },
        false,
      );
      bump(scen.foreign, `cancel:${c.outcome}`);
      if (c.status !== 403)
        fail("foreign", `${intruder.id} cancelled ${owner.id}'s booking: ${c.status} ${c.outcome}`);
    });
  }

  // Interleave: the burst is everyone at once, not scenario after scenario.
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
  }

  // ---- Live invariant polling

  const pollViolations: string[] = [];
  let polls = 0;
  let pollFailed = 0;
  let sold = 0;
  let running = true;
  const checkSnapshot = (c: Counts, where: string) => {
    const sum = c.available + c.held + c.confirmed;
    if (!c.invariant_ok || sum !== c.total) {
      pollViolations.push(`${where}: ${c.available}+${c.held}+${c.confirmed}=${sum} of ${c.total}`);
    }
    if (c.confirmed < sold)
      pollViolations.push(`${where}: sold went down ${sold} → ${c.confirmed}`);
    sold = Math.max(sold, c.confirmed);
  };
  const poller = (async () => {
    if (!o.pollMs) return;
    while (running && !signal?.aborted) {
      const r = await send("GET", showPath);
      if (r.status === 200) {
        polls++;
        checkSnapshot((r.body as { counts: Counts }).counts, `poll ${polls}`);
      } else {
        pollFailed++;
        if (r.status >= 500 || r.status === 0) httpStatus[r.status === 0 ? "network" : "5xx"]++;
      }
      await sleep(o.pollMs, signal);
    }
  })();

  // The server's log position, so the 5xx causes below are only this burst's.
  const mark = await send("GET", "/ops/logs?limit=1");
  const logSeq = (mark.body as { lines?: { seq: number }[] } | null)?.lines?.at(-1)?.seq ?? 0;
  const t0 = performance.now();
  const planned = plannedRequests(o);
  const ticker = setInterval(() => {
    o.onProgress?.({
      elapsedMs: performance.now() - t0,
      done,
      planned,
      inFlight,
      outcomes: { ...outcomes },
      polls,
      pollViolations: pollViolations.length,
    });
  }, 250);

  status(`firing ${planned.toLocaleString("en")} requests, ${o.concurrency} in flight…`);
  try {
    await Promise.all(tasks.map((t) => t()));
  } finally {
    running = false;
    clearInterval(ticker);
  }
  const durationMs = performance.now() - t0;
  await poller;
  o.onProgress?.({
    elapsedMs: durationMs,
    done,
    planned,
    inFlight: 0,
    outcomes: { ...outcomes },
    polls,
    pollViolations: pollViolations.length,
  });

  // ---- Afterwards: the final map, the audit, the metrics

  status("reconciling…");
  const snap = await send("GET", showPath);
  const finalSnap =
    snap.status === 200
      ? (snap.body as { counts: Counts; seats: { label: string; status: string }[] })
      : null;
  if (finalSnap) checkSnapshot(finalSnap.counts, "final");
  const auditR = await send("GET", `${showPath}/audit`);
  const audit =
    auditR.status === 200 ? (auditR.body as { ok: boolean; violations: unknown[] }) : null;

  const serverAfter = await instanceNow();

  let metrics: BurstReport["metrics"] = null;
  if (metricsBefore) {
    const m = await fetch(`${base}/metrics`, { signal }).catch(() => null);
    const after = m?.ok ? reserveCounters(parseMetrics(await m.text())) : null;
    if (after) {
      const keys = new Set([...Object.keys(outcomes), ...after.keys()]);
      metrics = [...keys]
        .map((k) => ({
          outcome: k,
          observed: outcomes[k] ?? 0,
          delta: (after.get(k) ?? 0) - (metricsBefore!.get(k) ?? 0),
        }))
        .filter((r) => r.observed || r.delta)
        .sort((a, b) => b.observed - a.observed);
    }
  }

  // ---- Checks

  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // On any 5xx, ask the server why: its error lines are public (GET /ops/logs, redacted).
  let causes = "";
  if (httpStatus["5xx"] > 0) {
    const logs = await send("GET", `/ops/logs?level=error&after=${logSeq}&limit=200`);
    type Line = { msg?: string; fields?: Record<string, unknown> };
    const lines = (logs.body as { lines?: Line[] } | null)?.lines;
    const seen = new Map<string, number>();
    for (const l of lines ?? []) {
      const f = l.fields ?? {};
      const err = f.err as { code?: string; message?: string } | undefined;
      if (!err) continue;
      const what = String(f.code ?? l.msg ?? f.status);
      const why = `${what} ← ${err.code ?? ""} ${err.message ?? ""}`.trim();
      seen.set(why, (seen.get(why) ?? 0) + 1);
    }
    if (seen.size) causes = `: ${[...seen].map(([why, n]) => `${why} (×${n})`).join("; ")}`;
  }
  check(
    "no 5xx",
    httpStatus["5xx"] === 0,
    `${httpStatus["5xx"]} server errors (polls included)${causes}`,
  );
  // A dropped connection is retried with the same key, as the API asks; the idempotency key
  // makes that safe. What breaks a guarantee is a request that never gets an answer.
  const span = (a: number, b: number) =>
    Math.round(a) === Math.round(b) ? `${Math.round(a)}ms` : `${Math.round(a)}–${Math.round(b)}ms`;
  check(
    "every request answered",
    unanswered === 0,
    (unanswered
      ? `${unanswered} still unanswered after ${MAX_ATTEMPTS} tries; `
      : httpStatus.network
        ? ""
        : "no connection dropped") +
      (httpStatus.network
        ? `${httpStatus.network} connections dropped in transit after ${span(netMin, netMax)}` +
          (unanswered ? "" : ", each reserve and cancel retried with the same key and answered") +
          (networkErrors.length ? `: ${networkErrors.join("; ")}` : "")
        : ""),
  );
  if (serverBefore && serverAfter) {
    const same =
      serverBefore.instance === serverAfter.instance &&
      serverBefore.started_at === serverAfter.started_at;
    check(
      "server stayed up",
      same,
      same
        ? `instance ${serverBefore.instance}, up since ${serverBefore.started_at}`
        : `${serverBefore.instance} (up since ${serverBefore.started_at}) → ` +
            `${serverAfter.instance} (up since ${serverAfter.started_at})`,
    );
  }

  // No seat sold twice: the reservations granted to us never overlap.
  const owner = new Map<string, string>();
  const doubles: string[] = [];
  for (const g of granted) {
    for (const s of g.seats) {
      const prev = owner.get(s);
      if (prev && prev !== g.reservation_id) doubles.push(s);
      owner.set(s, g.reservation_id);
    }
  }
  const distinct = new Set(granted.map((g) => g.reservation_id)).size;
  check(
    "no seat sold twice",
    doubles.length === 0,
    doubles.length
      ? `seats in two reservations: ${doubles.slice(0, 10).join(", ")}`
      : `${owner.size.toLocaleString("en")} seats across ${distinct.toLocaleString("en")} reservations, all disjoint`,
  );

  const perUser = new Map<string, number>();
  for (const g of new Map(granted.map((x) => [x.reservation_id, x])).values()) {
    perUser.set(g.user_id, (perUser.get(g.user_id) ?? 0) + g.seats.length);
  }
  const over = [...perUser].filter(([, n]) => n > o.perUserLimit);
  check(
    "no user over the limit",
    over.length === 0,
    over.length
      ? over
          .slice(0, 5)
          .map(([u, n]) => `${u} holds ${n}`)
          .join(", ")
      : `max ${Math.max(0, ...perUser.values())} of ${o.perUserLimit} seats per user`,
  );

  // The final map is exactly what was granted: every granted seat confirmed, nothing else sold.
  if (finalSnap) {
    const sold = new Set(
      finalSnap.seats.filter((s) => s.status !== "available").map((s) => s.label),
    );
    const missing = [...owner.keys()].filter((s) => !sold.has(s));
    const extra = [...sold].filter((s) => !owner.has(s));
    check(
      "final map matches what was granted",
      missing.length === 0 && extra.length === 0 && finalSnap.counts.held === 0,
      missing.length || extra.length
        ? `granted but not sold: ${missing.slice(0, 5).join(", ") || "none"}; sold but never granted: ${extra.slice(0, 5).join(", ") || "none"}`
        : `${sold.size.toLocaleString("en")} sold = ${owner.size.toLocaleString("en")} granted`,
    );
  } else {
    check("final map matches what was granted", false, `GET ${showPath} → ${snap.status}`);
  }

  check(
    "invariant held during the burst",
    pollViolations.length === 0 && (polls > 0 || !o.pollMs),
    pollViolations.length
      ? pollViolations.slice(0, 3).join("; ")
      : `${polls} snapshots, every one balanced${pollFailed ? ` (${pollFailed} polls failed)` : ""}`,
  );
  check(
    "audit",
    audit?.ok === true,
    audit
      ? audit.ok
        ? "ok"
        : JSON.stringify(audit.violations).slice(0, 200)
      : `HTTP ${auditR.status}`,
  );

  // Hot storm: every hot seat has exactly one winner (nobody else may book them).
  const hotWins = scen.hot.created ?? 0;
  const hotOdd = Object.keys(scen.hot).filter((k) => !["created", "seat_taken"].includes(k));
  check(
    "hot: one winner per hot seat",
    hotWins === hotWanted.size && hotOdd.length === 0,
    `${hotWins} winners for ${hotWanted.size} seats among ${o.hotUsers} users` +
      (hotOdd.length ? `; unexpected ${hotOdd.join(", ")}` : ""),
  );
  const stampedeOdd = Object.keys(scen.stampede).filter(
    // "overloaded": still shed after every retry. A 429 is graceful degradation, not a broken
    // guarantee; it is listed in the detail and in the outcome table.
    (k) => !["created", "seat_taken", "per_user_limit", "overloaded"].includes(k),
  );
  check(
    "stampede: only bookings and clean declines",
    stampedeOdd.length === 0,
    stampedeOdd.length
      ? `unexpected outcomes: ${stampedeOdd.map((k) => `${k}×${scen.stampede[k]}`).join(", ")}`
      : Object.entries(scen.stampede)
          .map(([k, v]) => `${k} ${v.toLocaleString("en")}`)
          .join(" · "),
  );
  const exactScenarios: [Scenario, string, number][] = [
    ["retry", "same key: one booking, the rest replay it", o.retryGroups],
    ["keyreuse", "key reuse: 409, then the original replays", o.keyReuseGroups],
    ["limit", `limit: exactly ${o.perUserLimit} of ${o.limitParallel} parallel`, o.limitUsers],
    ["crossed", "crossed pairs: one winner, no deadlock", o.crossedPairs],
    ["spoof", "spoofed user_id ignored", o.spoofs],
    ["foreign", "foreign cancel refused (403)", o.foreignCancels],
  ];
  for (const [s, label, n] of exactScenarios) {
    if (n === 0) continue;
    check(
      label,
      failures[s].length === 0,
      failures[s].length ? failures[s].join("; ") : `${n} groups as expected`,
    );
  }

  if (metrics) {
    // The server counts a response once it has sent it; the client only counts what arrived. An
    // answer lost on the way (a network error, or a copy re-sent in transit) is counted by the
    // server alone, so the metric may run ahead, by at most one per such request. It may never
    // fall behind: every response the client saw was sent, and counted, by the server.
    const behind = metrics.filter((m) => m.delta < m.observed);
    const ahead = metrics.filter((m) => m.delta > m.observed);
    const lost = ahead.reduce((a, m) => a + m.delta - m.observed, 0);
    const mayLose = droppedAttempts + resent;
    const off = [...behind, ...(lost > mayLose ? ahead : [])];
    const lostNote =
      `${lost} answer${lost === 1 ? "" : "s"} the server sent never arrived ` +
      `(${ahead.map((m) => `${m.outcome} +${m.delta - m.observed}`).join(", ")})`;
    check(
      "metrics match observations",
      off.length === 0,
      off.length
        ? off.map((m) => `${m.outcome}: saw ${m.observed}, metric +${m.delta}`).join("; ") +
            (lost > mayLose
              ? `; more than the ${mayLose} requests whose answer was lost in transit`
              : "")
        : lost
          ? `fdfs_reserve_responses_total agrees on ${metrics.length - ahead.length} of ` +
            `${metrics.length} outcomes; ${lostNote}, within the ${mayLose} requests whose ` +
            `answer was lost in transit`
          : `fdfs_reserve_responses_total agrees on all ${metrics.length} outcomes`,
    );
  }

  const sortedLat = latencies.sort((a, b) => a - b);
  const report: BurstReport = {
    ok: checks.every((c) => c.ok),
    show,
    base: o.base,
    durationMs,
    outcomes,
    scenarios: scen,
    status: httpStatus,
    retries,
    unanswered,
    resent,
    reserveRequests,
    throughput: reserveRequests / Math.max(0.001, durationMs / 1000),
    latency: sortedLat.length
      ? {
          p50: quantile(sortedLat, 0.5),
          p95: quantile(sortedLat, 0.95),
          p99: quantile(sortedLat, 0.99),
          max: sortedLat.at(-1)!,
        }
      : null,
    slowest,
    polls: { count: polls, violations: pollViolations, failed: pollFailed },
    final: finalSnap?.counts ?? null,
    audit,
    metrics,
    checks,
  };

  // Record the run, so the War Room shows its verdict after the live window has moved on. The
  // server keeps the fields its scorecard renders and adds its own audit of the show. Best
  // effort: a failure here is a status line, never a failed burst.
  const saved = await send("POST", "/ops/runs", {
    bearer: o.adminKey,
    body: { ...report, settings: { concurrency: o.concurrency, perUserLimit: o.perUserLimit } },
  });
  if (saved.status !== 201) {
    status(
      `note: could not record the run for the War Room (HTTP ${saved.status} ${saved.outcome})`,
    );
  }
  return report;
}
