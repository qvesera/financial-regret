"""
POST /api/epic_exchange   body: {"code": "<authorizationCode pasted from the redirect page>"}

Exchanges an Epic Games authorization code for an access token + refresh
token. Uses the publicly-known Epic Games Launcher client credentials
(the same ones baked into every real Epic Games Launcher install, and
used by the open-source `legendary` project --
https://github.com/derrod/legendary/blob/master/legendary/api/egs.py).
Unofficial: Epic could change this without notice.
"""

import json
import os
from http.server import BaseHTTPRequestHandler

import requests
from requests.auth import HTTPBasicAuth

from _common import send_json, handle_options

EPIC_OAUTH_HOST = "account-public-service-prod03.ol.epicgames.com"
EPIC_CLIENT_ID = os.environ.get("EPIC_CLIENT_ID", "34a02cf8f4414e29b15921876da36f9a")
EPIC_CLIENT_SECRET = os.environ.get("EPIC_CLIENT_SECRET", "daafbccc737745039dffe53d94fc76cf")


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            send_json(self, 400, {"error": "Invalid JSON body"})
            return

        code = payload.get("code")
        if not code:
            send_json(self, 400, {"error": "Missing 'code' in request body"})
            return

        try:
            resp = requests.post(
                f"https://{EPIC_OAUTH_HOST}/account/api/oauth/token",
                data={"grant_type": "authorization_code", "code": code, "token_type": "eg1"},
                auth=HTTPBasicAuth(EPIC_CLIENT_ID, EPIC_CLIENT_SECRET),
                timeout=15,
            )
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Epic: {e}"})
            return

        if resp.status_code != 200:
            send_json(self, 401, {"error": "Epic rejected the code (it may be expired or already used -- codes are single-use)"})
            return

        data = resp.json()
        send_json(self, 200, {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
        })
