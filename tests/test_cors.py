"""CORS contract tests for split-origin hosting (static frontend on a CDN, API here).

Two properties matter and both are easy to break without noticing:

  1. The allowlist is opt-in per origin. A wildcard would let any website in
     the world drive this API using a visitor's stored tokens, so "no origin
     requested -> no header" and "origin not allowlisted -> no header" must both
     hold, and Access-Control-Allow-Credentials must never appear.
  2. The header list must track the browser client exactly. A header outside
     the list fails preflight for every user with an opaque network error, so
     the last tests read public/js and refuse to let the two drift.
"""
import io
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "api"))

import _cors

CLIENT_JS = [ROOT / "public" / "js" / "api.js", ROOT / "public" / "js" / "app.js"]


class StubHandler:
    """Minimal stand-in: records headers, holds the request headers."""

    def __init__(self, headers=None):
        self.headers = dict(headers or {})
        self.sent = []
        self._response_sent = False
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, name, value):
        self.sent.append((name, value))

    def end_headers(self):
        pass


def _sent(handler) -> dict:
    return dict(handler.sent)


def _run(handler):
    _cors.send_cors(handler)
    return _sent(handler)


class TestAllowlist(unittest.TestCase):
    def test_allowlisted_origin_is_echoed(self):
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://regret.example"}):
            h = StubHandler({"Origin": "https://regret.example"})
            self.assertEqual(_run(h)["Access-Control-Allow-Origin"], "https://regret.example")

    def test_disallowed_origin_gets_no_header(self):
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://regret.example"}):
            h = StubHandler({"Origin": "https://evil.example"})
            self.assertNotIn("Access-Control-Allow-Origin", _run(h))

    def test_no_origin_header_means_same_origin(self):
        # This is the default self-hosted case: nothing changes for it.
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://regret.example"}):
            self.assertNotIn("Access-Control-Allow-Origin", _run(StubHandler()))

    def test_empty_allowlist_emits_nothing(self):
        h = StubHandler({"Origin": "https://regret.example"})
        self.assertEqual(_run(h), {})

    def test_trailing_slashes_and_spaces_are_tolerated(self):
        env = {"CORS_ALLOWED_ORIGINS": " https://a.example/ , https://b.example "}
        with mock.patch.dict(os.environ, env):
            for origin in ("https://a.example", "https://b.example"):
                h = StubHandler({"Origin": origin})
                self.assertEqual(_run(h)["Access-Control-Allow-Origin"], origin)

    def test_wildcard_is_never_emitted(self):
        env = {"CORS_ALLOWED_ORIGINS": "https://a.example, *"}
        with mock.patch.dict(os.environ, env):
            ok = StubHandler({"Origin": "https://a.example"})
            self.assertEqual(_run(ok)["Access-Control-Allow-Origin"], "https://a.example")
            for origin in ("https://anything.example", "*", "null"):
                self.assertNotIn("Access-Control-Allow-Origin",
                                 _run(StubHandler({"Origin": origin})), origin)


class TestPreflight(unittest.TestCase):
    def test_preflight_carries_methods_and_cached_max_age(self):
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://a.example"}):
            h = StubHandler({"Origin": "https://a.example"})
            headers = _run(h)
            self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS")
            self.assertEqual(headers["Access-Control-Max-Age"], "600")
            self.assertEqual(headers["Vary"], "Origin")

    def test_allow_credentials_is_never_sent(self):
        # Tokens travel in headers, never cookies, so credentialed mode is both
        # unnecessary and a hazard: it is what a wildcard would make exploitable.
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://a.example"}):
            h = StubHandler({"Origin": "https://a.example"})
            self.assertNotIn("Access-Control-Allow-Credentials", _run(h))


class TestClientDrift(unittest.TestCase):
    """The allowlist must cover every header the browser actually sends."""

    @staticmethod
    def _client_headers() -> set:
        found = set()
        for path in CLIENT_JS:
            found |= set(re.findall(r"X-[A-Za-z][A-Za-z0-9-]*", path.read_text()))
        return found

    def test_every_client_header_is_covered(self):
        allowed = {h.strip() for h in _cors.ALLOW_HEADERS.split(",")}
        missing = self._client_headers() - allowed
        self.assertFalse(
            missing,
            "public/js sends headers _cors.ALLOW_HEADERS omits; cross-origin "
            f"preflight would fail for: {sorted(missing)}",
        )

    def test_client_headers_were_actually_found(self):
        # Guards the guard: a bad glob would otherwise make the test vacuous.
        found = self._client_headers()
        self.assertGreater(len(found), 5, f"regex found only {sorted(found)}")
        self.assertIn("X-Steam-Key", found)


class TestCommonIntegration(unittest.TestCase):
    def test_send_json_attaches_cors(self):
        import _common
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://a.example"}):
            h = StubHandler({"Origin": "https://a.example"})
            _common.send_json(h, 200, {"ok": True})
            headers = _sent(h)
            self.assertEqual(headers["Access-Control-Allow-Origin"], "https://a.example")
            self.assertEqual(h.status, 200)

    def test_handle_options_is_a_preflight(self):
        import _common
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://a.example"}):
            h = StubHandler({"Origin": "https://a.example"})
            _common.handle_options(h)
            headers = _sent(h)
            self.assertEqual(h.status, 204)
            self.assertEqual(headers["Access-Control-Allow-Origin"], "https://a.example")
            self.assertIn("Access-Control-Allow-Headers", headers)


if __name__ == "__main__":
    unittest.main()
