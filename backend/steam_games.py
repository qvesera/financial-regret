"""
GET /api/steam_games?steamid=<SteamID64>

Fetches the owned games for a Steam account. Uses STEAM_API_KEY from
environment variables (set in a local .env file) -- this is the
only place the key ever exists; it never reaches the browser.
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import requests

from _common import send_json, handle_options, user_key

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

        # Prefer the caller's own key (X-Steam-Key); fall back to the server
        # key unless this deployment is public and REQUIRE_USER_KEYS=1.
        api_key = user_key(self, "X-Steam-Key", "STEAM_API_KEY")
        if not api_key:
            send_json(self, 500, {"error": "No Steam key: add your own under API keys"})
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

        # Canonical game row consumed by the client: {id, name, platform, hours, appid}
        games = [{
            "id": f"Steam:{g.get('appid')}",
            "name": g.get("name", f"Unknown (App {g.get('appid')})"),
            "appid": g.get("appid"),
            "hours": round(g.get("playtime_forever", 0) / 60, 1),
            "platform": "Steam",
        } for g in data["games"]]

        # The account's display name rides along: the shared-card caption
        # signs the sharer's persona rather than a hostname. Best-effort —
        # a summaries hiccup must never cost the library.
        persona = None
        try:
            s = requests.get(
                f"{STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/",
                params={"key": api_key, "steamids": steam_id},
                timeout=10,
            )
            if s.status_code == 200:
                players = s.json().get("response", {}).get("players") or []
                name = players[0].get("personaname") if players else None
                # str() guard: a test double (or a mangled upstream) must not
                # reach the JSON body as anything else.
                persona = name if isinstance(name, str) and name.strip() else None
        except (requests.RequestException, ValueError):
            pass

        send_json(self, 200, {"games": games, "persona": persona})
