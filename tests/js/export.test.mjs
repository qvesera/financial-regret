/** Card exports: the specs that decide what a card says, the share-link
 *  codec, and the painter — all testable without a real canvas. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardSpec, encodeCard, decodeCard, shareUrl, drawCard, drawRupee, rupeeSvg,
  exportKinds, kindLabel, pixelCapRatio, CARD_TOKENS, CARD_W, CARD_H,
} from "../../public/js/export.js";
import { benchmark, verdictMap, comparators } from "../../public/js/verdict.js";
import { computeRegret } from "../../public/js/regret.js";

// Six games covering every verdict: Hades is a regret (55.65/h), Celeste fair
// (40/h), Disco Elysium worth it (20/h), Pocket F2P free, Cyberpunk and Elden
// Ring untouched. Rates are INR; the arithmetic is the dashboard's own.
const GAMES = [
  { id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, price: 1113 },
  { id: "Steam:2", name: "Cyberpunk 2077", platform: "Steam", hours: 0, price: 1855 },
  { id: "Steam:3", name: "Elden Ring", platform: "Steam", hours: null, price: 1457 },
  { id: "Steam:4", name: "Pocket F2P", platform: "Steam", hours: 5, price: 0 },
  { id: "GOG:1", name: "Disco Elysium", platform: "GOG", hours: 45, price: 900 },
  { id: "GOG:2", name: "Celeste", platform: "GOG", hours: 10, price: 400 },
];

function makeState(patch = {}) {
  const bench = benchmark(GAMES);
  return {
    currency: "INR",
    games: GAMES,
    rows: GAMES,
    bench,
    verdicts: verdictMap(GAMES, bench),
    comparators: comparators(GAMES),
    metrics: computeRegret(GAMES),
    tier: "All", platform: "All", filter: "All", search: "",
    ...patch,
  };
}

test("the wrapped card states the same figures the dashboard does", () => {
  const spec = cardSpec(makeState(), "wrapped");
  assert.equal(spec.title, "WRAPPED");
  assert.equal(spec.badge, "6 GAMES");
  const stats = Object.fromEntries(spec.stats.map((x) => [x.label, x.value]));
  assert.equal(stats["LIBRARY VALUE"], "₹5,725.00");
  assert.equal(stats["TOTAL HOURS"], "80 h");
  // backlog 1855 ÷ known 4268 = 43%
  assert.equal(stats["REGRET SCORE"], "43%");
  assert.equal(stats["PLAYED"], "67%");
  assert.ok(spec.rows.some((r) => r.name.includes("Hades")), "the worst buy is named");
  assert.ok(spec.rows.some((r) => r.name.includes("Disco Elysium")), "the best value is named");
  assert.ok(spec.rows.some((r) => r.name.includes("Cyberpunk")), "the biggest idle buy is named");
});

test("the wrapped card is the whole library, whatever the filters say", () => {
  // A filtered view is what the other cards are for. Wrapped is the
  // screenshot card — if a facet shrank it, the numbers would quietly be
  // about the filter instead of the library.
  const gogOnly = makeState({
    platform: "GOG",
    rows: GAMES.filter((g) => g.platform === "GOG"),
  });
  const spec = cardSpec(gogOnly, "wrapped");
  assert.equal(spec.badge, "6 GAMES", "the badge counts the library, not the view");
  const stats = Object.fromEntries(spec.stats.map((x) => [x.label, x.value]));
  assert.equal(stats["LIBRARY VALUE"], "₹5,725.00", "whole-library spend");
  assert.equal(stats["TOTAL HOURS"], "80 h", "whole-library hours");
  assert.ok(spec.rows.some((r) => r.name.includes("Hades")),
    "the library's worst buy, not the GOG view's");
});

test("each verdict card holds only its own members, ranked its own way", () => {
  const s = makeState();

  const untouched = cardSpec(s, "verdict:untouched");
  assert.equal(untouched.tier, "untouched");
  assert.deepEqual(untouched.rows.map((r) => r.name),
    ["Cyberpunk 2077", "Elden Ring"], "dearest unopened first");
  assert.equal(untouched.rows[0].value, "₹1,855.00");
  assert.ok(!untouched.stats.some((x) => x.label === "HOURS ON RECORD"),
    "a sub-hour opening is not playtime worth claiming above rows that say unopened");
  const idle = untouched.stats.find((x) => x.label === "AVG IDLE COST");
  assert.equal(idle && idle.value, "₹1,656.00", "3312 ÷ 2 idle games");

  assert.equal(cardSpec(s, "verdict:regret").rows[0].name, "Hades");
  assert.equal(cardSpec(s, "verdict:worth").rows[0].name, "Disco Elysium",
    "Worth it reads cheapest-per-hour first");
  assert.equal(cardSpec(s, "verdict:fair").rows[0].name, "Celeste");
  assert.equal(cardSpec(s, "verdict:free").rows[0].value, "₹0/h",
    "a free game's value is play, at an honest zero rate");
  assert.equal(cardSpec(s, "verdict:nodata"), null,
    "no unpriced games, no card — the UI says so rather than exporting a lie");
});

test("the chip list offers only what the library can fill", () => {
  const kinds = exportKinds(makeState());
  for (const k of ["wrapped", "worst", "best", "verdict:worth",
    "verdict:fair", "verdict:regret", "verdict:untouched", "verdict:free", "view"]) {
    assert.ok(kinds.includes(k), `${k} is offered`);
  }
  assert.ok(!kinds.includes("verdict:nodata"), "an empty verdict never gets a chip");
  assert.ok(!kinds.includes("untouched"),
    "no view-scoped idle twin: the verdict card is the single Untouched card");
  assert.equal(kindLabel("wrapped"), "Wrapped");
  assert.equal(kindLabel("verdict:untouched"), "Untouched");
  assert.equal(kindLabel("verdict:fair"), "Fair");
});

test("the view card carries the live filters", () => {
  const gogRows = GAMES.filter((g) => g.platform === "GOG");
  const spec = cardSpec(makeState({ platform: "GOG", rows: gogRows }), "view");
  assert.equal(spec.title, "YOUR VIEW");
  assert.equal(spec.badge, "GOG");
  assert.equal(spec.stats[0].value, "2");
  assert.deepEqual(spec.rows.map((r) => r.name),
    ["Disco Elysium", "Celeste"], "in the view's own sort order");
});

test("a share link round-trips and refuses anything else", () => {
  const spec = cardSpec(makeState({ steamPersona: "Sir Regrets" }), "wrapped");
  assert.equal(spec.who, "Sir Regrets",
    "the card is signed by the Steam name, not the hostname");
  const encoded = encodeCard(spec);
  assert.deepEqual(decodeCard(`#card=${encoded}`), spec, "byte-for-byte after JSON");
  assert.equal(decodeCard("#card=!!!not-base64!!!"), null);
  assert.equal(decodeCard("#nothing"), null);
  assert.equal(decodeCard(""), null);
  const foreign = btoa(JSON.stringify({ v: 2, title: "WRAPPED" }));
  assert.equal(decodeCard(`#card=${foreign}`), null, "a foreign version is not ours");
  const truncated = btoa("{not json");
  assert.equal(decodeCard(`#card=${truncated}`), null, "a corrupt payload never throws");
  assert.ok(shareUrl(spec, "https://x.test").startsWith("https://x.test/#card="));
});

function fakeCtx() {
  const texts = [];
  const rects = [];
  const fonts = [];
  const ctx = {
    texts, rects, fonts,
    fillStyle: "", strokeStyle: "", lineWidth: 0, textAlign: "", font: "",
    fillRect: (...a) => rects.push(a),
    strokeRect: (...a) => rects.push(a),
    fillText: (t) => { texts.push(String(t)); fonts.push([String(t), ctx.font]); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    measureText: (t) => ({ width: String(t).length * 14 }),
  };
  return ctx;
}

test("the painter draws the arcade card, scanlines and watermark and all", () => {
  const spec = cardSpec(makeState(), "worst");
  spec.src = "regret.example";
  const ctx = fakeCtx();
  drawCard(ctx, spec, CARD_TOKENS);

  assert.ok(ctx.texts.includes("HALL OF SHAME"));
  assert.ok(ctx.texts.some((t) => t.includes("Hades")), "the rows are drawn");
  assert.ok(ctx.texts.includes("egret"),
    "the watermark wears the wordmark, in the pixel font");
  const markFont = ctx.fonts.find(([t]) => t === "egret");
  assert.ok(markFont && markFont[1].includes("Press Start 2P"),
    `drawn in the pixel font, not mono: ${markFont && markFont[1]}`);
  assert.ok(!ctx.texts.includes("₹"),
    "the rupee is drawn, never typed — no font fallback anywhere");
  const statBlocks = ctx.rects.filter((r) => r[2] === 5 && r[3] === 5);
  assert.equal(statBlocks.length, 15,
    "the stat's ₹ is fifteen pixel blocks (the '₹56/h' value)");
  const markBlocks = ctx.rects.filter((r) => r[2] === 2 && r[3] === 2);
  assert.equal(markBlocks.length, 15,
    "and so is the watermark's, one block size down");
  assert.ok(ctx.texts.includes("financial-regret.vercel.app"),
    "and names where to get it — the project home, not this hostname");
  const scanlines = ctx.rects.filter((r) => r[3] === 1);
  assert.equal(scanlines.length, Math.floor(CARD_H / 3),
    "one transparent pixel every three, the toy-screen skin");
  assert.ok(ctx.rects.some((r) => r[2] === CARD_W && r[3] === CARD_H),
    "the background covers the whole card");
});

test("the rupee glyph is hand-drawn pixel art — one grid, two surfaces", () => {
  const ctx = fakeCtx();
  drawRupee(ctx, 10, 70, 70, "#fff");   // size 70 → 10px blocks, top at 20
  assert.equal(ctx.rects.length, 15, "fifteen blocks make the sign");
  assert.ok(ctx.rects.every(([, , w, h]) => w === 10 && h === 10),
    "square blocks, sized to the request — never fractional pixels");
  assert.deepEqual(ctx.rects[0], [10, 20, 10, 10],
    "baseline-aligned: the top bar starts at the top-left");
  assert.equal(ctx.fillStyle, "#fff", "drawn in the caller's ink");

  const svg = rupeeSvg();
  assert.ok(svg.includes('viewBox="0 0 5 5"'),
    "the same 5×5 grid — one block per Press Start 2P design pixel");
  assert.equal((svg.match(/<rect/g) || []).length, 15,
    "the same fifteen blocks, as SVG for the DOM wordmark");
  assert.ok(svg.includes('aria-hidden="true"'),
    "decorative — the word beside it carries the name");
});

test("the DOM rupee is sized from the font's measured cap height", async () => {
  // Without a canvas (the test environment) the measured value degrades to
  // the classic five-of-eight guess rather than throwing.
  assert.equal(await pixelCapRatio(), 0.625);
});
