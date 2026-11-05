"""Contract tests for /api/ps_plus_price.

It prices exactly one plan -- PlayStation Plus Essential, one month (concept
10004507) -- because it is the only subscription Sony's public store schema will
price at all: the 3- and 12-month plans are product-only ids with no concept
page, and productRetrieve is refused outright. So most of what is asserted here
is the failure shape. A missing price has to arrive as a reason the client can
hide behind, never as a 500 and never as a zero, because a zero would be a
claim the store did not make.

All upstream HTTP is mocked; no network access.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import ps_plus_price  # noqa: E402
import psn_prices      # noqa: E402


class FakeHandler:
    def __init__(self, path="/api/ps_plus_price?currency=ZAR"):
        self.path = path
        self._out = None


class Resp:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def payload(base=14900, discounted=None, present=True):
    """A metGetPricingDataByConceptId answer shaped like the store's own."""
    if not present:
        return {"data": {"conceptRetrieve": None}}
    return {"data": {"conceptRetrieve": {"defaultProduct": {
        "id": "IP9102-PPSA06902_00-PLUS1T01M0000000",
        "price": {"basePriceValue": base,
                  "discountedValue": base if discounted is None else discounted,
                  "currencyCode": "ZAR"},
    }}}}          # ^ the product id is the evidence for tier and term in LABEL


class TestPsPlusPrice(unittest.TestCase):
    def setUp(self):
        # The price cache is shared with psn_prices and keyed per locale: an
        # answer left behind by one test would silently pass the next one.
        psn_prices._price_cache.clear()

    @staticmethod
    def _run(rq, path="/api/ps_plus_price?currency=ZAR"):
        handler = FakeHandler(path)
        with mock.patch.object(ps_plus_price, "requests", rq), \
                mock.patch.object(ps_plus_price, "send_json") as send:
            send.side_effect = lambda h, status, data: setattr(h, "_out", (status, data))
            ps_plus_price.handler.do_GET(handler)
        return handler._out          # (status, body) -- rq stays with the caller

    @staticmethod
    def _rq(resp):
        rq = mock.MagicMock()
        rq.RequestException = Exception
        rq.post.return_value = resp
        return rq

    def test_quotes_the_plan_in_the_callers_currency(self):
        status, body = self._run(self._rq(Resp(payload())))
        self.assertEqual(status, 200)
        self.assertEqual(body["price"], 149.0)
        self.assertIsNone(body["was"])
        self.assertIs(body["promo"], False)
        self.assertEqual(body["currency"], "ZAR")
        self.assertEqual(body["region"], "en-ZA")
        self.assertIsNone(body["reason"])

    def test_the_label_names_the_tier_and_the_term(self):
        """An unlabelled price would read as any plan, and there are three."""
        _, body = self._run(self._rq(Resp(payload())))
        self.assertIn("Essential", body["label"])
        self.assertIn("1 month", body["label"])
        self.assertEqual(body["plan"], {"tier": "Essential", "months": 1})

    def test_a_sale_is_reported_as_a_sale(self):
        status, body = self._run(self._rq(Resp(payload(base=37900, discounted=18950))))
        self.assertEqual(status, 200)
        self.assertEqual(body["price"], 189.5)
        self.assertEqual(body["was"], 379.0)
        self.assertIs(body["promo"], True)

    def test_a_currency_with_no_store_is_refused_without_asking_sony(self):
        rq = self._rq(Resp(payload()))
        status, body = self._run(rq, path="/api/ps_plus_price?currency=XYZ")
        self.assertEqual(status, 200)
        self.assertEqual(body["reason"], "no_region")
        self.assertIsNone(body["price"])
        rq.post.assert_not_called()

    def test_a_retired_concept_reads_as_no_plan_not_as_zero(self):
        status, body = self._run(self._rq(Resp(payload(present=False))))
        self.assertEqual(status, 200)
        self.assertEqual(body["reason"], "no_plan")
        self.assertIsNone(body["price"])

    def test_a_refusal_is_a_reason_the_client_can_hide_behind(self):
        for rq in (self._rq(Resp({}, status=500)),
                   self._rq(Resp(ValueError("no body"))),
                   self._rq(Resp({"errors": [{"message": "hash rotated"}]}))):
            status, body = self._run(rq)
            self.assertEqual(status, 200, "never a 500: the KPI hides a reason")
            self.assertEqual(body["reason"], "store_error")
            self.assertIsNone(body["price"])

    def test_the_price_is_cached_so_a_scan_asks_once(self):
        rq = self._rq(Resp(payload()))
        self._run(rq)
        self._run(rq)
        self.assertEqual(rq.post.call_count, 1)

    def test_the_call_carries_the_store_locale_and_no_credential(self):
        rq = self._rq(Resp(payload()))
        self._run(rq)
        headers = rq.post.call_args.kwargs["headers"]
        self.assertEqual(headers["x-psn-store-locale-override"], "en-ZA")
        self.assertNotIn("Authorization", headers)


if __name__ == "__main__":
    unittest.main()
