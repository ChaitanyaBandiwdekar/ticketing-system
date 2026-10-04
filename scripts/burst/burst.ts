#!/usr/bin/env node
/**
 * npm run burst -- <BASE_URL> [options]
 * node scripts/burst/burst.mjs <BASE_URL> [options]   (the same, prebuilt: one file, no install)
 *
 * Fires the full first-day-first-show stampede (scripts/burst/core.ts) at a running FDFS and
 * exits non-zero if any guarantee broke: a 5xx, a request never answered, a server restart, a
 * seat sold twice, a user over the limit, a broken idempotent retry, an unbalanced snapshot, a
 * failed audit, or /metrics disagreeing with what the burst saw.
 *
 * The admin key (POST /shows) comes from --admin-key or ADMIN_API_KEY.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DEFAULTS, plannedRequests, runBurst, type BurstOptions, type BurstReport } from "./core";

const HELP = `Usage: node burst.mjs <BASE_URL> [options]    (or, in a clone: npm run burst -- <BASE_URL>)

  --admin-key <key>      admin key for POST /shows (default: $ADMIN_API_KEY)
  --requests <n>         stampede requests (default ${DEFAULTS.requests})
  --users <n>            stampede crowd size (default ${DEFAULTS.users})
  --concurrency <n>      requests in flight (default ${DEFAULTS.concurrency})
  --rows <n>             hall rows (default ${DEFAULTS.rows})
  --seats-per-row <n>    hall seats per row (default ${DEFAULTS.seatsPerRow})
  --limit <n>            per-user seat limit (default ${DEFAULTS.perUserLimit})
  --hot-users <n>        users storming the hot seats (default ${DEFAULTS.hotUsers})
  --small                a quick run: 2,000 stampede requests, smaller scenarios
  --no-metrics           skip the /metrics diff (another client is booking on the same instance)
  --json <file>          also write the full report as JSON
  -h, --help`;

function int(v: string | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
  return n;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "admin-key": { type: "string" },
    requests: { type: "string" },
    users: { type: "string" },
    concurrency: { type: "string" },
    rows: { type: "string" },
    "seats-per-row": { type: "string" },
    limit: { type: "string" },
    "hot-users": { type: "string" },
    small: { type: "boolean", default: false },
    "no-metrics": { type: "boolean", default: false },
    json: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

const base = positionals[0]!;
const adminKey = values["admin-key"] ?? process.env.ADMIN_API_KEY ?? "";
if (!adminKey) {
  console.error("An admin key is required: --admin-key <key> or ADMIN_API_KEY.");
  process.exit(2);
}

const small: Partial<BurstOptions> = values.small
  ? {
      requests: 2_000,
      users: 600,
      hotUsers: 100,
      retryGroups: 20,
      keyReuseGroups: 10,
      limitUsers: 5,
      crossedPairs: 10,
      spoofs: 10,
      foreignCancels: 10,
      rows: 20,
      seatsPerRow: 30,
    }
  : {};
const opts: Partial<BurstOptions> = { ...DEFAULTS, ...small };
opts.requests = int(values.requests, "requests", opts.requests!);
opts.users = int(values.users, "users", opts.users!);
opts.concurrency = int(values.concurrency, "concurrency", opts.concurrency!);
opts.rows = int(values.rows, "rows", opts.rows!);
opts.seatsPerRow = int(values["seats-per-row"], "seats-per-row", opts.seatsPerRow!);
opts.perUserLimit = int(values.limit, "limit", opts.perUserLimit!);
opts.hotUsers = int(values["hot-users"], "hot-users", opts.hotUsers!);
opts.metrics = !values["no-metrics"];

// ---------------------------------------------------------------------------------------------
// Output

const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [green, red, yellow, dim, bold] = [c(32), c(31), c(33), c(2), c(1)];
const n = (v: number) => v.toLocaleString("en");
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`);
const row = (cells: string[], widths: number[]) =>
  cells.map((x, i) => (i === 0 ? x.padEnd(widths[i]!) : x.padStart(widths[i]!))).join("  ");

function print(r: BurstReport) {
  const out: string[] = [];
  out.push("");
  out.push(bold(`Burst against ${r.base}`));
  out.push(dim(`show ${r.show.id} · ${n(r.show.total_seats)} seats · ${ms(r.durationMs)}`));

  out.push("", bold("Reserve outcomes") + dim(" (every response, retries included)"));
  const total = Object.values(r.outcomes).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(r.outcomes).sort((a, b) => b[1] - a[1])) {
    out.push("  " + row([k, n(v), `${((v / Math.max(1, total)) * 100).toFixed(1)}%`], [24, 8, 7]));
  }
  out.push(
    "  " + row(["429 shed / retried", `${n(r.status["429"])} / ${n(r.retries)}`, ""], [24, 8, 7]),
  );
  out.push(
    "  " +
      row(
        [
          "5xx · dropped · unanswered",
          `${n(r.status["5xx"])} · ${n(r.status.network)} · ${n(r.unanswered)}`,
          "",
        ],
        [24, 8, 7],
      ),
  );
  if (r.resent) {
    out.push("  " + row(["re-sent in transit", n(r.resent), ""], [24, 8, 7]));
  }

  out.push("", bold("By scenario") + dim(" (final outcome per request)"));
  for (const [s, rec] of Object.entries(r.scenarios)) {
    const parts = Object.entries(rec)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${n(v)}`);
    if (parts.length) out.push(`  ${s.padEnd(10)} ${parts.join(" · ")}`);
  }

  out.push("", bold("Speed"));
  out.push(`  ${n(r.reserveRequests)} reserve requests at ${r.throughput.toFixed(0)} req/s`);
  if (r.latency) {
    const l = r.latency;
    out.push(`  p50 ${ms(l.p50)} · p95 ${ms(l.p95)} · p99 ${ms(l.p99)} · max ${ms(l.max)}`);
  }
  if (r.slowest.length) {
    out.push(dim(`  slowest (x-request-id, searchable in the War Room log tail):`));
    for (const s of r.slowest) out.push(dim(`    ${s.requestId}  ${ms(s.ms)}  ${s.outcome}`));
  }

  if (r.final) {
    const f = r.final;
    out.push("", bold("Final reconciliation"));
    out.push(
      `  ${n(f.available)} available + ${n(f.held)} held + ${n(f.confirmed)} sold = ${n(f.available + f.held + f.confirmed)} of ${n(f.total)}`,
    );
  }

  if (r.metrics) {
    out.push("", bold("/metrics vs observed") + dim(" (fdfs_reserve_responses_total delta)"));
    // ≈: the server sent more than arrived, within what was lost in transit (see the check).
    const within = r.checks.find((ch) => ch.name === "metrics match observations")?.ok;
    for (const m of r.metrics) {
      const mark =
        m.observed === m.delta
          ? green("=")
          : within && m.delta > m.observed
            ? yellow("≈")
            : red("≠");
      out.push("  " + row([m.outcome, n(m.observed), mark, n(m.delta)], [24, 8, 1, 8]));
    }
  }

  out.push("", bold("Checks"));
  for (const ch of r.checks) {
    out.push(`  ${ch.ok ? green("✓") : red("✗")} ${ch.name.padEnd(44)} ${dim(ch.detail)}`);
  }
  out.push("");
  out.push(
    r.ok ? green(bold("PASS: every guarantee held.")) : red(bold("FAIL: see the checks above.")),
  );
  console.log(out.join("\n"));
}

// ---------------------------------------------------------------------------------------------

const ctrl = new AbortController();
process.once("SIGINT", () => {
  console.error("\ninterrupted");
  ctrl.abort();
  process.exit(130);
});

let lastLine = 0;
try {
  console.log(
    dim(
      `${n(plannedRequests({ ...DEFAULTS, ...opts } as BurstOptions))} requests planned, ${opts.concurrency} in flight`,
    ),
  );
  const report = await runBurst({
    ...opts,
    base,
    adminKey,
    signal: ctrl.signal,
    onStatus: (line) => console.log(dim(line)),
    onShow: (s) => console.log(dim(`show ${s.id}: ${base.replace(/\/+$/, "")}/app/shows/${s.id}`)),
    onProgress: (p) => {
      // A line every 2s (a CI log stays readable; a TTY gets the same).
      if (p.elapsedMs - lastLine < 2_000 && p.done < p.planned) return;
      lastLine = p.elapsedMs;
      const pct = Math.min(100, (p.done / Math.max(1, p.planned)) * 100).toFixed(0);
      const seen = Object.entries(p.outcomes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${n(v)}`)
        .join(" · ");
      console.log(
        dim(
          `  ${(p.elapsedMs / 1000).toFixed(0).padStart(4)}s  ${pct.padStart(3)}%  ${n(p.done)} done  ${p.inFlight} in flight  ${seen}  · ${p.polls} polls${p.pollViolations ? red(` ${p.pollViolations} unbalanced`) : ""}`,
        ),
      );
    },
  });
  print(report);
  if (values.json) await writeFile(values.json, JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  console.error(red(`burst failed: ${(err as Error).message}`));
  process.exit(1);
}
