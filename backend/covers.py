"""
POST /api/covers   body: {"games": [{"id": "...", "title": "...", "appid": 123,
                                     "conceptId": "..."}, ...], "currency": "INR"}

Resolves box-art URLs for the grid view, PlayStation first:

  1. Sony's own storefront, keyless. A PlayStation title the gamelist
     identified carries its concept id, and the same public read
     psn_prices.py makes (metGetPricingDataByConceptId) answers with the
     product's media list; the PORTRAIT_BANNER role there is the store's key
     art at 1440x2160 -- the grid's 600x900 box, the same 2:3. No key, no
     quota: an instance with nothing configured still serves art for every
     PlayStation title it knows the concept of.
  2. SteamGridDB (https://www.steamgriddb.com) as the backup -- PlayStation
     titles Sony's answer missed (delisted concept, media trimmed to
     landscape roles), and every other game in the library: Steam goes
     straight to /grids/steam/{appid}; everything else is searched by title
     first, then resolved by game id.

The caller supplies its own SteamGridDB key in the ``X-SGDB-Key`` header so
each user spends their own quota (the same pattern as ``X-ITAD-Key``);
``SGDB_API_KEY`` in the environment is the fallback. No key anywhere is no
longer a refusal: the Sony leg needs none, so only the SteamGridDB half of
the work is skipped and those games answer null -- the grid keeps its
placeholders instead of an error.

Results are cached per game -- including the "no art found" misses -- so
scrolling back never re-hits an API, and a global throttle keeps one big
library inside a single rate-limit window.

The answer also names a PlayStation title's console ("PS5" or "PS4") beside
its url, read from the same product node that carries the art: the grid wears
that console's retail band (public/ps4-band.png, public/ps5-band.png) over
Sony's banner-less key art. A title Sony states no console for gets no band
rather than a guess.

Response: {"covers": {"Steam:730": "https://cdn2.steamgriddb.com/...", ...},
           "psPlatforms": {"PSN:200520": "PS4"}}
"""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler
from urllib.parse import quote

import requests

from _common import send_json, handle_options, user_key
# PlayStation art rides the same store read as pricing: same operation, same
# persisted hash, same headers -- so the rotation canary in
# scripts/probe_psn_store.py watches this leg too, and a redeploy that rotates
# the hash fails here exactly as it fails there.
from psn_prices import (STORE_URL, _concept_payload, _headers, _locale_for,
                        _normalise_currency)

SGDB_BASE = "https://www.steamgriddb.com/api/v2"
MAX_GAMES = 40          # per request; the client pages through the rest
MAX_WORKERS = 4
MAX_BODY_BYTES = 262_144
CACHE_TTL = 7 * 24 * 3600        # cover art rarely changes
NEGATIVE_TTL = 24 * 3600         # "no art" -> retry later, not forever
MIN_INTERVAL = 0.12              # spacing that keeps parallel workers polite

# Distinguishes "Sony answered, this concept carries no portrait" (cached as a
# miss) from "Sony did not answer" (never cached -- a blip must not buy the
# game a day of placeholders).
_PSN_FAIL = object()

PSN_TIMEOUT_S = 8                # one concept, the budget psn_prices gives it
# Sony's media lives on a global CDN, so the storefront locale only picks which
# catalogue answers at all. When the display currency has no store (pricing
# reports no_region), the US catalogue is a neutral ask for art.
PSN_FALLBACK_LOCALE = "en-US"
PORTRAIT_ROLE = "PORTRAIT_BANNER"

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


def _console_of(product) -> str | None:
    """Which retail band this title wears: "PS5", "PS4", or None.

    The product node that carries the portrait also lists the platforms it
    runs on (["PS5"], or both on a cross-gen release). Only one band fits on
    a cover, so the current-gen one wins -- the same choice a shop shelf
    makes. A node that states nothing answers None instead of a guess: the
    band is the one thing on the card that would be a lie if it were wrong.
    """
    listed = product.get("platforms")
    if not isinstance(listed, list):
        return None
    for console in ("PS5", "PS4"):
        if console in listed:
            return console
    return None


def _psn_portrait(payload):
    """(art-url, console) for one metGetPricingDataByConceptId answer.

    A concept answers with several product nodes -- base game, edition bundle
    -- and their media lists are not equal: the bundle usually keeps only a
    square MASTER while the base game carries the full set. Every node is
    walked and the first PORTRAIT_BANNER wins, because it is the only role
    that is actually a portrait (1440x2160, the grid's 2:3 box): MASTER is
    square and the landscape roles would crop to a stripe in the card.
    (None, None) when no node carries one.
    """
    try:
        concept = payload["data"]["conceptRetrieve"]
    except (KeyError, TypeError):
        return None, None
    if not isinstance(concept, dict):
        return None, None
    nodes = []
    selectable = concept.get("selectableProducts")
    products = ((selectable or []) if not isinstance(selectable, dict)
                else (selectable.get("purchasableProducts") or []))
    nodes.extend(p for p in products if isinstance(p, dict))
    for key in ("defaultProduct", "purchasableProducts"):
        node = concept.get(key)
        if isinstance(node, dict):
            nodes.append(node)
    for product in nodes:
        media = product.get("media")
        if not isinstance(media, list):
            continue
        for m in media:
            if (isinstance(m, dict) and m.get("role") == PORTRAIT_ROLE
                    and m.get("url")):
                return str(m["url"]), _console_of(product)
    # No portrait -- older catalogue entries were never given one -- but the
    # console is still stated on the products, and it decides which band the
    # card wears when SteamGridDB's art stands in for Sony's. Returning it
    # without art is what keeps a band-less fallback title dressed like the
    # rest of the library instead of silently dropping the console on the floor.
    for product in nodes:
        console = _console_of(product)
        if console:
            return None, console
    return None, None


def _psn_art(concept_id, locale: str):
    """Sony's art for one concept: (url, console), (None, None), or _PSN_FAIL.

    A clean answer is cached either way -- url or the 24h miss, since the
    store simply does not carry that portrait. A transport failure, a refusal
    or a rotated hash answers _PSN_FAIL and spends nothing on the cache: the
    SteamGridDB backup still gets its turn, and the next scroll may succeed
    where this call could not. The rotation canary lives in
    scripts/probe_psn_store.py -- it watches this same operation for pricing.
    """
    cache_key = f"psn:{locale}:{concept_id}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return (None, None) if cached is _MISS else cached
    try:
        resp = requests.post(
            STORE_URL,
            data=json.dumps(_concept_payload(concept_id)),
            headers=_headers(locale),
            timeout=PSN_TIMEOUT_S,
        )
        if resp.status_code != 200:
            return _PSN_FAIL
        url, console = _psn_portrait(resp.json())
    except (requests.RequestException, ValueError):
        return _PSN_FAIL
    # Cached either way as a pair: "no portrait, but PS4" is a real answer the
    # next scroll must not lose, and it is still a clean miss -- unlike
    # _PSN_FAIL, which spends nothing so a blip cannot buy a day of placeholders.
    _cache_set(cache_key, (url, console),
               CACHE_TTL if url else NEGATIVE_TTL)
    return url, console


def resolve_cover(title, appid, concept_id, locale, key):
    """(cover-url, console) for one game. Sony first, SteamGridDB behind it."""
    if concept_id:
        cache_key = f"concept:{locale}:{concept_id}"
    elif appid and str(appid).isdigit():
        cache_key = f"steam:{appid}"
    else:
        cache_key = f"title:{(title or '').strip().lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return (None, None) if cached is _MISS else cached

    url, console = None, None
    failed = False
    if concept_id:
        art = _psn_art(concept_id, locale)
        if art is _PSN_FAIL:
            failed = True          # Sony's blip must not become a cached miss
        else:
            url, console = art
    # The keyless leg answered -- or there was none to give -- before any of
    # this runs, so SteamGridDB only ever spends on what Sony could not serve.
    # When Sony named a console but carried no portrait, the console survives
    # this fallback on purpose: the art changes hands, the band it wears does
    # not. Steam games never pass through the concept leg, so they keep
    # console=None and wear no band at all.
    if not url and key:
        if appid and str(appid).isdigit():
            url = _first_grid_url(_sgdb(f"/grids/steam/{appid}", key, GRID_PARAMS))
        if not url and title:
            gid = _search_game_id(title, key)
            if gid:
                url = _first_grid_url(_sgdb(f"/grids/game/{gid}", key, GRID_PARAMS))

    if not failed:
        _cache_set(cache_key, (url, console) if url else _MISS,
                   CACHE_TTL if url else NEGATIVE_TTL)
    return url, console


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
        # No key is no longer a 401: Sony's leg spends none, so a PlayStation
        # title answers on a bare instance. Only the SteamGridDB backup and
        # the games neither source can place need a key, and those simply
        # answer null -- the grid's placeholder, not an error.
        currency = _normalise_currency(payload.get("currency"))
        locale = _locale_for(currency) or PSN_FALLBACK_LOCALE

        covers: dict[str, str | None] = {}
        consoles: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {
                pool.submit(resolve_cover, g.get("title"), g.get("appid"),
                            g.get("conceptId"), locale, key): g["id"]
                for g in games
            }
            for fut in as_completed(futures):
                gid = futures[fut]
                try:
                    url, console = fut.result()
                except Exception:
                    url, console = None, None
                covers[gid] = url
                if url and console:
                    consoles[gid] = console

        send_json(self, 200, {"covers": covers, "psPlatforms": consoles})

