"""
POST /api/amazon_exchange   body: {code, client_id, code_verifier, serial}

Completes Amazon's device (PKCE) registration to turn a pasted authorization
code into a bearer token. This is the same undocumented flow the Amazon Games
launcher and Nile use — there is no public Amazon library API — so it POSTs
https://api.amazon.com/auth/register with the launcher's auth_data /
registration_data block and reads the bearer token out of
``response.success.tokens.bearer`` (confirmed against the open-source Nile and
audible clients).

The ``client_id``/``code_verifier``/``serial`` come back from the /signin step
(see api.js loginAmazon); ``serial`` doubles as the device serial reused later
for the library's hardwareHash.

Response: {"access_token", "refresh_token", "expires_in", "user_id", "serial"}
"""
import json
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

AMAZON_AUTH_REGISTER = "https://api.amazon.com/auth/register"
MAX_BODY_BYTES = 65_536


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY_BYTES:
            send_json(self, 413, {"error": "Request body too large"})
            return
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            send_json(self, 400, {"error": "Invalid JSON body"})
            return

        code = payload.get("code")
        client_id = payload.get("client_id")
        verifier = payload.get("code_verifier")
        serial = payload.get("serial")
        for field, value in (("code", code), ("client_id", client_id),
                             ("code_verifier", verifier), ("serial", serial)):
            if not isinstance(value, str) or not value:
                send_json(self, 400, {"error": f"Missing '{field}'"})
                return

        register_body = {
            "auth_data": {
                "authorization_code": code,
                "client_domain": "DeviceLegacy",
                "client_id": client_id,
                "code_algorithm": "SHA-256",
                "code_verifier": verifier,
                "use_global_authentication": False,
            },
            "registration_data": {
                "app_name": "AGSLauncher for Windows",
                "app_version": "1.0.0",
                "device_model": "Windows",
                "device_name": None,
                "device_serial": serial,
                "device_type": "A2UMVHOX7UP4V7",
                "domain": "Device",
                "os_version": "10.0.19044.0",
            },
            "requested_extensions": ["customer_info", "device_info"],
            "requested_token_type": ["bearer", "mac_dms"],
            "user_context_map": {},
        }

        try:
            resp = requests.post(AMAZON_AUTH_REGISTER, json=register_body, timeout=20)
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Amazon: {e}"})
            return

        try:
            data = resp.json()
        except ValueError:
            data = None

        if resp.status_code != 200 or not isinstance(data, dict):
            send_json(self, 401, {
                "error": "Amazon rejected the sign-in (codes are single-use and "
                         "short-lived -- run Connect again and paste a fresh URL)",
                "detail": str(data)[:200],
            })
            return

        success = (data.get("response") or {}).get("success") or {}
        bearer = (success.get("tokens") or {}).get("bearer") or {}
        extensions = success.get("extensions") or {}
        access_token = bearer.get("access_token")
        if not access_token:
            send_json(self, 502, {"error": "Amazon returned no access token"})
            return

        device_serial = (extensions.get("device_info") or {}).get("device_serial_number")
        user_id = (extensions.get("customer_info") or {}).get("customer_id")
        send_json(self, 200, {
            "access_token": access_token,
            "refresh_token": bearer.get("refresh_token"),
            "expires_in": bearer.get("expires_in"),
            "user_id": user_id,
            "serial": device_serial or serial,
        })
