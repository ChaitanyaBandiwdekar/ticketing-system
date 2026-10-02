/**
 * TS face of fdfs_reserve (db/migrations/0002_reserve_fn.sql). The decision itself — fast path,
 * idempotency, per-user limit, all-or-nothing seat locks — happens in one SQL round trip; this
 * module only shapes input, computes the request fingerprint, and retries transient contention.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../db/pool";
import { withContentionRetry, type RetryOptions } from "../db/retry";
import type { ReserveOutcome } from "./types";
import { isUuid } from "./ids";

export type ReserveInput = {
  showId: string;
  /** Identity from the verified token — never from the request body. */
  userId: string;
  seats: string[];
  idempotencyKey: string;
};

const MAX_SEATS_PER_REQUEST = 100;
const MAX_KEY_LENGTH = 200;
const MAX_USER_ID_LENGTH = 128;

/**
 * Fingerprint of what the request asks for. Seats are a set: the same seats in a different
 * order are the same request (replay), different seats under the same key are not (reused).
 */
export function reserveRequestHash(showId: string, seats: readonly string[]): string {
  const canonical = JSON.stringify([showId.toLowerCase(), [...seats].sort()]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Cheap guards so malformed input never costs a DB round trip (the API schema checks too). */
function validate(input: ReserveInput): ReserveOutcome | null {
  const invalid = (message: string): ReserveOutcome => ({
    outcome: "invalid",
    path: "fast",
    message,
    unknown_seats: [],
  });
  if (!isUuid(input.showId)) return { outcome: "show_not_found", path: "fast" };
  // The token layer guarantees this, so a violation is a programming error: fail loudly here
  // rather than half-way through the SQL function on a CHECK constraint.
  if (input.userId.length === 0 || input.userId.length > MAX_USER_ID_LENGTH) {
    throw new Error(`user id must be 1-${MAX_USER_ID_LENGTH} characters`);
  }
  const { seats } = input;
  if (seats.length === 0 || seats.length > MAX_SEATS_PER_REQUEST) {
    return invalid(`seats must contain 1-${MAX_SEATS_PER_REQUEST} labels`);
  }
  if (seats.some((s) => typeof s !== "string" || s.length === 0)) {
    return invalid("seat labels must be non-empty strings");
  }
  if (new Set(seats).size !== seats.length) return invalid("seats must not repeat");
  const key = input.idempotencyKey;
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return invalid(`idempotency key must be 1-${MAX_KEY_LENGTH} characters`);
  }
  return null;
}

export async function reserve(
  sql: Sql,
  input: ReserveInput,
  retry: RetryOptions = {},
): Promise<ReserveOutcome> {
  const rejected = validate(input);
  if (rejected) return rejected;
  const hash = reserveRequestHash(input.showId, input.seats);
  return withContentionRetry(async () => {
    const [row] = await sql<{ result: ReserveOutcome }[]>`
      select fdfs_reserve(
        ${input.showId}::uuid, ${input.userId}, ${input.seats}::text[],
        ${input.idempotencyKey}, ${hash}
      ) as result`;
    return row!.result;
  }, retry);
}
