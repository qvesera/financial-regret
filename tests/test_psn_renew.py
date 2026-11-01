"""The renewal script's non-network half: .env rewriting, NPSSO storage, and
the two response parsers.

These are the parts that can quietly wreck an operator's config or misread
Sony's answer, so they are pinned without touching the network -- the exchange
itself is exercised by running the script for real.
"""
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "scripts"))

import renew_psn_token as renew  # noqa: E402
from _psn_auth import code_from_location  # noqa: E402


class FakeResp:
    def __init__(self, location=None, cookies=None):
        self.headers = {"Location": location} if location is not None else {}
        self.cookies = cookies or {}


class TestCodeFromLocation(unittest.TestCase):
    def test_the_code_is_read_off_the_redirect(self):
        code = code_from_location(FakeResp(
            "com.scee.psxandroid.scecompcall://redirect?code=ABC123&state=x"))
        self.assertEqual(code, "ABC123")

    def test_no_redirect_is_a_readable_refusal(self):
        # The message is what an operator sees at 3am from a cron log: it has
        # to name the likely cause instead of a KeyError.
        with self.assertRaisesRegex(ValueError, "expired or mistyped"):
            code_from_location(FakeResp("https://ca.account.sony.com/error"))

    def test_an_empty_code_never_passes(self):
        with self.assertRaisesRegex(ValueError, "no code"):
            code_from_location(FakeResp("com.x://redirect?code="))


class TestReissuedNpsso(unittest.TestCase):
    def test_a_set_cookie_npsso_is_recognised(self):
        self.assertEqual(
            renew.reissued_npsso(FakeResp(cookies={"npsso": "x" * 64})), "x" * 64)

    def test_no_cookie_means_none(self):
        self.assertIsNone(renew.reissued_npsso(FakeResp(cookies={})))
        self.assertIsNone(renew.reissued_npsso(FakeResp()))

    def test_a_tiny_cookie_is_never_saved_over_the_real_one(self):
        # An NPSSO is 64 characters. Something shorter cannot be one, and
        # overwriting the stored file with it would break the whole chain.
        self.assertIsNone(renew.reissued_npsso(FakeResp(cookies={"npsso": "abc"})))
        self.assertIsNone(
            renew.reissued_npsso(FakeResp(cookies={"session": "y" * 64})))


class TestUpsertEnv(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / ".env"

    def test_a_missing_file_is_created_with_the_key(self):
        renew.upsert_env(self.path, "PSN_REFRESH_TOKEN", "r1")
        self.assertEqual(self.path.read_text(), "PSN_REFRESH_TOKEN=r1\n")

    def test_an_existing_key_is_replaced_never_duplicated(self):
        self.path.write_text(
            "ITAD_API_KEY=keep-me\n"
            "PSN_REFRESH_TOKEN=stale\n"
            "PORT=8089\n"
            "# a comment that must survive\n")
        renew.upsert_env(self.path, "PSN_REFRESH_TOKEN", "fresh")
        lines = self.path.read_text().splitlines()
        self.assertEqual([l for l in lines if l.startswith("PSN_REFRESH_TOKEN=")],
                         ["PSN_REFRESH_TOKEN=fresh"])
        self.assertEqual(
            lines,
            ["ITAD_API_KEY=keep-me", "PSN_REFRESH_TOKEN=fresh", "PORT=8089",
             "# a comment that must survive"],
            "every other line keeps its content and its place")

    def test_a_second_run_is_idempotent(self):
        renew.upsert_env(self.path, "PSN_REFRESH_TOKEN", "r1")
        renew.upsert_env(self.path, "PSN_REFRESH_TOKEN", "r2")
        self.assertEqual(self.path.read_text().count("PSN_REFRESH_TOKEN="), 1)
        self.assertEqual(self.path.read_text(), "PSN_REFRESH_TOKEN=r2\n")


class TestNpssoStorage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "npsso"

    def test_stored_file_is_0600_and_roundtrips(self):
        # A PSN web session on disk gets owner-only permissions, not 0644.
        renew.save_npsso("a" * 64, self.path)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(renew.load_npsso(self.path), "a" * 64)

    def test_the_environment_wins_over_the_file(self):
        renew.save_npsso("stored", self.path)
        with mock.patch.dict(os.environ, {"PSN_NPSSO": "from-env"}):
            self.assertEqual(renew.load_npsso(self.path), "from-env")

    def test_nothing_anywhere_fails_loudly(self):
        with mock.patch.dict(os.environ, {"PSN_NPSSO": ""}):
            with self.assertRaises(SystemExit):
                renew.load_npsso(Path(self.tmp.name) / "absent")


class TestVerifyTarget(unittest.TestCase):
    """Where verification points decides whether a healthy deployment reads as
    a failure. Run 41300183313 proved production correct by hand while its own
    verify step was 302-redirected into Vercel Authentication's HTML."""

    def test_the_production_alias_wins_over_the_deployment_url(self):
        with mock.patch.object(renew, "PROD_URL", "https://prod.example"), \
                mock.patch.object(renew, "VERCEL_PROJECT", "proj"):
            self.assertEqual(
                renew.verify_target("https://x-abc123-qvesera.vercel.app"),
                "https://prod.example")

    def test_the_project_name_builds_the_alias_when_no_url_is_given(self):
        with mock.patch.object(renew, "PROD_URL", ""), \
                mock.patch.object(renew, "VERCEL_PROJECT", "financial-regret"):
            self.assertEqual(renew.verify_target(""),
                             "https://financial-regret.vercel.app")

    def test_the_deployment_url_is_a_last_resort_only(self):
        with mock.patch.object(renew, "PROD_URL", ""), \
                mock.patch.object(renew, "VERCEL_PROJECT", ""):
            self.assertEqual(renew.verify_target("https://dpl.example"),
                             "https://dpl.example")

    def test_nothing_to_verify_against_fails(self):
        with mock.patch.object(renew, "PROD_URL", ""), \
                mock.patch.object(renew, "VERCEL_PROJECT", ""):
            with self.assertRaises(SystemExit):
                renew.verify_target("")


class TestCliRefusalHints(unittest.TestCase):
    """The two refusals this job has actually hit must name their own fix:
    run 1 died on an unlinked checkout, run 2 on a bad VERCEL_TOKEN, and both
    were only legible by hand."""

    def test_an_invalid_token_points_at_the_secret(self):
        message = renew._why(
            "Error: The token provided via the `--token` option is not valid.")
        self.assertIn("VERCEL_TOKEN secret", message)
        self.assertIn("vercel.com/account/tokens", message)

    def test_an_unlinked_checkout_points_at_vercel_link(self):
        message = renew._why(
            "Error: Your codebase isn't linked to a project on Vercel.")
        self.assertIn("vercel link", message)

    def test_an_unknown_refusal_is_passed_through_untouched(self):
        # Hints must never mask an error nobody has seen before.
        self.assertEqual(renew._why("Error: something brand new"), "Error: something brand new")

    def test_output_is_bounded(self):
        self.assertLessEqual(len(renew._why("x" * 5000 + " not valid")), 500)


if __name__ == "__main__":
    unittest.main()