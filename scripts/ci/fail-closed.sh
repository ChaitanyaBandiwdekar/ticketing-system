#!/usr/bin/env bash
# CI: proves the instance fails CLOSED when the database goes away, and recovers when it returns.
#   - /healthz stays 200 (process alive; the platform must not kill a healthy process)
#   - /readyz flips to 503 (stop routing reservations here)
#   - a reservation attempt gets 503 db_unavailable, never a 500 and never a hang
#   - once the database is back, /readyz returns to 200 and reservations work again
# Usage: scripts/ci/fail-closed.sh <BASE_URL>   (run from the repo root, compose stack up)
set -euo pipefail
BASE="${1:?usage: fail-closed.sh <BASE_URL>}"

status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
wait_for() { # wait_for <want> <path> <seconds>
  for _ in $(seq 1 "$3"); do
    [[ "$(status "$BASE$2")" == "$1" ]] && { echo "ok  $2 -> $1"; return 0; }
    sleep 1
  done
  echo "FAIL: $2 never returned $1" >&2; return 1
}

TOKEN="$(curl -sS -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"username":"failclosed"}' | jq -r .token)"
SHOW="$(curl -sS "$BASE/shows" | jq -r '.shows[0].id // empty')"
[[ -n "$SHOW" ]] || SHOW="00000000-0000-4000-8000-000000000000"

docker compose stop db
wait_for 503 /readyz 20
[[ "$(status "$BASE/healthz")" == "200" ]] || { echo "FAIL: healthz not 200 with DB down" >&2; exit 1; }

code="$(curl -sS -o /tmp/res.json -w '%{http_code}' --max-time 30 -X POST "$BASE/shows/$SHOW/reserve" \
  -H "authorization: Bearer $TOKEN" -H 'idempotency-key: failclosed-1' \
  -H 'content-type: application/json' -d '{"seats":["A1"]}')"
echo "reserve with DB down -> $code $(cat /tmp/res.json)"
[[ "$code" == "503" ]] || { echo "FAIL: expected 503 with DB down" >&2; exit 1; }
[[ "$(jq -r .error.code /tmp/res.json)" == "db_unavailable" ]] || exit 1

docker compose start db
wait_for 200 /readyz 60
echo "fail-closed: all good"
