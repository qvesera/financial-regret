"""
GET /api/steam_verify?<the exact query params Steam sent back>

Verifies a Steam OpenID login callback and returns the account's
SteamID64. Runs server-side purely to avoid browser CORS issues talking
to steamcommunity.com -- no secret key is actually needed for this step.
"""

import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

from _common import send_json, handle_options

STEAM_OPENID_URL = "https://steamcommunity.com/openid/login"


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        params = {k: v[0] for k, v in query.items()}

        if not params:
            send_json(self, 400, {"error": "Missing OpenID parameters"})
            return

        verify_params = dict(params)
        verify_params["openid.mode"] = "check_authentication"

        try:
            resp = requests.post(STEAM_OPENID_URL, data=verify_params, timeout=15)
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Steam: {e}"})
            return

        if "is_valid:true" not in resp.text:
            send_json(self, 401, {"error": "Steam login verification failed"})
            return

        claimed_id = params.get("openid.claimed_id", "")
        match = re.search(r"/openid/id/(\d+)$", claimed_id)

        if not match:
            send_json(self, 400, {"error": "Could not extract SteamID from response"})
            return

        send_json(self, 200, {"steamid": match.group(1)})
