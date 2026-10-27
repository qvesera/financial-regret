"""
POST /api/prices   body: {"games": [{"id": "Steam:730", "title": "...", "appid": 730, "platform": "Steam"}, ...]}

Looks up the cheapest current price for each game via IsThereAnyDeal,
priced in the caller's chosen currency (default INR). Uses ITAD_API_KEY from
environment variables.

Prices are keyed by the caller-supplied ``id`` (e.g. "Steam:730", "GOG:123") so
the same title on two platforms never collides. Steam games are resolved by
exact appid batch lookup first; everything else (including Steam misses) falls
back to title lookup, deduplicated by normalised title so one ITAD id can serve
multiple rows without being priced twice.

Response: {"prices": {"Steam:730": 499.0, "GOG:123": null}, "resolved": {"Steam:730": "itad-id"}}
"""
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

ITAD_API_BASE = "https://api.isthereanydeal.com"
STEAM_SHOP_ID = 61
MAX_WORKERS = 15        # concurrent title lookups
CHUNK_SIZE = 200        # ITAD's per-request cap on both lookup and prices endpoints
TITLE_CHUNK = 200       # titles per batched /lookup/id/title/v1 request
MAX_GAMES = 5000        # hard cap to protect the ITAD quota
MAX_BODY_BYTES = 1_048_576

DEFAULT_CURRENCY = "INR"
DEFAULT_COUNTRY = "IN"
# Store region for each display currency. ITAD denominates prices by the
# requested `country`, so the region follows the chosen currency (USD -> US
# store prices). That mapping is the reliable denomination fallback if ITAD
# rejects/ignores the `currency` parameter.
CURRENCY_COUNTRY = {
    "INR": "IN", "USD": "US", "EUR": "DE", "GBP": "GB", "JPY": "JP",
    "AUD": "AU", "CAD": "CA", "BRL": "BR", "KRW": "KR", "SGD": "SG",
    "HKD": "HK", "NZD": "NZ", "SEK": "SE", "NOK": "NO", "DKK": "DK",
    "CHF": "CH", "PLN": "PL", "TRY": "TR", "ZAR": "ZA", "MXN": "MX",
    "CNY": "CN", "IDR": "ID", "THB": "TH", "PHP": "PH", "RUB": "RU",
    "UAH": "UA", "CZK": "CZ", "HUF": "HU", "ILS": "IL",
}

# in-memory caches: {key: (value, expiry_monotonic)}
_title_cache: dict[str, tuple[str, float]] = {}
_price_cache: dict[str, tuple[float | None, float]] = {}
TITLE_TTL = 7 * 24 * 3600      # 7 days
PRICE_TTL = 6 * 3600           # 6 hours
_MISS = object()               # cached marker: ITAD confirmed no match
NEGATIVE_TTL = 6 * 3600        # re-check unresolved titles after 6h


def _now() -> float:
    return time.monotonic()


def _cache_get(cache: dict, key: str):
    entry = cache.get(key)
    if entry is None:
        return None
    value, expiry = entry
    if _now() > expiry:
        del cache[key]
        return None
    return value


def _cache_set(cache: dict, key: str, value, ttl: float) -> None:
    cache[key] = (value, _now() + ttl)


def _normalise_title(title: str) -> str:
    return " ".join(title.lower().split())


def _alnum(title: str) -> str:
    """Alphanumeric-only lowercase form; ignores ®/™/punctuation so a query of
    "Sid Meier's Civilization VI" still matches ITAD's "...Civilization® VI"."""
    return re.sub(r"[^0-9a-z]", "", title.lower())


def _best_search_match(query: str, candidates) -> str | None:
    """Pick the candidate game id whose title best matches the query.

    An exact alnum-fold match wins outright; otherwise accept the candidate
    that contains (or is contained by) the query within a few characters --
    this tolerates a missing leading "The" while still rejecting soundtracks
    and bundles, whose titles diverge much further.
    """
    q = _alnum(query)
    best, best_delta = None, None
    for c in candidates or []:
        cid = c.get("id")
        ca = _alnum(c.get("title") or "")
        if not cid or not ca:
            continue
        if ca == q:
            return cid
        if q in ca or ca in q:
            delta = abs(len(ca) - len(q))
            if delta <= 4 and (best_delta is None or delta < best_delta):
                best, best_delta = cid, delta
    return best


def _normalise_currency(raw) -> str:
    """ISO-4217 code from the caller, uppercased; falls back to INR."""
    if isinstance(raw, str):
        code = raw.strip().upper()
        if re.fullmatch(r"[A-Z]{3}", code):
            return code
    return DEFAULT_CURRENCY


def _price_key(country: str, currency: str, iid: str) -> str:
    """Cache key spanning region+currency so switching currency never reuses an
    amount quoted in the previous currency."""
    return f"{country}:{currency}:{iid}"


def _request_prices(api_key: str, ids: list[str], country: str, currency: str) -> list:
    """POST /games/prices/v3 for `ids` and return the parsed list (or []).

    Asks ITAD for `currency` within store region `country`. If ITAD answers
    400 (the `currency` parameter rejected/unsupported), retry region-only so
    the region's native denomination still yields prices instead of dropping
    them. 429/5xx are NOT retried -- that would just double-hit the rate limit.
    """
    url = f"{ITAD_API_BASE}/games/prices/v3"
    try:
        resp = requests.post(
            url, params={"key": api_key, "country": country, "currency": currency},
            json=ids, timeout=20,
        )
        if resp.status_code == 400:
            resp = requests.post(
                url, params={"key": api_key, "country": country},
                json=ids, timeout=20,
            )
        if resp.status_code != 200:
            return []
        data = resp.json()
        return data if isinstance(data, list) else []
    except (requests.RequestException, ValueError):
        return []


def _bulk_resolve_titles(api_key: str, titles: list[str]) -> dict[str, str | None]:
    """Batched POST /lookup/id/title/v1 -> {title: itad_id or None}.

    Resolves many titles in one request (ITAD matches case-insensitively and
    tolerates ®/™), so a big library doesn't spend one-or-two calls per game
    and trip ITAD's rate limit (1000 req / 5 min) -- which is exactly what
    blanked out large Epic scans while Steam's batched appid lookup stayed
    fine. Titles the batch can't match (a missing "The"/colon isn't fuzzy
    matched here) come back None for the caller to retry per-title; a failed
    batch simply omits its titles so they fall back too.
    """
    out: dict[str, str | None] = {}
    for i in range(0, len(titles), TITLE_CHUNK):
        chunk = titles[i:i + TITLE_CHUNK]
        try:
            resp = requests.post(
                f"{ITAD_API_BASE}/lookup/id/title/v1",
                params={"key": api_key},
                json=chunk,
                timeout=20,
            )
            if resp.status_code == 200:
                data = resp.json()
                if isinstance(data, dict):
                    for t in chunk:
                        out[t] = data.get(t) or None
        except (requests.RequestException, ValueError):
            pass  # leave these unresolved -> the fuzzy fallback covers them
    return out


def _resolve_title(api_key: str, title: str) -> tuple[str | None, bool]:
    """Return (itad_id, transient).

    transient is True when a 429/network error made the answer unreliable, so
    the caller must NOT cache the miss -- a rate-limited scan should not poison
    the cache for hours. A confident hit is returned immediately.
    """
    transient = False
    # Fast path: exact lookup + alnum guard (tolerates ®/™ and formatting).
    try:
        resp = requests.get(
            f"{ITAD_API_BASE}/games/lookup/v1",
            params={"key": api_key, "title": title},
            timeout=10,
        )
        if resp.status_code == 429:
            transient = True
        elif resp.status_code == 200:
            data = resp.json()
            game = data.get("game") or {}
            if game.get("id") and data.get("found") and _alnum(game.get("title", "")) == _alnum(title):
                return game["id"], False
    except requests.RequestException:
        transient = True
    # Fuzzy fallback: search and take the closest alnum-fold match. Catches a
    # missing/extra article ("Jackbox Party Pack 4" -> "The Jackbox ...").
    try:
        resp = requests.get(
            f"{ITAD_API_BASE}/games/search/v1",
            params={"key": api_key, "title": title},
            timeout=10,
        )
        if resp.status_code == 429:
            transient = True
        elif resp.status_code == 200:
            match = _best_search_match(title, resp.json())
            if match:
                return match, False
    except requests.RequestException:
        transient = True
    return None, transient


def _lookup_by_title(api_key: str, title: str) -> str | None:
    cached = _cache_get(_title_cache, title)
    if cached is not None:
        return None if cached is _MISS else cached
    itad_id, transient = _resolve_title(api_key, title)
    if itad_id:
        _cache_set(_title_cache, title, itad_id, TITLE_TTL)
    elif not transient:
        # Confirmed miss (ITAD answered, just has no match): skip it on the
        # next scan instead of burning another 2 calls against the rate limit.
        _cache_set(_title_cache, title, _MISS, NEGATIVE_TTL)
    return itad_id


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
        if len(games) > MAX_GAMES:
            send_json(self, 400, {"error": f"'games' list exceeds {MAX_GAMES} items"})
            return
        # Validate shape up front: every row must be id-keyed and titled,
        # otherwise the lookups below would raise KeyError mid-request.
        for i, g in enumerate(games):
            if not isinstance(g, dict) or not isinstance(g.get("id"), str) or not isinstance(g.get("title"), str):
                send_json(self, 400, {"error": f"games[{i}] must be an object with string 'id' and 'title'"})
                return

        # Prefer the caller's own key (X-ITAD-Key) so each user brings their
        # own IsThereAnyDeal rate-limit quota; fall back to the server key.
        api_key = self.headers.get("X-ITAD-Key") or os.environ.get("ITAD_API_KEY")
        if not api_key:
            send_json(self, 500, {"error": "No ITAD key: set ITAD_API_KEY on the server or supply your own"})
            return

        # Caller-selected display currency (ISO 4217) forwarded to ITAD; the
        # store region follows it so the amount is denominated correctly.
        currency = _normalise_currency(payload.get("currency"))
        country = CURRENCY_COUNTRY.get(currency, DEFAULT_COUNTRY)

        # --- Step 1: exact appid batch resolution for Steam games -------------
        steam_games = [g for g in games if g.get("appid") and str(g["appid"]).isdigit()]
        itad_id_by_game_id: dict[str, str] = {}
        unresolved: list[dict] = []

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
                            itad_id_by_game_id[g["id"]] = itad_id
                        else:
                            unresolved.append(g)
                else:
                    unresolved.extend(chunk)
            except requests.RequestException:
                unresolved.extend(chunk)

        # non-Steam games always go through title lookup
        unresolved.extend(g for g in games if g not in steam_games)

        # --- Step 2: title-based lookup, deduplicated by normalised title -----
        # Rate-limit aware: reuse the title cache, resolve the bulk in a few
        # batched POSTs, then fuzzy-fallback only for what the batch couldn't
        # match. One lookup+search call per game exceeded ITAD's rate limit and
        # blanked large Epic scans (Steam's batched appid lookup never hit it).
        by_normalised: dict[str, dict] = {}
        for g in unresolved:
            by_normalised.setdefault(_normalise_title(g["title"]), g)

        resolved_by_norm: dict[str, str] = {}
        uncached: list[str] = []
        for norm in by_normalised:
            cached = _cache_get(_title_cache, norm)
            if cached is None:
                uncached.append(norm)
            elif cached is not _MISS:
                resolved_by_norm[norm] = cached

        if uncached:
            for norm, itad_id in _bulk_resolve_titles(api_key, uncached).items():
                if itad_id:
                    _cache_set(_title_cache, norm, itad_id, TITLE_TTL)
                    resolved_by_norm[norm] = itad_id

            # Fuzzy fallback for titles the batch couldn't match (or whose batch
            # failed): handles a missing "The"/punctuation and confirmed misses.
            still = [n for n in uncached if n not in resolved_by_norm]
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                future_to_norm = {
                    pool.submit(_lookup_by_title, api_key, n): n for n in still
                }
                for future in as_completed(future_to_norm):
                    norm = future_to_norm[future]
                    try:
                        itad_id = future.result()
                    except Exception:
                        itad_id = None
                    if itad_id:
                        resolved_by_norm[norm] = itad_id

        for g in unresolved:
            itad_id = resolved_by_norm.get(_normalise_title(g["title"]))
            if itad_id:
                itad_id_by_game_id[g["id"]] = itad_id

        # --- Step 3: batch-fetch prices for resolved ITAD ids ----------------
        prices: dict[str, float | None] = {g["id"]: None for g in games}
        highs: dict[str, float | None] = {g["id"]: None for g in games}
        lows: dict[str, float | None] = {g["id"]: None for g in games}
        resolved: dict[str, str] = {}
        id_to_game_ids: dict[str, list[str]] = {}
        for gid, iid in itad_id_by_game_id.items():
            resolved[gid] = iid
            id_to_game_ids.setdefault(iid, []).append(gid)

        all_ids = list(id_to_game_ids.keys())
        actual_currency = None
        for i in range(0, len(all_ids), CHUNK_SIZE):
            chunk_ids = all_ids[i:i + CHUNK_SIZE]
            # check price cache first (keyed by region+currency)
            to_fetch = []
            for iid in chunk_ids:
                key = _price_key(country, currency, iid)
                cached = _cache_get(_price_cache, key)
                if isinstance(cached, dict):
                    for gid in id_to_game_ids[iid]:
                        prices[gid] = cached.get("price")
                        highs[gid] = cached.get("high")
                        lows[gid] = cached.get("low")
                else:
                    to_fetch.append(iid)

            if not to_fetch:
                continue
            for entry in _request_prices(api_key, to_fetch, country, currency):
                iid = entry.get("id")
                deals = entry.get("deals", [])
                price = high = low = None
                if deals:
                    if actual_currency is None:
                        # Trust ITAD's own currency label for what the amounts
                        # are actually denominated in (drives the UI symbol).
                        for d in deals:
                            cur = (d.get("price") or {}).get("currency")
                            if cur:
                                actual_currency = cur
                                break
                    # ITAD sends null for price/regular/storeLow on some deals.
                    # `.get(key, {})` only defaults on a MISSING key, so a null
                    # value must be coalesced explicitly or it raises
                    # AttributeError and takes the whole pricing request down.
                    amounts = [(d.get("price") or {}).get("amount") for d in deals
                               if (d.get("price") or {}).get("amount") is not None]
                    price = min(amounts) if amounts else None
                    # Highest ever: the top list (regular) price any shop asks.
                    regulars = [(d.get("regular") or {}).get("amount") for d in deals
                                if (d.get("regular") or {}).get("amount") is not None]
                    high = max(regulars) if regulars else (max(amounts) if amounts else None)
                    # Lowest ever: ITAD's all-time low for the game (else the
                    # best per-shop low, else today's price).
                    hl = (entry.get("historyLow") or {}).get("all") or {}
                    low = hl.get("amount")
                    if low is None:
                        store_lows = [(d.get("storeLow") or {}).get("amount") for d in deals
                                      if (d.get("storeLow") or {}).get("amount") is not None]
                        low = min(store_lows) if store_lows else price
                _cache_set(_price_cache, _price_key(country, currency, iid),
                           {"price": price, "high": high, "low": low}, PRICE_TTL)
                for gid in id_to_game_ids.get(iid, []):
                    prices[gid] = price
                    highs[gid] = high
                    lows[gid] = low

        send_json(self, 200, {
            "prices": prices,
            "highs": highs,
            "lows": lows,
            "resolved": resolved,
            "currency": actual_currency or currency,
        })