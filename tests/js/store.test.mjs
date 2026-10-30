import test from "node:test";
import assert from "node:assert/strict";
import { store } from "../../public/js/store.js";

// store.js touches localStorage only, so a plain map is the whole environment.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};
const reset = (pairs = []) => {
  mem.clear();
  for (const [k, v] of pairs) mem.set(k, v);
};

test("a snapshot is only restored when it carries the current shape", () => {
  reset();
  store.setSnapshot({ games: [{ id: "Steam:1" }] });
  assert.deepEqual(store.getSnapshot().games, [{ id: "Steam:1" }]);
  assert.equal(typeof store.getSnapshot().at, "number");

  // Older and failed snapshots held rows the current renderer cannot read;
  // restoring one boots the app into undefined-shaped games.
  mem.set("last_scan", JSON.stringify({ games: [{ platform: undefined }], v: 0 }));
  assert.equal(store.getSnapshot(), null, "an old version is dropped, not guessed at");
  mem.set("last_scan", "not json at all");
  assert.equal(store.getSnapshot(), null, "a corrupt blob is dropped");
  mem.delete("last_scan");
  assert.equal(store.getSnapshot(), null, "no snapshot reads as no snapshot");
  store.clearSnapshot();
});

test("setEdit drops a null field, and the husk it leaves behind", () => {
  reset();
  store.setEdit("Steam:1", { price: 100 });
  store.setEdit("Steam:1", { hours: 5 });
  assert.deepEqual(store.getEdits()["Steam:1"], { price: 100, hours: 5 });

  store.setEdit("Steam:1", { price: null });
  assert.deepEqual(store.getEdits()["Steam:1"], { hours: 5 }, "one field cleared, the rest stay");

  store.setEdit("Steam:1", { hours: null });
  assert.equal(store.getEdits()["Steam:1"], undefined, "an empty edit disappears");
  assert.equal(JSON.parse(mem.get("game_edits"))["Steam:1"], undefined,
    "and it is not written back as an empty husk");
});

test("forget takes credentials, edits and caches — and leaves the preferences", () => {
  reset([
    ["steam_id", "7656119"],
    ["gog_access_token", "gog-tok"],
    ["psn_refresh_token", "psn-ref"],
    ["sgdb_api_key", "sgdb-k"],
    ["itad_api_key", "itad-k"],
    ["paid_overrides", "{}"],           // legacy "what I paid" entries
    ["game_edits", JSON.stringify({ "Steam:1": { price: 1 } })],
    ["covers_cache", "{}"],
    ["last_scan", '{"games":[],"v":1}'],
    ["currency", "EUR"],
    ["view_mode", "grid"],
  ]);

  store.forget();

  for (const key of ["steam_id", "gog_access_token", "psn_refresh_token",
                     "sgdb_api_key", "itad_api_key", "paid_overrides",
                     "game_edits", "covers_cache", "last_scan"]) {
    assert.equal(localStorage.getItem(key), null, `${key} is forgotten`);
  }
  // Preferences are not data about the visitor's library; a forgotten visitor
  // comes back to their currency and layout, not to someone else's figures.
  assert.equal(localStorage.getItem("currency"), "EUR", "display currency survives");
  assert.equal(localStorage.getItem("view_mode"), "grid", "view mode survives");
});
