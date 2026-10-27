import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pricePerHour, perHour, money } from "./format.js";

describe("pricePerHour", () => {
  it("divides normally at one hour or more", () => {
    assert.equal(pricePerHour(500, 10), 50);
    assert.equal(pricePerHour(500, 1), 500);
    assert.equal(pricePerHour(600, 2), 300);
  });

  it("caps sub-hour play at the purchase price", () => {
    assert.equal(pricePerHour(500, 0.5), 500, "0.5h must not double the price");
    assert.equal(pricePerHour(500, 0.1), 500);
    assert.equal(pricePerHour(499, 0.9), 499);
    assert.ok(pricePerHour(500, 0.5) <= 500, "never above what you paid");
  });

  it("treats never-played as an infinite rate", () => {
    assert.equal(pricePerHour(500, 0), Infinity);
  });

  it("returns null when the price or playtime is unknown", () => {
    assert.equal(pricePerHour(null, 10), null);
    assert.equal(pricePerHour(500, null), null);
    assert.equal(pricePerHour(null, null), null);
  });

  it("charges nothing per hour for a free game", () => {
    assert.equal(pricePerHour(0, 0), 0);
    assert.equal(pricePerHour(0, 5), 0);
    assert.equal(pricePerHour(0, 0.5), 0);
  });
});

describe("perHour", () => {
  it("formats a finite rate", () => {
    assert.equal(perHour(500, "INR"), "₹500/h");
    assert.equal(perHour(55.65, "INR"), "₹56/h");
  });

  it("renders an infinite rate symbolically", () => {
    assert.equal(perHour(Infinity, "INR"), "∞/h");
  });

  it("renders an unknown rate as a dash", () => {
    assert.equal(perHour(null, "INR"), "—");
  });
});

describe("money", () => {
  it("renders an amount in the chosen currency", () => {
    assert.equal(money(500, "INR"), "₹500.00");
  });
  it("renders unknown as a dash", () => {
    assert.equal(money(null, "INR"), "—");
  });
});
