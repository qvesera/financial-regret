import test from "node:test";
import assert from "node:assert/strict";
import { fetchPrices, fetchPsnPrices } from "../../public/js/api.js";

// api.js reaches for localStorage; the module has no other global deps.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const PSN = { id: "PSN:PPSA00142_00", name: "Astro Bot", platform: "PlayStation", titleId: "PPSA00142_00" };
const STEAM = { id: "steam_1", name: "Portal 2", platform: "Steam" };

/** fetch stub: records every call, answers from `routes`. */
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const r = routes[u] || { ok: false, status: 404, json: {} };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json || {} };
  };
  return calls;
}

test("fetchPrices splits PSN rows to PlatPrices and the rest to ITAD", async () => {
  const calls = stub({
    "/api/prices": { json: { prices: { steam_1: 19.99 }, highs: {}, lows: {}, currency: "INR" } },
    "/api/psn_prices": { json: { prices: { "PSN:PPSA00142_00": 39.99 }, highs: {}, lows: {}, currency: "INR" } },
  });

  const out = await fetchPrices([PSN, STEAM], "INR");

  const itad = calls.find((c) => c.url === "/api/prices");
  const psn = calls.find((c) => c.url === "/api/psn_prices");
  assert.ok(itad, "ITAD was called");
  assert.ok(psn, "PlatPrices was called");

  // ITAD has no PlayStation catalog at all, so offering the PSN row to it would
  // only ever come back unpriced -- the row has to be routed elsewhere.
  assert.deepEqual(itad.body.games.map((g) => g.id), ["steam_1"]);
  assert.deepEqual(psn.body.games, [{ id: "PSN:PPSA00142_00", titleId: "PPSA00142_00" }]);

  assert.equal(out.prices["steam_1"], 19.99);
  assert.equal(out.prices["PSN:PPSA00142_00"], 39.99);
});

test("a dead PlatPrices call leaves PSN rows Unpriced without failing the batch", async () => {
  stub({
    "/api/prices": { json: { prices: { steam_1: 19.99 }, highs: {}, lows: {}, currency: "INR" } },
    "/api/psn_prices": { ok: false, status: 500, json: { error: "boom" } },
  });

  const out = await fetchPrices([PSN, STEAM], "INR");

  assert.equal(out.prices["steam_1"], 19.99, "Steam prices survive a PSN outage");
  assert.equal(out.prices["PSN:PPSA00142_00"], undefined);
});

test("a PSN row with no titleId is never offered to PlatPrices", async () => {
  const calls = stub({
    "/api/prices": { json: { prices: {}, highs: {}, lows: {}, currency: "INR" } },
  });

  await fetchPrices([{ ...PSN, titleId: null }], "INR");

  assert.ok(!calls.some((c) => c.url === "/api/psn_prices"),
    "PlatPrices joins on the title id, so a row without one is skipped");
});

test("fetchPsnPrices sends a user-supplied PlatPrices key as a header", async () => {
  globalThis.localStorage.getItem = (k) => (k === "platprices_api_key" ? "my-key" : null);
  const calls = stub({ "/api/psn_prices": { json: { prices: {}, highs: {}, lows: {} } } });

  await fetchPsnPrices([PSN], "INR");

  const call = calls.find((c) => c.url === "/api/psn_prices");
  assert.equal(call.opts.headers["X-Platprices-Key"], "my-key");
  globalThis.localStorage.getItem = () => null;
});


test("fetchPrices surfaces the provider credit the UI must display", async () => {
  // PlatPrices' free and Indie plans require crediting it wherever its data
  // appears, so the credit has to survive the merge back into one result.
  stub({
    "/api/prices": { json: { prices: { steam_1: 19.99 }, highs: {}, lows: {}, currency: "INR" } },
    "/api/psn_prices": { json: { prices: {}, highs: {}, lows: {}, currency: "INR", attribution: "Powered by PlatPrices" } },
  });

  const out = await fetchPrices([PSN, STEAM], "INR");
  assert.equal(out.attribution, "Powered by PlatPrices");

  // No PSN rows priced -> nothing to credit, so no credit is claimed.
  stub({ "/api/prices": { json: { prices: {}, highs: {}, lows: {}, currency: "INR" } } });
  const bare = await fetchPrices([STEAM], "INR");
  assert.equal(bare.attribution, null);
});

test("fetchPrices carries the PSN pricing reason through the merge", async () => {
  // An unpriced PlayStation row is normal, but a silent one is not: "no key
  // saved", "key cannot see this region" and "store has no such game" all look
  // identical without the reason surviving the merge back into one result.
  stub({
    "/api/prices": { json: { prices: { steam_1: 19.99 }, highs: {}, lows: {}, currency: "INR" } },
    "/api/psn_prices": { json: { prices: {}, highs: {}, lows: {}, currency: "INR", attribution: null, reason: "no_key" } },
  });

  const out = await fetchPrices([PSN, STEAM], "INR");
  assert.equal(out.psnReason, "no_key");
  assert.equal(out.prices["steam_1"], 19.99, "ITAD prices still land");
});

test("a priced PSN batch reports no reason", async () => {
  stub({
    "/api/psn_prices": {
      json: {
        prices: { "PSN:PPSA00142_00": 39.99 }, highs: {}, lows: {}, currency: "INR",
        attribution: "Powered by PlatPrices", reason: null,
      },
    },
  });

  const out = await fetchPrices([PSN], "INR");
  assert.equal(out.psnReason, null);
  assert.equal(out.prices["PSN:PPSA00142_00"], 39.99);
});

test("fetchPrices reports which shared key refused it, per provider", async () => {
  // A blank price column means two very different things: nothing to price,
  // or no quota left. Only the second is fixed by pasting a key, so each
  // provider's refusal has to survive the merge into one result.
  stub({
    "/api/prices": { json: { prices: {}, highs: {}, lows: {}, currency: "INR", limited: { itad: true } } },
    "/api/psn_prices": { json: { prices: {}, highs: {}, lows: {}, currency: "INR", limited: { platprices: true } } },
  });

  const out = await fetchPrices([PSN, STEAM], "INR");
  assert.deepEqual(out.limited, { itad: true, platprices: true },
    "each half reports its own refusal, not one blended flag");

  stub({ "/api/prices": { json: { prices: { steam_1: 19.99 }, highs: {}, lows: {}, currency: "INR", limited: {} } } });
  const clean = await fetchPrices([STEAM], "INR");
  assert.deepEqual(clean.limited, {}, "an answered scan reports nothing");
});

test("our own per-IP 429 is reported too, not swallowed by !ok", async () => {
  stub({ "/api/prices": { ok: false, status: 429, json: { error: "Too many requests -- slow down" } } });

  const out = await fetchPrices([STEAM], "INR");

  assert.deepEqual(out.limited, { itad: true }, "the server's own limiter counts as a limit");
  assert.equal(out.prices.steam_1, undefined, "still no prices, as before");
});
