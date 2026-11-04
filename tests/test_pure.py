"""Pure-function unit tests for price resolution, regret math, and path safety."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from prices import _normalise_title  # noqa: E402
from psn_games import iso8601_to_hours  # noqa: E402
from psn_prices import (  # noqa: E402
    LOCALE_BY_CURRENCY, _locale_for, _money, _price_fields, _purchase_cta,
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


def _cta(upsell, price):
    return {"meta": {"upSellService": upsell}, "price": price}


def _payload(*ctas):
    return {"data": {"conceptRetrieve": {"defaultProduct": {"mobilectas": list(ctas)}}}}


class TestStoreMoney(unittest.TestCase):
    """Sony quotes whole units for some currencies and hundredths for others.
    The decimal count belongs to the currency, not the payload -- a blind /100
    prices every Japanese title at 1/100th of what it costs."""

    def test_hundredths_region(self):
        self.assertEqual(_money(5999, "USD"), 59.99)
        self.assertEqual(_money(7999, "EUR"), 79.99)

    def test_whole_unit_regions(self):
        # Probed live: en-IN answers 4999 as "Rs 4,999", ja-JP 8690 as "¥8,690",
        # ko-KR 79800 as "79,800원" -- all without a decimal point.
        for code in ("INR", "JPY", "KRW"):
            self.assertEqual(_money(5999, code), 5999.0, code)

    def test_zero_is_a_real_price(self):
        # A genuinely free game, not a missing one.
        self.assertEqual(_money(0, "USD"), 0.0)

    def test_missing_is_none(self):
        self.assertIsNone(_money(None, "USD"))

    def test_negative_is_none(self):
        self.assertIsNone(_money(-1, "USD"))

    def test_bool_is_none(self):
        # bool is an int subclass; accepting it would price a game at 0.01.
        self.assertIsNone(_money(True, "USD"))


class TestStorePriceFields(unittest.TestCase):
    def test_the_sale_price_wins_and_the_list_price_is_the_high(self):
        p = _payload(_cta("NONE", {"basePriceValue": 5999, "discountedValue": 2999}))
        self.assertEqual(_price_fields(p, "USD"), (29.99, 59.99, None))

    def test_no_campaign_reports_the_list_price(self):
        # discountedValue 0 with no campaign means "nothing is on sale", which
        # must not be read as "this game is free".
        p = _payload(_cta("NONE", {"basePriceValue": 5999, "discountedValue": 0}))
        self.assertEqual(_price_fields(p, "USD"), (59.99, 59.99, None))

    def test_free_is_zero_not_none(self):
        p = _payload(_cta("NONE", {"basePriceValue": 0, "discountedValue": 0,
                                   "isFree": True}))
        self.assertEqual(_price_fields(p, "USD"), (0.0, 0.0, None))

    def test_the_plus_catalog_button_is_never_read(self):
        # The trap this whole handler exists around: the PlayStation Plus button
        # answers "Included", isFree true, discountedValue 0. Reading it prices
        # an entire library at zero; only upSellService NONE is a purchase.
        plus = _cta("PS_PLUS", {"basePriceValue": 5999, "discountedValue": 0,
                                "isFree": True, "isTiedToSubscription": True})
        real = _cta("NONE", {"basePriceValue": 5999, "discountedValue": 5999})
        self.assertEqual(_price_fields(_payload(plus, real), "USD"),
                         (59.99, 59.99, None), "the real button wins")
        self.assertEqual(_price_fields(_payload(plus), "USD"),
                         (None, None, None), "a Plus-only concept is unpriced")
        self.assertIsNone(_purchase_cta(_payload(plus)))

    def test_history_is_never_invented(self):
        # lows is always None: the store keeps no all-time low here, and the
        # dashboard's tooltip already promises to fall back to today's price.
        p = _payload(_cta("NONE", {"basePriceValue": 5999, "discountedValue": 4999}))
        self.assertIsNone(_price_fields(p, "USD")[2])

    def test_no_purchase_button_is_no_price(self):
        for payload in (_payload(), {"data": None}, {},
                        {"data": {"conceptRetrieve": {}}},
                        {"data": {"conceptRetrieve": {"defaultProduct": None}}}):
            self.assertEqual(_price_fields(payload, "USD"), (None, None, None))

    def test_a_sale_above_the_list_price_cannot_read_as_a_price_cut(self):
        # A malformed campaign (discount > base) would otherwise show a "deal"
        # that is really just a higher number.
        p = _payload(_cta("NONE", {"basePriceValue": 5999, "discountedValue": 8999}))
        self.assertEqual(_price_fields(p, "USD")[0], 59.99)


class TestStoreLocales(unittest.TestCase):
    """A currency with no PlayStation Store must map to no locale at all.
    Quoting another region's price is worse than quoting none, because it
    reads as fact on every verdict the dashboard goes on to grade."""

    # Exactly what the currency picker offers (public/js/format.js). One code
    # without a locale would be a picker entry that can never price anything.
    OFFERED = ["INR", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "BRL", "KRW",
               "SGD", "HKD", "NZD", "SEK", "NOK", "DKK", "CHF", "PLN", "TRY",
               "ZAR", "MXN", "CNY", "IDR", "THB", "PHP", "RUB", "UAH", "CZK",
               "HUF", "ILS"]

    def test_every_offered_currency_has_a_store(self):
        for code in self.OFFERED:
            self.assertIn(code, LOCALE_BY_CURRENCY, f"{code} cannot be priced")

    def test_a_locale_looks_like_a_locale(self):
        for code in ("INR", "USD", "JPY", "BRL"):
            self.assertRegex(_locale_for(code), r"^[a-z]{2}-[A-Z]{2}$")

    def test_supported_currencies_map_to_a_locale(self):
        for code in ("INR", "USD", "EUR", "GBP", "JPY", "KRW"):
            self.assertIn(code, LOCALE_BY_CURRENCY)

    def test_a_currency_without_a_store_has_none(self):
        for code in ("XAF", "XCD", "ZZZ", "not-a-code"):
            self.assertIsNone(_locale_for(code))


if __name__ == "__main__":
    unittest.main()
