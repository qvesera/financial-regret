/** The arithmetic under the PS Plus paid KPI's "at most" line.
 *
 *  Pure functions, so these run without the DOM: what is being tested is the
 *  shape of the estimate -- whole months, a real price, and nothing at all
 *  when either input is missing -- not how it is painted. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { monthsBetween, estimatePlusSpend } from "../../public/js/plus.js";

test("monthsBetween counts whole calendar months", () => {
  assert.equal(monthsBetween("2016-07-10", "2016-07-28"), 0, "same month");
  assert.equal(monthsBetween("2016-07-10", "2016-08-09"), 0,
    "the day has not come round yet, so no month was paid");
  assert.equal(monthsBetween("2016-07-10", "2016-08-10"), 1);
  // 2016-07-10 -> 2026-11-06: ten years plus four months, less one because
  // the 6th precedes the 10th.
  assert.equal(monthsBetween("2016-07-10", "2026-11-06"), 123);
  assert.equal(monthsBetween("2020-01-31", "2020-03-01"), 1,
    "a short February does not complete a month from the 31st");
  assert.equal(monthsBetween("2020-01-01", "2019-01-01"), 0,
    "an end before the start is not negative time");
});

test("monthsBetween refuses anything it cannot parse", () => {
  assert.equal(monthsBetween(null, "2026-11-06"), null);
  assert.equal(monthsBetween(undefined, "2026-11-06"), null);
  assert.equal(monthsBetween("yesterday-ish", "2026-11-06"), null);
  assert.equal(monthsBetween("2016-07-10", "not a date"), null);
});

test("the estimate is months at the monthly price, rounded to the coin", () => {
  assert.deepEqual(
    estimatePlusSpend({ firstPlayed: "2016-07-10", monthlyPrice: 149, now: "2026-11-06" }),
    { months: 123, total: 18327 });
  assert.deepEqual(
    estimatePlusSpend({ firstPlayed: "2024-01-01", monthlyPrice: 9.99, now: "2024-04-01" }),
    { months: 3, total: 29.97 });
});

test("a missing input means no estimate, never a zero", () => {
  const now = "2026-11-06";
  // A zero would read as "you have paid nothing", which is a claim about the
  // visitor's history that nothing here can support.
  for (const firstPlayed of ["", null, undefined, "not a date"]) {
    assert.equal(estimatePlusSpend({ firstPlayed, monthlyPrice: 149, now }), null,
      `${String(firstPlayed)} must not produce a figure`);
  }
  for (const monthlyPrice of [undefined, null, 0, -5, NaN, "149"]) {
    assert.equal(estimatePlusSpend({ firstPlayed: "2016-07-10", monthlyPrice, now }), null,
      `${monthlyPrice} must not produce a figure`);
  }
  assert.equal(
    estimatePlusSpend({ firstPlayed: "2026-11-01", monthlyPrice: 149, now }),
    null, "joined this month: no elapsed months to price yet");
  assert.equal(estimatePlusSpend(), null, "no arguments at all");
});
