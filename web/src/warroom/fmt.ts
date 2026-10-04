/** Number formats the War Room shares between its cards. */
import { num } from "../lib/format";

/** 412 -> "412ms"; 1810 -> "1.81s"; 1000 -> "1s"; 12_400 -> "12s". */
export const ms = (v: number) =>
  v >= 1000 ? `${Number((v / 1000).toFixed(v >= 10_000 ? 0 : 2))}s` : `${Math.round(v)}ms`;

/** A rate per second: one decimal under 10 so a quiet second isn't rounded to zero. */
export const perSec = (v: number) =>
  v >= 1000
    ? `${(v / 1000).toFixed(1)}k`
    : v > 0 && v < 10
      ? v.toFixed(1).replace(/\.0$/, "")
      : `${Math.round(v)}`;

export const mb = (v: number) => `${Math.round(v)} MB`;
export const plain = (v: number) => num(Math.round(v));

/** 173_210 -> "2m 53s"; 41_000 -> "41s". */
export function duration(msTotal: number): string {
  const s = Math.round(msTotal / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function uptime(s: number): string {
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** "no seat sold twice" -> "No seat sold twice". */
export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
