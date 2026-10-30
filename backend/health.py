"""GET /api/health   -- liveness probe, and a quick read on how this deploy is set up.

Self-hosted, server.py imports this module at boot, so ``uptime_s`` counts from
process start. On a serverless host each instance loads it lazily on its first
request, so the same number reads as "this instance's age" -- which is what an
operator wants to know there. Same payload, different clock origin, by design.
"""
import os
import time
from http.server import BaseHTTPRequestHandler

from _common import handle_options, require_user_keys, send_json

_STARTED = time.monotonic()


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        send_json(self, 200, {
            "ok": True,
            "uptime_s": round(time.monotonic() - _STARTED, 3),
            # In BYO-key mode the server's own keys are ignored, so say which
            # mode this is rather than implying the ones listed below are live.
            "require_user_keys": require_user_keys(),
            "keys": {
                "steam": bool(os.environ.get("STEAM_API_KEY")),
                "itad": bool(os.environ.get("ITAD_API_KEY")),
                "platprices": bool(os.environ.get("PLATPRICES_API_KEY")),
                "sgdb": bool(os.environ.get("SGDB_API_KEY")),
            },
        })
