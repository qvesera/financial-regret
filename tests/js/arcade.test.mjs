import { test } from "node:test";
import assert from "node:assert/strict";
import { installEnv } from "./dom-stub.mjs";
import {
  toyState, renderVerdictToy, paintVerdictToy,
  TOY_SAMPLE, TOY_GAME, TOY_MAX, TOY_DEFAULT,
} from "../../public/js/arcade.js";
import { benchmark } from "../../public/js/verdict.js";

test("one drag spans every verdict the product can give", () => {
  // The whole pitch of the toy: four tiers, measured, not asserted by eye.
  assert.equal(toyState(0).tier, "untouched", "a never-opened game reads Untouched");
  assert.equal(toyState(1).tier, "regret", "one hour of a ₹690 game is Regret");
  assert.equal(toyState(23).tier, "fair", "23h crosses into Fair");
  assert.equal(toyState(53).tier, "worth", "53h reaches Worth it");

  // Strictly improving: dragging right must never make the verdict worse.
  const order = ["untouched", "regret", "fair", "worth"];
  const seen = [0, 1, 23, 53].map((h) => order.indexOf(toyState(h).tier));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], "monotonic");
});

test("the sample library is large enough to produce a benchmark at all", () => {
  // Below three priced, playing games benchmark() withholds quartiles and every
  // verdict reads "No benchmark" — a demo that judges nothing.
  const bench = benchmark(TOY_SAMPLE);
  assert.ok(bench.samples >= 3, `only ${bench.samples} priced samples`);
  assert.notEqual(bench.p25, null);
  assert.ok(TOY_SAMPLE.every((g) => g.price > 0 && g.hours > 0));
});

test("renders a playable slider wired to the delegated input handler", () => {
  installEnv();
  const toy = renderVerdictToy();

  // No ATTRACT MODE banner: the arcade term read as an error message, and
  // the toy explains itself in the copy below the slider instead.
  assert.equal(toy.querySelector(".toy-kicker"), null);

  const range = toy.querySelector("#toy-hours");
  assert.ok(range, "slider present");
  assert.equal(range.type, "range");
  assert.equal(range.dataset.action, "toy",
    "routes through app.js's delegated input listener — no per-node listener to lose on re-render");
  assert.equal(range.min, "0");
  assert.equal(range.max, String(TOY_MAX));
  assert.equal(range.value, String(TOY_DEFAULT));

  // The label points at the input, and the badge announces itself.
  assert.equal(toy.querySelector("#toy-label").htmlFor, "toy-hours",
    "label must be associated with the slider, not just sit near it");
  assert.equal(toy.querySelector("#toy-badge").getAttribute("role"), "status");
});

test("the badge ships populated, not blank until the first drag", () => {
  installEnv();
  const toy = renderVerdictToy();
  const badge = toy.querySelector("#toy-badge");
  assert.equal(badge.textContent, "Untouched",
    "initial paint must happen during the build");

  // Caveat worth writing down: dom-stub registers ids eagerly on assignment,
  // so it would pass even if the initial paint used a document lookup — which
  // fails in a real browser while the section is still detached. The refs path
  // below is therefore what actually pins the behaviour.
  const detached = { textContent: "", className: "", dataset: {} };
  paintVerdictToy(53, { badge: detached });
  assert.equal(detached.textContent, "Worth it");
  assert.equal(detached.className, "badge badge-worth");
  assert.equal(detached.dataset.tier, "worth");
});

test("painting by id works once the toy is in the document", () => {
  installEnv();
  const toy = renderVerdictToy();
  document.documentElement.appendChild(toy);   // registers its ids

  paintVerdictToy(1);
  assert.equal(document.getElementById("toy-badge").textContent, "Regret");
  assert.match(document.getElementById("toy-out").textContent, /1h/);
  assert.match(document.getElementById("toy-rate").textContent, /₹/);

  paintVerdictToy(23);
  assert.equal(document.getElementById("toy-badge").textContent, "Fair");
});

test("the frame at 0h explains itself instead of showing a blank rate", () => {
  installEnv();
  const toy = renderVerdictToy();
  const note = toy.querySelector("#toy-note");
  assert.match(note.textContent, /never opened/);
  assert.equal(toy.querySelector("#toy-rate").textContent, "—");
});

test("the demo cartridge ships a real game's cover and price", () => {
  // A real title, not an invention: Hollow Shard had no store page to fetch
  // anything from, which is exactly why the frame used to come up empty. The
  // cover still ships beside the page (img-src 'self' forbids a runtime CDN
  // fetch) and the price is the game's actual list price — the toy's
  // "no sign-up, no key" pitch rules out a live lookup either way.
  assert.equal(TOY_GAME.name, "Hollow Knight", "a real game, not an invention");
  assert.match(TOY_GAME.cover, /^covers\//, "the cover ships beside the page");
  assert.ok(TOY_GAME.price > 0, "the price is baked, not left blank");

  installEnv();
  const toy = renderVerdictToy();
  const cover = toy.querySelector(".toy-cover");
  assert.ok(cover, "cover art renders in the card");
  assert.equal(cover.src, TOY_GAME.cover);
  assert.equal(cover.alt, "",
    "decorative: the game's name is already the heading beside it");
  assert.equal(toy.querySelector(".toy-price").textContent, "₹690",
    "the game's real list price, and the figure the verdict arithmetic uses");
});
