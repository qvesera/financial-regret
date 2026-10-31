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
  const paidBest = [...desc].reverse().slice(0, limit);
  // Best value falls back to free games when nothing paid qualifies — in an
  // all-free view the only value on offer is play itself, so the most hours
  // wins. Rate stays 0 because free is 0/h: honest, and uniform across rows.
  // Hall of shame gains nothing from this fallback: worst stays empty for
  // free rows (nothing was paid), and the view hides that card outright
  // rather than implying a free game could ever be a bad buy.
  const freeBest = (rows || [])
    .filter((x) => x.price === 0 && x.hours != null && x.hours >= 1)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, limit)
    .map((x) => ({ id: x.id, name: x.name, hours: x.hours, price: 0, rate: 0 }));
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
    best: paidBest.length ? paidBest : freeBest,
    untouched,
  };
}

/** The banded one-liners a shared card's page shows about its author's shelf.
 *  The band comes from the regret score; the line is picked at random within
 *  it, so a reload feels alive without inventing new verdicts per visit.
 *  Impersonal on purpose — the reader is looking at someone else's library. */
export const SHARED_VERDICTS = {
  pristine: [
    "Nothing unplayed. The shelf is clean.",
    "Every rupee has hours behind it.",
    "No backlog. Suspicious, but respect.",
    "Played everything. Nothing to regret.",
    "The report is boring. That's the point.",
  ],
  tidy: [
    "A tidy shelf, barely a dent.",
    "The backlog is a rounding error.",
    "One or two stragglers. That's discipline.",
    "A few sealed boxes on an otherwise honest shelf.",
  ],
  ordinary: [
    "A normal amount of good intentions.",
    "The backlog is a habit, not a crisis.",
    "Buys games. Mostly plays them. Mostly.",
    "Nothing here would embarrass anyone at a dinner party.",
  ],
  warning: [
    "The backlog has started paying rent.",
    "A quarter of the shelf is decoration.",
    "Buying faster than playing.",
    "The case for \"I'll get to it\" is getting thin.",
  ],
  shame: [
    "The shelf is mostly a museum.",
    "Half the library has never loaded a save.",
    "The wallet is doing the playing.",
    "This is a collection, not a hobby.",
  ],
  ruin: [
    "Welcome to the hall of shame.",
    "The backlog is the library now.",
    "Funded the industry single-handedly.",
    "Purchases outnumber play sessions.",
    "At this point the shelf buys games, not the person.",
  ],
  unknown: [
    "No playtime reported. No verdict either.",
    "Verdict withheld: nobody measured the hours.",
    "Can't judge what nobody recorded.",
  ],
};

/** The band a regret score earns. One table feeds both features: the shared
 *  page's verdict line and the drawer's share nudge. */
export function verdictBand(score) {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
  if (s === null) return "unknown";
  if (s === 0) return "pristine";
  if (s < 0.10) return "tidy";
  if (s < 0.25) return "ordinary";
  if (s < 0.45) return "warning";
  if (s < 0.65) return "shame";
  return "ruin";
}

/** Imperative cousins of SHARED_VERDICTS, shown to the sharer under the copy
 *  link: pride when the shelf is clean, shame when it is a museum, neutral in
 *  between — and for a card with no score to judge by. */
export const SHARE_NUDGE_SETS = {
  pride: [
    "Share your pride.",
    "A clean shelf deserves a witness.",
    "Show the shelf. It can take it.",
  ],
  neutral: [
    "Send the damage report.",
    "Share the card as it stands.",
    "Hand over the verdict.",
  ],
  shame: [
    "Share your shame.",
    "Broadcast the damage.",
    "Own the backlog.",
  ],
};

const NUDGE_BY_BAND = {
  pristine: "pride", tidy: "pride",
  ordinary: "neutral", warning: "neutral",
  shame: "shame", ruin: "shame",
  unknown: "neutral",
};

/** One nudge from the group the score's band earns. */
export function shareNudge(score) {
  const set = SHARE_NUDGE_SETS[NUDGE_BY_BAND[verdictBand(score)]];
  return set[Math.floor(Math.random() * set.length)];
}

/** One line from the band the regret score earns. Regret is the share of
 *  known money sitting in barely-played games: 0 is a shelf with no backlog,
 *  high is the hall of shame. Missing score (old links, unknown playtime)
 *  reads the Unknown set rather than guessing. */
export function sharedVerdict(score) {
  const lines = SHARED_VERDICTS[verdictBand(score)];
  return lines[Math.floor(Math.random() * lines.length)];
}
