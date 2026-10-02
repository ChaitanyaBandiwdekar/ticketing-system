/**
 * JSON schemas: request validation (compiled by ajv) and response serialization (compiled by
 * fast-json-stringify) for the hot paths. Response schemas also guarantee we never leak a field
 * by accident.
 */

export const uuidParam = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", maxLength: 64 } },
} as const;

export const reservationSchema = {
  type: "object",
  required: [
    "reservation_id",
    "show_id",
    "user_id",
    "seats",
    "amount_paise",
    "status",
    "expires_at",
    "created_at",
  ],
  properties: {
    reservation_id: { type: "string" },
    show_id: { type: "string" },
    user_id: { type: "string" },
    seats: { type: "array", items: { type: "string" } },
    amount_paise: { type: "integer" },
    status: { type: "string", enum: ["held", "confirmed", "cancelled", "expired"] },
    expires_at: { type: ["string", "null"] },
    created_at: { type: "string" },
  },
} as const;

export const countsSchema = {
  type: "object",
  required: ["total", "available", "held", "confirmed", "invariant_ok"],
  properties: {
    total: { type: "integer" },
    available: { type: "integer" },
    held: { type: "integer" },
    confirmed: { type: "integer" },
    invariant_ok: { type: "boolean" },
  },
} as const;

export const showProperties = {
  id: { type: "string" },
  name: { type: "string" },
  price_paise: { type: "integer" },
  per_user_limit: { type: "integer" },
  hold_ttl_seconds: { type: ["integer", "null"] },
  total_seats: { type: "integer" },
  ephemeral: { type: "boolean" },
  created_at: { type: "string" },
  counts: countsSchema,
} as const;
