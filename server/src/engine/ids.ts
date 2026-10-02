const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed ids are answered as "not found" without a DB round trip (or a 22P02 cast error). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
