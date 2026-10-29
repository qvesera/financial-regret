"""Pure-function unit tests for price resolution, regret math, and path safety."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from prices import _normalise_title  # noqa: E402
from psn_games import iso8601_to_hours  # noqa: E402
from psn_prices import (  # noqa: E402
    REGION_BY_CURRENCY, _index_by_title_id, _money, _price_fields,
)


class TestNormaliseTitle(unittest.TestCase):
    def test_collapses_whitespace(self):
        self.assertEqual(_normalise_title("  Counter-Strike   2  "), "counter-strike 2")

    def test_case_insensitive(self):
        self.assertEqual(_normalise_title("DOOM Eternal"), "doom eternal")

    def test_empty(self):
        self.assertEqual(_normalise_title(""), "")


class TestIso8601ToHours(unittest.TestCase):
    """PSN playtime is an ISO-8601 duration (PT228H56M33S). The contract that
    matters: an unknown or unparseable duration is None, never 0 — a 0 would
    be read as 'definitely zero hours played' and poison every per-hour ratio."""

    def test_hours_minutes_seconds(self):
        self.assertAlmostEqual(iso8601_to_hours("PT228H56M33S"), 228.9, places=1)

    def test_hours_only(self):
        self.assertAlmostEqual(iso8601_to_hours("PT10H"), 10.0)

    def test_minutes_only(self):
        self.assertAlmostEqual(iso8601_to_hours("PT45M"), 0.8)   # rounds to 1dp

    def test_seconds_only(self):
        # Sub-6-minute playtimes floor at 0.1, never 0.0 (which would be
        # read as "never played" and make price / hours = Infinity).
        self.assertAlmostEqual(iso8601_to_hours("PT30S"), 0.1)

    def test_days_roll_up(self):
        self.assertAlmostEqual(iso8601_to_hours("P1DT2H"), 26.0)

    def test_zero_duration_is_none(self):
        self.assertIsNone(iso8601_to_hours("PT0S"), "a real zero must stay out of ratios")

    def test_garbage_is_none(self):
        self.assertIsNone(iso8601_to_hours("two hours"))

    def test_empty_is_none(self):
        self.assertIsNone(iso8601_to_hours(""))

    def test_none_is_none(self):
        self.assertIsNone(iso8601_to_hours(None))


class TestPlatPricesMoney(unittest.TestCase):
    """PlatPrices quotes integers in the region's *minor* units, and the
    decimal count is per region -- not a universal 2. A hardcoded /100 would
    price every Japanese title at 1/100th of what it costs."""

    def test_two_decimal_region(self):
        self.assertEqual(_money(5999, "in"), 59.99)

    def test_zero_decimal_region(self):
        self.assertEqual(_money(5999, "jp"), 5999.0)

    def test_zero_is_a_real_price(self):
        # A genuinely free game, not a missing one.
        self.assertEqual(_money(0, "in"), 0.0)

    def test_missing_is_none(self):
        self.assertIsNone(_money(None, "in"))

    def test_negative_is_none(self):
        self.assertIsNone(_money(-1, "in"))

    def test_bool_is_none(self):
        # bool is an int subclass; accepting it would price a game at 0.01.
        self.assertIsNone(_money(True, "in"))


class TestPlatPricesFields(unittest.TestCase):
    def test_sale_price_wins(self):
        price, high, low = _price_fields(
            {"BasePrice": 5999, "SalePrice": 2999, "LowestEverPrice": 2499}, "in")
        self.assertEqual((price, high, low), (29.99, 59.99, 24.99))

    def test_base_price_fallback(self):
        # Most titles have no LaunchPrice, so the list price stands in as the
        # high -- the same meaning highs carries for every other store.
        price, high, low = _price_fields({"BasePrice": 5999, "SalePrice": None}, "in")
        self.assertEqual((price, high), (59.99, 59.99))

    def test_delisted_price_is_none_but_history_survives(self):
        price, high, low = _price_fields(
            {"BasePrice": 5999, "SalePrice": 5999, "LowestEverPrice": 1499,
             "IsDelisted": 1}, "in")
        self.assertIsNone(price, "you cannot buy a delisted game")
        self.assertEqual(high, 59.99)
        self.assertEqual(low, 14.99)


class TestPlatPricesIndex(unittest.TestCase):
    """The join key is NpTitleId, which is exactly the titleId psn_games.py
    returns -- but GameID (bare, no _00) is echoed back too, so index both."""

    def test_matches_suffixed_and_bare_ids(self):
        item = {"NpTitleId": "PPSA23226_00", "GameID": "PPSA23226"}
        index = _index_by_title_id([item])
        self.assertIs(index["PPSA23226_00"], item)
        self.assertIs(index["PPSA23226"], item)

    def test_uppercase_normalisation_covers_mixed_case_ids(self):
        # The handler looks a title up as-given and then uppercased, so a
        # mixed-case id from the store must still land.
        item = {"NpTitleId": "PpSa23226_00"}
        self.assertIs(_index_by_title_id([item])["PPSA23226_00"], item)

    def test_skips_non_objects_and_idless_rows(self):
        self.assertEqual(_index_by_title_id([None, "junk", {"GameID": 123}]), {})


class TestPlatPricesRegions(unittest.TestCase):
    """Currencies with no PlatPrices store must map to no region at all.
    Quoting a wrong region's prices is worse than quoting none."""

    def test_supported_currencies_map_to_a_region(self):
        for code in ("INR", "USD", "EUR", "GBP", "JPY", "KRW"):
            self.assertIn(code, REGION_BY_CURRENCY)

    def test_unsupported_currencies_have_no_region(self):
        for code in ("CNY", "PHP", "RUB"):
            self.assertNotIn(code, REGION_BY_CURRENCY)


if __name__ == "__main__":
    unittest.main()
