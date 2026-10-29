"""BYO-key (REQUIRE_USER_KEYS) tests.

A self-hosted install spends the owner's key when a visitor supplies none. A
public install must not: that quota is a shared pool, and PlatPrices' free tier
is 1,000 requests a month, so one large library scan would drain it for
everyone. Reselling a provider's data on your own account is also what their
paid tiers exist to prevent.
"""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from _common import user_key


class StubHandler:
    def __init__(self, headers=None):
        self.headers = dict(headers or {})


BYO = {"REQUIRE_USER_KEYS": "1"}
OFF = {"REQUIRE_USER_KEYS": "0"}


class TestUserKey(unittest.TestCase):
    def test_caller_key_always_wins(self):
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", **BYO}):
            h = StubHandler({"X-ITAD-Key": "mine"})
            self.assertEqual(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"), "mine")

    def test_self_hosted_falls_back_to_the_server_key(self):
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", **OFF}):
            self.assertEqual(user_key(StubHandler(), "X-ITAD-Key", "ITAD_API_KEY"), "server")

    def test_byo_mode_never_spends_the_server_key(self):
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", **BYO}):
            self.assertIsNone(user_key(StubHandler(), "X-ITAD-Key", "ITAD_API_KEY"))

    def test_missing_everything_is_none(self):
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "", **OFF}):
            self.assertIsNone(user_key(StubHandler(), "X-ITAD-Key", "ITAD_API_KEY"))

    def test_blank_header_counts_as_absent(self):
        # The client sends some optional headers as empty strings, so whitespace
        # must not be mistaken for a real key.
        h = StubHandler({"X-ITAD-Key": "   "})
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", **OFF}):
            self.assertEqual(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"), "server")
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", **BYO}):
            self.assertIsNone(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"))


if __name__ == "__main__":
    unittest.main()
