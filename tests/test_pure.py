"""Pure-function unit tests for price resolution, regret math, and path safety."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

from prices import _normalise_title  # noqa: E402


class TestNormaliseTitle(unittest.TestCase):
    def test_collapses_whitespace(self):
        self.assertEqual(_normalise_title("  Counter-Strike   2  "), "counter-strike 2")

    def test_case_insensitive(self):
        self.assertEqual(_normalise_title("DOOM Eternal"), "doom eternal")

    def test_empty(self):
        self.assertEqual(_normalise_title(""), "")


if __name__ == "__main__":
    unittest.main()
