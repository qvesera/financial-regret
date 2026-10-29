"""
GET /api/amazon_games   headers: X-Amazon-Token, X-Amazon-Serial

Fetches the caller's owned Amazon Games library via the AGS distribution
GetEntitlements endpoint — the same undocumented call the Amazon Games launcher
and Nile make (there is no public Amazon library API). Pagination follows
``nextToken``; each entitlement carries ``product.id`` + ``product.title``.

Amazon ships DLC in the same list with no isDLC flag, so obvious add-ons are
tagged by title and returned as ``kind: "dlc"`` (kept, not dropped — their
spend is real and tracked separately). Amazon exposes no playtime, so
``hours`` is always null and the regret math excludes these rows from
per-hour ratios by design.

Response: {"games": [{"id", "name", "platform", "hours", "appid"}, ...]}
"""
import hashlib
import json
import re
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

AMAZON_ENTITLEMENTS_URL = "https://gaming.amazon.com/api/distribution/entitlements"
GET_ENTITLEMENTS_TARGET = (
    "com.amazon.animusdistributionservice.entitlement."
    "AnimusEntitlementsService.GetEntitlements"
)
AGS_USER_AGENT = "com.amazon.agslauncher.win/3.0.9202.1"
KEY_ID = "d5dc8b8b-86c8-4fc4-ae93-18c0def5314d"
MAX_PAGES = 40
# Base-game titles never contain these as standalone words, but Amazon's DLC
# ("Foo - DLC", "Season Pass") always does — and it rides in the same list.
_DLC_RE = re.compile(r"\bdlc\b|\bseason pass\b", re.IGNORECASE)


def _extract_entitlements(data):
    """The AGS list lives under one of a few keys; accept them plus any list of
    ``{product: ...}`` items so a naming drift can't silently return []."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("entitlements", "items", "products", "games"):
        value = data.get(key)
        if isinstance(value, list):
            return value
    for value in data.values():
        if isinstance(value, list) and value and isinstance(value[0], dict) and "product" in value[0]:
            return value
    return []


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        token = self.headers.get("X-Amazon-Token")
        if not token:
            send_json(self, 400, {"error": "Missing X-Amazon-Token header"})
            return
        serial = self.headers.get("X-Amazon-Serial", "")
        headers = {
            "X-Amz-Target": GET_ENTITLEMENTS_TARGET,
            "x-amzn-token": token,
            "UserAgent": AGS_USER_AGENT,
            "User-Agent": AGS_USER_AGENT,
            "Content-Type": "application/json",
            "Content-Encoding": "amz-1.0",
        }
        hardware_hash = hashlib.sha256(serial.encode("utf-8")).hexdigest().upper()

        games_by_id: dict = {}
        next_token = None
        pages = 0
        try:
            while pages < MAX_PAGES:
                request_body = {
                    "Operation": "GetEntitlements",
                    "clientId": "Sonic",
                    "syncPoint": None,
                    "nextToken": next_token,
                    "maxResults": 50,
                    "productIdFilter": None,
                    "keyId": KEY_ID,
                    "hardwareHash": hardware_hash,
                }
                resp = requests.post(AMAZON_ENTITLEMENTS_URL, headers=headers,
                                     json=request_body, timeout=20)
                if resp.status_code in (401, 403):
                    send_json(self, 401, {
                        "error": "Amazon session expired or invalid — reconnect "
                                 "Amazon Luna to get a fresh token",
                    })
                    return
                if resp.status_code != 200:
                    send_json(self, 502, {
                        "error": f"Amazon library returned {resp.status_code}",
                        "detail": resp.text[:200],
                    })
                    return
                data = resp.json()
                for entry in _extract_entitlements(data):
                    product = entry.get("product") or {}
                    pid = product.get("id")
                    title = (product.get("title") or "").strip()
                    if not pid or not title:
                        continue
                    game = {
                        "id": f"Amazon:{pid}",
                        "name": title,
                        "platform": "Amazon",
                        "hours": None,
                        "appid": None,
                    }
                    # Amazon ships DLC in the same list with no isDLC flag, so a
                    # title match is the only signal. Keep it (tagged) rather
                    # than dropping: it is real paid content. No base-game
                    # pointer exists here, so baseAppId stays unset.
                    if _DLC_RE.search(title):
                        game["kind"] = "dlc"
                    games_by_id[pid] = game
                next_token = data.get("nextToken") if isinstance(data, dict) else None
                pages += 1
                if not next_token:
                    break
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Amazon: {e}"})
            return

        send_json(self, 200, {"games": list(games_by_id.values())})
