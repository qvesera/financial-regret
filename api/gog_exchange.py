"""
POST /api/gog_exchange   body: {"code": "<code pasted from the GOG redirect URL>"}

Exchanges a GOG login code for an access token + refresh token. Uses the
publicly-documented GOG Galaxy client credentials (community-reverse-
engineered, used by tools like gogdl/Legendary -- see
https://github.com/Yepoleb/gogapidocs). These aren't secret in the usual
sense (they're baked into every GOG Galaxy install), but they're kept
server-side here for consistency and so they're easy to swap out later.
"""

import os
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

GOG_AUTH_BASE = "https://auth.gog.com"
GOG_CLIENT_ID = os.environ.get("GOG_CLIENT_ID", "46899977096215655")
GOG_CLIENT_SECRET = os.environ.get(
    "GOG_CLIENT_SECRET",
    "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9",
)
GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client"


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            import json
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            send_json(self, 400, {"error": "Invalid JSON body"})
            return

        code = payload.get("code")
        if not code:
            send_json(self, 400, {"error": "Missing 'code' in request body"})
            return

        try:
            resp = requests.get(
                f"{GOG_AUTH_BASE}/token",
                params={
                    "client_id": GOG_CLIENT_ID,
                    "client_secret": GOG_CLIENT_SECRET,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": GOG_REDIRECT_URI,
                },
                timeout=15,
            )
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach GOG: {e}"})
            return

        if resp.status_code != 200:
            send_json(self, 401, {"error": "GOG rejected the code (it may be expired -- codes are single-use and short-lived)"})
            return

        data = resp.json()
        send_json(self, 200, {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
        })
