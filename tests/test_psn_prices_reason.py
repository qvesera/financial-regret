"""`reason` on /api/psn_prices: an empty answer must say why it is empty.

PlayStation pricing takes no key now -- it reads Sony's public storefront --
which makes the old "no key" answer impossible and leaves three causes worth
telling apart: this display currency has no store, the store did not answer, or
the store carries none of these titles. Reporting all three as a bare "empty"
is what sends a visitor hunting for a configuration step that no longer exists.

The PlayStation Plus trap is pinned here too: one concept answers with both a
Plus catalog button ("Included", free) and the real purchase button, and taking
the wrong one prices an entire library at zero.
"""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import psn_prices

GAME = {"id": "PSN:PPSA20622_00", "titleId": "PPSA20622_00", "conceptId": 10026204}


def _req(games=(GAME,), currency="INR"):
    body = json.dumps({"games": list(games), "currency": currency}).encode()
    fake = mock.MagicMock()
    fake.path = "/api/psn_prices"
    fake.headers = {"Content-Length": str(len(body))}
    fake.rfile = io.BytesIO(body)
    return fake


class _Resp:
    """The slice of `requests` the handler actually reads."""

    def __init__(self, payload, status=200):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


def _priced(base=5999, sale=4999, ccy="INR"):
    """A real concept answer: a PlayStation Plus button and the purchase one."""
    return {"data": {"conceptRetrieve": {"defaultProduct": {"mobilectas": [
        {"meta": {"upSellService": "PS_PLUS"},
         "price": {"basePrice": "Included", "basePriceValue": base,
                   "discountedPrice": "Included", "discountedValue": 0,
                   "currencyCode": ccy, "isFree": True,
                   "isTiedToSubscription": True}},
        {"meta": {"upSellService": "NONE"},
         "price": {"basePrice": "Rs 5,999", "basePriceValue": base,
                   "discountedPrice": "Rs 4,999", "discountedValue": sale,
                   "currencyCode": ccy, "isFree": False,
                   "isTiedToSubscription": False}},
    ]}}}}


def _plus_only():
    """Only the Plus catalog button -- no purchasable offer at all."""
    return {"data": {"conceptRetrieve": {"defaultProduct": {"mobilectas": [
        {"meta": {"upSellService": "PS_PLUS"},
         "price": {"basePrice": "Included", "basePriceValue": 5999,
                   "discountedPrice": "Included", "discountedValue": 0,
                   "currencyCode": "INR", "isFree": True,
                   "isTiedToSubscription": True}},
    ]}}}}


def _no_product():
    """A concept this store does not sell: data present, product absent."""
    return {"data": {"conceptRetrieve": {"id": 10026204}}}


class TestReason(unittest.TestCase):
    def setUp(self):
        psn_prices._price_cache.clear()
        self.post = mock.MagicMock()
        self.post.RequestException = Exception

    def _run(self, fake, post=None):
        with mock.patch.object(psn_prices, "requests", post or self.post), \
                mock.patch.object(psn_prices, "send_json") as sj:
            sj.side_effect = lambda h, status, data: setattr(
                h, "_out", (status, data))
            psn_prices.handler.do_POST(fake)
        return getattr(fake, "_out")

    def _answer(self, response, games=(GAME,), currency="INR"):
        """One fixed response for every concept request this test makes."""
        self.post.post.side_effect = lambda *a, **k: response
        return self._run(_req(games, currency))

    def test_no_key_is_ever_asked_for(self):
        # The whole point of the change: there is no credential to bring and
        # none is read off the request.
        status, payload = self._answer(_Resp(_priced()))
        self.assertEqual(status, 200)
        self.assertEqual(payload["prices"]["PSN:PPSA20622_00"], 4999.0,
                         "whole-rupee region: no blind /100")
        self.assertIsNone(payload["reason"])
        self.assertEqual(payload["limited"], {}, "nothing spent, nothing refused")
        self.assertIsNone(payload["attribution"])

        headers = self.post.post.call_args.kwargs["headers"]
        self.assertEqual(headers["x-psn-store-locale-override"], "en-IN")
        for banned in ("Authorization", "X-API-Key", "X-Platprices-Key"):
            self.assertNotIn(banned, headers, "no credential reaches Sony")

    def test_a_currency_with_no_store_says_so(self):
        # XAF is a real ISO code the PlayStation Store does not serve: quoting
        # somebody else's region would read as fact on every verdict.
        status, payload = self._run(_req(currency="XAF"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_region")
        self.assertIsNone(payload["region"])
        self.post.post.assert_not_called()

    def test_dead_upstream_is_not_blamed_on_the_store(self):
        status, payload = self._answer(_Resp({}, status=500))
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "upstream_failed")
        self.assertIsNone(payload["attribution"], "no data, no credit claimed")

    def test_a_clean_answer_with_no_matches_is_not_an_error(self):
        status, payload = self._answer(_Resp(_no_product()))
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_match")
        self.assertEqual(payload["limited"], {})
        self.assertTrue(all(v is None for v in payload["prices"].values()),
                        "unpriced, not failed")

    def test_the_plus_catalog_button_is_never_taken_for_a_price(self):
        # Taking upSellService PS_PLUS prices every game free: it answers
        # "Included", isFree true, discountedValue 0.
        status, payload = self._answer(_Resp(_plus_only()))
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_match")
        self.assertIsNone(payload["prices"]["PSN:PPSA20622_00"])

    def test_a_refused_burst_says_so_as_a_rate_limit(self):
        status, payload = self._answer(_Resp({}, status=429))
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "rate_limited",
                         "a refusal outranks 'the store has no such game'")

    def test_a_sale_price_wins_and_the_list_price_is_the_high(self):
        # USD is a hundredths region: 2999 is $29.99, not two thousand nine
        # hundred ninety-nine dollars -- the scale is per currency, not per 100
        # everywhere (INR in the test above is whole units).
        status, payload = self._answer(_Resp(_priced(base=5999, sale=2999,
                                                     ccy="USD")),
                                       currency="USD")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["reason"])
        self.assertEqual(payload["prices"]["PSN:PPSA20622_00"], 29.99)
        self.assertEqual(payload["highs"]["PSN:PPSA20622_00"], 59.99)
        self.assertIsNone(payload["lows"]["PSN:PPSA20622_00"],
                          "the store keeps no history; the KPI falls back")
        self.assertEqual(payload["resolved"]["PSN:PPSA20622_00"], "10026204")

    def test_rows_without_a_concept_never_reach_the_store(self):
        conceptless = {"id": "PSN:PPSA00142_00", "titleId": "PPSA00142_00",
                       "conceptId": None}
        status, payload = self._run(_req(games=(conceptless,)))
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_match")
        self.post.post.assert_not_called()

    def test_one_concept_can_price_several_rows(self):
        ps4 = {"id": "PSN:PPSA20622_00", "titleId": "PPSA20622_00",
               "conceptId": 10026204}
        ps5 = {"id": "PSN:PPSA20623_00", "titleId": "PPSA20623_00",
               "conceptId": 10026204}
        status, payload = self._answer(_Resp(_priced()), games=(ps4, ps5))
        self.assertEqual(status, 200)
        self.assertEqual(self.post.post.call_count, 1,
                         "a concept shared by both editions is bought once")
        self.assertEqual(payload["prices"]["PSN:PPSA20623_00"], 4999.0)

    def test_a_second_scan_spends_nothing(self):
        self._answer(_Resp(_priced()))
        self.post.post.reset_mock()
        status, payload = self._run(_req())
        self.assertEqual(status, 200)
        self.assertEqual(self.post.post.call_count, 0, "the 24-hour cache held")
        self.assertEqual(payload["prices"]["PSN:PPSA20622_00"], 4999.0)


class TestRequestAll(unittest.TestCase):
    """A store miss, a dead upstream and a refusal are three different answers,
    and collapsing them into one is what sends visitors hunting for a key."""

    def setUp(self):
        psn_prices._price_cache.clear()

    @staticmethod
    def _request(rq):
        """Run one concept lookup against a stubbed `requests`.

        The patch is not optional: `_request_all` reaches the module global
        directly, and leaving it alone turns every one of these tests into a
        live call to Sony's storefront that happens to pass on the author's
        machine and fails anywhere else.
        """
        with mock.patch.object(psn_prices, "requests", rq):
            return psn_prices._request_all(["10026204"], "en-IN", "INR")

    @staticmethod
    def _rq():
        rq = mock.MagicMock()
        rq.RequestException = Exception
        return rq

    def test_failure_is_reported_not_swallowed(self):
        rq = self._rq()
        rq.post.side_effect = rq.RequestException("boom")
        fields, _not_sold, _plus, failed, limited = self._request(rq)
        self.assertEqual(fields, {})
        self.assertTrue(failed)
        self.assertFalse(limited, "a dead upstream is not a spent burst")

    def test_a_clean_answer_is_not_a_failure(self):
        rq = self._rq()
        rq.post.side_effect = lambda *a, **k: _Resp(_priced())
        fields, _not_sold, _plus, failed, limited = self._request(rq)
        self.assertEqual(fields["10026204"], (4999.0, 5999.0, None))
        self.assertFalse(failed)
        self.assertFalse(limited)

    def test_a_refusal_is_reported_on_its_own(self):
        rq = self._rq()
        rq.post.side_effect = lambda *a, **k: _Resp({}, status=429)
        fields, _not_sold, _plus, failed, limited = self._request(rq)
        self.assertEqual(fields, {})
        self.assertFalse(failed, "a refusal is not a dead upstream")
        self.assertTrue(limited)

    def test_an_answer_without_a_purchase_is_cached_as_a_miss(self):
        rq = self._rq()
        rq.post.side_effect = lambda *a, **k: _Resp(_no_product())
        self._request(rq)
        self.assertEqual(rq.post.call_count, 1)
        # Negative caching matters more than positive: the store will never
        # carry this title, and re-asking about it every scan is pure cost.
        self._request(rq)
        self.assertEqual(rq.post.call_count, 1, "a miss is remembered")


if __name__ == "__main__":
    unittest.main()


