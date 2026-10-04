/**
 * pino settings shared by the server and tooling: JSON lines, ISO timestamps, string levels, and
 * credentials redacted wherever they might appear.
 */
import {
  destination,
  multistream,
  pino,
  stdTimeFunctions,
  type Logger,
  type LoggerOptions,
  type StreamEntry,
} from "pino";
import type { Config } from "../config";
import type { LogBuffer } from "./logbuffer";

export function loggerOptions(level: Config["logLevel"]): LoggerOptions {
  return {
    level,
    base: { service: "fdfs" },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ["req.headers.authorization", "headers.authorization", "authorization", "token"],
      censor: "[redacted]",
    },
  };
}

/**
 * The process logger: stdout (the platform's log stream) plus, when given, the in-memory ring
 * buffer behind /ops/logs. Both receive the same redacted lines.
 */
export function createLogger(
  level: Config["logLevel"],
  opts: { buffer?: LogBuffer; stdout?: boolean } = {},
): Logger {
  const streams: StreamEntry[] = [];
  if (opts.stdout ?? true) streams.push({ level: "trace", stream: destination(1) });
  if (opts.buffer) streams.push({ level: "trace", stream: opts.buffer });
  return pino(loggerOptions(level), multistream(streams));
}
