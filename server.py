"""
Library aggregator server -- public-hostable, single-process, no DB.

Serves public/ as static files and routes /api/<name> requests to the
matching handler class in api/<name>.py. Only dependencies: `requests`
(for the api modules) and `python-dotenv` (optional, for reading .env).

Usage:
    python server.py           (honours PORT/HOST env; defaults to localhost:3000)

Set STEAM_API_KEY / ITAD_API_KEY as real environment variables first, or
put them in a .env file and this script will load it automatically if
python-dotenv is installed (optional -- falls back to plain os.environ
if not).

Security notes for public hosting:
  * tokens are never logged (query strings are redacted from access logs)
  * per-IP rate limiting on every endpoint
  * strict CSP + security headers on all responses
  * path traversal is impossible (resolve() + is_relative_to guard)
  * cross-origin access is opt-in per origin (CORS_ALLOWED_ORIGINS), never a
    wildcard, so a browser can only reach this API from origins you named
"""
import importlib.util
import mimetypes
import os
import re
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
API_DIR = ROOT / "backend"

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

sys.path.insert(0, str(API_DIR))

# api/ is on the path now, so the shared response/header helpers are importable
# here. server.py keeps its own copies of the response writers because it also
# serves static files and its own /api/health and /api/config.
from _common import CSP, handle_options   # noqa: E402
from _cors import send_cors               # noqa: E402

_module_cache = {}
_module_cache_lock = threading.Lock()

HOST = os.environ.get("HOST", "localhost")
PORT = int(os.environ.get("PORT", "3000"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", f"http://{HOST}:{PORT}")
# 120/min: a paginated Epic scan plus price batches legitimately bursts past 30.
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "120"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", "1048576"))
TRUST_PROXY = os.environ.get("TRUST_PROXY", "0").lower() in ("1", "true", "yes")
DEBUG = os.environ.get("DEBUG", "0").lower() in ("1", "true", "yes")

_buckets: dict[str, deque[float]] = defaultdict(deque)
_buckets_lock = threading.Lock()


def _client_ip(handler: BaseHTTPRequestHandler) -> str:
    if TRUST_PROXY:
        fwd = handler.headers.get("X-Forwarded-For", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return handler.client_address[0] if handler.client_address else "unknown"


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    with _buckets_lock:
        dq = _buckets[ip]
        while dq and dq[0] <= now - 60:
            dq.popleft()
        if len(dq) >= RATE_LIMIT_PER_MIN:
            return True
        dq.append(now)
    return False


_BROKEN = object()   # sentinel: the file exists but will not load


def _load_api_handler(name: str):
    if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
        return None
    with _module_cache_lock:
        if name in _module_cache:
            return _module_cache[name]
    module_path = API_DIR / f"{name}.py"
    if not module_path.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location(name, module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls = getattr(module, "handler", None)
    except Exception:
        # A broken module is a deployment error, not a missing route -- and it
        # must not escape as an unhandled exception either, because dispatch
        # calls this before the crash guard around handler_fn exists.
        import traceback
        traceback.print_exc()
        return _BROKEN
    if cls is None:
        return _BROKEN
    with _module_cache_lock:
        _module_cache[name] = cls
    return cls


def _security_headers(handler: BaseHTTPRequestHandler) -> None:
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-Frame-Options", "DENY")
    handler.send_header("Content-Security-Policy", CSP)
    handler.send_header("Cache-Control", "no-store")


class DevRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        path_only = self.path.split("?", 1)[0]
        print(f"  {self.command} {path_only}", end="")
        # The inherited line logs self.requestline verbatim, which would put the
        # query string straight back after the redacted print above. Strip it
        # from every string argument before handing them on, so the "tokens are
        # never logged" claim in the module docstring is actually true.
        if self.path != path_only:
            args = tuple(
                a.replace(self.path, path_only) if isinstance(a, str) else a
                for a in args
            )
        super().log_message(fmt, *args)

    def _send_json(self, status: int, data: dict, extra_headers=None) -> None:
        import json
        self._response_sent = True
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        _security_headers(self)
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        send_cors(self)
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self, max_bytes: int = MAX_BODY_BYTES) -> dict | None:
        import json
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length > max_bytes:
            self._send_json(413, {"error": "Request body too large"})
            return None
        if length == 0:
            self._send_json(400, {"error": "Missing request body"})
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            self._send_json(400, {"error": "Invalid JSON body"})
            return None

    def _dispatch_api(self, method: str) -> None:
        # Reset per request: HTTP/1.1 keep-alive reuses this object, so a
        # stale True left by the previous response would skip the 500 fallback
        # below and leave the browser hanging on "pending" forever.
        self._response_sent = False
        path_only = self.path.split("?", 1)[0]
        name = path_only[len("/api/"):].split("/")[0]

        handler_cls = _load_api_handler(name)
        if handler_cls is _BROKEN:
            self._send_json(500, {"error": f"API function '{name}' failed to load"})
            return
        if handler_cls is None:
            self._send_json(404, {"error": f"No API function named '{name}'"})
            return

        handler_fn = getattr(handler_cls, method, None)
        if handler_fn is None:
            allow = ", ".join(
                m for m in ("GET", "POST", "OPTIONS")
                if getattr(handler_cls, m, None) is not None
            )
            self._send_json(405, {"error": "Method not allowed"}, {"Allow": allow})
            return

        # A handler bug must never kill the socket without a response
        # (browsers report that as ERR_EMPTY_RESPONSE) -- return a clean 500.
        try:
            handler_fn(self)
        except Exception:
            import traceback
            traceback.print_exc()
            if not getattr(self, "_response_sent", False):
                try:
                    self._send_json(500, {"error": "Internal server error"})
                except Exception:
                    pass

    def _serve_static(self) -> None:
        path_only = self.path.split("?")[0]
        if path_only == "/":
            path_only = "/index.html"

        # path traversal guard: reject any dot segment outright
        if any(seg in (".", "..") or seg.startswith(".") for seg in path_only.split("/")):
            self._send_json(404, {"error": "Not found"})
            return

        file_path = (PUBLIC_DIR / path_only.lstrip("/")).resolve()
        public_root = PUBLIC_DIR.resolve()
        try:
            ok = file_path.is_relative_to(public_root)
        except AttributeError:
            ok = str(file_path).startswith(str(public_root) + os.sep)

        if not ok or not file_path.is_file():
            self._send_json(404, {"error": "Not found"})
            return

        content_type, _ = mimetypes.guess_type(str(file_path))
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        # No validators (ETag/Last-Modified) are sent, so browsers may cache
        # heuristically; without this a stale app.js kept running after edits.
        self.send_header("Cache-Control", "no-cache")
        _security_headers(self)
        self.end_headers()
        self.wfile.write(body)

    def _rate_check(self) -> bool:
        if _rate_limited(_client_ip(self)):
            self._send_json(429, {"error": "Too many requests -- slow down"}, {"Retry-After": "60"})
            return False
        return True

    def do_GET(self) -> None:
        if not self._rate_check():
            return
        if self.path.startswith("/api/"):
            self._dispatch_api("do_GET")
        else:
            self._serve_static()

    def do_POST(self) -> None:
        if not self._rate_check():
            return
        # enforce body size before dispatching to api modules (they read their own bodies)
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "Request body too large"})
            return
        if self.path.startswith("/api/"):
            self._dispatch_api("do_POST")
        else:
            self._send_json(404, {"error": "Not found"})

    def do_PUT(self) -> None:
        if not self._rate_check():
            return
        self._send_json(405, {"error": "Method not allowed"}, {"Allow": "GET, POST, OPTIONS"})

    def do_DELETE(self) -> None:
        if not self._rate_check():
            return
        self._send_json(405, {"error": "Method not allowed"}, {"Allow": "GET, POST, OPTIONS"})

    def do_OPTIONS(self) -> None:
        if not self._rate_check():
            return
        if self.path.startswith("/api/"):
            self._dispatch_api("do_OPTIONS")
        else:
            handle_options(self)


# /api/health and /api/config live in api/ alongside every other endpoint now,
# so they deploy to a serverless host instead of being special cases only this
# server understands. Loading them at boot rather than on first request surfaces
# a broken import at startup and pins the health endpoint's uptime clock to
# process start.
def _preload_builtin_endpoints() -> None:
    for name in ("health", "config"):
        _load_api_handler(name)


def main() -> None:
    _preload_builtin_endpoints()
    server = ThreadingHTTPServer((HOST, PORT), DevRequestHandler)
    print(f"Serving at http://{HOST}:{PORT}  (Ctrl+C to stop)")
    print(f"  public base url: {PUBLIC_BASE_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
