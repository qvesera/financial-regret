/** Verdict engine — pure, no DOM, no I/O.
 *
 *  A game's worth is judged against this library's own distribution of
 *  price-per-hour, not a hardcoded rupee threshold: what counts as a rip-off
 *  depends on what you normally pay. Quartiles (p25/p50/p75) are the whole
 *  model, which is why the UI can draw them as a box plot.
 */
import { pricePerHour } from "./format.js";

/** Linear-interpolated quantile of an ascending array. */
function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Finite, non-zero price-per-hour figures for every priced, played game,
 *  ascending. Unplayed (∞), unpriced games and free games are not
 *  observations of value: a zero rate cannot lose in a lower-is-better
 *  ratio, and enough of them pin the first quartile to exactly zero — at
 *  which point "Worth it" (rate ≤ p25) degenerates into "is it free" and no
 *  paid game can ever reach the top band. */
export function rateSamples(rows) {
  const out = [];
  for (const g of rows || []) {
    const r = pricePerHour(g.price, g.hours);
    if (r != null && Number.isFinite(r) && r > 0) out.push(r);
  }
  return out.sort((a, b) => a - b);
}

/** Distribution the verdicts are read against. Below 3 observations there is
 *  no meaningful quartile, so the bounds stay null and the view shows "—". */
export function benchmark(rows) {
  const s = rateSamples(rows);
  const enough = s.length >= 3;
  return {
    samples: s.length,
    p25: enough ? quantile(s, 0.25) : null,
    p50: enough ? quantile(s, 0.5) : null,
    p75: enough ? quantile(s, 0.75) : null,
    p90: enough ? quantile(s, 0.9) : null,
    max: s.length ? s[s.length - 1] : null,
  };
}

/** Tier order, cheapest verdict first. */
export const TIERS = ["worth", "fair", "regret", "untouched", "free", "nodata"];

export const TIER_LABEL = {
  worth: "Worth it",
  fair: "Fair",
  regret: "Regret",
  untouched: "Untouched",
  // Outside the graded scale: nothing was paid, so nothing can be a bargain
  // or a regret. The colour for it shipped in :root long before this tier
  // existed — the token was waiting for its verdict.
  free: "Free",
  // Not "No data": the play-status tab already owns that phrase (it means
  // hours unknown there). Here the gap is specifically the price.
  nodata: "Unpriced",
  unknown: "No benchmark",
};

/** How one game sits against the benchmark.
 *  nodata    — no purchase price known, so nothing to judge
 *  untouched — never played (or under an hour): money spent, nothing earned
 *  free      — priced at zero: outside the scale, because a zero rate beats
 *              every other rate by construction — grading it against p25 would
 *              make Worth it mean "is it free"
 *  unknown   — fewer than 3 priced games in the library to compare against   */
export function verdictOf(game, bench) {
  if (!game || game.price == null) return "nodata";
  if (game.hours == null || game.hours < 1) return "untouched";
  // Playtime is checked first on purpose: a free game never opened is still
  // Untouched — the play truth comes before the money truth.
  if (game.price === 0) return "free";
  const rate = pricePerHour(game.price, game.hours);
  if (rate == null || !Number.isFinite(rate)) return "untouched";
  if (!bench || bench.p25 == null) return "unknown";
  if (rate <= bench.p25) return "worth";
  if (rate <= bench.p50) return "fair";
  return "regret";
}

/** Every verdict for a library, keyed by game id. */
export function verdictMap(rows, bench) {
  const out = new Map();
  for (const g of rows || []) out.set(g.id, verdictOf(g, bench));
  return out;
}

/** Replay a game at a hypothetical playtime: what the per-hour rate would be
 *  and whether that flips the verdict. Used by the what-if slider. */
export function whatIf(game, bench, hours) {
  const h = Number(hours);
  const rate = pricePerHour(game ? game.price : null, h);
  const nowRate = game ? pricePerHour(game.price, game.hours) : null;
  const playable = game && game.price != null && Number.isFinite(h) && h >= 1;
  const tier = playable
    ? verdictOf({ price: game.price, hours: h }, bench)
    : verdictOf(game, bench);
  const nowTier = game ? verdictOf(game, bench) : "nodata";
  return {
    rate: rate != null && Number.isFinite(rate) ? rate : null,
    tier,
    nowTier,
    nowRate: nowRate != null && Number.isFinite(nowRate) ? nowRate : null,
    delta: rate != null && Number.isFinite(rate) && nowRate != null && Number.isFinite(nowRate)
      ? rate - nowRate
      : null,
    changed: tier !== nowTier,
  };
}

/** Stable hue (0-359) from a game id — the cover placeholder's colour, so the
 *  same game always wears the same colour and the grid stays recognisable. */
export function coverHue(id) {
  const s = id == null ? "" : String(id);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** One plain-language line for the hero. Money is passed in already
 *  formatted — this module never touches a currency formatter. */
export function headline({ total = 0, played = 0, worstName = null, worstRate = null } = {}) {
  if (!total) return "";
  const pct = Math.round((played / total) * 100);
  if (!played) return `${total} games, none played yet — the shelf is the story.`;
  if (!worstName) return `${played} of ${total} games played — ${pct}% of the library.`;
  return `${pct}% of ${total} games played. Worst buy: ${worstName} at ${worstRate}/h.`;
}

/** Ranked extremes for the insight cards. Games need at least an hour of play
 *  to be evidence about value — a 10-minute session proves nothing — and a
 *  price above zero, because a free game tops Best value by definition and
 *  would colonise the list while proving nothing about what a purchase was
 *  worth. */
export function comparators(rows, limit = 5) {
  const scored = (rows || [])
    .filter((x) => x.price != null && x.price > 0 && x.hours != null && x.hours >= 1)
    .map((x) => ({
      id: x.id,
      name: x.name,
      hours: x.hours,
      price: x.price,
      rate: pricePerHour(x.price, x.hours),
    }))
    .filter((x) => Number.isFinite(x.rate));
  const desc = [...scored].sort((a, b) => b.rate - a.rate || (b.hours || 0) - (a.hours || 0));
  // Untouched ranked by what it cost: an unopened game has no rate to rank on
  // (₹/hour over ~zero hours is unbounded), and the honest measure of a
  // wasted purchase is the purchase. Mirrors the Untouched verdict — hours
  // unknown or under an hour — so the facet filter and this list always agree,
  // and free and unpriced rows stay out because there is no spend to rank.
  const untouched = (rows || [])
    .filter((x) => x.price > 0 && (x.hours == null || x.hours < 1))
    .sort((a, b) => b.price - a.price || (a.hours || 0) - (b.hours || 0))
    .slice(0, limit)
    .map((x) => ({ id: x.id, name: x.name, hours: x.hours, price: x.price }));
  return {
    worst: desc.slice(0, limit),
    best: [...desc].reverse().slice(0, limit),
    untouched,
  };
}
