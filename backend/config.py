"""GET /api/config   -- the runtime settings the browser needs to build OAuth links.

Deliberately carries no secrets: a client id identifies the application, not a
user, and this endpoint answers anyone who asks. The frontend reads it on boot
to construct the Steam, GOG and Epic sign-in URLs, and to learn whether this
instance can price anything without the visitor's own key — key *presence* is
reported as booleans, never key material.
"""
import os
from http.server import BaseHTTPRequestHandler

from _common import handle_options, require_user_keys, send_json


def _edge_country(handler) -> str | None:
    """The visitor's ISO 3166-1 alpha-2 country, when an edge put one on the
    request: Vercel sends x-vercel-ip-country, Cloudflare cf-ipcountry.
    Anything that is not a two-letter string is discarded — a header is
    attacker-controlled input (and a test double is a MagicMock), so only a
    plausible code reaches the JSON body. Nothing is stored or logged."""
    for header in ("x-vercel-ip-country", "cf-ipcountry"):
        value = handler.headers.get(header)
        if isinstance(value, str) and len(value.strip()) == 2:
            return value.strip().upper()
    return None


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
            # Whether a visitor can price anything without bringing their own
            # key. Booleans only: key presence is deployment shape, the key
            # itself never leaves the server. The landing page's keys card
            # reads these to choose between "optional" and "needed for
            # pricing" — the same rule health.py states for BYO-key mode.
            "requireUserKeys": require_user_keys(),
            # The browser defaults the display currency to the visitor's
            # region from this. Null on a direct self-hosted server.py — the
            # frontend then keeps its own default.
            "country": _edge_country(self),
            "keys": {
                "steam": bool(os.environ.get("STEAM_API_KEY")),
                "itad": bool(os.environ.get("ITAD_API_KEY")),
                "platprices": bool(os.environ.get("PLATPRICES_API_KEY")),
            },
        })
