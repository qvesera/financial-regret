/** Verdict engine — pure, no DOM, no I/O.
 *
 *  Two lenses judge a library, and every row is judged by exactly one of them:
 *
 *  - **content** — playtime ÷ typical length, for games whose length is known.
 *    Finished is finished: a 6-hour indie you completed is 100% consumed, not
 *    a ₹166/h failure. Graded against your own library's quartiles of
 *    consumption, inverted so that higher is better.
 *  - **rate** — price ÷ hours, the original model, for everything else.
 *
 *  Both read your library's own distribution, never a hardcoded threshold:
 *  what counts as a rip-off depends on what you normally pay and how you
 *  normally finish. Quartiles (p25/p50/p75) are the whole model, which is why
 *  the UI can draw them as box plots.
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

/** Share of a finite game actually consumed: playtime ÷ typical length,
 *  capped at 1 — finishing early is still finished, and a 6-hour campaign
 *  inside a 500-hour game is 100%, not 8000%. Null when either number is
 *  missing, so a row without a length stays untouched: the verdict lens this
 *  feeds lands with it, and until then it is an annotation the drawer shows. */
export function contentPct(game) {
  if (!game || game.hours == null || !(game.expectedHours > 0)) return null;
  const pct = game.hours / game.expectedHours;
  return Number.isFinite(pct) ? Math.min(1, pct) : null;
}

/** Consumption observations for the content bench: played games (an hour or
 *  more — an unopened game is not an observation of consumption) whose length
 *  is known, ascending. Mirrors rateSamples' rule that only evidence counts. */
export function contentSamples(rows) {
  const out = [];
  for (const g of rows || []) {
    if (!g || g.hours == null || g.hours < 1) continue;
    const pct = contentPct(g);
    if (pct != null) out.push(pct);
  }
  return out.sort((a, b) => a - b);
}

/** The content benchmark: quartiles of how much of their lengths your library
 *  has actually consumed. Below three observations there is no meaningful
 *  quartile (bounds stay null); and when the spread is degenerate — everyone
 *  sits at (nearly) the same point — quartiles would grade every row by mere
 *  equality, so `degenerate` tells the caller to use fixed marks instead. */
export function contentBench(rows) {
  const s = contentSamples(rows);
  const enough = s.length >= 3;
  const p25 = enough ? quantile(s, 0.25) : null;
  const p75 = enough ? quantile(s, 0.75) : null;
  return {
    samples: s.length,
    p25,
    p50: enough ? quantile(s, 0.5) : null,
    p75,
    p90: enough ? quantile(s, 0.9) : null,
    max: s.length ? s[s.length - 1] : null,
    degenerate: enough && p75 - p25 < 0.05,
  };
}

/** Which lens judged this row: content when a length exists *and* the library
 *  holds enough lengths to compare against (three, same floor as the rate
 *  bench), rate otherwise. The lens travels with verdicts, rankings and
 *  badges so no display has to re-derive it. */
export function lensOf(game, contentBench) {
  if (!game || contentPct(game) == null) return "rate";
  if (!contentBench || (contentBench.samples || 0) < 3) return "rate";
  return "content";
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
export function verdictOf(game, rateBench, contentBench) {
  if (!game || game.price == null) return "nodata";
  if (game.hours == null || game.hours < 1) return "untouched";
  // Playtime is checked first on purpose: a free game never opened is still
  // Untouched — the play truth comes before the money truth.
  if (game.price === 0) return "free";
  // Content lens first: a game with a known length is judged on how much of it
  // you consumed, not on how expensive its hours were — which is the entire
  // criticism this lens exists to answer.
  if (lensOf(game, contentBench) === "content") {
    const pct = contentPct(game);
    if (contentBench.degenerate) {
      // Everyone at (nearly) the same point: quartiles would call every row
      // Worth it for being equal to itself. Fixed marks instead.
      if (pct >= 0.9) return "worth";
      if (pct >= 0.5) return "fair";
      return "regret";
    }
    if (pct >= contentBench.p75) return "worth";
    if (pct >= contentBench.p25) return "fair";
    return "regret";
  }
  const rate = pricePerHour(game.price, game.hours);
  if (rate == null || !Number.isFinite(rate)) return "untouched";
  if (!rateBench || rateBench.p25 == null) return "unknown";
  if (rate <= rateBench.p25) return "worth";
  if (rate <= rateBench.p50) return "fair";
  return "regret";
}

/** Every verdict for a library, keyed by game id. */
export function verdictMap(rows, rateBench, contentBench) {
  const out = new Map();
  for (const g of rows || []) out.set(g.id, verdictOf(g, rateBench, contentBench));
  return out;
}

/** Replay a game at a hypothetical playtime: what the per-hour rate would be,
 *  what fraction of its length that would consume, and whether either flips
 *  the verdict. Used by the what-if slider. `contentBench` is optional —
 *  without it (or without a length on the game) the replay is judged on the
 *  rate lens, exactly as before. */
export function whatIf(game, rateBench, hours, contentBench) {
  const h = Number(hours);
  const rate = pricePerHour(game ? game.price : null, h);
  const nowRate = game ? pricePerHour(game.price, game.hours) : null;
  const playable = game && game.price != null && Number.isFinite(h) && h >= 1;
  // The replay keeps the game's own length: dragging hours changes the
  // numerator, never what the game is meant to be.
  const replay = playable && game
    ? { price: game.price, hours: h, expectedHours: game.expectedHours }
    : game;
  const tier = playable
    ? verdictOf(replay, rateBench, contentBench)
    : verdictOf(game, rateBench, contentBench);
  const nowTier = game ? verdictOf(game, rateBench, contentBench) : "nodata";
  const replayPct = playable && game && game.expectedHours > 0
    ? contentPct({ hours: h, expectedHours: game.expectedHours })
    : null;
  return {
    rate: rate != null && Number.isFinite(rate) ? rate : null,
    tier,
    nowTier,
    nowRate: nowRate != null && Number.isFinite(nowRate) ? nowRate : null,
    delta: rate != null && Number.isFinite(rate) && nowRate != null && Number.isFinite(nowRate)
      ? rate - nowRate
      : null,
    changed: tier !== nowTier,
    lens: lensOf(game, contentBench),
    contentPct: replayPct,
    nowContentPct: game ? contentPct(game) : null,
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
 *  formatted — this module never touches a currency formatter. `worstNote`
 *  lets the caller describe the worst buy in its own lens ("50% of 12 h"),
 *  instead of forcing a rupee rate onto a content-graded row. */
export function headline({ total = 0, played = 0, worstName = null, worstRate = null, worstNote = null } = {}) {
  if (!total) return "";
  const pct = Math.round((played / total) * 100);
  if (!played) return `${total} games, none played yet — the shelf is the story.`;
  if (!worstName) return `${played} of ${total} games played — ${pct}% of the library.`;
  if (worstNote) return `${pct}% of ${total} games played. Worst buy: ${worstName} — ${worstNote}.`;
  return `${pct}% of ${total} games played. Worst buy: ${worstName} at ${worstRate}/h.`;
}

/** Ranked extremes for the insight cards, on two axes.
 *
 *  Every row keeps the axis that judged it: rows with a known length rank by
 *  content consumed (least first for worst, most first for best), rows
 *  without one rank by price ÷ hours as before. The populations never mix
 *  inside a sort — content rows lead, rate rows fill the remaining slots —
 *  and each entry carries `lens`, `contentPct` and `expectedHours` so every
 *  display can say which number it is showing.
 *
 *  Games need at least an hour of play to be evidence about value — a
 *  10-minute session proves nothing — and a price above zero, because a free
 *  game tops Best value by definition and would colonise the list while
 *  proving nothing about what a purchase was worth.
 */
export function comparators(rows, limit = 5, contentBench) {
  const base = (rows || [])
    .filter((x) => x.price != null && x.price > 0 && x.hours != null && x.hours >= 1)
    .map((x) => ({ row: x, rate: pricePerHour(x.price, x.hours) }))
    .filter((x) => Number.isFinite(x.rate));
  const rated = base.filter((x) => lensOf(x.row, contentBench) !== "content")
    .map((x) => ({
      id: x.row.id, name: x.row.name, hours: x.row.hours, price: x.row.price,
      rate: x.rate, lens: "rate",
    }));
  const contented = base.filter((x) => lensOf(x.row, contentBench) === "content")
    .map((x) => ({
      id: x.row.id, name: x.row.name, hours: x.row.hours, price: x.row.price,
      rate: x.rate, lens: "content",
      contentPct: contentPct(x.row), expectedHours: x.row.expectedHours,
    }));

  const desc = [...rated].sort((a, b) => b.rate - a.rate || (b.hours || 0) - (a.hours || 0));
  // Worst: the least-consumed games first (that is the criticism this lens
  // answers), then the dearest hours filling whatever slots are left. The two
  // axes are never sorted against each other — each row shows its own number.
  const contentWorst = [...contented]
    .sort((a, b) => (a.contentPct ?? 1) - (b.contentPct ?? 1) || b.rate - a.rate)
    .slice(0, limit);
  const worst = [
    ...contentWorst,
    ...desc.slice(0, Math.max(0, limit - contentWorst.length)),
  ];
  // Best: the most-consumed first, then the cheapest hours.
  const contentBest = [...contented]
    .sort((a, b) => (b.contentPct ?? 0) - (a.contentPct ?? 0) || a.rate - b.rate)
    .slice(0, limit);
  const paidBest = [
    ...contentBest,
    ...[...desc].reverse().slice(0, Math.max(0, limit - contentBest.length)),
  ];
  // Best value falls back to free games when nothing paid qualifies — in an
  // all-free view the only value on offer is play itself, so the most hours
  // wins. Rate stays 0 because free is 0/h: honest, and uniform across rows.
  // The worst list gains nothing from this fallback: worst stays empty for
  // free rows (nothing was paid), and the view hides that card outright
  // rather than implying a free game could ever be a bad buy.
  const freeBest = (rows || [])
    .filter((x) => x.price === 0 && x.hours != null && x.hours >= 1)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, limit)
    .map((x) => ({ id: x.id, name: x.name, hours: x.hours, price: 0, rate: 0, lens: "rate" }));
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
    worst,
    best: paidBest.length ? paidBest : freeBest,
    untouched,
    // Which axis filled each list — the titles, chips and card faces follow
    // this rather than guessing from the rows.
    worstLens: worst.length ? worst[0].lens : null,
    bestLens: paidBest.length ? paidBest[0].lens : null,
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
