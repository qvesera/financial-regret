"""The PlayStation contract: an online ID goes out, a public list comes back,
and no route here ever accepts a PSN credential.

The endpoint is a two-part promise. Part one is functional: given a valid
online ID it reads the profile's playtime and maps it to the row shape the
rest of the app (and the store's concept-id price join) already expects. Part
two is why a data provider declined to be connected to this project while it
held a credential: the exchange route that used to take a visitor's NPSSO is
gone, and the module left behind cannot become a route by accident.
"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import psn_games  # noqa: E402
import _psn_auth  # noqa: E402


class FakeHandler:
    """Stands in for the BaseHTTPRequestHandler: only path and headers are read."""

    def __init__(self, path="/api/psn_games?onlineId=SomePlayer_91"):
        self.path = path
        self.headers = {}          # no X-PSN-* anything: nothing is required
        self.wfile = io.BytesIO()
        self._response_sent = False


class Resp:
    def __init__(self, status=200, data=None, text=""):
        self.status_code = status
        self._data = data or {}
        self.text = text or json.dumps(self._data)

    def json(self):
        return self._data


PROFILE = {"profile": {"onlineId": "SomePlayer_91", "accountId": "2736737651100659016"}}
PAGE = {"titles": [{"name": "Astro Bot", "titleId": "PPSA00142_00",
                    "playDuration": "PT5H12M"}],
        "totalItemCount": 1, "nextOffset": None}
# The same entry with the store's concept object the gamelist documents beside
# titleId -- the id psn_prices.py joins on, so it has to survive the round trip.
PAGE_WITH_CONCEPT = {
    "titles": [{"name": "Astro Bot", "titleId": "PPSA00142_00",
                "playDuration": "PT5H12M",
                "concept": {"id": 10010174, "titleIds": ["PPSA00142_00"],
                            "name": "Astro Bot"}}],
    "totalItemCount": 1, "nextOffset": None}


class TestPsnGames(unittest.TestCase):
    def setUp(self):
        # Reset to the module's initial shape rather than clearing it: this is
        # a cache with fixed keys, and _access_token reads it by key.
        psn_games._token_cache.update(
            {"access": None, "refresh": None, "expires_at": 0.0})
        self.env = mock.patch.dict(os.environ, {"PSN_REFRESH_TOKEN": "refresh-1"})
        self.env.start()
        self.addCleanup(self.env.stop)

    @staticmethod
    def _run(rq, path="/api/psn_games?onlineId=SomePlayer_91"):
        """Run the handler with `requests` mocked; returns (status, body)."""
        handler = FakeHandler(path)
        with mock.patch.object(psn_games, "requests", rq), \
                mock.patch.object(psn_games, "send_json") as send, \
                mock.patch.object(psn_games, "refresh_tokens",
                                  return_value={"access_token": "tok",
                                                "expires_in": 3600}):
            send.side_effect = lambda h, status, data: setattr(
                h, "_out", (status, data))
            psn_games.handler.do_GET(handler)
        return handler._out

    @staticmethod
    def _rq(*responses):
        rq = mock.MagicMock()
        rq.RequestException = Exception
        rq.get.side_effect = list(responses)
        return rq

    def test_public_profile_is_asked_without_a_token_then_gamelist_with_one(self):
        rq = self._rq(Resp(data=PROFILE), Resp(data=PAGE))
        status, body = self._run(rq)

        self.assertEqual(status, 200)
        self.assertEqual(body["games"], [{
            "id": "PSN:PPSA00142_00", "name": "Astro Bot",
            "platform": "PlayStation", "titleId": "PPSA00142_00",
            "console": "PS5",
            "conceptId": None, "hours": 5.2,
        }])
        self.assertNotIn("reason", body, "a non-empty answer needs no excuse")

        first, second = rq.get.call_args_list
        # The profile read is public: no Authorization header at all, which is
        # also what keeps the reader account's quota for the playtime itself.
        self.assertNotIn("Authorization", first.kwargs.get("headers", {}))
        self.assertIn("profile2", first.args[0])
        self.assertIn("2736737651100659016", second.args[0], "gamelist by account id")
        self.assertIn("Bearer tok", second.kwargs["headers"]["Authorization"])

    def test_the_console_is_read_off_the_title_id(self):
        """PS4 vs PS5 comes from Sony's own id shape -- PPSA is PS5, CUSA is
        PS4 -- and anything else answers None so the console filter only ever
        offers what the scan actually knows."""
        self.assertEqual(psn_games._console("PPSA00142_00"), "PS5")
        self.assertEqual(psn_games._console("CUSA00207"), "PS4")
        self.assertEqual(psn_games._console("ppsa00001_00"), "PS5",
                         "the prefix is case-insensitive")
        for junk in (None, "", "  ", 123, "NPNA00001", "PCSE00001",
                     "PLAYSTATION4", "unknown"):
            self.assertIsNone(psn_games._console(junk), f"{junk!r} must stay unknown")

    def test_a_malformed_online_id_never_reaches_sony(self):
        # %20 decodes to a space before validation, which is legal -- the
        # values below are malformed after decoding: punctuation outside the
        # charset, over-length, a path walk and nothing at all.
        for bad in ("..%2F..%2Fetc%2Fpasswd", "x" * 17, "not!an!id", ""):
            rq = self._rq()
            status, body = self._run(rq, f"/api/psn_games?onlineId={bad}")
            self.assertEqual(status, 400, bad)
            self.assertIn("onlineId", body["error"])
            rq.get.assert_not_called()

    def test_an_unconfigured_server_says_what_is_missing(self):
        with mock.patch.dict(os.environ, {"PSN_REFRESH_TOKEN": ""}):
            rq = self._rq()
            status, body = self._run(rq)
        self.assertEqual(status, 503)
        self.assertEqual(body["reason"], "no_token")
        rq.get.assert_not_called()

    def test_a_profile_that_does_not_exist_is_a_404_not_an_outage(self):
        rq = self._rq(Resp(status=404, text='{"error":{"message":"Not Found"}}'))
        status, body = self._run(rq)
        self.assertEqual(status, 404)
        self.assertEqual(body["reason"], "not_found")

    def test_an_empty_list_reports_empty_so_the_privacy_switch_can_be_named(self):
        # 200 with nothing behind it: either nothing was played, or the profile
        # hides "Who can see your gaming history". The browser must be able to
        # tell that apart from an outage.
        rq = self._rq(Resp(data=PROFILE),
                      Resp(data={"titles": [], "totalItemCount": 0}))
        status, body = self._run(rq)
        self.assertEqual(status, 200)
        self.assertEqual(body["games"], [])
        self.assertEqual(body["reason"], "empty")

    def test_a_refused_gamelist_is_not_reported_as_an_empty_library(self):
        # Refusing us while a privacy switch points elsewhere would send the
        # visitor hunting for a setting that is not the problem.
        rq = self._rq(Resp(data=PROFILE), Resp(status=403, text="forbidden"))
        status, body = self._run(rq)
        self.assertEqual(status, 502)
        self.assertEqual(body["reason"], "upstream_failed")


class TestNoVisitorCredentialRoute(unittest.TestCase):
    """The promise the credential-free design rests on."""

    def test_the_npsso_exchange_route_is_gone(self):
        self.assertFalse(
            (ROOT / "backend" / "psn_exchange.py").exists(),
            "the route that accepted a visitor's PSN session is back in the tree",
        )

    def test_the_auth_module_cannot_become_a_route(self):
        # api/index.py only serves modules exposing `class handler`; _psn_auth
        # holds the two hops and nothing else, and its leading underscore fails
        # the route-name regex, so it answers 404 like every private module.
        self.assertFalse(hasattr(_psn_auth, "handler"))
        self.assertTrue("_psn_auth.py" in str(_psn_auth.__file__))

    def test_the_handler_reads_no_psn_header(self):
        """psn_games must never consult X-PSN-* -- the moment it does, a visitor
        is handing us something again."""
        source = (ROOT / "backend" / "psn_games.py").read_text()
        self.assertNotIn("X-PSN-", source)


class TestConceptPassthrough(unittest.TestCase):
    """psn_prices.py prices on the store's concept id, so the gamelist has to
    carry it -- and has to carry nothing harmful when it does not arrive."""

    @staticmethod
    def _run_page(page):
        handler = FakeHandler("/api/psn_games?onlineId=SomePlayer_91")
        rq = mock.MagicMock()
        rq.RequestException = Exception
        rq.get.side_effect = [Resp(data=PROFILE), Resp(data=page)]
        env = mock.patch.dict(os.environ, {"PSN_REFRESH_TOKEN": "refresh-1"})
        env.start()
        try:
            with mock.patch.object(psn_games, "requests", rq), \
                    mock.patch.object(psn_games, "send_json") as send, \
                    mock.patch.object(psn_games, "refresh_tokens",
                                      return_value={"access_token": "tok",
                                                    "expires_in": 3600}):
                send.side_effect = lambda h, status, data: setattr(
                    h, "_out", (status, data))
                psn_games.handler.do_GET(handler)
        finally:
            env.stop()
        return handler._out

    def test_the_concept_id_reaches_the_client(self):
        status, body = self._run_page(PAGE_WITH_CONCEPT)
        self.assertEqual(status, 200)
        self.assertEqual(body["games"][0]["conceptId"], 10010174,
                         "the price join key must survive the gamelist round trip")

    def test_a_row_without_a_concept_still_reads(self):
        status, body = self._run_page(PAGE)
        self.assertEqual(status, 200)
        self.assertEqual(body["games"][0]["conceptId"], None,
                         "an absent concept stays Unpriced, not a failed scan")

    def test_only_a_positive_integer_concept_counts(self):
        self.assertEqual(psn_games._concept_id({"concept": {"id": 10009763}}),
                         10009763)
        # Sony ships ids as numbers, but every hop in between is JSON, so a
        # numeric string is equally good -- padding included, since the value
        # arrives from JSON headers and forms that tolerate whitespace.
        self.assertEqual(psn_games._concept_id({"concept": {"id": "10009763"}}),
                         10009763)
        self.assertEqual(psn_games._concept_id({"concept": {"id": " 10009763 "}}),
                         10009763)

    def test_junk_never_becomes_a_concept_id(self):
        for concept in (None, "", 0, -1, True, "0", "12abc", "concept-id",
                        "string", [], {}, {"id": None}, {"id": True},
                        {"id": []}, {"id": -5}, {"id": "10 00"}):
            self.assertIsNone(psn_games._concept_id({"concept": concept}),
                              f"junk accepted: {concept!r}")

    def test_a_title_without_the_key_at_all_is_none(self):
        self.assertIsNone(psn_games._concept_id({"titleId": "PPSA00142_00"}))


if __name__ == "__main__":
    unittest.main()