"""Two facts a price cannot carry: the store stopped selling it, and it is in
the PlayStation Plus catalogue today.

Both matter because of what they replace. Without the first, a delisted title
reads as "Unpriced", which sends the visitor hunting for a pricing bug that
is really a store that no longer lists the game. Without the second, a Plus
catalogue game reads the same way -- and the answer a subscriber wants ("you
already have this") is the one thing the card never says.

The distinction that has to hold: a delisted concept answers with nothing for
sale, while a free or Plus-only title answers with products and no purchase
button. Collapsing them would label free games "Unlisted".
"""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import psn_prices  # noqa: E402

GAME = {"id": "PSN:PPSA00001_00", "titleId": "PPSA00001_00", "conceptId": 10007176}


class _Resp:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


def _delisted():
    """The shape FC 24 and CoD: MW III answer with in every locale sampled:
    the concept resolves, nothing is for sale, no default product."""
    return {"data": {"conceptRetrieve": {
        "id": 10007176,
        "defaultProduct": None,
        "selectableProducts": {"purchasableProducts": []},
    }}}


def _priced_with_plus():
    """A purchase button AND a Plus button -- the shape TLOU, Dead Island 2 and
    Monster Train 2 all answer with. Priced, and still in the catalogue."""
    return {"data": {"conceptRetrieve": {"defaultProduct": {"mobilectas": [
        {"meta": {"upSellService": "PS_PLUS"},
         "price": {"basePriceValue": 6999, "discountedValue": 0,
                   "currencyCode": "USD", "isFree": True}},
        {"meta": {"upSellService": "NONE"},
         "price": {"basePriceValue": 6999, "discountedValue": 6999,
                   "currencyCode": "USD", "isFree": False}},
    ]},
        "selectableProducts": {"purchasableProducts": [{}]},
    }}}


def _plus_only():
    """Products, a Plus button and no purchase button: on the store, not
    buyable. Unlisted would be a lie about a game you can play today."""
    return {"data": {"conceptRetrieve": {"defaultProduct": {"mobilectas": [
        {"meta": {"upSellService": "PS_PLUS"},
         "price": {"basePriceValue": 5999, "discountedValue": 0,
                   "currencyCode": "INR", "isFree": True}},
    ]},
        "selectableProducts": {"purchasableProducts": [{}]},
    }}}


def _fetch(payload, status=200):
    with mock.patch.object(psn_prices, "requests") as rq:
        rq.post.return_value = _Resp(payload, status)
        return psn_prices._fetch_concept(("10007176", "en-US", "USD"))


class TestCatalogueFacts(unittest.TestCase):
    """notSold and plusIncluded, from the store's own answer to one concept."""

    def setUp(self):
        psn_prices._price_cache.clear()

    def test_a_delisted_concept_is_not_sold(self):
        result = _fetch(_delisted())
        self.assertEqual(result.status, psn_prices._Fetch.NOT_SOLD)
        self.assertEqual(result.fields, (None, None, None),
                         "nothing for sale, so nothing to price")

    def test_a_free_or_plus_only_title_is_not_called_not_sold(self):
        # The trap: products exist and there is simply no purchase button.
        # "Unlisted" here would tell the visitor a game they can play is gone.
        result = _fetch(_plus_only())
        self.assertEqual(result.status, psn_prices._Fetch.NO_PRICE)
        self.assertTrue(result.plus, "and it is in the Plus catalogue")

    def test_a_priced_plus_title_reports_both_facts(self):
        result = _fetch(_priced_with_plus())
        self.assertEqual(result.status, psn_prices._Fetch.OK)
        self.assertTrue(result.plus,
                        "the Plus button is there even though we priced it")
        self.assertIsNotNone(result.fields[0])

    def test_the_plus_flag_is_cached_alongside_the_price(self):
        # A second pass must not re-ask for either fact: the Plus flag has its
        # own cache entry because the price entry is a tuple or one of two
        # markers, and none of those has room for it.
        with mock.patch.object(psn_prices, "requests") as rq:
            rq.post.return_value = _Resp(_priced_with_plus())
            fields, not_sold, plus_ids, failed, limited = psn_prices._request_all(
                ["10007176"], "en-US", "USD")
        self.assertIn("10007176", plus_ids)
        self.assertIn("plus:en-US:10007176", psn_prices._price_cache,
                      "the flag rides its own cache entry")
        with mock.patch.object(psn_prices, "requests") as rq:
            rq.post.side_effect = AssertionError("the cache must answer alone")
            fields2, not_sold2, plus_ids2, failed2, limited2 = psn_prices._request_all(
                ["10007176"], "en-US", "USD")
        self.assertIn("10007176", plus_ids2, "the Plus flag survived the cache")
        self.assertFalse(failed2)

    def test_not_sold_survives_the_cache_and_stays_distinct_from_a_miss(self):
        _fetch(_delisted())
        psn_prices._price_cache.pop("en-US:10007176", None)
        psn_prices._price_cache["en-US:10007176"] = (psn_prices._NOT_SOLD, 2 ** 60)
        with mock.patch.object(psn_prices, "requests") as rq:
            rq.post.side_effect = AssertionError("the cache must answer alone")
            fields, not_sold, plus_ids, failed, limited = psn_prices._request_all(
                ["10007176"], "en-US", "USD")
        self.assertIn("10007176", not_sold)
        self.assertNotIn("10007176", fields)
        self.assertFalse(failed)

    def test_the_response_defaults_both_maps_when_there_is_nothing_to_ask(self):
        # No locale means no request at all: the shape must still be the shape.
        body = json.loads(json.dumps({"games": [GAME], "currency": "ZZZ"}))
        fake = mock.MagicMock()
        fake.path = "/api/psn_prices"
        fake.headers = {"Content-Length": str(len(json.dumps(body).encode()))}
        fake.rfile = io.BytesIO(json.dumps(body).encode())
        with mock.patch.object(psn_prices, "requests") as rq, \
                mock.patch.object(psn_prices, "send_json") as sj:
            psn_prices.handler.do_POST(fake)
            payload = sj.call_args.args[2]
        self.assertEqual(payload["notSold"], {})
        self.assertEqual(payload["plusIncluded"], {})
        self.assertEqual(payload["reason"], "no_region")
        rq.post.assert_not_called()


def _no_default_product():
    """Death Stranding's real answer in en-ZA: defaultProduct is NULL, the PS5
    Director's Cut is on sale, the PS4 original is Plus-only and the PS4
    Deluxe is the only PS4 thing you can actually buy."""
    return {"data": {"conceptRetrieve": {
        "defaultProduct": None,
        "selectableProducts": {"purchasableProducts": [
            {"name": "DEATH STRANDING DIRECTOR’S CUT", "platforms": ["PS5"],
             "media": [{"role": "PORTRAIT_BANNER", "url": "https://img/dc.png"}],
             "mobilectas": [
                 {"meta": {"upSellService": "PS_PLUS"},
                  "price": {"basePriceValue": 94900, "discountedValue": 0,
                            "currencyCode": "ZAR", "isFree": True}},
                 {"meta": {"upSellService": "NONE"},
                  "price": {"basePriceValue": 94900, "discountedValue": 37960,
                            "currencyCode": "ZAR", "isFree": False}}]},
            {"name": "DEATH STRANDING", "platforms": ["PS4"],
             "media": [{"role": "PORTRAIT_BANNER", "url": "https://img/ds.png"}],
             "mobilectas": [
                 {"meta": {"upSellService": "PS_PLUS"},
                  "price": {"basePriceValue": 114900, "discountedValue": 0,
                            "currencyCode": "ZAR", "isFree": True}}]},
            {"name": "DEATH STRANDING Digital Deluxe Edition",
             "platforms": ["PS4"],
             "mobilectas": [
                 {"meta": {"upSellService": "NONE"},
                  "price": {"basePriceValue": 94900, "discountedValue": 94900,
                            "currencyCode": "ZAR", "isFree": False}}]},
        ]},
    }}}


class TestNoDefaultProduct(unittest.TestCase):
    """The reader must not stop at defaultProduct: it is NULL for concepts the
    store sells through a specific product, and two purchase buttons were
    sitting one level down while Death Stranding read Unpriced."""

    def setUp(self):
        psn_prices._price_cache.clear()

    @staticmethod
    def _fetch(payload, console):
        with mock.patch.object(psn_prices, "requests") as rq:
            rq.post.return_value = _Resp(payload)
            return psn_prices._fetch_concept(("234585", "en-ZA", "ZAR", console))

    def test_a_ps4_row_is_priced_from_a_ps4_product(self):
        result = self._fetch(_no_default_product(), "PS4")
        self.assertEqual(result.status, psn_prices._Fetch.OK)
        # The PS4 Deluxe (94900), not the PS5 Director's Cut that is listed
        # first and on sale -- the row owns a PS4 title.
        self.assertEqual(result.fields[0], 949.0)

    def test_a_ps5_row_is_priced_from_the_directors_cut(self):
        result = self._fetch(_no_default_product(), "PS5")
        self.assertEqual(result.status, psn_prices._Fetch.OK)
        self.assertEqual(result.fields[0], 379.60, "the Director's Cut is on sale")

    def test_the_plus_flag_comes_from_a_product_not_the_default(self):
        # defaultProduct is NULL here, and the Plus button lives on the
        # products -- reading only the default would lose the chip too.
        result = self._fetch(_no_default_product(), "PS4")
        self.assertTrue(result.plus)

    def test_concepts_without_a_console_keep_the_old_cache_key(self):
        # A row with no derivable console must not be written under a key that
        # includes "None", or it would never be found again.
        with mock.patch.object(psn_prices, "requests") as rq:
            rq.post.return_value = _Resp(_no_default_product())
            psn_prices._request_all(["234585"], "en-ZA", "ZAR")
        self.assertIn("en-ZA:234585", psn_prices._price_cache)
        self.assertNotIn("en-ZA:None:234585", psn_prices._price_cache)


class TestHandlerFansOut(unittest.TestCase):
    """One concept backs several rows: both facts fan out to each of them."""

    def setUp(self):
        psn_prices._price_cache.clear()

    def test_a_delisted_concept_marks_every_row_that_shares_it(self):
        rows = [dict(GAME), {"id": "PSN:OTHER", "titleId": "X", "conceptId": 10007176}]
        body = json.dumps({"games": rows, "currency": "USD"}).encode()
        fake = mock.MagicMock()
        fake.path = "/api/psn_prices"
        fake.headers = {"Content-Length": str(len(body))}
        fake.rfile = io.BytesIO(body)
        with mock.patch.object(psn_prices, "requests") as rq, \
                mock.patch.object(psn_prices, "send_json") as sj:
            rq.post.return_value = _Resp(_delisted())
            psn_prices.handler.do_POST(fake)
            payload = sj.call_args.args[2]
        self.assertEqual(payload["notSold"],
                         {"PSN:PPSA00001_00": True, "PSN:OTHER": True})
        self.assertIsNone(payload["prices"]["PSN:PPSA00001_00"])
        self.assertEqual(payload["plusIncluded"], {},
                         "a delisted concept has no Plus button to report")

    def test_a_priced_plus_concept_reports_plus_but_not_not_sold(self):
        body = json.dumps({"games": [GAME], "currency": "USD"}).encode()
        fake = mock.MagicMock()
        fake.path = "/api/psn_prices"
        fake.headers = {"Content-Length": str(len(body))}
        fake.rfile = io.BytesIO(body)
        with mock.patch.object(psn_prices, "requests") as rq, \
                mock.patch.object(psn_prices, "send_json") as sj:
            rq.post.return_value = _Resp(_priced_with_plus())
            psn_prices.handler.do_POST(fake)
            payload = sj.call_args.args[2]
        self.assertEqual(payload["plusIncluded"], {"PSN:PPSA00001_00": True})
        self.assertEqual(payload["notSold"], {})
        self.assertEqual(payload["prices"]["PSN:PPSA00001_00"], 69.99)


if __name__ == "__main__":
    unittest.main()
