"""
POST /api/psn_prices   body: {"games": [{"id": "PSN:PPSA23226_00", "titleId": "PPSA23226_00"}], "currency": "INR"}

PlayStation Store prices, looked up by PSN title id via PlatPrices
(platprices.com/api/v2). IsThereAnyDeal -- the source for every other store --
does not cover the PlayStation Store at all, so PSN rows used to have no price
and rendered as "Unpriced".

Why an id and not a name: PlatPrices' game object carries ``NpTitleId``
(e.g. "PPSA23226_00"), which is exactly the ``titleId`` the gamelist endpoint
in psn_games.py already returns. That is a real join key, so none of the fuzzy
title matching (and none of its mis-pairings) the ITAD path needs is required.

A missing key is NOT an error: without PLATPRICES_API_KEY the endpoint answers
200 with empty maps and PSN rows simply stay Unpriced. Pricing is a garnish on
this dashboard, never a precondition for a scan.

Units: PlatPrices returns integers in the region's *minor* units, scaled by a
per-region ``decimalPlaces``. We divide by 10**d before answering, because a
hardcoded /100 would report every Japanese game at 1/100th of its price.

Response: {"prices": {..}, "highs": {..}, "lows": {..}, "resolved": {..},
           "currency": "INR", "region": "in",
           "attribution": "Powered by PlatPrices", "reason": null}

``reason`` explains an empty answer and is null once anything priced:
"no_key" (no key reached the server), "no_region" (this currency has no
PlatPrices store), "upstream_failed" (the API did not answer) or "no_match"
(it answered and carried none of these titles).

Regions: a key may only query the store regions it has been configured for --
free plans allow 2, reconfigurable at most once a day via
PUT /account/regions. A key whose allowlist excludes India therefore answers
with nothing at all for region=in, which is precisely the failure that
``reason`` exists to name.
"""
import json
import re
import time
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options, user_key

PLATPRICES_BASE = "https://platprices.com/api/v2"
BATCH_SIZE = 100          # ids per /games/batch call; halved automatically on 400
MAX_GAMES = 5000
MAX_BODY_BYTES = 1_048_576
PRICE_TTL = 6 * 3600      # 6 hours, matching prices.py
DEFAULT_CURRENCY = "INR"
ATTRIBUTION = "Powered by PlatPrices"

# Display currency -> PlatPrices store region. Only currencies that BOTH the
# dashboard offers and PlatPrices actually serves: CNY, PHP and RUB have no
# store there, so those stay unpriced rather than quoting a wrong region.
REGION_BY_CURRENCY = {
    "INR": "in", "USD": "us", "EUR": "de", "GBP": "gb", "JPY": "jp",
    "AUD": "au", "CAD": "ca", "BRL": "br", "KRW": "kr", "SGD": "sg",
    "HKD": "hk", "NZD": "nz", "SEK": "se", "NOK": "no", "DKK": "dk",
    "CHF": "ch", "PLN": "pl", "TRY": "tr", "ZAR": "za", "MXN": "mx",
    "IDR": "id", "THB": "th", "UAH": "ua", "CZK": "cz", "HUF": "hu",
    "ILS": "il",
}

# Regions whose currency has no minor unit; everywhere else PlatPrices quotes
# hundredths. A static set rather than a /regions round-trip because the only
# zero-decimal stores among PlatPrices' 47 are Japan and Korea.
ZERO_DECIMAL_REGIONS = {"jp", "kr"}

# {"region:title_id": ({price, high, low}, expiry)}
_price_cache: dict[str, tuple[dict, float]] = {}


def _now() -> float:
    return time.monotonic()


def _cache_get(key: str):
    entry = _price_cache.get(key)
    if entry is None:
        return None
    value, expiry = entry
    if _now() > expiry:
        del _price_cache[key]
        return None
    return value


def _cache_set(key: str, value: dict) -> None:
    _price_cache[key] = (value, _now() + PRICE_TTL)


def _normalise_currency(raw) -> str:
    """ISO-4217 code from the caller, uppercased; falls back to INR."""
    if isinstance(raw, str):
        code = raw.strip().upper()
        if re.fullmatch(r"[A-Z]{3}", code):
            return code
    return DEFAULT_CURRENCY


def _money(raw, region: str) -> float | None:
    """Minor-unit integer -> major-unit float, or None when absent/invalid."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    if raw < 0:
        return None
    scale = 1 if region in ZERO_DECIMAL_REGIONS else 100
    return round(raw / scale, 2)


def _price_fields(item: dict, region: str) -> tuple:
    """(price, high, low) from one PlatPrices game object.

    ``SalePrice`` is what the store charges today (sale or not); ``BasePrice`` is
    the undiscounted list figure. ``LaunchPrice`` is absent on most titles, so
    the list price stands in as the historical high -- which is the same
    meaning ``highs`` carries for every other store. A delisted game has no
    purchasable price at all, so it reports None rather than an amount nobody
    can act on.
    """
    price = item.get("SalePrice")
    if price is None:
        price = item.get("BasePrice")
    high = item.get("LaunchPrice")
    if high is None:
        high = item.get("BasePrice")
    low = item.get("LowestEverPrice")
    if item.get("IsDelisted") in (1, True, "1"):
        price = None
    return (_money(price, region), _money(high, region), _money(low, region))


def _index_by_title_id(items) -> dict:
    """{id: game object}, indexed under both id shapes PlatPrices returns.

    Verified against the keyless /demo payload: ``NpTitleId`` is the
    ``_00``-suffixed form our gamelist already carries ("PPSA23226_00"), while
    ``GameID`` is the bare one ("PPSA23226"). ``PSNID`` is deliberately skipped:
    it is a full content id ("HP6545-PPSA23226_00-GAME000000000000"), not a
    title id, so it is never a valid lookup key.
    """
    index: dict[str, dict] = {}
    for item in items or []:
        if not isinstance(item, dict):
            continue
        for key in ("NpTitleId", "GameID"):
            value = item.get(key)
            if isinstance(value, str) and value:
                index[value] = item
                index.setdefault(value.upper(), item)
    return index


def _request_batch(api_key: str, title_ids: list, region: str):
    """One /games/batch call.

    Returns a list (possibly empty), None on failure, or the string "SPLIT" when
    the batch exceeded the plan's per-request record cap -- which surfaces as
    400 INVALID_PARAM -- and therefore needs to be halved by the caller.
    """
    try:
        resp = requests.get(
            f"{PLATPRICES_BASE}/games/batch",
            params={"psnids": ",".join(title_ids), "region": region},
            headers={"X-API-Key": api_key},
            timeout=20,
        )
    except requests.RequestException:
        return None
    if resp.status_code == 400:
        return "SPLIT"
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    if not isinstance(data, dict) or not data.get("success"):
        return None
    items = data.get("data")
    return items if isinstance(items, list) else []


def _request_all(api_key: str, title_ids: list, region: str) -> tuple[list, bool]:
    """(game objects for ``title_ids``, whether any batch failed), splitting on 400.

    The per-plan record cap is not published as a number, so a 400 is read as
    "too many ids" and the batch is halved. That is both cheaper and more
    durable than hardcoding a guess that silently starts failing when the plan
    tiers change.

    Failure is reported rather than swallowed: "the store carries no such game"
    and "we never got an answer" are different answers, and only one of them
    should leave a user hunting for a configuration problem.
    """
    out: list = []
    failed = False
    stack = [title_ids]
    while stack:
        chunk = stack.pop()
        if not chunk:
            continue
        got = _request_batch(api_key, chunk, region)
        if got == "SPLIT":
            if len(chunk) == 1:
                failed = True       # a single id the plan rejects: give up on it
                continue
            mid = len(chunk) // 2
            stack.append(chunk[:mid])
            stack.append(chunk[mid:])
            continue
        if got is None:
            failed = True           # network error, bad key, or a non-200
            continue
        if got:
            out.extend(got)
    return out, failed


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > MAX_BODY_BYTES:
            send_json(self, 413, {"error": "Request body too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
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
        # Validate up front: the loops below key on both fields, so a missing
        # titleId would otherwise raise mid-request.
        for i, g in enumerate(games):
            if (not isinstance(g, dict) or not isinstance(g.get("id"), str)
                    or not isinstance(g.get("titleId"), str) or not g["titleId"].strip()):
                send_json(self, 400, {
                    "error": f"games[{i}] must be an object with string 'id' and 'titleId'",
                })
                return

        currency = _normalise_currency(payload.get("currency"))
        region = REGION_BY_CURRENCY.get(currency)

        def respond(**extra) -> None:
            body = {
                "prices": {}, "highs": {}, "lows": {}, "resolved": {},
                "currency": currency, "region": region, "attribution": None,
                # Why the maps above are empty; null once anything priced. An
                # empty answer used to be indistinguishable between "no key",
                # "key cannot see this region" and "store has no such game",
                # which is exactly the confusion that sends people hunting for
                # a bug that is really a missing configuration step.
                "reason": None,
            }
            body.update(extra)
            send_json(self, 200, body)

        # Prefer the caller's own PlatPrices key (the free and Indie plans cap
        # at 2 regions and 1,000 requests/month), else fall back to the server
        # key -- unless this deployment is public and REQUIRE_USER_KEYS=1.
        api_key = user_key(self, "X-Platprices-Key", "PLATPRICES_API_KEY")
        if not api_key:
            respond(reason="no_key")
            return
        if not region:
            respond(reason="no_region")   # this currency has no PlatPrices store
            return

        # One title id can back several dashboard rows, so fetch each once and
        # fan the answer back out.
        ids_by_title: dict[str, list] = {}
        for g in games:
            ids_by_title.setdefault(g["titleId"].strip(), []).append(g["id"])

        prices = {g["id"]: None for g in games}
        highs = {g["id"]: None for g in games}
        lows = {g["id"]: None for g in games}
        resolved: dict[str, str] = {}

        def apply(title_id: str, price, high, low) -> None:
            for gid in ids_by_title.get(title_id, []):
                prices[gid] = price
                highs[gid] = high
                lows[gid] = low
                resolved[gid] = title_id

        pending: list[str] = []
        for title_id in ids_by_title:
            cached = _cache_get(f"{region}:{title_id}")
            if cached is None:
                pending.append(title_id)
            else:
                apply(title_id, cached.get("price"), cached.get("high"), cached.get("low"))

        upstream_failed = False
        for i in range(0, len(pending), BATCH_SIZE):
            chunk = pending[i:i + BATCH_SIZE]
            items, chunk_failed = _request_all(api_key, chunk, region)
            upstream_failed = upstream_failed or chunk_failed
            index = _index_by_title_id(items)
            for title_id in chunk:
                item = index.get(title_id) or index.get(title_id.upper())
                if item is None:
                    continue      # not in the store (or DLC-only): stays Unpriced
                price, high, low = _price_fields(item, region)
                _cache_set(f"{region}:{title_id}", {"price": price, "high": high, "low": low})
                apply(title_id, price, high, low)

        priced = any(v is not None for v in prices.values())
        reason = None
        if not priced:
            reason = "upstream_failed" if upstream_failed else "no_match"

        respond(
            prices=prices, highs=highs, lows=lows, resolved=resolved,
            # Credit only where there is data to credit: a dead upstream is not
            # PlatPrices answering, it is nobody answering.
            attribution=(ATTRIBUTION if (priced or not upstream_failed) else None),
            reason=reason,
        )
