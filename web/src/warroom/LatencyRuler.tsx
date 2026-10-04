/**
 * A latency distribution in one line: p50, p95, p99 and the max as marks on a single axis from
 * zero, so the spread (and how far the tail sits from the median) reads at a glance. The exact
 * values sit under the ruler as figures.
 */
import { niceCeil } from "./chartData";

type Mark = { key: string; label: string; value: number; color: string };

export function LatencyRuler({
  latency,
  format,
}: {
  latency: { p50: number; p95: number; p99: number; max: number };
  format: (ms: number) => string;
}) {
  const marks: Mark[] = [
    { key: "p50", label: "p50", value: latency.p50, color: "var(--color-ramp-3)" },
    { key: "p95", label: "p95", value: latency.p95, color: "var(--color-ramp-2)" },
    { key: "p99", label: "p99", value: latency.p99, color: "var(--color-ramp-1)" },
    { key: "max", label: "max", value: latency.max, color: "var(--color-ink-2)" },
  ];
  const top = niceCeil(latency.max * 1.05);
  const pos = (v: number) => Math.min(100, (v / top) * 100);
  // Labels sit above their mark; one too close to the previous label drops below instead.
  let lastAbove = -Infinity;
  const placed = marks.map((m) => {
    const p = pos(m.value);
    const above = p - lastAbove >= 9;
    if (above) lastAbove = p;
    return { ...m, p, above };
  });

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative mx-2 h-14"
        role="img"
        aria-label={`Reserve latency: ${marks.map((m) => `${m.label} ${format(m.value)}`).join(", ")}`}
      >
        {/* Track from zero to the axis top, filled up to p99 */}
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-3" />
        <div
          className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary-soft"
          style={{ width: `${pos(latency.p99)}%` }}
        />
        {placed.map((m) => (
          <div
            key={m.key}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${m.p}%` }}
          >
            <span
              aria-hidden
              className="block size-3 rounded-full ring-2 ring-surface"
              style={{ background: m.color }}
            />
            <span
              className={`absolute left-1/2 -translate-x-1/2 text-[0.6875rem] font-medium whitespace-nowrap text-ink-2 ${m.above ? "bottom-full mb-1" : "top-full mt-1"}`}
            >
              {m.label}
            </span>
          </div>
        ))}
        <span className="tabular absolute -bottom-1 left-0 -translate-x-1/2 text-[0.625rem] text-muted">
          0
        </span>
        <span className="tabular absolute right-0 -bottom-1 translate-x-1/2 text-[0.625rem] text-muted">
          {format(top)}
        </span>
      </div>
      <dl className="grid grid-cols-4 gap-2">
        {marks.map((m) => (
          <div key={m.key} className="flex flex-col">
            <dt className="flex items-center gap-1.5 text-xs text-muted">
              <span aria-hidden className="size-2 rounded-full" style={{ background: m.color }} />
              {m.label}
            </dt>
            <dd className="text-[0.9375rem] font-semibold text-ink">{format(m.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
