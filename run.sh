#!/usr/bin/env bash
# Launch the financial-regret dev server.
#   ./run.sh              # http://localhost:8089
#   ./run.sh 9000         # custom port
#   PORT=9000 ./run.sh    # same thing
# server.py reads config from env only (it ignores argv), so the port is
# exported before exec.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

PORT="${PORT:-${1:-8089}}"
PY=".venv/bin/python"

# Create the venv once, install what server.py and the backend handlers need.
if [ ! -x "$PY" ]; then
  echo "==> creating .venv"
  python3 -m venv .venv
  "$PY" -m pip install --quiet --upgrade pip
  "$PY" -m pip install --quiet -r requirements.txt -r requirements-dev.txt
fi

# server.py imports `requests`; python-dotenv is optional (.env loading).
if ! "$PY" -c 'import requests' 2>/dev/null; then
  echo "==> installing dependencies"
  "$PY" -m pip install --quiet -r requirements.txt -r requirements-dev.txt
fi

# Fail with a readable message instead of "OSError: [Errno 98]".
# SO_REUSEADDR mirrors server.py's allow_reuse_address so a lingering
# TIME_WAIT socket from a just-killed server isn't mistaken for "in use".
if ! "$PY" - "$PORT" <<'EOF' >/dev/null 2>&1
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
EOF
then
  echo "error: port $PORT is already in use." >&2
  echo "       try: ./run.sh 3003   (or set PORT=...)" >&2
  exit 1
fi

echo "==> serving on http://localhost:$PORT  (Ctrl+C to stop)"
exec env PORT="$PORT" "$PY" server.py
