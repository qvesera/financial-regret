"""/api/steam_verify sits on a trust boundary: whoever it names becomes the
visitor's linked Steam library.

The signature check with Steam only proves *somebody* logged into Steam -- it
says nothing about who was being redirected where. OpenID 2.0's answer is the
return_to check: the assertion must be one this deployment asked for, on this
deployment's origin. Without it, an attacker takes an assertion for their own
account and replays it into a victim's browser callback, and the victim's
library becomes the attacker's (and the shared key spends itself on it).
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

import requests  # noqa: E402
import steam_verify  # noqa: E402


class StubHandler:
    def __init__(self, query, host="app.example"):
        self.path = f"/api/steam_verify?{query}"
        self.headers = {"Host": host}
        self.sent = []
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, name, value):
        self.sent.append((name, value))

    def end_headers(self):
        pass


def _query(**extra):
    base = {"openid.mode": "id_res"}
    base.update(extra)
    return "&".join(f"{k}={v}" for k, v in base.items())


def _call(query, env=None, host="app.example", post=None):
    with mock.patch.dict(os.environ, env or {}, clear=False):
        h = StubHandler(query, host)
        with mock.patch.object(steam_verify.requests, "post",
                               post or mock.MagicMock()):
            steam_verify.handler.do_GET(h)
    return h.status, json.loads(h.wfile.getvalue().decode() or "{}")


def _valid_steam_response(*a, **kw):
    resp = mock.MagicMock()
    resp.text = "ns:S:0\nis_valid:true\n"
    return resp


CLAIMED = "https://steamcommunity.com/openid/id/123456789"


class TestReturnTo(unittest.TestCase):
    def test_another_origins_assertion_is_refused_before_steam_is_contacted(self):
        post = mock.MagicMock()
        status, body = _call(
            _query(**{"openid.return_to": "https://evil.example/steam-callback.html",
                      "openid.claimed_id": CLAIMED}),
            env={"PUBLIC_BASE_URL": "https://app.example"}, post=post)
        self.assertEqual(status, 401)
        self.assertIn("return_to", body["error"])
        post.assert_not_called()

    def test_a_missing_return_to_is_refused(self):
        status, body = _call(_query(), env={"PUBLIC_BASE_URL": "https://app.example"})
        self.assertEqual(status, 401)
        self.assertIn("return_to", body["error"])

    def test_the_deployments_own_return_to_verifies(self):
        status, body = _call(
            _query(**{"openid.return_to": "https://app.example/steam-callback.html",
                      "openid.claimed_id": CLAIMED}),
            env={"PUBLIC_BASE_URL": "https://app.example"},
            post=_valid_steam_response)
        self.assertEqual(status, 200)
        self.assertEqual(body["steamid"], "123456789")

    def test_without_public_base_url_the_request_host_names_the_expectation(self):
        # A self-hosted server.py that never set PUBLIC_BASE_URL: the browser
        # asked for the host the request arrived on, and that is the host a
        # callback is allowed to return to.
        status, body = _call(
            _query(**{"openid.return_to": "http://localhost:8089/steam-callback.html",
                      "openid.claimed_id": CLAIMED}),
            env={"PUBLIC_BASE_URL": ""}, host="localhost:8089",
            post=_valid_steam_response)
        self.assertEqual(status, 200)
        self.assertEqual(body["steamid"], "123456789")


class TestErrors(unittest.TestCase):
    def test_an_unreachable_steam_answers_a_bare_502(self):
        # Exception text carries the URL, the assertion params and the local
        # network's vocabulary; a public endpoint must not repeat it.
        def boom(*a, **kw):
            raise requests.ConnectionError("connect failed to 10.0.0.7:443")

        status, body = _call(
            _query(**{"openid.return_to": "https://app.example/steam-callback.html"}),
            env={"PUBLIC_BASE_URL": "https://app.example"}, post=boom)
        self.assertEqual(status, 502)
        self.assertNotIn("10.0.0.7", body["error"])
        self.assertEqual(body["error"], "Could not reach Steam")

    def test_a_failed_verification_is_401(self):
        resp = mock.MagicMock()
        resp.text = "ns:S:0\nis_valid:false\n"
        status, _ = _call(
            _query(**{"openid.return_to": "https://app.example/steam-callback.html"}),
            env={"PUBLIC_BASE_URL": "https://app.example"},
            post=lambda *a, **kw: resp)
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
