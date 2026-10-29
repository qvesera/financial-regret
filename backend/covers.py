"""
POST /api/covers   body: {"games": [{"id": "...", "title": "...", "appid": 123}, ...]}

Resolves box-art URLs for the grid view from SteamGridDB
(https://www.steamgriddb.com). Steam games go straight to /grids/steam/{appid};
everything else is searched by title first, then resolved by game id.

The caller supplies its own SteamGridDB key in the ``X-SGDB-Key`` header so
each user spends their own quota (the same pattern as ``X-ITAD-Key``);
``SGDB_API_KEY`` in the environment is the fallback. Without a key the endpoint
answers 401 and the grid keeps its placeholders.

Results are cached per game -- including the "no art found" misses -- so
scrolling back never re-hits the API, and a global throttle keeps one big
library inside a single rate-limit window.

Response: {"covers": {"Steam:730": "https://cdn2.steamgriddb.com/..."}}
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote

import requests

from _common import send_json, handle_options, user_key

SGDB_BASE = "https://www.steamgriddb.com/api/v2"
MAX_GAMES = 40          # per request; the client pages through the rest
MAX_WORKERS = 4
MAX_BODY_BYTES = 262_144
CACHE_TTL = 7 * 24 * 3600        # cover art rarely changes
NEGATIVE_TTL = 24 * 3600         # "no art" -> retry later, not forever
MIN_INTERVAL = 0.12              # spacing that keeps parallel workers polite

# Portrait covers only, static files, safe-for-work, no joke art.
GRID_PARAMS = {
    "dimensions": "600x900",
    "types": "static",
    "nsfw": "false",
    "humor": "false",
    "limit": "1",
}

_MISS = object()
_cache: dict[str, tuple] = {}
_cache_lock = threading.Lock()
_rate_lock = threading.Lock()
_last_call = [0.0]


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
    if hit is None:
        return None
    value, expires = hit
    if time.time() > expires:
        with _cache_lock:
            _cache.pop(key, None)
        return None
    return value


def _cache_set(key, value, ttl):
    with _cache_lock:
        _cache[key] = (value, time.time() + ttl)


def _throttle():
    """Space out calls across all workers so parallelism can't blow the limit."""
    with _rate_lock:
        wait = MIN_INTERVAL - (time.monotonic() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.monotonic()


def _sgdb(path, key, params=None):
    _throttle()
    try:
        resp = requests.get(
            f"{SGDB_BASE}{path}",
            headers={"Authorization": f"Bearer {key}"},
            params=params or {},
            timeout=15,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _first_grid_url(data):
    if not data or not data.get("success"):
        return None
    for item in data.get("data") or []:
        if isinstance(item, dict) and item.get("url"):
            return item["url"]
    return None


def _first_game_id(data):
    """Search hits are {id, name, ...}; tolerate the nested {data:{id}} shape too."""
    if not data or not data.get("success"):
        return None
    for item in data.get("data") or []:
        if not isinstance(item, dict):
            continue
        inner = item.get("data") if isinstance(item.get("data"), dict) else item
        if inner.get("id"):
            return inner["id"]
    return None


def _search_game_id(title, key):
    # Both spellings have shipped: the documented /search/autocomplete/{term}
    # and the older /search/auto-complete?name=. Try one, then the other.
    term = quote(title)
    for data in (
        _sgdb(f"/search/autocomplete/{term}", key),
        _sgdb("/search/auto-complete", key, {"name": title}),
    ):
        gid = _first_game_id(data)
        if gid:
            return gid
    return None


def resolve_cover(title, appid, key):
    """Cover URL for one game, or None. Cached, including the misses."""
    cache_key = f"steam:{appid}" if appid else f"title:{(title or '').strip().lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return None if cached is _MISS else cached

    url = None
    if appid and str(appid).isdigit():
        url = _first_grid_url(_sgdb(f"/grids/steam/{appid}", key, GRID_PARAMS))
    if not url and title:
        gid = _search_game_id(title, key)
        if gid:
            url = _first_grid_url(_sgdb(f"/grids/game/{gid}", key, GRID_PARAMS))

    _cache_set(cache_key, url if url else _MISS, CACHE_TTL if url else NEGATIVE_TTL)
    return url


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_BODY_BYTES:
            send_json(self, 413, {"error": "Request body too large"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            send_json(self, 400, {"error": "Invalid JSON body"})
            return

        games = payload.get("games", [])
        if not isinstance(games, list) or not games:
            send_json(self, 400, {"error": "Missing 'games' list in request body"})
            return
        for i, g in enumerate(games):
            if not isinstance(g, dict) or not isinstance(g.get("id"), str):
                send_json(self, 400, {"error": f"games[{i}] must be an object with a string 'id'"})
                return
        games = games[:MAX_GAMES]

        key = user_key(self, "X-SGDB-Key", "SGDB_API_KEY")
        if not key:
            send_json(self, 401, {"error": "No SteamGridDB key: add one under API keys"})
            return

        covers: dict[str, str | None] = {}
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {
                pool.submit(resolve_cover, g.get("title"), g.get("appid"), key): g["id"]
                for g in games
            }
            for fut in as_completed(futures):
                gid = futures[fut]
                try:
                    covers[gid] = fut.result()
                except Exception:
                    covers[gid] = None

        send_json(self, 200, {"covers": covers})

