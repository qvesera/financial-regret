"""
GET /api/epic_games?access_token=<token>&refresh_token=<token>

Fetches the owned games for an Epic account via the (unofficial) library
service the real Epic Games Launcher uses internally. Auto-refreshes the
access token if it's expired, same pattern as GOG.

Titles are read from each item's metadata when present; items without
metadata fall back to their internal app name (less readable, but still
usable) rather than making one extra lookup call per game.
"""

import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests
from requests.auth import HTTPBasicAuth

from _common import send_json, handle_options

EPIC_OAUTH_HOST = "account-public-service-prod03.ol.epicgames.com"
EPIC_LIBRARY_HOST = "library-service.live.use1a.on.epicgames.com"
EPIC_CLIENT_ID = os.environ.get("EPIC_CLIENT_ID", "34a02cf8f4414e29b15921876da36f9a")
EPIC_CLIENT_SECRET = os.environ.get("EPIC_CLIENT_SECRET", "daafbccc737745039dffe53d94fc76cf")
MAX_PAGES = 50  # library API paginates via cursor; cap pages to stay within the time budget


def refresh_access_token(refresh_token: str) -> dict | None:
    resp = requests.post(
        f"https://{EPIC_OAUTH_HOST}/account/api/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": refresh_token, "token_type": "eg1"},
        auth=HTTPBasicAuth(EPIC_CLIENT_ID, EPIC_CLIENT_SECRET),
        timeout=15,
    )
    if resp.status_code != 200:
        return None
    return resp.json()


def fetch_library(access_token: str) -> list[dict]:
    headers = {"Authorization": f"bearer {access_token}"}
    records = []
    cursor = None

    for _ in range(MAX_PAGES):
        params = {"includeMetadata": "true"}
        if cursor:
            params["cursor"] = cursor

        resp = requests.get(
            f"https://{EPIC_LIBRARY_HOST}/library/api/public/items",
            headers=headers, params=params, timeout=15,
        )
        if resp.status_code != 200:
            break

        data = resp.json()
        records.extend(data.get("records", []))
        cursor = data.get("responseMetadata", {}).get("nextCursor")
        if not cursor:
            break

    return records


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        access_token = query.get("access_token", [None])[0]
        refresh_token = query.get("refresh_token", [None])[0]

        if not access_token:
            send_json(self, 400, {"error": "Missing access_token parameter"})
            return

        new_tokens = None
        headers = {"Authorization": f"bearer {access_token}"}
        probe = requests.get(
            f"https://{EPIC_LIBRARY_HOST}/library/api/public/items",
            headers=headers, params={"includeMetadata": "true"}, timeout=15,
        )

        if probe.status_code == 401 and refresh_token:
            refreshed = refresh_access_token(refresh_token)
            if not refreshed:
                send_json(self, 401, {"error": "Epic session expired -- please relink your Epic account"})
                return
            access_token = refreshed["access_token"]
            new_tokens = {"access_token": refreshed["access_token"], "refresh_token": refreshed["refresh_token"]}

        records = fetch_library(access_token)

        games = []
        for r in records:
            metadata = r.get("metadata") or {}
            title = metadata.get("title") or r.get("appName", "Unknown Epic game")
            games.append({
                "name": title,
                "appid": r.get("appName"),
                "playtime_hours": 0,
                "platform": "Epic Games",
            })

        result = {"games": games}
        if new_tokens:
            result["new_tokens"] = new_tokens

        send_json(self, 200, result)
