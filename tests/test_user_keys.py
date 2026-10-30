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


class TestSuperuserTerm(unittest.TestCase):
    """The shared-term bypass: a visitor may present the configured term in a
    key field to spend the instance's own keys instead of bringing one."""

    def test_configured_term_spends_the_server_key_even_in_byo_mode(self):
        env = {"ITAD_API_KEY": "server", "SUPERUSER_KEY": "superuser", **BYO}
        with mock.patch.dict(os.environ, env):
            h = StubHandler({"X-ITAD-Key": "superuser"})
            self.assertEqual(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"), "server")

    def test_term_match_is_case_insensitive(self):
        env = {"ITAD_API_KEY": "server", "SUPERUSER_KEY": "SuperUser", **BYO}
        with mock.patch.dict(os.environ, env):
            h = StubHandler({"X-ITAD-Key": "SUPERUSER"})
            self.assertEqual(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"), "server")

    def test_unconfigured_term_never_reaches_a_provider(self):
        # Without SUPERUSER_KEY the literal must behave exactly like an absent
        # key: BYO refuses it, self-hosted falls back — never "superuser" upstream.
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", "SUPERUSER_KEY": "", **BYO}):
            self.assertIsNone(user_key(StubHandler({"X-ITAD-Key": "superuser"}), "X-ITAD-Key", "ITAD_API_KEY"))
        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "server", "SUPERUSER_KEY": "", **OFF}):
            self.assertEqual(
                user_key(StubHandler({"X-ITAD-Key": "superuser"}), "X-ITAD-Key", "ITAD_API_KEY"), "server")

    def test_only_the_configured_term_opens_the_fallback(self):
        env = {"ITAD_API_KEY": "server", "SUPERUSER_KEY": "opensesame", **BYO}
        with mock.patch.dict(os.environ, env):
            self.assertEqual(
                user_key(StubHandler({"X-ITAD-Key": "opensesame"}), "X-ITAD-Key", "ITAD_API_KEY"), "server")
            self.assertIsNone(user_key(StubHandler({"X-ITAD-Key": "superuser"}), "X-ITAD-Key", "ITAD_API_KEY"))

    def test_a_real_caller_key_still_wins_with_the_term_configured(self):
        env = {"ITAD_API_KEY": "server", "SUPERUSER_KEY": "superuser", **BYO}
        with mock.patch.dict(os.environ, env):
            h = StubHandler({"X-ITAD-Key": "mine"})
            self.assertEqual(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"), "mine")

    def test_term_with_no_server_key_is_none(self):
        env = {"ITAD_API_KEY": "", "SUPERUSER_KEY": "superuser", **BYO}
        with mock.patch.dict(os.environ, env):
            h = StubHandler({"X-ITAD-Key": "superuser"})
            self.assertIsNone(user_key(h, "X-ITAD-Key", "ITAD_API_KEY"))


if __name__ == "__main__":
    unittest.main()
