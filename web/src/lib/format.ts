const inrWhole = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const inrPaise = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const count = new Intl.NumberFormat("en-IN");
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

/** 25000 paise -> "₹250"; 25050 -> "₹250.50". Amounts are integer paise end to end. */
export function rupees(paise: number): string {
  return (paise % 100 === 0 ? inrWhole : inrPaise).format(paise / 100);
}

export function num(n: number): string {
  return count.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 min. ago", "yesterday", "just now". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(s) >= size) return relative.format(Math.round(s / size), unit);
  }
  return Math.abs(s) < 10 ? "just now" : relative.format(s, "second");
}

export function holdMode(holdTtlSeconds: number | null): string {
  if (holdTtlSeconds == null) return "Instant confirm";
  if (holdTtlSeconds % 60 === 0) return `Hold ${holdTtlSeconds / 60} min`;
  return `Hold ${holdTtlSeconds}s`;
}

/** A countdown: 272_000 -> "4:32", 7_400 -> "0:08" (rounded up, so 0:00 means it's over). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
