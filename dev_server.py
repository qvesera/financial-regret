"""
Local server -- runs the whole app on your own machine. No account,
no login, no cloud dependency of any kind.

Serves public/ as static files and routes /api/<name> requests to the
matching handler class in api/<name>.py. Only dependencies: `requests`
(for the api modules) and `python-dotenv` (optional, for reading .env).

Usage:
    python dev_server.py [port]   (defaults to port 3000)

Set STEAM_API_KEY / ITAD_API_KEY as real environment variables first, or
put them in a .env file and this script will load it automatically if
python-dotenv is installed (optional -- falls back to plain os.environ
if not).
"""

import importlib.util
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PUBLIC_DIR = ROOT / "public"
API_DIR = ROOT / "api"

# Optional: load .env if python-dotenv is available; otherwise skip quietly
try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

sys.path.insert(0, str(API_DIR))  # so api modules' "from _common import ..." works

_module_cache = {}


def _load_api_handler(name: str):
    if name in _module_cache:
        return _module_cache[name]

    module_path = API_DIR / f"{name}.py"
    if not module_path.exists():
        return None

    spec = importlib.util.spec_from_file_location(name, module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _module_cache[name] = module.handler
    return module.handler


class DevRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {self.command} {self.path} -> ", end="")
        super().log_message(fmt, *args)

    def _dispatch_api(self, method: str):
        # /api/steam_verify?... -> "steam_verify"
        path_only = self.path.split("?")[0]
        name = path_only[len("/api/"):].split("/")[0]

        handler_cls = _load_api_handler(name)
        if handler_cls is None:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(f"No API function named '{name}'".encode())
            return

        getattr(handler_cls, method)(self)

    def _serve_static(self):
        path_only = self.path.split("?")[0]
        if path_only == "/":
            path_only = "/index.html"

        file_path = PUBLIC_DIR / path_only.lstrip("/")

        if not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        content_type, _ = mimetypes.guess_type(str(file_path))
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.end_headers()
        self.wfile.write(file_path.read_bytes())

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._dispatch_api("do_GET")
        else:
            self._serve_static()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._dispatch_api("do_POST")
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self._dispatch_api("do_OPTIONS")
        else:
            self.send_response(204)
            self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000

    missing = [k for k in ("STEAM_API_KEY", "ITAD_API_KEY") if not os.environ.get(k)]
    if missing:
        print(f"Warning: {', '.join(missing)} not set -- related features will fail.")
        print("Set them as environment variables or in a .env file next to this script.\n")

    server = HTTPServer(("localhost", port), DevRequestHandler)
    print(f"Serving at http://localhost:{port}  (Ctrl+C to stop)\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
