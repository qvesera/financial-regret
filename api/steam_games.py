"""
GET /api/steam_games?steamid=<SteamID64>

Fetches the owned games for a Steam account. Uses STEAM_API_KEY from
environment variables (set in a local .env file) -- this is the
only place the key ever exists; it never reaches the browser.
"""

import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

from _common import send_json, handle_options

STEAM_API_BASE = "https://api.steampowered.com"


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        steam_id = query.get("steamid", [None])[0]

        if not steam_id:
            send_json(self, 400, {"error": "Missing steamid parameter"})
            return

        api_key = os.environ.get("STEAM_API_KEY")
        if not api_key:
            send_json(self, 500, {"error": "STEAM_API_KEY not configured on the server"})
            return

        try:
            resp = requests.get(
                f"{STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/",
                params={
                    "key": api_key,
                    "steamid": steam_id,
                    "include_appinfo": 1,
                    "include_played_free_games": 1,
                    "format": "json",
                },
                timeout=15,
            )
        except requests.RequestException as e:
            send_json(self, 502, {"error": f"Could not reach Steam API: {e}"})
            return

        if resp.status_code != 200:
            send_json(self, 502, {"error": f"Steam API returned {resp.status_code}"})
            return

        data = resp.json().get("response", {})
        if "games" not in data:
            send_json(self, 200, {
                "games": [],
                "warning": "No games returned -- check that 'Game details' privacy is Public.",
            })
            return

        games = [{
            "name": g.get("name", f"Unknown (App {g.get('appid')})"),
            "appid": g.get("appid"),
            "playtime_hours": round(g.get("playtime_forever", 0) / 60, 1),
            "platform": "Steam",
        } for g in data["games"]]

        send_json(self, 200, {"games": games})
