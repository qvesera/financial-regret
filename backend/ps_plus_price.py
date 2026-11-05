"""
GET /api/ps_plus_price   query: ?currency=<ISO code>

The PlayStation Store's own price for **PlayStation Plus Essential, one
month** -- concept 10004507, which is the only subscription plan reachable
without a credential.

The 3- and 12-month plans are product-only ids (…PLUS1T12M…) with no concept
page at all, and the store's public schema refuses product lookups outright
(productRetrieve answers 400), so there is no annual figure to read anywhere.
This module therefore prices exactly one plan, names its tier and term, and
never implies anything about the others: an annual cost is not 12 x this price,
and nothing here multiplies it.

What the number is for: the "at most" estimate under the PS Plus paid KPI,
which assumes monthly billing at today's price since the account's first played
title. Both halves of that sentence are assumptions, and both are stated on the
card rather than buried here.

Reuses psn_prices' locale map, headers, request shape and cache instead of
re-deriving them: the currency/locale answer has to be the one game prices use,
or a library would quote one region and this would quote another.
"""
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

from _common import send_json, handle_options
from psn_prices import (
    ATTRIBUTION,
    FETCH_TIMEOUT_S,
    STORE_URL,
    _cache_get,
    _cache_set,
    _concept_payload,
    _headers,
    _locale_for,
    _money,
    _normalise_currency,
    _product_nodes,
)

# The concept that answers with Essential billed monthly. Its product id
# (IP9102-PPSA06902_00-PLUS1T01M0000000) is what the store returns for it,
# which is the evidence for both the tier and the term in the label below.
PLUS_CONCEPT = 10004507
PLAN = {"tier": "Essential", "months": 1}
LABEL = "PlayStation Plus Essential · 1 month"


def _read_plan(payload: dict, currency: str) -> dict | None:
    """{price, was, promo} for the first product that carries a price, or None.

    A subscription concept answers with one product, but the reader stays
    general. A sale prices below the base, and the card says so rather than
    quietly showing a discounted figure as though it were always the cost.
    """
    for node in _product_nodes(payload):
        price = (node or {}).get("price") or {}
        base = _money(price.get("basePriceValue"), currency)
        if base is None:
            continue
        discounted = _money(price.get("discountedValue"), currency)
        if discounted is not None and discounted < base:
            return {"price": discounted, "was": base, "promo": True}
        return {"price": base, "was": None, "promo": False}
    return None


def _fetch_plan(locale: str, currency: str) -> dict:
    """The plan's price, or the reason it is missing. Never raises.

    A price this dashboard cannot read is a reason, not a 500: the KPI simply
    shows nothing and every other figure keeps working. Only a catalogue answer
    is cached -- a transient refusal must retry on the next request, while a
    retired concept must not be re-asked on every render.
    """
    key = f"plus:{locale}:{currency}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    def store(result: dict) -> dict:
        _cache_set(key, result)
        return result

    try:
        resp = requests.post(
            STORE_URL,
            data=json.dumps(_concept_payload(PLUS_CONCEPT)),
            headers=_headers(locale),
            timeout=FETCH_TIMEOUT_S,
        )
    except requests.RequestException:
        return {"reason": "store_error"}
    if resp.status_code != 200:
        return {"reason": "store_error"}
    try:
        payload = resp.json()
    except ValueError:
        return {"reason": "store_error"}
    # A rotated persisted-query hash still answers 200 -- with an errors[] array
    # and no data -- so "did it answer" is checked by shape, not by code.
    if not isinstance(payload, dict) or not payload.get("data"):
        return {"reason": "store_error"}
    # Nothing left to sell: a fact about the catalogue, so it is cached like a
    # price rather than retried until the next scan.
    if not _product_nodes(payload):
        return store({"reason": "no_plan"})
    fields = _read_plan(payload, currency)
    if fields is None:
        return store({"reason": "no_plan"})
    return store({**fields, "reason": None})


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        # An absent or malformed code normalises to the app's default, and an
        # unsupported one keeps its own value so _locale_for can refuse it.
        currency = _normalise_currency((query.get("currency") or [""])[0])
        body = {
            "currency": currency,
            "region": None,
            "price": None,
            "was": None,
            "promo": False,
            "plan": PLAN,
            "label": LABEL,
            # Sony asks for no credit, so nothing is claimed -- the same field
            # the game-price endpoint returns, for the same reason.
            "attribution": ATTRIBUTION,
            "reason": None,
        }
        locale = _locale_for(currency)
        if not locale:
            # This display currency has no PlayStation Store. Quoting a wrong
            # region's price would read as fact on a verdict, so none is quoted.
            body["reason"] = "no_region"
            send_json(self, 200, body)
            return
        body["region"] = locale

        result = _fetch_plan(locale, currency)
        if result.get("price") is not None:
            body.update({
                "price": result["price"],
                "was": result.get("was"),
                "promo": bool(result.get("promo")),
            })
        else:
            body["reason"] = result.get("reason") or "no_plan"
        send_json(self, 200, body)
