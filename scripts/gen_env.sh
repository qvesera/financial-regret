#!/usr/bin/env sh
# Point the static bundle at the API host, and emit the security headers to
# match.
#
# Deliberately POSIX sh with no bashisms: Netlify runs `sh scripts/gen_env.sh`,
# and dash rejects `set -o pipefail`, which failed the first real build.
#
# Local and self-hosted runs need none of this: server.py serves public/ and
# /api from one process, so BACKEND_URL is unset, env.js keeps its checked-in
# empty base and no _headers file is produced.
set -eu

cd "$(dirname "$(readlink -f "$0")")/.."

# Strip any trailing slash so "${API_BASE}${path}" never yields "//api/...".
BACKEND_URL="${BACKEND_URL:-}"
BACKEND_URL="${BACKEND_URL%/}"

cat > public/js/env.js <<EOF
/**
 * Deploy-time configuration -- written by scripts/gen_env.sh, do not edit.
 *
 * Left empty in the repo so the default stays "same origin": server.py serves
 * public/ and /api from one process, so there is nothing to point at. A public
 * split deploy (static site on a CDN, API elsewhere) rewrites this line from
 * BACKEND_URL at build time.
 *
 * This file holds a URL only. Never put a key here: the bundle ships to
 * everyone, and it is not a secret store.
 */
export const API_BASE = "${BACKEND_URL}";
EOF

# netlify.toml cannot interpolate environment variables, so the CSP is written
# here instead: connect-src has to name the real API host, and a committed
# placeholder would be deployed verbatim and silently block every request.
if [ -n "$BACKEND_URL" ]; then
  cat > public/_headers <<EOF
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cache-Control: no-cache
  Content-Security-Policy: default-src 'self'; connect-src 'self' ${BACKEND_URL}; img-src 'self' data: https://cdn2.steamgriddb.com https://cdn.steamgriddb.com; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
EOF
  echo "wrote public/_headers for ${BACKEND_URL}"
else
  rm -f public/_headers
  echo "no BACKEND_URL set -- same-origin build"
fi
