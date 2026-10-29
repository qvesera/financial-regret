"""
POST /api/psn_exchange   body: {"npsso": "<64-char NPSSO>"}

Turns a pasted PSN NPSSO token into an access token + refresh token. This is
the community "manual auth" flow used by psn-api (achievements-app/psn-api) --
Sony offers no official third-party OAuth for hobbyists, so there is no public
client to redirect through and no client secret to keep.

Two hops, both here so the NPSSO never touches a second service:
  1. GET  /authz/v3/oauth/authorize  with Cookie: npsso=<token>  -> 302 Location
     carrying ?code=<access code>. We read the header, never following it.
  2. POST /authz/v3/oauth/token      (Basic auth) exchanging that code for
     access_token + refresh_token.

The Basic credential is the same one psn-api ships: it is Sony's own public
PlayStation App client, not a secret of this app's. The NPSSO itself is
equivalent to a password -- it is sent only over this server's localhost hop
and is never logged or stored.
"""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

from _common import send_json, handle_options

AUTH_BASE = "https://ca.account.sony.com/api/authz/v3/oauth"
CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891"
REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect"
SCOPE = "psn:mobile.v2.core psn:clientapp"
# base64("09515159-7237-4370-9b40-3806e67c0891:ucPjkA5tntB2KkqsP")
BASIC = "MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
MAX_BODY_BYTES = 16_384


def npsso_to_access_code(npsso: str) -> str:
    """Cookie in, one-time access code out (read off the 302's Location)."""
    resp = requests.get(
        f"{AUTH_BASE}/authorize",
        params={
            "access_type": "offline",
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": SCOPE,
        },
        headers={"Cookie": f"npsso={npsso}"},
        allow_redirects=False,   # the code lives in the Location header
        timeout=20,
    )
    location = resp.headers.get("Location") or resp.headers.get("location") or ""
    if "code=" not in location:
        raise ValueError(
            "Sony did not hand back an access code -- the NPSSO is probably "
            "expired or mistyped"
        )
    code = parse_qs(urlparse(location).query).get("code", [""])[0]
    if not code:
        raise ValueError("The redirect carried no code")
    return code


def code_to_tokens(code: str) -> dict:
    """One-time access code in, access + refresh token pair out."""
    resp = requests.post(
        f"{AUTH_BASE}/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {BASIC}",
        },
        data={
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "grant_type": "authorization_code",
            "token_format": "jwt",
        },
        timeout=20,
    )
    if resp.status_code != 200:
        raise ValueError(f"Sony rejected the access code (HTTP {resp.status_code})")
    data = resp.json()
    if not data.get("access_token"):
        raise ValueError("Sony returned no access token")
    return data


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

        npsso = payload.get("npsso")
        if not isinstance(npsso, str) or not npsso.strip():
            send_json(self, 400, {"error": "Missing 'npsso' in request body"})
            return

        try:
            code = npsso_to_access_code(npsso.strip())
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Sony: {e}"})
            return
        except ValueError as e:
            send_json(self, 401, {"error": str(e)})
            return

        try:
            data = code_to_tokens(code)
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Sony: {e}"})
            return
        except ValueError as e:
            send_json(self, 401, {"error": str(e)})
            return

        send_json(self, 200, {
            "access_token": data.get("access_token"),
            "refresh_token": data.get("refresh_token"),
            "expires_in": data.get("expires_in"),
            "refresh_token_expires_in": data.get("refresh_token_expires_in"),
        })
