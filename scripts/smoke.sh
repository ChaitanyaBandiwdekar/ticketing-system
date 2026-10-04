#!/usr/bin/env bash
# End-to-end smoke test against a running FDFS instance (compose, CI, or the live Render URL).
#   scripts/smoke.sh <BASE_URL> <ADMIN_API_KEY>
# Exits non-zero on the first broken expectation. Needs curl + jq.
set -euo pipefail

BASE="${1:?usage: smoke.sh <BASE_URL> <ADMIN_API_KEY>}"
ADMIN="${2:?usage: smoke.sh <BASE_URL> <ADMIN_API_KEY>}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# call METHOD PATH EXPECTED_STATUS [curl args...]; body ends up in $TMP
call() {
  local method="$1" path="$2" want="$3"; shift 3
  local got
  got="$(curl -sS -o "$TMP" -w '%{http_code}' -X "$method" "$BASE$path" "$@")"
  [[ "$got" == "$want" ]] || fail "$method $path -> $got (want $want): $(cat "$TMP")"
  echo "ok  $method $path -> $got"
}

call GET /healthz 200
call GET /readyz 200

call POST /auth/login 200 -H 'content-type: application/json' -d '{"username":"smoke-alice"}'
ALICE="$(jq -r .token "$TMP")"
call POST /auth/login 200 -H 'content-type: application/json' -d '{"username":"smoke-bob"}'
BOB="$(jq -r .token "$TMP")"

call POST /shows 201 -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"smoke test","seats":["A1","A2","A3"],"price_paise":15000,"per_user_limit":2,"ephemeral":true}'
SHOW="$(jq -r .id "$TMP")"

KEY="smoke-$(date +%s%N)"
call POST "/shows/$SHOW/reserve" 201 -H "authorization: Bearer $ALICE" -H "idempotency-key: $KEY" \
  -H 'content-type: application/json' -d '{"seats":["A1"],"user_id":"smoke-bob"}'
RID="$(jq -r .reservation_id "$TMP")"
[[ "$(jq -r .user_id "$TMP")" == "smoke-alice" ]] || fail "spoofed user_id was honoured"
[[ "$(jq -r .amount_paise "$TMP")" == "15000" ]] || fail "wrong amount"

call POST "/shows/$SHOW/reserve" 200 -H "authorization: Bearer $ALICE" -H "idempotency-key: $KEY" \
  -H 'content-type: application/json' -d '{"seats":["A1"]}'
[[ "$(jq -r .reservation_id "$TMP")" == "$RID" ]] || fail "replay returned a different reservation"

call POST "/shows/$SHOW/reserve" 409 -H "authorization: Bearer $BOB" -H "idempotency-key: $KEY-bob" \
  -H 'content-type: application/json' -d '{"seats":["A1","A2"]}'
[[ "$(jq -r .error.code "$TMP")" == "seat_taken" ]] || fail "expected seat_taken"

call POST "/reservations/$RID/cancel" 403 -H "authorization: Bearer $BOB"
call POST "/reservations/$RID/cancel" 200 -H "authorization: Bearer $ALICE"

call GET "/shows/$SHOW" 200
[[ "$(jq -r .counts.invariant_ok "$TMP")" == "true" ]] || fail "invariant not ok"
call GET "/shows/$SHOW/audit" 200
[[ "$(jq -r .ok "$TMP")" == "true" ]] || fail "audit not ok: $(cat "$TMP")"

# Live seat map: the stream opens with a snapshot (A1 was cancelled above, so all available).
# curl exits 28 when --max-time ends the never-ending stream; that is the expected way out.
curl -sSN --max-time 3 "$BASE/stream?show=$SHOW" > "$TMP" 2>/dev/null || [[ $? == 28 ]] || fail "stream failed"
grep -q '^event: snapshot$' "$TMP" || fail "stream sent no snapshot: $(head -c 300 "$TMP")"
SNAP="$(grep -m1 -A1 '^event: snapshot$' "$TMP" | sed -n 's/^data: //p')"
[[ "$(jq -r .status <<<"$SNAP")" == "aaa" ]] || fail "stream snapshot wrong: $SNAP"
echo "ok  GET /stream -> snapshot"

# The UI: the shell is served (never cached) and the script it references exists (immutable).
call GET /app/ 200
grep -q '<div id="root">' "$TMP" || fail "/app/ is not the UI shell: $(head -c 300 "$TMP")"
JS="$(grep -o '/app/assets/[^"]*\.js' "$TMP" | head -n1)"
[[ -n "$JS" ]] || fail "the UI shell references no script"
call GET "$JS" 200
CC="$(curl -sS -o /dev/null -w '%header{cache-control}' "$BASE$JS")"
[[ "$CC" == *immutable* ]] || fail "$JS cache-control: $CC"
call GET /app/shows/new 200
grep -q '<div id="root">' "$TMP" || fail "client route did not get the UI shell"

echo "smoke: all good"
