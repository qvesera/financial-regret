/** Unit tests for the view builders — the pieces app.test.mjs can't reach
 *  because they only exist mid-scan or inside a single card.
 *
 *  node --test runs each file in its own process, so mutating the view
 *  singleton here cannot leak into the app tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installEnv } from "./dom-stub.mjs";
import { view, pageWindow } from "../../public/js/view.js";

const state = () => ({
  currency: "INR",
  tier: "All",
  games: [],
  rows: [],
  prices: {},
  counts: {},
  bench: { samples: 0, p25: null, p50: null, p75: null, p90: null, max: null },
  verdicts: new Map(),
  comparators: { worst: [], best: [] },
});

test("renderStepper lists each source with a single progressbar", () => {
  installEnv();
  const box = document.createElement("ol");
  view.stepper = box;

  view.renderStepper({ scanSteps: [
    { label: "Steam", status: "done" },
    { label: "GOG", status: "pending" },
    { label: "Epic", status: "failed" },
  ] });

  assert.equal(box.children.length, 3, "one row per source");
  assert.equal(box.getAttribute("role"), "progressbar");
  assert.equal(box.getAttribute("aria-valuenow"), "2", "done and failed both count as settled");
  assert.equal(box.children[0].classList.contains("is-done"), true);
  assert.equal(box.children[1].classList.contains("is-pending"), true);
  assert.equal(box.children[2].classList.contains("is-failed"), true);
  assert.equal(box.children[0].querySelector(".scan-source").textContent, "Steam");

  view.renderStepper({ scanSteps: [] });
  assert.equal(box.classList.contains("hidden"), true, "hidden again once the scan ends");
  view.stepper = null;
});

test("renderTable keeps the money columns in place and appends the verdict", () => {
  installEnv();
  view.currency = "INR";
  const tbody = document.createElement("tbody");
  const verdicts = new Map([["Steam:1", "regret"]]);

  view.renderTable(tbody, [{ id: "Steam:1", name: "Hades", platform: "Steam", hours: 20 }],
    { "Steam:1": 1113 }, false, verdicts);

  const tr = tbody.children[0];
  const cells = tr.querySelectorAll("td");
  assert.equal(cells.length, 6, "five original columns plus the verdict");
  assert.equal(cells[0].textContent, "Hades", "column 0 is still the name");
  assert.equal(cells[1].textContent, "Steam", "column 1 is still the platform");
  assert.ok(cells[1].querySelector(".platform-mark"), "with the store's glyph");
  assert.equal(cells[4].textContent, "₹56/h", "column 4 is still the rate");
  assert.equal(cells[5].querySelector(".badge").getAttribute("data-tier"), "regret");
  assert.equal(cells[5].querySelector(".badge").textContent, "Regret");
});

test("renderGrid gives every card a fallback, a badge and a tab stop", () => {
  installEnv();
  view.currency = "INR";
  localStorage.removeItem("sgdb_api_key");
  const wrap = document.createElement("div");
  const verdicts = new Map([["Steam:1", "worth"]]);

  view.renderGrid(wrap, [{ id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, price: 1113, low: 599, high: 1499 }],
    { "Steam:1": 1113 }, false, verdicts);

  const card = wrap.querySelector(".game-card");
  assert.equal(card.getAttribute("role"), "button", "cards are keyboard-operable");
  assert.equal(card.tabIndex, 0);
  assert.ok(card.querySelector(".cover-fallback"), "gradient placeholder behind the art");
  assert.equal(card.querySelector(".cover-fallback").textContent, "HA");
  assert.equal(card.querySelector(".card-badge").getAttribute("data-tier"), "worth");
  assert.equal(card.querySelector(".card-hours").textContent, "20.0 h");
  assert.ok(card.querySelector(".card-sub").textContent.includes("1,113"),
    "price still shown as text under the cover");
  assert.ok(card.querySelector(".card-mark"), "the store's glyph rides beside the platform");
  // Layout contract: name, then the band, then the money line — amount
  // bottom-left, store bottom-right.
  const meta = card.querySelector(".card-meta");
  assert.ok(meta.children[1].classList.contains("price-band"),
    "the band sits between the name and the info row");
  const sub = meta.children[2];
  assert.ok(sub.classList.contains("card-sub"), "the money line comes last");
  assert.ok(sub.children[0].classList.contains("card-price"), "amount sits bottom-left");
  assert.ok(sub.children[1].classList.contains("card-store"), "store sits bottom-right");
});

test("price band marks where today's price sits", () => {
  installEnv();
  const game = { id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, low: 599, high: 1499 };
  const band = view.priceBand(game, 1113);
  assert.ok(band, "band rendered when low < high");
  assert.equal(band.getAttribute("aria-hidden"), "true", "cards repeat the fact as text");
  const pct = ((1113 - 599) / (1499 - 599)) * 100;
  assert.equal(band.querySelector(".band-fill").style.width, `${pct}%`);
  assert.equal(band.querySelector(".band-marker").style.left, `${pct}%`);
  assert.equal(view.priceBand({ id: "x" }, 100), null, "no range, no band");
});

test("the drawer explains the verdict in words", () => {
  installEnv();
  view.currency = "INR";
  const body = document.createElement("div");
  const verdicts = new Map([["Steam:1", "regret"]]);
  const s = { ...state(), verdicts };

  view.renderDrawer(body,
    { id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, low: 599, high: 1499 },
    1113, s);

  const text = body.textContent;
  assert.ok(text.includes("Current price"), "the price row survives");
  assert.ok(text.includes("Verdict"), "the verdict is named");
  assert.equal(body.querySelector(".badge").getAttribute("data-tier"), "regret");
  assert.ok(text.includes("below its all-time high"), `position reads: ${text}`);
  assert.ok(text.includes("median cost per hour"), "the maths is said out loud");
});

test("the grid is fluid: auto-fill with a readable card floor", () => {
  // The grid must track the window, not a fixed ladder — a ladder capped at
  // 6 columns parked a half-empty grid inside dead space on wide monitors.
  const css = readFileSync(new URL("../../public/style.css", import.meta.url), "utf8");
  // Anchor on the rule, not the name: prose elsewhere mentions ".grid-wrap".
  const at = css.indexOf(".grid-wrap {");
  assert.ok(at > -1, "the grid rule exists");
  // Strip comments first so the prose can mention the keyword freely.
  const block = css.slice(at, at + 400).replace(/\/\*[\s\S]*?\*\//g, "");
  const m = block.match(/repeat\(auto-fill, minmax\((\d+)px, 1fr\)\)/);
  assert.ok(m, `columns are fluid auto-fill: ${block.slice(0, 120)}`);
  const floor = Number(m[1]);
  assert.ok(floor >= 150 && floor <= 220, `card floor ${floor}px keeps covers readable`);
  const fixed = [...css.matchAll(/\.grid-wrap\s*\{[^}]*repeat\(\d,/g)];
  assert.equal(fixed.length, 0, "no media query pins a fixed column count");
});

test("the hidden attribute beats any author display rule", () => {
  // The view toggle hides the inactive view with the `hidden` attribute, but
  // the UA sheet's [hidden]{display:none} loses to class rules that set
  // `display` — the grid kept rendering under the list until the global
  // override existed.
  const css = readFileSync(new URL("../../public/style.css", import.meta.url), "utf8");
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(clean),
    "a global [hidden] { display: none !important } rule exists"
  );
});

test("pageWindow shows every page when few, a window with ellipses when many", () => {
  assert.deepEqual(pageWindow(1, 3), [1, 2, 3], "small libraries list outright");
  assert.deepEqual(pageWindow(4, 7), [1, 2, 3, 4, 5, 6, 7], "seven pages is still a short list");
  assert.deepEqual(pageWindow(1, 38), [1, 2, "…", 38], "page 1 offers the next step and the end");
  assert.deepEqual(pageWindow(2, 38), [1, 2, 3, "…", 38], "no leading gap next to page 1");
  assert.deepEqual(pageWindow(14, 38), [1, "…", 13, 14, 15, "…", 38], "the window with gaps both sides");
  assert.deepEqual(pageWindow(37, 38), [1, "…", 36, 37, 38], "no trailing gap next to the last page");
  assert.deepEqual(pageWindow(38, 38), [1, "…", 37, 38], "the last page offers the way back");
});
