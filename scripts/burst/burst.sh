#!/usr/bin/env bash
# The burst without remembering npm syntax: scripts/burst/burst.sh <BASE_URL> [options]
# Installs dependencies on first use, then runs `npm run burst` (see scripts/burst/burst.ts).
# The admin key comes from --admin-key or ADMIN_API_KEY. Exits non-zero if a guarantee broke.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ $# -lt 1 ]]; then
  echo "usage: scripts/burst/burst.sh <BASE_URL> [--admin-key KEY] [--small] [--requests N] ..." >&2
  exit 2
fi
[[ -d node_modules ]] || npm ci --no-audit --no-fund
exec npm run --silent burst -- "$@"
