"""
POST /api/prices   body: {"games": [{"title": "...", "appid": 123}, ...]}

Looks up the cheapest current price for each game via IsThereAnyDeal,
priced for India (INR). Uses ITAD_API_KEY from environment variables.

Steam games (which carry a numeric appid) are resolved via ITAD's
shop-ID batch lookup -- an EXACT match, not a title guess, and it
resolves many games in a single request instead of one per game.
Games without an appid (GOG, Epic) fall back to title-based lookup,
run in parallel.
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

ITAD_API_BASE = "https://api.isthereanydeal.com"
STEAM_SHOP_ID = 61
MAX_WORKERS = 15       # concurrent title lookups
CHUNK_SIZE = 200       # ITAD's per-request cap on both lookup and prices endpoints


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

        games = payload.get("games", [])
        if not games:
            send_json(self, 400, {"error": "Missing 'games' list in request body"})
            return

        api_key = os.environ.get("ITAD_API_KEY")
        if not api_key:
            send_json(self, 500, {"error": "ITAD_API_KEY not configured on the server"})
            return

        steam_games = [g for g in games if g.get("appid") and str(g["appid"]).isdigit()]
        other_games = [g for g in games if g not in steam_games]

        # title -> ITAD game id
        itad_id_by_title: dict[str, str] = {}

        # Step 1: batch-resolve Steam games by exact appid (few requests, exact match)
        for i in range(0, len(steam_games), CHUNK_SIZE):
            chunk = steam_games[i:i + CHUNK_SIZE]
            shop_keys = [f"app/{g['appid']}" for g in chunk]
            try:
                resp = requests.post(
                    f"{ITAD_API_BASE}/lookup/id/shop/{STEAM_SHOP_ID}/v1",
                    params={"key": api_key},
                    json=shop_keys,
                    timeout=20,
                )
                if resp.status_code == 200:
                    mapping = resp.json()
                    for g in chunk:
                        itad_id = mapping.get(f"app/{g['appid']}")
                        if itad_id:
                            itad_id_by_title[g["title"]] = itad_id
            except requests.RequestException:
                pass  # these games just won't get a price this round

        # Step 2: title-based lookup for everything else (GOG, Epic, any Steam misses), in parallel
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            future_to_title = {pool.submit(_lookup_by_title, api_key, g["title"]): g["title"] for g in other_games}
            for future in as_completed(future_to_title):
                title = future_to_title[future]
                try:
                    itad_id = future.result()
                    if itad_id:
                        itad_id_by_title[title] = itad_id
                except Exception:
                    pass

        # Step 3: batch-fetch prices for every resolved ITAD id
        id_to_titles: dict[str, list[str]] = {}
        for title, itad_id in itad_id_by_title.items():
            id_to_titles.setdefault(itad_id, []).append(title)

        prices: dict[str, float | None] = {g["title"]: None for g in games}
        all_ids = list(id_to_titles.keys())

        for i in range(0, len(all_ids), CHUNK_SIZE):
            chunk_ids = all_ids[i:i + CHUNK_SIZE]
            try:
                resp = requests.post(
                    f"{ITAD_API_BASE}/games/prices/v3",
                    params={"key": api_key, "country": "IN"},
                    json=chunk_ids,
                    timeout=20,
                )
                if resp.status_code == 200:
                    for entry in resp.json():
                        deals = entry.get("deals", [])
                        price = min(d["price"]["amount"] for d in deals) if deals else None
                        for title in id_to_titles.get(entry["id"], []):
                            prices[title] = price
            except requests.RequestException:
                pass

        send_json(self, 200, {"prices": prices})


def _lookup_by_title(api_key: str, title: str) -> str | None:
    try:
        resp = requests.get(
            f"{ITAD_API_BASE}/games/lookup/v1",
            params={"key": api_key, "title": title},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data["game"]["id"] if data.get("found") else None
    except requests.RequestException:
        return None