/**
 * pino settings shared by the server and tooling: JSON lines, ISO timestamps, string levels, and
 * credentials redacted wherever they might appear.
 */
import { stdTimeFunctions, type LoggerOptions } from "pino";
import type { Config } from "../config";

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
