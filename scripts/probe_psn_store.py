#!/usr/bin/env python3
"""Canary for the persisted-query hash PlayStation pricing and cover art depend on.

backend/psn_prices.py prices the PlayStation Store through one GraphQL
operation, `metGetPricingDataByConceptId`, addressed by a sha256 hash that
Sony rotates whenever it redeploys the store frontend. Nothing else changes
when that happens: the endpoint keeps answering 200 with an errors[] array and
no `data`, which the handler reads as `upstream_failed`. Prices quietly go
blank for every PlayStation row, and nothing in the request path can tell you
whether the store moved or your network did.

backend/covers.py reads the same operation for its keyless cover art (the
PORTRAIT_BANNER media role on the concept's products), so this script watches
that role too: a price-shaped answer with no portrait would silently fall
cover art back to SteamGridDB -- or to placeholders on a keyless instance.

This script is the thing that can tell you. It asks for one real concept in
three locales and fails loudly when the answer stops looking like a price or
stops carrying the portrait, so the scheduled run it rides along in turns red
instead of the dashboard turning blank.

    python scripts/probe_psn_store.py            # 0 = healthy, 1 = rotated

When it fails, the live hash is readable off the store's own network panel:
open the PlayStation Store in a browser, filter the request list to `op?`,
and copy the `sha256Hash` out of the `extensions` parameter. Update
PERSISTED_HASH in backend/psn_prices.py and here together -- they are the same
value in two places, and only one of them pricing is not enough.

No credentials: this is the same public call the store's web app makes.
"""
import json
import sys
import urllib.error
import urllib.request

STORE_URL = "https://web.np.playstation.com/api/graphql/v1/op"
OPERATION = "metGetPricingDataByConceptId"
# Keep in sync with backend/psn_prices.py -- deliberately duplicated so this
# script still runs when the backend itself is the thing that is broken.
PERSISTED_HASH = "abcb311ea830e679fe2b697a27f755764535d825b24510ab1239a4ca3092bd09"

# The Last of Us Part I, present in every store the dashboard offers, and the
# concept the currency probe that produced LOCALE_BY_CURRENCY was run against.
CONCEPT_ID = "10002694"

# One locale per unit convention: INR and JPY are quoted in whole units, USD in
# hundredths. A locale that answers with the wrong currency means the locale
# override is being ignored, which would price a library in the wrong money.
LOCALES = {"en-IN": "INR", "en-US": "USD", "ja-JP": "JPY"}

HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "x-apollo-operation-name": OPERATION,
    "apollographql-client-name": "@sie-ppr-web-store/app",
    "apollographql-client-version": "0.109.0",
    "User-Agent": "Mozilla/5.0",
}


def _portrait(payload) -> str | None:
    """The first PORTRAIT_BANNER url across the concept's product nodes.

    Deliberately the same walk backend/covers.py does, duplicated so this
    script still runs when the backend itself is the thing that is broken.
    """
    try:
        concept = payload["data"]["conceptRetrieve"]
    except (KeyError, TypeError):
        return None
    if not isinstance(concept, dict):
        return None
    selectable = concept.get("selectableProducts")
    nodes = [((selectable or []) if not isinstance(selectable, dict)
              else (selectable.get("purchasableProducts") or []))]
    nodes.append([concept.get(k) for k in ("defaultProduct", "purchasableProducts")
                  if isinstance(concept.get(k), dict)])
    for group in nodes:
        for product in group:
            if not isinstance(product, dict):
                continue
            for media in product.get("media") or []:
                if (isinstance(media, dict) and media.get("role") == "PORTRAIT_BANNER"
                        and media.get("url")):
                    return media["url"]
    return None


def _ask(locale: str):
    """(status, error-or-None, price-or-None, portrait-url-or-None) per locale."""
    body = json.dumps({
        "operationName": OPERATION,
        "variables": {"conceptId": CONCEPT_ID},
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": PERSISTED_HASH}},
    }).encode("utf-8")
    request = urllib.request.Request(
        STORE_URL, data=body, headers={**HEADERS, "x-psn-store-locale-override": locale})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, f"HTTP {exc.code}", None, None
    except Exception as exc:                       # network, DNS, TLS
        return None, f"{type(exc).__name__}: {exc}", None, None

    try:
        payload = json.loads(raw)
    except ValueError:
        return status, "answer was not JSON", None, None

    if not isinstance(payload, dict) or not payload.get("data"):
        # 200 with no data is the signature of a rotated hash, not an outage.
        errors = payload.get("errors") if isinstance(payload, dict) else None
        return status, f"no data in the answer ({errors or 'empty body'})", None, None

    try:
        product = payload["data"]["conceptRetrieve"]["defaultProduct"]
    except (KeyError, TypeError):
        return status, "conceptRetrieve.defaultProduct missing", None, None
    if not isinstance(product, dict):
        return status, "concept not sold in this store", None, None

    portrait = _portrait(payload)
    for cta in product.get("mobilectas") or []:
        meta = (cta or {}).get("meta") or {}
        if meta.get("upSellService") != "NONE":
            continue                               # Plus/trial buttons are not a price
        price = (cta or {}).get("price") or {}
        if isinstance(price.get("basePriceValue"), int):
            return status, None, price, portrait
    return status, "no purchase CTA carrying a price", None, portrait


def main() -> int:
    failures = []
    for locale, expected_currency in LOCALES.items():
        status, error, price, portrait = _ask(locale)
        if error:
            failures.append(f"{locale}: {error}")
            print(f"FAIL {locale}: {error}")
            continue
        currency = price.get("currencyCode")
        value = price.get("basePriceValue")
        if currency != expected_currency:
            # The locale override silently falling back to a default store would
            # price an entire library in money the visitor never chose.
            failures.append(f"{locale}: expected {expected_currency}, got {currency}")
            print(f"FAIL {locale}: expected {expected_currency}, got {currency}")
            continue
        if not portrait:
            # Cover art reads this same answer (backend/covers.py): without the
            # portrait role it silently falls back to SteamGridDB, and to
            # placeholders on an instance with no key at all.
            failures.append(f"{locale}: no PORTRAIT_BANNER media for cover art")
            print(f"FAIL {locale}: no PORTRAIT_BANNER media (cover art would fall back)")
            continue
        print(f"ok   {locale}: {value} {currency} "
              f"({price.get('basePrice')!r}, HTTP {status}, portrait ok)")

    if failures:
        print("\nThe PlayStation price source is not answering as designed.")
        print("If every locale reports 'no data in the answer', the persisted "
              "query hash has been rotated by a store deploy: copy the live "
              "sha256Hash from the store's network panel (see this script's "
              "docstring) into backend/psn_prices.py and here.")
        print("If prices are fine but the portrait check fails, Sony kept "
              "pricing and moved the cover art: check the media roles in "
              "backend/covers.py (PORTRAIT_ROLE).")
        return 1
    print("\nPlayStation store pricing and cover art are healthy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
