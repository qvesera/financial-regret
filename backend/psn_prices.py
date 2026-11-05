"""
POST /api/psn_prices   body: {"games": [{"id": "PSN:PPSA23226_00", "titleId":
"PPSA23226_00", "conceptId": 10009763}], "currency": "INR"}

PlayStation Store prices, read from Sony's own storefront GraphQL.

IsThereAnyDeal has no PlayStation Store catalog, and PlatPrices -- the
third-party provider this used to call -- no longer grants keys. GG.deals'
public API only prices Steam. So the price comes from the same public endpoint
the PS Store web app itself calls, which needs no key, no account, no login:

    POST https://web.np.playstation.com/api/graphql/v1/op
    operationName=metGetPricingDataByConceptId   (persisted query, hashed)

Why an id and not a name: the gamelist in psn_games.py already returns
``concept.id`` for every title, and a concept is Sony's own identifier for the
"various versions of a game". Pricing by it joins exactly -- no fuzzy title
matching, and none of the mis-pairings that fuzzy matching costs.

Three traps this code deliberately walks around:

  * **PlayStation Plus catalog CTAs are not a price.** One concept answers with
    several purchase buttons; the Plus one reports discountedPrice "Included",
    isFree true and discountedValue 0. Taking it would price every game free.
    Only the button whose ``meta.upSellService`` is "NONE" is a real purchase.
  * **Unit scale is per currency, not always per 100.** Sony quotes whole
    rupees, yen and won but hundredths everywhere else. A blind /100 prices
    every Japanese title at 1/100th of what it costs.
  * **There is no history here.** The store reports today's list and sale
    figures only, so ``lows`` is null and the dashboard's "lowest ever" figure
    falls back to today's price -- which is what its own tooltip promises.

A missing concept is NOT an error: without a reachable price the endpoint
answers 200 with nulls and the row simply renders Unpriced. Pricing is a
garnish on this dashboard, never a precondition for a scan.

Honest limits:
  * This is an *unofficial* read of Sony's storefront. No third party grants or
    revokes it -- and psn_games.py already talks to Sony's network -- but it is
    the same Terms-of-Service uncertainty PlatPrices refused to be tied to.
  * The persisted query hash rotates when Sony redeploys the store, which shows
    up as ``upstream_failed``. scripts/probe_psn_store.py checks it.

Response: {"prices": {..}, "highs": {..}, "lows": {..}, "resolved": {..},
           "currency": "INR", "region": "en-IN",
           "attribution": null, "reason": null, "limited": {}}

``reason`` explains an empty answer and is null once anything priced:
"no_region" (this display currency has no store), "upstream_failed" (the API
did not answer or its shape changed), "rate_limited" (the store refused this
burst) or "no_match" (it answered and carries none of these titles). ``no_key``
no longer exists: there is no key to forget.
"""
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

STORE_URL = "https://web.np.playstation.com/api/graphql/v1/op"
OPERATION = "metGetPricingDataByConceptId"
# Rotated when Sony redeploys the store frontend. When this starts failing, the
# live hash is readable off the store's own network panel.
PERSISTED_HASH = "abcb311ea830e679fe2b697a27f755764535d825b24510ab1239a4ca3092bd09"
# The store app sends these; without them the operation answers empty.
CLIENT_NAME = "@sie-ppr-web-store/app"
CLIENT_VERSION = "0.109.0"

MAX_GAMES = 5000
MAX_BODY_BYTES = 1_048_576
PRICE_TTL = 24 * 3600     # 24 hours. Console prices drift slowly, and the cache
                          # is per serverless instance.
DEFAULT_CURRENCY = "INR"
ATTRIBUTION = None        # Sony asks for no credit, so nothing is ever claimed.

# Concept lookups are one HTTP call each -- Apollo refuses a JSON array of
# operations with 400, so there is no batch endpoint to lean on. A whole-library
# scan can be a few hundred concepts, so they run in parallel against a
# wall-clock budget: anything unfetched in time simply stays Unpriced rather
# than holding the response open until the platform times the function out.
FETCH_WORKERS = 12
FETCH_BUDGET_S = 20
FETCH_TIMEOUT_S = 8

# Display currency -> PS Store locale. The locale picks both the storefront and
# its currency, so this map answers the whole region question. Every entry was
# probed live; an unsupported locale is answered by Sony rather than guessed at
# here, so a currency with no store maps to no locale and reports no_region.
LOCALE_BY_CURRENCY = {
    "INR": "en-IN", "USD": "en-US", "EUR": "de-DE", "GBP": "en-GB", "JPY": "ja-JP",
    "AUD": "en-AU", "CAD": "en-CA", "BRL": "pt-BR", "KRW": "ko-KR", "SGD": "en-SG",
    "HKD": "zh-HK", "NZD": "en-NZ", "SEK": "sv-SE", "NOK": "no-NO", "DKK": "da-DK",
    "CHF": "de-CH", "PLN": "pl-PL", "TRY": "en-TR", "ZAR": "en-ZA", "MXN": "es-MX",
    "CNY": "zh-CN", "IDR": "id-ID", "THB": "th-TH", "PHP": "en-PH", "RUB": "ru-RU",
    "UAH": "uk-UA", "CZK": "cs-CZ", "HUF": "hu-HU", "ILS": "he-IL",
}

# Currencies Sony quotes in whole units. Everything else is quoted in
# hundredths. Verified live for INR, JPY and KRW, and for the inverse across the
# other 22 offered currencies; the last seven take their ISO minor unit.
ZERO_DECIMAL_CURRENCIES = {"INR", "JPY", "KRW"}

# {locale:conceptId: ({price, high, low} | _MISS, expiry)}
_price_cache: dict[str, tuple] = {}
_MISS = object()          # cached marker: no purchase button for this concept
_NOT_SOLD = object()      # cached marker: nothing left to sell (delisted)


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


def _cache_set(key: str, value) -> None:
    _price_cache[key] = (value, _now() + PRICE_TTL)


def _normalise_currency(raw) -> str:
    """ISO-4217 code from the caller, uppercased; falls back to INR."""
    if isinstance(raw, str):
        code = raw.strip().upper()
        if re.fullmatch(r"[A-Z]{3}", code):
            return code
    return DEFAULT_CURRENCY


def _locale_for(currency: str) -> str | None:
    """The store locale for this display currency, or None when it has none.

    Deliberately absent rather than defaulted: quoting a wrong region's price is
    worse than quoting none, because it reads as fact on every verdict.
    """
    return LOCALE_BY_CURRENCY.get(currency)


def _unit_scale(currency: str) -> int:
    """Divisor from Sony's integer to the displayed amount for this currency."""
    return 1 if currency in ZERO_DECIMAL_CURRENCIES else 100


def _money(raw, currency: str) -> float | None:
    """Whole units -> major-unit float, or None when absent/invalid."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    if raw < 0:
        return None
    return round(raw / _unit_scale(currency), 2)


def _purchase_cta(payload: dict):
    """The one CTA that is an actual purchase, or None.

    A concept answers with several buttons: a PlayStation Plus catalog offer, a
    trial, a preorder. Only upSellService "NONE" is "buy this game" -- the Plus
    button reports itself as free and would price the whole library at zero.
    """
    try:
        product = payload["data"]["conceptRetrieve"]["defaultProduct"]
    except (KeyError, TypeError):
        return None
    if not isinstance(product, dict):
        return None
    for cta in product.get("mobilectas") or []:
        if not isinstance(cta, dict):
            continue
        meta = cta.get("meta") or {}
        if meta.get("upSellService") == "NONE":
            return cta
    return None


def _price_fields(payload: dict, currency: str) -> tuple:
    """(price, high, low) from one metGetPricingDataByConceptId answer.

    ``basePriceValue`` is the undiscounted list figure and stands in as the
    historical high -- the same meaning ``highs`` carries for every other store.
    The sale price is what the store charges today. There is no all-time low in
    this payload at all, so low is always None and the dashboard falls back to
    today's price rather than inventing a history it cannot back up.
    """
    cta = _purchase_cta(payload)
    if cta is None:
        return (None, None, None)
    price_obj = cta.get("price")
    if not isinstance(price_obj, dict):
        return (None, None, None)

    base = price_obj.get("basePriceValue")
    discounted = price_obj.get("discountedValue")
    if price_obj.get("isFree"):
        return (0.0, _money(base, currency) or 0.0, None)

    high = _money(base, currency)
    price = _money(discounted, currency)
    # discountedValue 0 with no campaign means "no discount offered", not "free".
    if price is None or price <= 0:
        price = high
    elif high is not None and price > high:
        price = high
    return (price, high, None)


def _still_listed(payload: dict) -> bool:
    """Does the store still sell anything from this concept?

    A delisted title answers with an empty product list AND no default product
    -- the shape verified against FC 24 and CoD: MW III, in every locale
    sampled. A concept that resolves to nothing at all is the same answer from
    the visitor's side: there is no store listing to price.
    """
    concept = (payload.get("data") or {}).get("conceptRetrieve")
    if not isinstance(concept, dict):
        return False
    if concept.get("defaultProduct"):
        return True
    sel = concept.get("selectableProducts")
    products = (sel.get("purchasableProducts") or []) if isinstance(sel, dict) else (sel or [])
    return any(isinstance(p, dict) for p in products)


def _plus_cta(payload: dict) -> bool:
    """Is this concept offered through PlayStation Plus today?

    The Plus button is unmistakable: ``upSellService`` is exactly "PS_PLUS",
    discounted to zero and reported as "Included". Any other non-NONE value is
    a trial or a preorder, which are not the catalogue -- and the purchase
    button itself is "NONE", so a game you can simply buy never counts here.
    """
    try:
        product = payload["data"]["conceptRetrieve"]["defaultProduct"]
    except (KeyError, TypeError):
        return False
    if not isinstance(product, dict):
        return False
    for cta in product.get("mobilectas") or []:
        if not isinstance(cta, dict):
            continue
        if (cta.get("meta") or {}).get("upSellService") == "PS_PLUS":
            return True
    return False


def _concept_payload(concept_id) -> dict:
    """The POST body for one concept. The id rides in variables, not the URL."""
    return {
        "operationName": OPERATION,
        "variables": {"conceptId": str(concept_id)},
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": PERSISTED_HASH}},
    }


def _headers(locale: str) -> dict:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-apollo-operation-name": OPERATION,
        "x-psn-store-locale-override": locale,
        "apollographql-client-name": CLIENT_NAME,
        "apollographql-client-version": CLIENT_VERSION,
        "User-Agent": "Mozilla/5.0",
    }


class _Fetch:
    """Pricing one concept: a price, a miss, or one kind of failure."""

    OK = "ok"
    NO_PRICE = "no_price"      # answered with products, but no purchase button
    NOT_SOLD = "not_sold"      # answered with nothing left to sell (delisted)
    FAILED = "failed"          # network / 5xx / rotated hash / unparsable
    LIMITED = "limited"        # 429

    def __init__(self, status, fields=None, plus=False):
        self.status = status
        self.fields = fields or (None, None, None)
        # In the PlayStation Plus catalogue as the store answered today. Kept
        # beside the price rather than folded into it: a Plus title is usually
        # still purchasable, so the two facts travel independently.
        self.plus = plus


def _fetch_concept(args):
    """Price one concept. Never raises: one bad title must not sink a scan."""
    concept_id, locale, currency = args
    try:
        resp = requests.post(
            STORE_URL,
            data=json.dumps(_concept_payload(concept_id)),
            headers=_headers(locale),
            timeout=FETCH_TIMEOUT_S,
        )
    except requests.RequestException:
        return _Fetch(_Fetch.FAILED)
    if resp.status_code == 429:
        return _Fetch(_Fetch.LIMITED)
    if resp.status_code != 200:
        return _Fetch(_Fetch.FAILED)
    try:
        payload = resp.json()
    except ValueError:
        return _Fetch(_Fetch.FAILED)
    # A rotated persisted-query hash still answers 200 -- with an errors[] array
    # and no data -- which is why "did it answer" is checked by shape, not code.
    if not isinstance(payload, dict) or not payload.get("data"):
        return _Fetch(_Fetch.FAILED)
    plus = _plus_cta(payload)
    # The delisted shape answers before the price is even read: nothing to sell
    # is a fact about the catalogue, and a different one from "this store has
    # no purchase button for it", which is what free and Plus-only titles look
    # like. Collapsing the two is what would label a free game "Not sold".
    if not _still_listed(payload):
        return _Fetch(_Fetch.NOT_SOLD, plus=plus)
    fields = _price_fields(payload, currency)
    if fields[0] is None:
        return _Fetch(_Fetch.NO_PRICE, plus=plus)
    return _Fetch(_Fetch.OK, fields, plus)


def _request_all(concept_ids: list, locale: str, currency: str) -> tuple:
    """({conceptId: (price, high, low)}, not-sold ids, Plus ids, failed, limited).

    Cached per concept, so only titles not seen before cost a request.

    Two limits are deliberate: a bounded worker pool (an unbounded one against a
    third party is just a way to earn yourself a rate limit) and a wall-clock
    budget. The budget is what keeps a cold scan inside the function's lifetime
    -- a concept still in flight when it expires is abandoned, that title stays
    Unpriced, and the response still returns with everything already priced.
    """
    fields_by_id: dict[str, tuple] = {}
    not_sold: set[str] = set()
    plus_ids: set[str] = set()

    def _plus_cached(concept_id: str) -> bool:
        # The Plus flag rides its own cache entry: the price entry is either a
        # 3-tuple or one of two markers, and none of them has room for it.
        return _cache_get(f"plus:{locale}:{concept_id}") is True

    work = []
    for concept_id in concept_ids:
        cached = _cache_get(f"{locale}:{concept_id}")
        if cached is _NOT_SOLD:
            not_sold.add(concept_id)        # already known: nothing left to sell
            if _plus_cached(concept_id):
                plus_ids.add(concept_id)
            continue
        if cached is _MISS:
            if _plus_cached(concept_id):
                plus_ids.add(concept_id)
            continue                      # already known: no purchase button
        if cached is not None:
            fields_by_id[concept_id] = cached
            if _plus_cached(concept_id):
                plus_ids.add(concept_id)
            continue
        work.append(concept_id)

    failed = False
    limited = False
    if not work:
        return fields_by_id, not_sold, plus_ids, failed, limited

    started = 0
    answered = 0
    pool = ThreadPoolExecutor(max_workers=min(FETCH_WORKERS, len(work)))
    try:
        futures = {
            pool.submit(_fetch_concept, (cid, locale, currency)): cid
            for cid in work
        }
        started = len(futures)
        for future in as_completed(futures, timeout=FETCH_BUDGET_S):
            concept_id = futures[future]
            try:
                result = future.result()
            except Exception:
                failed = True
                continue
            answered += 1
            # The Plus flag is cached either way: it is about the catalogue,
            # not about the price, so it has to survive a hit on either marker.
            if result.plus:
                plus_ids.add(concept_id)
            _cache_set(f"plus:{locale}:{concept_id}", result.plus)
            if result.status == _Fetch.OK:
                fields_by_id[concept_id] = result.fields
                _cache_set(f"{locale}:{concept_id}", result.fields)
            elif result.status == _Fetch.NOT_SOLD:
                not_sold.add(concept_id)
                _cache_set(f"{locale}:{concept_id}", _NOT_SOLD)
            elif result.status == _Fetch.NO_PRICE:
                _cache_set(f"{locale}:{concept_id}", _MISS)
            elif result.status == _Fetch.LIMITED:
                limited = True
            else:
                failed = True
    except (TimeoutError, RuntimeError):
        # The budget elapsed mid-burst: keep what arrived, abandon the rest.
        pass
    finally:
        # Never wait: futures still running must not hold the response open.
        pool.shutdown(wait=False, cancel_futures=True)

    if answered < started:
        # Something was never answered -- a timeout or a cancellation. Reporting
        # it as a store miss would send the visitor hunting for a title problem
        # that is really "we ran out of time".
        failed = True
    return fields_by_id, not_sold, plus_ids, failed, limited


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
        # Validate up front: the loops below key on these fields, so a missing
        # id would otherwise raise mid-request and answer 500 to a bad caller.
        for i, g in enumerate(games):
            if (not isinstance(g, dict) or not isinstance(g.get("id"), str)
                    or not isinstance(g.get("titleId"), str) or not g["titleId"].strip()):
                send_json(self, 400, {
                    "error": f"games[{i}] must be an object with string 'id' and 'titleId'",
                })
                return

        currency = _normalise_currency(payload.get("currency"))
        locale = _locale_for(currency)

        def respond(**extra) -> None:
            body = {
                "prices": {}, "highs": {}, "lows": {}, "resolved": {},
                # Catalogue facts per row: the store stopped selling it, or it
                # is in the Plus catalogue today. Both default empty so an
                # early return (no locale, nothing to ask) keeps the shape.
                "notSold": {}, "plusIncluded": {},
                "currency": currency, "region": locale,
                # Sony asks for no credit, so nothing is ever claimed. The field
                # survives because the footer's credit line is provider-agnostic.
                "attribution": ATTRIBUTION,
                # Why the maps above are empty; null once anything priced. An
                # empty answer used to be indistinguishable between "no key
                # saved", "wrong region" and "store has no such game", which is
                # exactly the confusion that sends people hunting for a
                # configuration step that was never there.
                "reason": None,
                # Which shared key refused this batch. Always {} now: there is
                # no visitor-supplied PlayStation key to spend, so a refusal here
                # cannot be fixed by pasting one, and saying otherwise would
                # send them to a key field we just deleted.
                "limited": {},
            }
            body.update(extra)
            send_json(self, 200, body)

        if not locale:
            respond(reason="no_region")   # this currency has no PlayStation Store
            return

        # One concept backs several dashboard rows (PS4 and PS5 editions of a
        # game share one), so price each concept once and fan it back out.
        rows_by_concept: dict[str, list] = {}
        for g in games:
            concept_id = g.get("conceptId")
            if isinstance(concept_id, bool) or concept_id in (None, "", 0):
                continue
            key = str(concept_id).strip()
            if key.isdigit():
                rows_by_concept.setdefault(key, []).append(g["id"])

        if not rows_by_concept:
            # Nothing to ask the store about. "no_match" is close enough -- from
            # the visitor's side the answer is the same: no price exists for
            # these rows and no setting will conjure one.
            respond(reason="no_match")
            return

        prices = {g["id"]: None for g in games}
        highs = {g["id"]: None for g in games}
        lows = {g["id"]: None for g in games}
        resolved: dict[str, str] = {}
        notSold: dict[str, bool] = {}
        plusIncluded: dict[str, bool] = {}

        fields_by_id, not_sold, plus_ids, failed, limited = _request_all(
            sorted(rows_by_concept, key=int), locale, currency)

        for concept_id, fields in fields_by_id.items():
            price, high, low = fields
            for gid in rows_by_concept.get(concept_id, []):
                prices[gid] = price
                highs[gid] = high
                lows[gid] = low
                resolved[gid] = concept_id

        # Two facts a price cannot carry: the store has stopped selling it, or
        # it is offered through Plus today. Both are per concept and fan out to
        # every row that shares one.
        for concept_id in not_sold:
            for gid in rows_by_concept.get(concept_id, []):
                notSold[gid] = True
        for concept_id in plus_ids:
            for gid in rows_by_concept.get(concept_id, []):
                plusIncluded[gid] = True

        priced = any(v is not None for v in prices.values())
        reason = None
        if not priced:
            # A refused burst outranks every other cause: it is the only one
            # waiting a minute can fix.
            if limited:
                reason = "rate_limited"
            else:
                reason = "upstream_failed" if failed else "no_match"

        respond(
            prices=prices, highs=highs, lows=lows, resolved=resolved,
            notSold=notSold, plusIncluded=plusIncluded,
            reason=reason,
            # `limited` stays as the /api/prices shape answers it -- always empty
            # here. PlayStation spends no key, so there is no refusal that
            # pasting one could fix, and inventing an entry would only send the
            # browser looking for a key field this change just deleted. The 429
            # still reaches the visitor: it arrives as `reason`.
        )



