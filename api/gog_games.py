"""
GET /api/gog_games?access_token=<token>&refresh_token=<token>

Fetches the owned games for a GOG account. If the access token has
expired (they last ~1hr), automatically refreshes it using the refresh
token and returns the new access token so the frontend can update its
stored copy.

Note: GOG's /user/data/games endpoint only returns game IDs, so this
resolves names with one extra call per game. To stay within a serverless
function's execution time limit, this is capped at MAX_GAMES -- if the
library is bigger than that, the response includes a 'truncated' flag.
"""

import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

from _common import send_json, handle_options

GOG_EMBED_BASE = "https://embed.gog.com"
GOG_AUTH_BASE = "https://auth.gog.com"
GOG_CLIENT_ID = os.environ.get("GOG_CLIENT_ID", "46899977096215655")
GOG_CLIENT_SECRET = os.environ.get(
    "GOG_CLIENT_SECRET",
    "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9",
)
MAX_GAMES = 40  # keep name-resolution calls within the function's time budget


def refresh_access_token(refresh_token: str) -> dict | None:
    resp = requests.get(
        f"{GOG_AUTH_BASE}/token",
        params={
            "client_id": GOG_CLIENT_ID,
            "client_secret": GOG_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
        timeout=15,
    )
    if resp.status_code != 200:
        return None
    return resp.json()


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
        headers = {"Authorization": f"Bearer {access_token}"}
        resp = requests.get(f"{GOG_EMBED_BASE}/user/data/games", headers=headers, timeout=15)

        if resp.status_code == 401 and refresh_token:
            refreshed = refresh_access_token(refresh_token)
            if not refreshed:
                send_json(self, 401, {"error": "GOG session expired -- please relink your GOG account"})
                return
            access_token = refreshed["access_token"]
            new_tokens = {"access_token": refreshed["access_token"], "refresh_token": refreshed["refresh_token"]}
            headers = {"Authorization": f"Bearer {access_token}"}
            resp = requests.get(f"{GOG_EMBED_BASE}/user/data/games", headers=headers, timeout=15)

        if resp.status_code != 200:
            send_json(self, 502, {"error": f"GOG API returned {resp.status_code}"})
            return

        owned_ids = resp.json().get("owned", [])
        truncated = len(owned_ids) > MAX_GAMES
        owned_ids = owned_ids[:MAX_GAMES]

        games = []
        for game_id in owned_ids:
            try:
                detail_resp = requests.get(
                    f"{GOG_EMBED_BASE}/account/gameDetails/{game_id}.json",
                    headers=headers,
                    timeout=10,
                )
                title = detail_resp.json().get("title") if detail_resp.status_code == 200 else None
            except (requests.RequestException, json.JSONDecodeError):
                title = None

            games.append({
                "name": title or f"GOG Game {game_id}",
                "appid": game_id,
                "playtime_hours": 0,
                "platform": "GOG",
            })

        result = {"games": games, "truncated": truncated}
        if new_tokens:
            result["new_tokens"] = new_tokens

        send_json(self, 200, result)
