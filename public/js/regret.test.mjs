import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRegret, sortByPriceDesc } from "./regret.js";

const baseGame = (overrides = {}) => ({
  id: "Steam:1",
  name: "Test Game",
  platform: "Steam",
  price: 1000,
  hours: null,
  ...overrides,
});

describe("computeRegret", () => {
  it("excludes unknown hours from regret", () => {
    const r = computeRegret([
      baseGame({ price: 1000, hours: null }),
      baseGame({ id: "Steam:2", price: 500, hours: 0.5 }),
    ]);
    assert.strictEqual(r.knownCount, 1);
    assert.strictEqual(r.unknownCount, 1);
    assert.strictEqual(r.libraryValue, 1500);
    assert.strictEqual(r.backlogValue, 500);
    assert.strictEqual(r.regretScore, 1);
  });

  it("treats null hours as unknown, never zero", () => {
    const r = computeRegret([baseGame({ price: 1000, hours: null })]);
    assert.strictEqual(r.regretScore, null);
    assert.strictEqual(r.coverage, 0);
  });

  it("value per hour excludes unplayed and unknown", () => {
    const r = computeRegret([
      baseGame({ price: 1000, hours: 10 }),
      baseGame({ id: "Steam:2", price: 500, hours: 0 }),
      baseGame({ id: "Steam:3", price: 300, hours: null }),
    ]);
    assert.strictEqual(r.valuePerHour, 1000 / 10);
  });

  it("bounds the library between all-time high and low", () => {
    const r = computeRegret([
      baseGame({ price: 1000, high: 1500, low: 400, hours: 10 }),
      baseGame({ id: "Steam:2", price: 500, high: 500, low: 250, hours: 0 }),
      baseGame({ id: "Steam:3", price: null, high: null, low: null, hours: null }),
    ]);
    assert.strictEqual(r.libraryValue, 1500);
    assert.strictEqual(r.highestEver, 2000, "1500 + 500 (unpriced adds 0)");
    assert.strictEqual(r.lowestEver, 650, "400 + 250");
    assert.ok(r.lowestEver <= r.libraryValue && r.libraryValue <= r.highestEver,
      "low <= current <= high");
  });

  it("falls back to today's price when high/low are unknown", () => {
    const r = computeRegret([baseGame({ price: 800, hours: 5 })]);
    assert.strictEqual(r.highestEver, 800);
    assert.strictEqual(r.lowestEver, 800);
  });

  it("sums the hours on record, ignoring unknown playtime", () => {
    const r = computeRegret([
      baseGame({ price: 1000, hours: 10 }),
      baseGame({ id: "Steam:2", price: 500, hours: 2.5 }),
      baseGame({ id: "Steam:3", price: 300, hours: null }),
      baseGame({ id: "Steam:4", price: 200, hours: 0 }),
    ]);
    assert.strictEqual(r.totalHours, 12.5, "null hours never counted; zeros add nothing");
  });

  it("empty list returns zeros and nulls", () => {
    const r = computeRegret([]);
    assert.strictEqual(r.libraryValue, 0);
    assert.strictEqual(r.regretScore, null);
    assert.strictEqual(r.valuePerHour, null);
    assert.strictEqual(r.coverage, null);
  });
});

describe("sortByPriceDesc", () => {
  it("sorts highest price first, nulls last", () => {
    const games = [
      baseGame({ id: "a", price: 100 }),
      baseGame({ id: "b", price: null }),
      baseGame({ id: "c", price: 500 }),
    ];
    const sorted = [...games].sort(sortByPriceDesc);
    assert.strictEqual(sorted[0].id, "c");
    assert.strictEqual(sorted[1].id, "a");
    assert.strictEqual(sorted[2].id, "b");
  });
});
