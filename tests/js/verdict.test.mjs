/** Unit tests for the pure verdict engine (no DOM needed). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  benchmark, rateSamples, verdictOf, verdictMap, whatIf, coverHue, headline, comparators,
  TIER_LABEL, SHARED_VERDICTS, sharedVerdict, verdictBand, SHARE_NUDGE_SETS, shareNudge,
} from "../../public/js/verdict.js";

const g = (id, name, hours, price) => ({ id, name, hours, price, platform: "Steam" });

// 4 priced + played games → a real quartile set: 10, 20, 40, 80
const LIB = [
  g("a", "A", 40, 400),   // 10/h
  g("b", "B", 20, 400),   // 20/h
  g("c", "C", 10, 400),   // 40/h
  g("d", "D", 5, 400),    // 80/h
  g("e", "E", 0, 400),    // unplayed → not an observation
  g("f", "F", null, 400), // no hours → not an observation
  g("h", "H", 12, null),  // unpriced → not an observation
];

test("rateSamples counts priced, played, paid games with a finite rate", () => {
  assert.deepEqual(rateSamples(LIB), [10, 20, 40, 80]);
  assert.deepEqual(rateSamples([...LIB, g("fp", "FP", 30, 0)]), [10, 20, 40, 80],
    "free games are not observations of value — a zero rate cannot lose");
});

test("benchmark reports quartiles of the library", () => {
  const b = benchmark(LIB);
  assert.equal(b.samples, 4);
  assert.equal(b.p50, 30);      // pos 1.5 → 20 + (40-20)*0.5
  assert.equal(b.p25, 17.5);    // pos 0.75 → 10 + (20-10)*0.75
  assert.equal(b.p75, 50);      // pos 2.25 → 40 + (80-40)*0.25
  assert.equal(b.max, 80);
  assert.equal(b.p90, 68);      // pos 2.7 → 40 + (80-40)*0.7
});

test("benchmark stays null below three observations (no invented thresholds)", () => {
  const b = benchmark([g("a", "A", 10, 100), g("b", "B", 5, 100)]);
  assert.equal(b.samples, 2);
  assert.equal(b.p25, null);
  assert.equal(b.p50, null);
  assert.equal(verdictOf(g("a", "A", 10, 100), b), "unknown");
});

test("verdictOf sorts a game into the quartile bands", () => {
  const b = benchmark(LIB);
  assert.equal(verdictOf(g("x", "X", 40, 400), b), "worth");   // 10/h ≤ p25
  assert.equal(verdictOf(g("y", "Y", 20, 400), b), "fair");    // 20/h ≤ p50
  assert.equal(verdictOf(g("z", "Z", 1, 400), b), "regret");   // 400/h > p50
});

test("verdictOf treats a missing price and missing playtime differently", () => {
  const b = benchmark(LIB);
  assert.equal(verdictOf(g("n", "N", 10, null), b), "nodata", "price unknown");
  assert.equal(verdictOf(g("u", "U", null, 400), b), "untouched", "hours unknown");
  assert.equal(verdictOf(g("s", "S", 0.5, 400), b), "untouched", "sub-hour play");
  assert.equal(verdictOf(null, b), "nodata");
});

// The old rule here read "a free played game is always worth it" — literally
// true and worth nothing: price zero makes rate zero, unbeatable in a
// lower-is-better ratio. Worse, once free rows were a quarter of the
// benchmark they pinned p25 to exactly zero, so "Worth it" degenerated into
// "is it free" and no paid game could ever reach the top band. Free now sits
// outside the scale, and the scale ignores it.
test("free games sit outside the scale instead of owning its top", () => {
  const freeHeavy = [...LIB,
    g("fp", "FP", 30, 0), g("fq", "FQ", 60, 0), g("fr", "FR", 90, 0)];
  const b = benchmark(freeHeavy);
  assert.equal(b.p25, 17.5,
    "three zero rates do not move the paid scale at all");
  assert.equal(verdictOf(g("free", "Free", 3, 0), b), "free",
    "its own verdict: no spend, no bargain, no regret");
  assert.equal(verdictOf(g("fu", "FU", 0.5, 0), b), "untouched",
    "a free game never opened stays Untouched — playtime is checked first");
  assert.equal(verdictOf(g("x", "X", 40, 400), b), "worth",
    "a paid game still earns Worth it in a free-heavy library");

  const { best } = comparators(freeHeavy);
  assert.ok(best.length > 0 && best.every((x) => x.price > 0),
    "Best value lists paid bargains only — free games would win it by definition");
  assert.ok(!best.some((x) => x.name === "FP"));
});

test("verdictMap keys every game in the library", () => {
  const b = benchmark(LIB);
  const m = verdictMap(LIB, b);
  assert.equal(m.size, LIB.length);
  assert.equal(m.get("h"), "nodata");
  assert.equal(m.get("e"), "untouched");
});

test("whatIf replays a playtime and reports whether the verdict flips", () => {
  const b = benchmark(LIB);

  // an unplayed purchase played for 20h lands at 20/h → inside the fair band
  const now = whatIf(g("u", "Untouched", 0, 400), b, 20);
  assert.equal(now.tier, "fair");
  assert.equal(now.nowTier, "untouched", "it is unplayed today");
  assert.equal(now.changed, true, "the verdict flips");
  assert.equal(now.delta, null, "no finite current rate to compare against");

  // a played game pushed to half its hours costs double per hour
  const worse = whatIf(g("a", "A", 40, 400), b, 20);
  assert.equal(worse.nowTier, "worth");
  assert.equal(worse.tier, "fair", "20/h is no longer a bargain");
  assert.equal(worse.changed, true);
  assert.equal(worse.delta, 10, "20/h minus the current 10/h");

  // replaying at today's playtime changes nothing
  const same = whatIf(g("a", "A", 40, 400), b, 40);
  assert.equal(same.tier, "worth");
  assert.equal(same.changed, false);
  assert.equal(same.delta, 0);
});

test("whatIf never returns an infinite rate", () => {
  const b = benchmark(LIB);
  const r = whatIf(g("u", "U", 0, 400), b, 0);
  assert.equal(r.rate, null, "0 hours is not a rate");
  assert.equal(r.delta, null);
});

test("coverHue is stable per id and inside the hue circle", () => {
  assert.equal(coverHue("Steam:730"), coverHue("Steam:730"));
  assert.notEqual(coverHue("Steam:730"), coverHue("Epic:730"));
  for (const id of ["", "a", "Steam:1", null]) {
    const h = coverHue(id);
    assert.ok(h >= 0 && h < 360, `${id} → ${h}`);
  }
});

test("headline reads as a sentence and handles the empty library", () => {
  assert.equal(headline({}), "", "nothing to say yet");
  assert.equal(headline({ total: 100, played: 0 }),
    "100 games, none played yet — the shelf is the story.");
  assert.equal(headline({ total: 100, played: 38, worstName: "Anthem", worstRate: "₹2,100" }),
    "38% of 100 games played. Worst buy: Anthem at ₹2,100/h.");
  assert.equal(headline({ total: 100, played: 100 }),
    "100 of 100 games played — 100% of the library.");
});

test("comparators rank the extremes and ignore unproven games", () => {
  const { worst, best } = comparators(LIB, 3);
  assert.equal(worst[0].name, "D", "80/h is the worst buy");
  assert.equal(best[0].name, "A", "10/h is the best value");
  assert.equal(worst.length, 3, "limited to the requested count");
  assert.equal(best.length, 3);
  assert.ok(!worst.some((x) => x.name === "E"), "unplayed games are excluded");
  assert.ok(!worst.some((x) => x.name === "H"), "unpriced games are excluded");
});

test("Untouched ranks unopened games by what they cost, not by rate", () => {
  const { untouched } = comparators([
    g("u1", "U1", 0, 900),
    g("u2", "U2", 0, 1500),
    g("u3", "U3", null, 1200),   // unknown playtime counts, like the verdict
    g("p1", "P1", 10, 5000),     // played: not untouched, whatever it cost
    g("f1", "F1", 0, 0),         // free: nothing was spent
    g("n1", "N1", 0, null),      // unpriced: no price to rank on
  ]);
  assert.deepEqual(untouched.map((x) => x.name), ["U2", "U3", "U1"],
    "dearest unopened purchase first; played, free and unpriced rows stay out");
  assert.equal(untouched[0].price, 1500);
  assert.equal(untouched.length, 3, "the other three had no spend to rank by");
});

test("an all-free view ranks Best value by hours — and has no hall of shame", () => {
  const { worst, best } = comparators([
    g("f1", "Short", 3, 0),
    g("f2", "Marathon", 300, 0),
    g("f3", "Middle", 40, 0),
    g("f4", "Never", 0, 0),       // unplayed: no value shown yet
    g("p1", "Paid", 10, 500),
  ]);
  // worst keeps its paid filter, so free rows leave it empty by truth —
  // the view hides the card rather than shaming a game that cost nothing.
  assert.equal(worst.length, 1, "only the paid game is shameable at all");
  assert.equal(worst[0].name, "Paid");

  const freeOnly = comparators([
    g("f1", "Short", 3, 0), g("f2", "Marathon", 300, 0),
    g("f3", "Middle", 40, 0), g("f4", "Never", 0, 0),
  ]);
  assert.equal(freeOnly.worst.length, 0, "nothing paid, nothing shamed");
  assert.deepEqual(freeOnly.best.map((x) => x.name),
    ["Marathon", "Middle", "Short"],
    "most hours first — play is the only value a free game offers");
  assert.ok(freeOnly.best.every((x) => x.rate === 0),
    "the rate column stays honest: ₹0/h on every row");
  assert.ok(!freeOnly.best.some((x) => x.name === "Never"),
    "an unplayed free game has shown no value yet");
});

test("every tier has a human label", () => {
  for (const t of ["worth", "fair", "regret", "untouched", "nodata", "unknown"]) {
    assert.ok(TIER_LABEL[t], `${t} labelled`);
  }
});

test("the shared verdict bands the regret score, and every line is on-brand", () => {
  // The band is the whole contract: score in, line from that band out. The
  // line itself is random by design, so membership is what gets asserted —
  // never a specific string.
  assert.ok(Object.values(SHARED_VERDICTS).every((set) => set.length >= 3),
    "every band has enough lines that a reload feels alive");
  const cases = [
    [0, "pristine"], [0.09, "tidy"], [0.10, "ordinary"], [0.24, "ordinary"],
    [0.25, "warning"], [0.44, "warning"], [0.45, "shame"], [0.64, "shame"],
    [0.65, "ruin"], [0.99, "ruin"], [null, "unknown"], [NaN, "unknown"],
  ];
  for (const [score, band] of cases) {
    for (let i = 0; i < 25; i += 1) {
      const line = sharedVerdict(score);
      assert.ok(SHARED_VERDICTS[band].includes(line),
        `${score} lands in ${band}: ${line}`);
    }
  }
  // Out-of-range scores read as their clamped selves, not as chaos.
  assert.ok(SHARED_VERDICTS.pristine.includes(sharedVerdict(-0.5)));
  assert.ok(SHARED_VERDICTS.ruin.includes(sharedVerdict(3)));
});

test("the drawer nudge rides the same bands the page verdict judges with", () => {
  // The caption under the copy link and the verdict on the shared page must
  // never disagree: one band table feeds both.
  const groupOf = {
    pristine: "pride", tidy: "pride",
    ordinary: "neutral", warning: "neutral",
    shame: "shame", ruin: "shame",
    unknown: "neutral",
  };
  const cases = [
    [0, "pride"], [0.09, "pride"], [0.10, "neutral"], [0.24, "neutral"],
    [0.25, "neutral"], [0.44, "neutral"], [0.45, "shame"], [0.64, "shame"],
    [0.65, "shame"], [0.99, "shame"], [null, "neutral"], [NaN, "neutral"],
  ];
  for (const [score, group] of cases) {
    assert.equal(groupOf[verdictBand(score)], group, `${score} bands as ${group}`);
    for (let i = 0; i < 25; i += 1) {
      const line = shareNudge(score);
      assert.ok(SHARE_NUDGE_SETS[group].includes(line),
        `${score} nudges ${group}: ${line}`);
    }
    // The page verdict and the drawer nudge always read the same band.
    assert.ok(SHARED_VERDICTS[verdictBand(score)].includes(sharedVerdict(score)));
  }
  assert.ok(SHARE_NUDGE_SETS.pride.includes(shareNudge(-1)), "clamped low");
  assert.ok(SHARE_NUDGE_SETS.shame.includes(shareNudge(4)), "clamped high");
});

