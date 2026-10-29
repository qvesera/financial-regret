/** Formatting helpers (pure, no DOM). Amounts render in the active currency. */

/** ISO 4217 codes offered in the picker. Keep in sync with the backend's
 *  CURRENCY_COUNTRY map so every option resolves to a store region. */
export const CURRENCIES = [
  "INR", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "BRL", "KRW", "SGD",
  "HKD", "NZD", "SEK", "NOK", "DKK", "CHF", "PLN", "TRY", "ZAR", "MXN",
  "CNY", "IDR", "THB", "PHP", "RUB", "UAH", "CZK", "HUF", "ILS",
];

const _formatters = new Map();

/** ISO 3166-1 alpha-2 → the display currency, restricted to the codes in
 *  CURRENCIES so a detected region can never name a currency the picker
 *  (and the price API) does not offer. Country groups share their currency
 *  where that is the truth — the euro area, Scandinavia's neighbours — and
 *  everything else maps to its own. */
const COUNTRY_CURRENCY = {
  IN: "INR",
  US: "USD", EC: "USD", SV: "USD", PA: "USD", PW: "USD", MH: "USD",
  FM: "USD", AS: "USD", GU: "USD", PR: "USD", VI: "USD", MP: "USD", TL: "USD",
  AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR",
  FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR",
  LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SK: "EUR", SI: "EUR",
  AD: "EUR", MC: "EUR", SM: "EUR", VA: "EUR", ME: "EUR", XK: "EUR",
  GF: "EUR", GP: "EUR", MQ: "EUR", RE: "EUR", YT: "EUR",
  GB: "GBP", JE: "GBP", GG: "GBP", IM: "GBP",
  JP: "JPY",
  AU: "AUD", CC: "AUD", CX: "AUD", HM: "AUD", NF: "AUD", NR: "AUD",
  TV: "AUD", KI: "AUD",
  CA: "CAD", BR: "BRL", KR: "KRW", SG: "SGD", HK: "HKD",
  NZ: "NZD", CK: "NZD", NU: "NZD", TK: "NZD", PN: "NZD",
  SE: "SEK", NO: "NOK", SJ: "NOK", BV: "NOK",
  DK: "DKK", FO: "DKK", GL: "DKK", CH: "CHF", LI: "CHF",
  PL: "PLN", TR: "TRY", ZA: "ZAR", LS: "ZAR", NA: "ZAR", SZ: "ZAR",
  MX: "MXN", CN: "CNY", ID: "IDR", TH: "THB", PH: "PH",
  RU: "RUB", UA: "UAH", CZ: "CZK", HU: "HUF", IL: "ILS",
};

/** The display currency for a country code, or null when we have none to
 *  offer — the caller falls back to the default rather than being handed a
 *  currency the price API cannot shop in. */
export function currencyForCountry(country) {
  const cc = String(country || "").trim().toUpperCase();
  return COUNTRY_CURRENCY[cc] || null;
}
function formatter(currency) {
  let f = _formatters.get(currency);
  if (!f) {
    try {
      f = new Intl.NumberFormat(undefined, {
        style: "currency", currency,
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    } catch {
      // Unsupported code must never throw — fall back so a bad value still renders.
      f = new Intl.NumberFormat(undefined, {
        style: "currency", currency: "USD",
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    }
    _formatters.set(currency, f);
  }
  return f;
}

/** "₹499.00" in the chosen currency; "—" when the amount is unknown. */
export function money(amount, currency = "INR") {
  if (amount == null) return "—";
  return formatter(currency).format(amount);
}

/** Bare symbol ("₹", "$") for compact labels like "$ / hour". */
export function symbol(currency = "INR") {
  try {
    const part = formatter(currency).formatToParts(0).find((p) => p.type === "currency");
    return part ? part.value : currency;
  } catch { return currency; }
}

/** "<symbol><whole>/h" figure for the per-hour column/labels. */
export function perHour(rate, currency = "INR") {
  if (rate == null) return "—";
  if (!Number.isFinite(rate)) return "∞/h";   // never played
  return `${symbol(currency)}${Number(rate).toFixed(0)}/h`;
}

/** Cost per hour of play, capped so it never exceeds what you paid.
 *  Dividing by a fraction of an hour would otherwise inflate the rate above
 *  the purchase price (a ₹500 game at 0.5 h would read ₹1000/h). */
export function pricePerHour(price, hours) {
  if (price == null || hours == null) return null;
  if (price === 0) return 0;        // a free game costs nothing per hour
  if (hours <= 0) return Infinity;  // never played
  if (hours < 1) return price;      // sub-hour: cap at the purchase price
  return price / hours;
}

export function hours(h) {
  if (h == null) return "—";
  return `${Number(h).toFixed(1)} h`;
}

export function percent(value, total) {
  if (total == null || total === 0 || value == null) return "—";
  return `${((value / total) * 100).toFixed(1)} %`;
}

export function relTime(msAgo) {
  const s = Math.floor(msAgo / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}
