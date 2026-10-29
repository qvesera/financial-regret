"""`reason` on /api/psn_prices: an empty answer must say why it is empty.

PlayStation pricing is optional -- rows simply render Unpriced -- but "empty"
used to cover four unrelated situations: no key reached the server, the key's
region allowlist excludes this store, the API did not answer, and the store
genuinely carries none of these titles. Users could not tell a configuration
problem from a real answer, and went hunting through code for a key that had
been missing all along.
"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

import psn_prices

GAME = {"id": "PSN:PPSA20622_00", "titleId": "PPSA20622_00"}


def _req(games=(GAME,), currency="INR", with_key=True):
    body = json.dumps({"games": list(games), "currency": currency}).encode()
    fake = mock.MagicMock()
    fake.path = "/api/psn_prices"
    fake.headers = {"Content-Length": str(len(body))}
    if with_key:
        fake.headers["X-Platprices-Key"] = "KEY"
    fake.rfile = io.BytesIO(body)
    return fake


def _resp(payload, status=200):
    r = mock.MagicMock()
    r.status_code = status
    r.json.return_value = payload
    return r


class TestReason(unittest.TestCase):
    def setUp(self):
        psn_prices._price_cache.clear()

    @staticmethod
    def _run(fake, responses, server_key="SERVERKEY"):
        env = {"PLATPRICES_API_KEY": server_key}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(psn_prices, "requests") as rq, \
                mock.patch.object(psn_prices, "send_json") as sj:
            rq.get.side_effect = list(responses)
            rq.RequestException = Exception
            psn_prices.handler.do_POST(fake)
        return sj.call_args.args[1], sj.call_args.args[2]

    def test_no_key_says_so(self):
        # Neither the caller nor the server supplies one -- the exact state a
        # public deployment with REQUIRE_USER_KEYS=1 and no saved key is in.
        status, payload = self._run(_req(with_key=False), [], server_key="")
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_key")
        self.assertIsNone(payload["attribution"])

    def test_a_currency_with_no_store_says_so(self):
        # CNY has no PlatPrices store, so there is nothing a key could do.
        status, payload = self._run(_req(currency="CNY"), [])
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_region")
        self.assertIsNone(payload["region"])

    def test_dead_upstream_is_not_blamed_on_the_store(self):
        status, payload = self._run(_req(), [_resp({}, status=500)])
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "upstream_failed")
        self.assertIsNone(payload["attribution"], "no data came back, so no credit is claimed")

    def test_a_clean_answer_with_no_matches_is_not_an_error(self):
        data = {"success": True, "data": [{"GameID": "SOMEOTHER", "NpTitleId": "OTHER_00"}]}
        status, payload = self._run(_req(), [_resp(data)])
        self.assertEqual(status, 200)
        self.assertEqual(payload["reason"], "no_match")
        self.assertEqual(payload["attribution"], psn_prices.ATTRIBUTION)

    def test_a_priced_batch_reports_no_reason(self):
        data = {"success": True, "data": [{
            "GameID": "PPSA20622", "NpTitleId": "PPSA20622_00",
            "SalePrice": 3999, "BasePrice": 3999,
        }]}
        status, payload = self._run(_req(), [_resp(data)])
        self.assertEqual(status, 200)
        self.assertIsNone(payload["reason"])
        self.assertEqual(payload["prices"]["PSN:PPSA20622_00"], 39.99)


class TestRequestAll(unittest.TestCase):
    def test_failure_is_reported_not_swallowed(self):
        with mock.patch.object(psn_prices, "_request_batch", return_value=None):
            items, failed = psn_prices._request_all("k", ["A_00"], "in")
        self.assertEqual(items, [])
        self.assertTrue(failed)

    def test_a_clean_answer_is_not_a_failure(self):
        with mock.patch.object(psn_prices, "_request_batch",
                               return_value=[{"GameID": "A"}]):
            items, failed = psn_prices._request_all("k", ["A_00"], "in")
        self.assertEqual(len(items), 1)
        self.assertFalse(failed)


if __name__ == "__main__":
    unittest.main()
