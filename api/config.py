"""GET /api/config   -- the runtime settings the browser needs to build OAuth links.

Deliberately carries no secrets: a client id identifies the application, not a
user, and this endpoint answers anyone who asks. The frontend reads it on boot
to construct the Steam, GOG and Epic sign-in URLs.
"""
import os
from http.server import BaseHTTPRequestHandler

from _common import handle_options, send_json


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        # Read per request rather than at import: env belongs to the operator,
        # and the fallback must describe the address actually in use.
        host = os.environ.get("HOST", "localhost")
        port = os.environ.get("PORT", "3000")
        send_json(self, 200, {
            # OAuth redirect URIs are built from this, so a deployment must set
            # it to the origin users actually reach the app on.
            "publicBaseUrl": os.environ.get("PUBLIC_BASE_URL", f"http://{host}:{port}"),
            "gogClientId": os.environ.get("GOG_CLIENT_ID", "46899977096215655"),
            "epicClientId": os.environ.get("EPIC_CLIENT_ID", "34a02cf8f4414e29b15921876da36f9a"),
            "gogRedirectMode": os.environ.get("GOG_REDIRECT_MODE", "callback"),
        })
