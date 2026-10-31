"""The PlayStation contract: an online ID goes out, a public list comes back,
and no route here ever accepts a PSN credential.

The endpoint is a two-part promise. Part one is functional: given a valid
online ID it reads the profile's playtime and maps it to the row shape the
rest of the app (and PlatPrices' title-id join) already expects. Part two is
the reason a data provider approved this project: the exchange route that
used to take a visitor's NPSSO is gone, and the module left behind cannot
become a route by accident.
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
            "platform": "PlayStation", "titleId": "PPSA00142_00", "hours": 5.2,
        }])
        self.assertNotIn("reason", body, "a non-empty answer needs no excuse")

        first, second = rq.get.call_args_list
        # The profile read is public: no Authorization header at all, which is
        # also what keeps the reader account's quota for the playtime itself.
        self.assertNotIn("Authorization", first.kwargs.get("headers", {}))
        self.assertIn("profile2", first.args[0])
        self.assertIn("2736737651100659016", second.args[0], "gamelist by account id")
        self.assertIn("Bearer tok", second.kwargs["headers"]["Authorization"])

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
    """The promise a PlatPrices key was approved on."""

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


if __name__ == "__main__":
    unittest.main()