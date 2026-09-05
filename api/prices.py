"""
POST /api/prices   body: {"titles": ["Game A", "Game B", ...]}

Looks up the cheapest current price for each title via IsThereAnyDeal,
priced for India (INR). Uses ITAD_API_KEY from environment variables.

Capped at MAX_TITLES per call to stay within the function's execution
time limit -- the frontend should call this in batches for large
libraries.
"""

import json
import os
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

ITAD_API_BASE = "https://api.isthereanydeal.com"
MAX_TITLES = 25


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

        titles = payload.get("titles", [])[:MAX_TITLES]
        if not titles:
            send_json(self, 400, {"error": "Missing 'titles' list in request body"})
            return

        api_key = os.environ.get("ITAD_API_KEY")
        if not api_key:
            send_json(self, 500, {"error": "ITAD_API_KEY not configured on the server"})
            return

        prices = {}
        for title in titles:
            prices[title] = _lookup_price(api_key, title)

        send_json(self, 200, {"prices": prices})


def _lookup_price(api_key: str, title: str) -> float | None:
    try:
        lookup_resp = requests.get(
            f"{ITAD_API_BASE}/games/lookup/v1",
            params={"key": api_key, "title": title},
            timeout=10,
        )
        if lookup_resp.status_code != 200:
            return None
        lookup_data = lookup_resp.json()
        if not lookup_data.get("found"):
            return None
        game_id = lookup_data["game"]["id"]

        price_resp = requests.post(
            f"{ITAD_API_BASE}/games/prices/v3",
            params={"key": api_key, "country": "IN"},
            json=[game_id],
            timeout=10,
        )
        if price_resp.status_code != 200:
            return None
        price_data = price_resp.json()
        if not price_data or not price_data[0].get("deals"):
            return None
        return min(d["price"]["amount"] for d in price_data[0]["deals"])
    except requests.RequestException:
        return None
