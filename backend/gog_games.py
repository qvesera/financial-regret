"""
GET /api/gog_games   headers: X-GOG-Token, X-GOG-Refresh

Fetches the owned games for a GOG account via the paginated
/account/getFilteredProducts endpoint (one call per ~page of products,
instead of one name-lookup call per game). Auto-refreshes the access
token if it's expired.

Playtime is probed per-game via gameplay.gog.com; unknown playtime is
reported as null (never 0) so the regret metric can exclude it.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

GOG_EMBED_BASE = "https://embed.gog.com"
GOG_AUTH_BASE = "https://auth.gog.com"
GOG_CLIENT_ID = os.environ.get("GOG_CLIENT_ID", "46899977096215655")
GOG_CLIENT_SECRET = os.environ.get(
    "GOG_CLIENT_SECRET",
    "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9",
)
MAX_PAGES = 100          # safety cap on paginated library fetch
MAX_WORKERS = 8          # concurrent playtime probes


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


def fetch_library(headers: dict) -> list[dict]:
    """Return [{id, title, image}] from paginated getFilteredProducts."""
    products = []
    page = 1
    while page <= MAX_PAGES:
        resp = requests.get(
            f"{GOG_EMBED_BASE}/account/getFilteredProducts",
            params={"mediaType": 1, "page": page},
            headers=headers, timeout=15,
        )
        if resp.status_code != 200:
            break
        data = resp.json()
        page_products = data.get("products", [])
        products.extend(page_products)
        total_pages = data.get("totalPages", 1)
        if page >= total_pages:
            break
        page += 1
    return products


def probe_playtime(headers: dict, product: dict) -> float | None:
    """Best-effort playtime probe. Returns hours or null."""
    gid = product.get("id")
    if not gid:
        return None
    uid = headers.get("X-GOG-User-Id", "")
    try:
        resp = requests.get(
            f"https://gameplay.gog.com/games/{gid}/users/{uid}/sessions",
            headers=headers, timeout=8,
        )
        if resp.status_code == 200:
            data = resp.json()
            total_ms = data.get("totalTime") or data.get("total_time")
            if isinstance(total_ms, (int, float)):
                return round(total_ms / 3_600_000, 1)
    except requests.RequestException:
        pass
    return None


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        access_token = self.headers.get("X-GOG-Token")
        refresh_token = self.headers.get("X-GOG-Refresh")
        user_id = self.headers.get("X-GOG-User-Id", "")

        if not access_token:
            send_json(self, 400, {"error": "Missing X-GOG-Token header"})
            return

        new_tokens = None
        headers = {"Authorization": f"Bearer {access_token}"}

        try:
            products = fetch_library(headers)
        except requests.RequestException:
            products = []

        # If the first fetch returned nothing and we can refresh, try once more
        if not products and refresh_token:
            refreshed = refresh_access_token(refresh_token)
            if refreshed:
                access_token = refreshed["access_token"]
                new_tokens = {
                    "access_token": refreshed["access_token"],
                    "refresh_token": refreshed["refresh_token"],
                }
                headers = {"Authorization": f"Bearer {access_token}"}
                try:
                    products = fetch_library(headers)
                except requests.RequestException:
                    products = []

        games = []
        for p in products:
            gid = p.get("id")
            title = p.get("title") or f"GOG Game {gid}"
            games.append({
                "id": f"GOG:{gid}",
                "name": title,
                "appid": gid,
                "platform": "GOG",
                "hours": None,
            })

        # best-effort playtime probes (concurrent, capped)
        probe_headers = {"Authorization": f"Bearer {access_token}", "X-GOG-User-Id": user_id}
        if games:
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                future_to_game = {
                    pool.submit(probe_playtime, probe_headers, g): g
                    for g in games
                }
                for future in as_completed(future_to_game):
                    g = future_to_game[future]
                    try:
                        hours = future.result()
                    except Exception:
                        hours = None
                    if hours is not None:
                        g["hours"] = hours

        result = {"games": games}
        if new_tokens:
            result["new_tokens"] = new_tokens

        send_json(self, 200, result)
