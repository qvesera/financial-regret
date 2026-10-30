"""
GET /api/steam_verify?<the exact query params Steam sent back>

Verifies a Steam OpenID login callback and returns the account's
SteamID64. Runs server-side purely to avoid browser CORS issues talking
to steamcommunity.com -- no secret key is actually needed for this step.
"""

import os
import re
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

from _common import send_json, handle_options

STEAM_OPENID_URL = "https://steamcommunity.com/openid/login"


def _expected_netloc(handler) -> str:
    """The origin Steam was told to return to -- this deployment's own.

    PUBLIC_BASE_URL when the operator has set it (it must match the origin
    users reach anyway, or OAuth redirects would already be broken). The
    request's Host header otherwise: a callback reaches us through the
    victim's browser, where the attacker cannot choose that header."""
    base = (os.environ.get("PUBLIC_BASE_URL") or "").strip()
    if base:
        netloc = urlparse(base).netloc.lower()
        if netloc:
            return netloc
    return (handler.headers.get("Host") or "").lower()


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        params = {k: v[0] for k, v in query.items()}

        if not params:
            send_json(self, 400, {"error": "Missing OpenID parameters"})
            return

        # OpenID 2.0 requires the relying party to check its own return_to.
        # The signature check below only proves *somebody* logged into Steam;
        # without this, that somebody's assertion can be replayed into another
        # visitor's callback and link the wrong library -- the attacker's, at
        # the victim's expense, on the operator's shared key.
        return_to = params.get("openid.return_to", "")
        if not return_to or urlparse(return_to).netloc.lower() != _expected_netloc(self):
            send_json(self, 401, {"error": "openid.return_to does not match this deployment"})
            return

        verify_params = dict(params)
        verify_params["openid.mode"] = "check_authentication"

        try:
            resp = requests.post(STEAM_OPENID_URL, data=verify_params, timeout=15)
        except requests.RequestException:
            # Exception text carries the URL, the assertion params and the
            # local network's vocabulary; a public endpoint must not repeat it.
            traceback.print_exc()
            send_json(self, 502, {"error": "Could not reach Steam"})
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
