import test from "node:test";
import assert from "node:assert/strict";
import { applyEdits, parseEdit } from "../../public/js/edits.js";

const ROWS = [
  { id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, price: 1000 },
  { id: "Epic:9", name: "Hades", platform: "Epic", hours: 3, price: 500 },
];

test("parseEdit: an empty box clears, a figure is taken as given", () => {
  assert.deepEqual(parseEdit("price", ""), { ok: true, value: null });
  assert.deepEqual(parseEdit("price", "  500 "), { ok: true, value: 500 });
  assert.deepEqual(parseEdit("hours", "0"), { ok: true, value: 0 },
    "0 is a value, not an absence");
  assert.deepEqual(parseEdit("price", "0"), { ok: true, value: 0 },
    "and it means free");
});

test("parseEdit: nonsense is refused with words the caller can show", () => {
  for (const bad of ["abc", "-5", "1e400", "Infinity", "₹500", "two"]) {
    assert.equal(parseEdit("price", bad).ok, false, `${bad} must be refused`);
  }
  assert.equal(parseEdit("price", "10000000000").ok, false, "a price past the cap is a typo");
  assert.equal(parseEdit("hours", "10000000").ok, false, "so are impossible hours");
  assert.ok(parseEdit("price", "abc").why, "and the refusal explains itself");
});

test("applyEdits layers a price over the store's and keeps the API figure", () => {
  const out = applyEdits(ROWS, { "Steam:1": 1000, "Epic:9": 500 },
    { "Steam:1": { price: 250, currency: "INR" } }, "INR");

  assert.equal(out.games[0].price, 250, "the visitor's number wins");
  assert.equal(out.games[0].apiPrice, 1000, "the store's figure survives for Reset");
  assert.equal(out.games[1].price, 500, "an untouched row is untouched");
  assert.equal(out.prices["Steam:1"], 250, "the price map agrees with the row");
  assert.equal(out.prices["Epic:9"], 500, "and leaves the rest alone");
  assert.equal(out.games[0].edited, true);
  assert.equal(out.games[0].priceStaleCurrency, false);
});

test("applyEdits: playtime overrides the store's hours", () => {
  const out = applyEdits(ROWS, {}, { "Epic:9": { hours: 40 } }, "INR");
  assert.equal(out.games[1].hours, 40, "the visitor's hours win");
  assert.equal(out.games[1].apiHours, 3, "the store's figure survives for Reset");
  assert.equal(out.games[0].hours, 20, "and no other row moves");
});

test("clearing an override restores the store's own numbers, offline", () => {
  // Two passes: the first applies, the second — with the edit gone — must give
  // the API values back with no re-fetch, which is what apiPrice/apiHours buy.
  const first = applyEdits(ROWS, { "Steam:1": 1000 }, { "Steam:1": { price: 250 } }, "INR");
  const second = applyEdits(first.games, { "Steam:1": 1000 }, {}, "INR");
  assert.equal(second.games[0].price, 1000, "back to what the store said");
  assert.equal(second.prices["Steam:1"], 1000, "in the map too");
  assert.equal(second.games[0].edited, undefined, "and no longer marked");
});

test("applying twice never moves the API figures (no ratchet)", () => {
  const edits = { "Steam:1": { price: 250 } };
  const once = applyEdits(ROWS, { "Steam:1": 1000 }, edits, "INR");
  const twice = applyEdits(once.games, { "Steam:1": 1000 }, edits, "INR");
  assert.equal(twice.games[0].apiPrice, 1000,
    "the raw figure is never overwritten by the effective one");
  assert.equal(twice.games[0].price, 250, "the edit still applies");
});

test("a price entered in another currency is flagged, not converted", () => {
  const out = applyEdits(ROWS, { "Steam:1": 1000 },
    { "Steam:1": { price: 500, currency: "USD" } }, "INR");
  assert.equal(out.games[0].priceStaleCurrency, true,
    "there is no FX in the app to move it");
  assert.equal(out.games[0].priceCurrency, "USD", "so the drawer can name it");
});

test("an edit for a row that no longer exists changes nothing", () => {
  const out = applyEdits(ROWS, {}, { "Ghost:1": { price: 100 } }, "INR");
  assert.equal(out.games[0].edited, undefined, "the library decides what is editable");
  assert.equal(out.prices["Ghost:1"], undefined, "and no phantom price appears");
});