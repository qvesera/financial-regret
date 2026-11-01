/**
 * Integration tests for the app wiring: boot phases, delegated link buttons,
 * scan pipeline, filters, drawer, unlink. Uses a minimal fake DOM (dom-stub)
 * and imports a fresh app.js per test via a ?case= query so module state resets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installEnv } from "./dom-stub.mjs";
import { encodeCard } from "../../public/js/export.js";
import { SHARED_VERDICTS, SHARE_NUDGE_SETS } from "../../public/js/verdict.js";
import { store } from "../../public/js/store.js";

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0)); };

let caseId = 0;

/** Fresh env + fresh app module instance. */
async function boot({ seed } = {}) {
  const env = installEnv();
  if (seed) seed(env);
  caseId += 1;
  const mod = await import(`../../public/js/app.js?case=${caseId}`);
  await settle();
  return { env, mod };
}

const byAction = (env, action, platform) =>
  env.root.querySelectorAll(".button, .source-action, .tab, .game-row")
    .find((el) => el.dataset.action === action && (!platform || el.dataset.platform === platform));

const steamFixture = {
  games: [
    { id: "Steam:730", name: "Hades", platform: "Steam", hours: 20, price: null, appid: 1145360 },
    { id: "Steam:1091500", name: "Cyberpunk 2077", platform: "Steam", hours: 0, price: null, appid: 1091500 },
    { id: "Steam:1245620", name: "Elden Ring", platform: "Steam", hours: null, price: null, appid: 1245620 },
  ],
};

// library = 1113 + 1855 + 1457 = 4425; known = 2968; backlog = 1855
// regret = 1855 / 2968 = 62.5%; vph = 1113 / 20 = ₹56/h; coverage = 67.1%
const PRICE_MAP = { "Steam:730": 1113, "Steam:1091500": 1855, "Steam:1245620": 1457 };
const HIGH_MAP = { "Steam:730": 1499, "Steam:1091500": 1999, "Steam:1245620": 1799 };
const LOW_MAP = { "Steam:730": 599, "Steam:1091500": 999, "Steam:1245620": 899 };

function routeScan(env, { steam = true } = {}) {
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return steam ? { json: steamFixture } : { ok: false, status: 500, json: {} };
    if (url.includes("/api/gog_games")) return { json: { games: [] } };
    if (url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) {
      return { json: { prices: PRICE_MAP, highs: HIGH_MAP, lows: LOW_MAP } };
    }
    return null;
  });
}

// The BYO-key gate in linkPlatform() refuses Connect while this browser holds
// no API key. Tests that drive a real login bring one first, as a visitor would.
const bringKey = (env) => { env.localStorage.setItem("itad_api_key", "test-key"); };

// Two stores, each with exactly one game that can rank (an hour or more of play
// *and* a price). A single-store fixture cannot test that hiding a store removes
// its games: there would be nothing left to distinguish from "everything gone".
const withSteamAndGog = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.localStorage.setItem("gog_access_token", "gog-seed-token");
  const extra = "GOG:12345";
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return { json: steamFixture };
    if (url.includes("/api/gog_games")) return { json: { games: [
      { id: extra, name: "Disco Elysium", platform: "GOG", hours: 45, appid: null },
    ] } };
    if (url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) return { json: {
      prices: { ...PRICE_MAP, [extra]: 900 },
      highs: { ...HIGH_MAP, [extra]: 900 },
      lows: { ...LOW_MAP, [extra]: 450 },
    } };
    return null;
  });
};

const withSteam = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  routeScan(env);
};

// Amazon's launcher mirrors no playtime, so every Amazon row carries hours:
// null by contract. Priced, so the rows survive to the table — only the
// ranking has nothing to work with.
const withSteamAndAmazon = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.localStorage.setItem("amazon_access_token", "amazon-seed-token");
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return { json: steamFixture };
    if (url.includes("/api/amazon_games")) return { json: { games: [
      { id: "Amazon:p1", name: "Control", platform: "Amazon", hours: null, appid: null },
      { id: "Amazon:p2", name: "Crysis", platform: "Amazon", hours: null, appid: null },
    ] } };
    if (url.includes("/api/gog_games")) return { json: { games: [] } };
    if (url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) return { json: {
      prices: { ...PRICE_MAP, "Amazon:p1": 1200, "Amazon:p2": 800 },
      highs: { ...HIGH_MAP, "Amazon:p1": 1400, "Amazon:p2": 1000 },
      lows: { ...LOW_MAP, "Amazon:p1": 700, "Amazon:p2": 500 },
    } };
    return null;
  });
};

test("cold start shows onboarding, hides metrics chrome", async () => {
  const { env, mod } = await boot();
  assert.equal(mod.getState().phase, "onboarding");
  assert.ok(env.root.querySelector(".onboarding"), "onboarding section rendered");
  assert.ok(env.root.querySelector(".hero-title"), "hero rendered");
  assert.equal(env.root.querySelectorAll(".platform-card").length, 7, "five store cards + one roadmap card + API keys card");
  // Xbox alone remains scaffolded, not linkable: an honest note about what
  // blocks it and no button pretending otherwise. PSN is now live.
  const planned = env.root.querySelectorAll(".platform-card.planned");
  assert.equal(planned.length, 1, "one planned card (Xbox)");
  for (const c of planned) {
    assert.ok(c.querySelector(".pc-planned"), "each says why it is not built yet");
    const links = c.querySelectorAll("button").filter((b) => b.dataset.action === "link");
    assert.equal(links.length, 0, "no dead Link button on a planned card");
  }
  assert.ok(env.root.querySelector(".api-keys"), "API keys card rendered");
  assert.equal(env.document.getElementById("kpi-high"), null, "no KPIs before linking");
  assert.equal(env.root.querySelector(".sources").hidden, true, "sources strip hidden on onboarding");

  // The link cards now say what will happen, in order, and the paste field
  // they point at is visible — it used to hide behind a collapsed <details>.
  assert.equal(env.root.querySelectorAll(".pc-steps").length, 5, "every live store card lists its steps");
  assert.equal(env.document.getElementById("epic-paste").open, true,
    "the paste field a step points at is open");
  assert.equal(env.root.querySelector(".api-keys").parentNode.className, "onboarding",
    "the optional keys card sits outside the store grid");

  // The key inputs used to carry their name in the placeholder only — no
  // label for screen readers, and (worse) no input styling in dark mode.
  for (const kind of ["itad", "steam", "sgdb"]) {
    const input = env.document.getElementById(`${kind}-key`);
    assert.ok(input, `${kind} key input exists`);
    const lab = env.root.querySelectorAll("label").find((l) => l.htmlFor === `${kind}-key`);
    assert.ok(lab && lab.textContent.length > 3, `${kind} key has a real <label for>`);
  }
  // No KEYS/DISPLAY column split any more: the currency picker moved to the
  // header, so the four fields sit directly in the card's own 2×2 grid.
  assert.equal(env.root.querySelectorAll(".key-group").length, 0,
    "the group wrappers are gone — the card heading carries the meaning");
  assert.equal(env.root.querySelector(".api-keys-fields").children.length, 4,
    "four key fields, direct children of the grid");
});

test("Steam link navigates to OpenID checkid_setup with return_to", async () => {
  const { env } = await boot();
  bringKey(env);
  const btn = byAction(env, "link", "steam");
  assert.ok(btn, "steam link button exists");
  btn.dispatch("click");
  assert.equal(env.navigations.length, 1, "one navigation");
  const url = new URL(env.navigations[0]);
  assert.equal(url.origin + url.pathname, "https://steamcommunity.com/openid/login");
  assert.equal(url.searchParams.get("openid.mode"), "checkid_setup");
  assert.equal(url.searchParams.get("openid.return_to"), "http://localhost:8089/steam-callback.html");
  assert.equal(url.searchParams.get("openid.realm"), "http://localhost:8089");
});

test("Connect with no API key is refused and lands on the keys card", async () => {
  const { env, mod } = await boot();
  // No key in this browser: the BYO-key gate must block the login outright —
  // no navigation, no popup — and point at the keys card instead.
  const note = env.document.getElementById("keys-lock");
  assert.ok(note, "the refusal note exists");
  assert.equal(note.hidden, true, "and stays hidden until a Connect is refused");

  byAction(env, "link", "steam").dispatch("click");

  assert.equal(env.navigations.length, 0, "no store login started");
  assert.equal(env.opened.length, 0, "no popup opened");
  assert.equal(mod.getState().phase, "onboarding", "already the landing page");
  assert.equal(note.hidden, false, "the note explains why Connect did nothing");
  assert.ok(env.root.querySelector(".api-keys").classList.contains("needs-keys"),
    "the keys card is highlighted");
});

test("saving a key clears the gate and Connect proceeds", async () => {
  const { env } = await boot();
  byAction(env, "link", "steam").dispatch("click");
  assert.equal(env.navigations.length, 0, "first attempt is refused");

  const input = env.document.getElementById("itad-key");
  input.value = "my-itad-key";
  byAction(env, "save-key").dispatch("click");
  await settle();

  assert.equal(env.localStorage.getItem("itad_api_key"), "my-itad-key", "key saved");
  assert.equal(env.document.getElementById("keys-lock").hidden, true,
    "the rebuild clears the note");
  assert.equal(env.root.querySelector(".api-keys").classList.contains("needs-keys"), false,
    "and the highlight");

  byAction(env, "link", "steam").dispatch("click");
  assert.equal(env.navigations.length, 1, "with a key present, Connect navigates");
});

test("Connect needs no key of your own when the instance carries shared keys", async () => {
  // The gate's whole reason was BYO mode: a visitor who brought nothing could
  // not finish the login usefully. With shared keys the server finishes it for
  // them, so demanding a key before Connect became friction with no purpose.
  const { env } = await boot({ seed: (e) => {
    e.fetchRoutes.push((url) => (url.includes("/api/config") ? { json: {
      requireUserKeys: false,
      keys: { steam: true, itad: true, platprices: false },
    } } : null));
  } });
  await settle();

  byAction(env, "link", "steam").dispatch("click");

  assert.equal(env.navigations.length, 1,
    "the store login opens with an empty browser: the server's keys do the work");
  assert.equal(env.document.getElementById("keys-lock").hidden, true,
    "the refusal note never appears");
  assert.equal(env.root.querySelector(".api-keys").classList.contains("needs-keys"), false,
    "and the keys card is not highlighted — it is optional, as the card says");
});

test("a keyless instance still refuses Connect — nothing to finish the login with", async () => {
  // BYO off, but no shared keys either: there is no key anywhere in the picture,
  // so the gate must keep doing its job rather than waving people through to a
  // library that cannot price a single row.
  const { env } = await boot({ seed: (e) => {
    e.fetchRoutes.push((url) => (url.includes("/api/config") ? { json: {
      requireUserKeys: false,
      keys: { steam: false, itad: false, platprices: false },
    } } : null));
  } });
  await settle();

  byAction(env, "link", "steam").dispatch("click");

  assert.equal(env.navigations.length, 0, "refused");
  assert.equal(env.document.getElementById("keys-lock").hidden, false,
    "and the note says why, pointing at the keys card");
});

test("the headline counts games actually played, not games with known playtime", async () => {
  // knownCount is "hours are known" — and on a Steam library that is every game,
  // because unplayed rows carry 0 rather than null. Passing it to the headline
  // printed "100% of 320 games played" over a library the user had not touched.
  const { env, mod } = await boot({ seed: (e) => {
    e.localStorage.setItem("steam_id", "76561198000000000");
    e.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: { games: [
        { id: "Steam:1", name: "Played Long", platform: "Steam", hours: 40, appid: 1 },
        { id: "Steam:2", name: "Played Short", platform: "Steam", hours: 1, appid: 2 },
        { id: "Steam:3", name: "Never Opened", platform: "Steam", hours: 0, appid: 3 },
        { id: "Steam:4", name: "Unknown Time", platform: "Steam", hours: null, appid: 4 },
      ] } };
      if (url.includes("/api/prices")) return { json: { prices: {
        "Steam:1": 500, "Steam:2": 300, "Steam:3": 100, "Steam:4": 700,
      } } };
      if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
      return null;
    });
  } });
  await settle();

  const line = env.root.querySelector(".hero-line").textContent;
  assert.ok(line.includes("50% of 4 games played"), `2 of 4 are actually played: ${line}`);
  assert.ok(!line.includes("100%"), "one hour on record is the bar, and known is not played");
  assert.equal(mod.getState().tabCounts.Played, 2,
    "the same two the play-status tab counts — one definition of played");
});

const coverSeed = (sgdbShared) => (e) => {
  e.localStorage.setItem("steam_id", "76561198000000000");
  e.fetchRoutes.push((url) => {
    if (url.includes("/api/config")) return { json: {
      requireUserKeys: false,
      keys: { steam: true, itad: true, platprices: false, sgdb: sgdbShared },
    } };
    if (url.includes("/api/steam_games")) return { json: { games: [
      { id: "Steam:1", name: "Coverless", platform: "Steam", hours: 5, appid: 1 },
    ] } };
    if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 500 } } };
    if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/covers")) return { json: { covers: { "Steam:1": "https://cdn.example/1.png" } } };
    return null;
  });
};

test("covers are fetched with the instance's key when the visitor has none", async () => {
  const { env } = await boot({ seed: coverSeed(true) });
  await settle();
  await openTitle(env, "Coverless");            // stampDrawerCover queues it
  await new Promise((r) => setTimeout(r, 400)); // flushCovers debounces 250ms

  const call = env.fetchCalls.find((c) => c.url.includes("/api/covers"));
  assert.ok(call, "a cover request is made with an empty browser — before this "
    + "the queue returned early without the visitor's own key, so no call ever happened");
  assert.equal((call.opts.headers || {})["X-SGDB-Key"], undefined,
    "no personal key is sent: the server spends its shared one");
  assert.equal(env.localStorage.getItem("sgdb_api_key"), null, "and none is saved");
});

test("with no key anywhere, covers are not requested at all", async () => {
  const { env } = await boot({ seed: coverSeed(false) });
  await settle();
  await openTitle(env, "Coverless");
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(!env.fetchCalls.some((c) => c.url.includes("/api/covers")),
    "nothing to ask with: no visitor key and no shared one either — placeholders stay");
});

test("the shared term in one key field fills all four fields", async () => {
  // Each provider only ever reads its own header, so the term has to land in
  // every field — one entry opts the whole browser into the instance defaults.
  const { env } = await boot();
  const input = env.document.getElementById("itad-key");
  input.value = "superuser";
  byAction(env, "save-key").dispatch("click");
  await settle();

  for (const k of ["itad", "steam", "platprices", "sgdb"]) {
    assert.equal(env.localStorage.getItem(`${k}_api_key`), "superuser", `${k} field filled`);
  }
  // It satisfies the BYO gate like any other stored value.
  byAction(env, "link", "steam").dispatch("click");
  assert.equal(env.navigations.length, 1, "Connect proceeds with the term saved");
});

test("an ordinary key saves only its own field", async () => {
  // The fan-out must trigger on the shared term alone: a real key in one
  // field must never overwrite the others.
  const { env } = await boot();
  const input = env.document.getElementById("itad-key");
  input.value = "my-itad-key";
  byAction(env, "save-key").dispatch("click");
  await settle();

  assert.equal(env.localStorage.getItem("itad_api_key"), "my-itad-key", "the real key saved");
  for (const k of ["steam", "platprices", "sgdb"]) {
    assert.equal(env.localStorage.getItem(`${k}_api_key`), null, `${k} left untouched`);
  }
});

test("GOG link opens auth popup and stores oauth state", async () => {
  const { env } = await boot();
  bringKey(env);
  byAction(env, "link", "gog").dispatch("click");
  await settle();
  assert.equal(env.opened.length, 1, "popup opened");
  const url = new URL(env.opened[0].url);
  assert.equal(url.origin + url.pathname, "https://auth.gog.com/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://embed.gog.com/on_login_success?origin=client",
    "only GOG's registered redirect is accepted");
  assert.equal(url.searchParams.get("response_type"), "code");
  const state = env.sessionStorage.getItem("gog_oauth_state");
  assert.ok(state, "oauth state persisted for callback verification");
  assert.equal(url.searchParams.get("state"), state, "state round-trips in popup URL");
});

test("Epic link opens the registered redirect; pasted JSON exchanges in-page and scans", async () => {
  const { env, mod } = await boot();
  bringKey(env);
  env.fetchRoutes.push((url, opts) => {
    if (url.includes("/api/epic_exchange")) {
      assert.equal(opts.method, "POST");
      assert.equal(JSON.parse(opts.body).code, "abc123def456ghi789");
      return { json: { access_token: "epic-tok", refresh_token: "epic-ref", account_id: "acct-1" } };
    }
    if (url.includes("/api/epic_games")) {
      return { json: { games: [{ id: "Epic:1", name: "Celeste", platform: "Epic", hours: 3, price: null }] } };
    }
    if (url.includes("/api/prices")) return { json: { prices: { "Epic:1": 600 } } };
    return null;
  });

  byAction(env, "link", "epic").dispatch("click");   // opens popup with the registered redirect
  await settle();
  assert.equal(env.opened.length, 1, "popup opened");
  const url = new URL(env.opened[0].url);
  assert.equal(url.origin + url.pathname, "https://www.epicgames.com/id/login");
  assert.equal(url.searchParams.get("redirectUrl"),
    "https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code",
    "only Epic's registered redirect is accepted by the client");

  const input = env.document.getElementById("epic-code");
  assert.ok(input, "epic paste input exists");
  input.value = JSON.stringify({ authorizationCode: "abc123def456ghi789" });
  byAction(env, "submit-epic").dispatch("click");
  await settle();

  assert.equal(env.navigations.length, 0, "in-page exchange, no callback navigation");
  assert.equal(env.localStorage.getItem("epic_access_token"), "epic-tok");
  assert.equal(env.localStorage.getItem("epic_account_id"), "acct-1");
  assert.equal(mod.getState().phase, "ready");
  assert.equal(mod.getState().rows.length, 1, "scan ran after exchange");
  assert.equal(mod.getState().rows[0].name, "Celeste");
});

test("Epic exchange failure surfaces the error and stores nothing", async () => {
  const { env, mod } = await boot();
  env.fetchRoutes.push((url) => (url.includes("/api/epic_exchange")
    ? { ok: false, status: 401, json: { error: "Epic rejected the code" } }
    : null));
  const input = env.document.getElementById("epic-code");
  input.value = JSON.stringify({ authorizationCode: "deadbeefdeadbeef1234" });
  byAction(env, "submit-epic").dispatch("click");
  await settle();

  assert.equal(env.localStorage.getItem("epic_access_token"), null, "no token stored");
  assert.ok(env.document.getElementById("epic-error").textContent.includes("rejected the code"));
  assert.equal(mod.getState().phase, "onboarding");
});

test("scan yields 3 rows, correct KPIs, and coverage text", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  const s = mod.getState();
  assert.equal(s.phase, "ready");
  assert.equal(s.rows.length, 3, "three games");
  assert.equal(s.metrics.libraryValue, 4425);
  assert.equal(s.metrics.backlogValue, 1855);
  assert.equal(s.metrics.regretScore, 0.625);
  assert.equal(s.metrics.knownCount, 2);
  assert.equal(s.metrics.unknownCount, 1);

  assert.equal(env.document.getElementById("hero-spend").textContent, "₹4,425.00");
  assert.equal(env.document.getElementById("kpi-high").textContent, "₹5,297.00");
  assert.equal(env.document.getElementById("kpi-low").textContent, "₹2,497.00");
  assert.equal(env.document.getElementById("kpi-backlog").textContent, "₹1,855.00");
  assert.equal(env.document.getElementById("kpi-regret").textContent, "62.5 %");
  assert.equal(env.document.getElementById("kpi-vph").textContent, "₹56/h");
  assert.equal(env.document.getElementById("kpi-hours").textContent, "20.0 h", "only Hades has recorded hours");

  assert.equal(env.root.querySelectorAll(".game-row").length, 3);
  assert.ok(env.root.querySelector(".coverage").textContent.includes("2 / 3"));
  assert.ok(env.root.querySelector(".coverage").textContent.includes("67.1%"));
  assert.equal(env.root.querySelector(".empty-state").hidden, true, "empty state hidden after scan");
  assert.equal(env.root.querySelector(".pager").classList.contains("hidden"), true,
    "a one-page library gets no pager");
});

test("a big library pages instead of rendering every row at once", async () => {
  const env = installEnv();
  env.localStorage.setItem("steam_id", "76561198000000000");
  const many = {
    games: Array.from({ length: 30 }, (_, i) => (
      { id: `Steam:${1000 + i}`, name: `Game ${i}`, platform: "Steam", hours: i + 1, appid: 1000 + i })),
  };
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return { json: many };
    if (url.includes("/api/prices")) return { json: { prices: {} } };
    return { json: { games: [] } };
  });
  caseId += 1;
  const mod = await import(`../../public/js/app.js?case=${caseId}`);
  await settle();

  assert.equal(env.root.querySelectorAll(".game-row").length, 24, "first page only, not all 30");
  const status = env.root.querySelector(".pager-status");
  assert.ok(status.textContent.includes("1–24 of 30"), `range reads: ${status.textContent}`);
  assert.ok(status.textContent.includes("page 1 of 2"));

  env.root.querySelectorAll("button").find((b) => b.dataset.action === "page-next").dispatch("click");
  await settle();
  assert.equal(env.root.querySelectorAll(".game-row").length, 6, "the tail page shows the remainder");
  assert.ok(env.root.querySelector(".pager-status").textContent.includes("25–30 of 30"));
  assert.equal(env.root.querySelectorAll("button").find((b) => b.dataset.action === "page-next").disabled,
    true, "no next past the end");

  env.root.querySelectorAll("button").find((b) => b.dataset.action === "page-prev").dispatch("click");
  await settle();
  assert.equal(env.root.querySelectorAll(".game-row").length, 24, "prev walks back");

  // A strip above and below the results, with direct jump targets.
  assert.equal(env.root.querySelectorAll(".pager").length, 2, "top and bottom strips");
  const topPager = env.root.querySelector(".pager");
  assert.deepEqual(topPager.querySelectorAll(".page-num").map((b) => b.textContent), ["1", "2"],
    "every page directly selectable");
  topPager.querySelectorAll(".page-num").find((b) => b.dataset.page === "2").dispatch("click");
  await settle();
  assert.equal(mod.getState().page, 2, "a page number jumps straight there");
  assert.equal(env.root.querySelectorAll(".game-row").length, 6);
  assert.equal(topPager.querySelectorAll(".page-num")[1].getAttribute("aria-current"), "page",
    "the current page is marked, not just coloured");

  // Any change to the query starts over at page 1 — page 2 of a filter that
  // now matches three games would be an empty screen.
  env.root.querySelectorAll("button").find((b) => b.dataset.action === "filter")
    .dispatch("click");
  await settle();
  assert.equal(mod.getState().page, 1, "filters reset the page");
});

test("the filter tabs explain themselves: counts, clear names, no self-shrinking", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  const tab = (f) => env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === f);
  const count = (f) => tab(f).querySelector(".tab-count").textContent;
  assert.equal(count("All"), "3");
  assert.equal(count("Unplayed"), "1", "Cyberpunk at 0 h");
  assert.equal(count("Played"), "1", "Hades at 20 h");
  assert.equal(count("No data"), "1", "Elden Ring, hours unknown");
  assert.equal(tab("No data").querySelector(".tab-label").textContent, "Unknown hours",
    "the tab is named for what it actually filters");

  tab("Unplayed").dispatch("click");
  await settle();
  assert.equal(mod.getState().rows.length, 1, "the tab filters");
  assert.equal(count("Unplayed"), "1", "and its own count survives the selection");

  // The verdict facet that used to share the name "No data" is now
  // "Unpriced" — the phrase means exactly one thing in the UI. And Free
  // deserves its own facet: it left the graded bands entirely, so it must be
  // findable like the others.
  const facetNames = env.root.querySelectorAll(".tier-facet")
    .map((b) => b.querySelector(".tier-name").textContent);
  assert.ok(facetNames.includes("Unpriced"), `verdict facets read: ${facetNames}`);
  assert.ok(facetNames.includes("Free"), `verdict facets read: ${facetNames}`);
});

test("regret gauge lives in its KPI card, not a second sidebar card", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const value = env.document.getElementById("kpi-regret");
  assert.equal(value.textContent, "62.5 %", "precise score still on the card");
  const gauge = value.parentNode;
  assert.ok(gauge.classList.contains("kpi-gauge"), "score sits in a gauge row");
  assert.equal(gauge.querySelectorAll(".kpi-ring").length, 1, "arc rendered beside the number");

  const sidebar = env.root.querySelector(".sidebar");
  const headings = sidebar.querySelectorAll("h3").map((h) => h.textContent);
  assert.deepEqual(headings, ["Value by platform", "Games by verdict"],
    "the two chart cards own the sidebar; the duplicate Regret card is gone");
});

test("filter tabs narrow the table", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  const tab = (f) => env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === f);

  tab("Unplayed").dispatch("click");
  assert.equal(mod.getState().rows.length, 1);
  assert.equal(env.root.querySelectorAll(".game-row").length, 1);
  assert.equal(env.root.querySelector(".game-row").dataset.id, "Steam:1091500");

  tab("No data").dispatch("click");
  assert.equal(mod.getState().rows.length, 1);
  assert.equal(env.root.querySelector(".game-row").dataset.id, "Steam:1245620");

  tab("All").dispatch("click");
  assert.equal(env.root.querySelectorAll(".game-row").length, 3);
});

test("row click opens the drawer; close hides it", async () => {
  const { env } = await boot({ seed: withSteam });
  const row = env.root.querySelectorAll(".game-row").find((r) => r.dataset.id === "Steam:730");
  row.dispatch("click");
  const drawer = env.root.querySelector(".drawer");
  assert.equal(drawer.classList.contains("hidden"), false, "drawer opens");
  assert.ok(drawer.textContent.includes("Hades"));
  assert.ok(drawer.textContent.includes("Current price"), "price row shown");
  assert.equal(drawer.querySelector(".paid-input"), null, "no paid input (feature removed)");

  // The panel carries its own cover: the same layered fallback as the grid
  // cards, keyed so the loader can stamp the art in when the url is known.
  const cover = drawer.querySelector(".drawer-cover");
  assert.ok(cover, "cover shown in the details panel");
  assert.equal(cover.querySelector(".cover-img").dataset.coverId, "Steam:730");

  drawer.querySelectorAll("button").find((b) => b.dataset.action === "close-drawer").dispatch("click");
  assert.equal(env.root.querySelector(".drawer").classList.contains("hidden"), true, "drawer closes");

  // Reopen, then dismiss via the scrim — a click on the panel element itself.
  row.dispatch("click");
  assert.equal(env.root.querySelector(".drawer").classList.contains("hidden"), false, "reopens");
  env.root.querySelector(".drawer").dispatch("click");
  assert.equal(env.root.querySelector(".drawer").classList.contains("hidden"), true,
    "clicking the scrim closes it");
});

test("unlinking the last account returns to onboarding and clears storage", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  assert.equal(mod.getState().phase, "ready");
  env.root.querySelectorAll(".source-action").find((b) => b.dataset.action === "unlink").dispatch("click");
  assert.equal(mod.getState().phase, "onboarding");
  assert.equal(env.localStorage.getItem("steam_id"), null, "steam id cleared");
  assert.ok(env.root.querySelector(".onboarding"), "onboarding back on screen");
});

test("GOG paste of the landing URL exchanges the code and scans", async () => {
  const { env, mod } = await boot();
  bringKey(env);
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/gog_exchange")) {
      return { json: { access_token: "gog-tok", refresh_token: "gog-ref", user_id: "u1" } };
    }
    if (url.includes("/api/gog_games")) {
      return { json: { games: [{ id: "GOG:1", name: "Witcher 3", appid: 1, platform: "GOG", hours: 12 }] } };
    }
    if (url.includes("/api/prices")) return { json: { prices: { "GOG:1": 300 } } };
    return null;
  });

  byAction(env, "link", "gog").dispatch("click");   // opens popup, records state
  await settle();
  assert.equal(env.opened.length, 1);
  const stateParam = new URL(env.opened[0].url).searchParams.get("state");
  assert.equal(env.sessionStorage.getItem("gog_oauth_state"), stateParam);

  const input = env.document.getElementById("gog-code");
  input.value = "https://embed.gog.com/on_login_success?origin=client"
    + `&code=PASTED_GOG_CODE_123&state=${encodeURIComponent(stateParam)}`;
  byAction(env, "submit-gog").dispatch("click");
  await settle();

  assert.equal(env.navigations.length, 0, "in-page exchange, no callback navigation");
  assert.equal(env.localStorage.getItem("gog_access_token"), "gog-tok");
  assert.equal(env.localStorage.getItem("gog_user_id"), "u1");
  assert.equal(mod.getState().phase, "ready");
  assert.equal(mod.getState().rows.length, 1);
  assert.equal(env.document.getElementById("hero-spend").textContent, "₹300.00");
});

test("GOG paste with mismatched OAuth state is rejected before any exchange", async () => {
  const { env, mod } = await boot();
  bringKey(env);
  env.fetchRoutes.push((url) => (url.includes("/api/gog_exchange") ? { json: { access_token: "t" } } : null));
  byAction(env, "link", "gog").dispatch("click");
  await settle();

  const input = env.document.getElementById("gog-code");
  input.value = "https://embed.gog.com/on_login_success?origin=client&code=XYZXYZXYZXYZ1234&state=WRONGSTATE";
  byAction(env, "submit-gog").dispatch("click");
  await settle();

  assert.equal(env.localStorage.getItem("gog_access_token"), null, "no token stored");
  assert.equal(env.fetchCalls.filter((c) => c.url.includes("gog_exchange")).length, 0, "exchange never called");
  assert.ok(env.document.getElementById("gog-error").textContent.includes("state"), "error surfaced");
  assert.equal(mod.getState().phase, "onboarding");
});

test("Epic library streams in page by page until the cursor dries up", async () => {
  const { env, mod } = await boot({
    seed: (env) => {
      env.localStorage.setItem("epic_access_token", "tok-1");
      env.fetchRoutes.push((url) => {
        if (url.includes("/api/epic_games")) {
          const cursor = new URL(url, "http://localhost:8089").searchParams.get("cursor");
          if (!cursor) {
            return { json: {
              games: [{ id: "Epic:1", name: "Celeste", platform: "Epic", hours: 3, appid: "Celeste" }],
              next_cursor: "P2",
            } };
          }
          assert.equal(cursor, "P2", "continuation cursor round-trips through the client");
          return { json: {
            games: [{ id: "Epic:2", name: "Hades", platform: "Epic", hours: 9, appid: "Hades" }],
            next_cursor: null,
          } };
        }
        if (url.includes("/api/prices")) return { json: { prices: {} } };
        return null;
      });
    },
  });
  await settle();

  const epicCalls = env.fetchCalls.filter((c) => c.url.includes("/api/epic_games"));
  assert.equal(epicCalls.length, 2, "one short request per page instead of one long one");
  assert.equal(mod.getState().phase, "ready");
  assert.equal(mod.getState().rows.length, 2, "pages aggregated");
  assert.deepEqual(mod.getState().rows.map((r) => r.name).sort(), ["Celeste", "Hades"]);
  assert.equal(mod.getState().scanProgress, null, "progress line cleared after scan");
});

test("Epic pagination surfaces a rate-limit error instead of hanging", async () => {
  const { env, mod } = await boot({
    seed: (env) => {
      env.localStorage.setItem("epic_access_token", "tok-1");
      env.fetchRoutes.push((url) => (url.includes("/api/epic_games")
        ? { ok: false, status: 429, json: {} }
        : null));
    },
  });
  await settle();

  assert.ok(mod.getState().scanError && mod.getState().scanError.includes("rate limited"));
  assert.equal(mod.getState().phase, "ready");
});

test("strip link for a second store surfaces the paste card; Back returns", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  bringKey(env);
  assert.equal(mod.getState().phase, "ready");

  env.root.querySelectorAll(".source-action").find((b) => b.dataset.platform === "gog").dispatch("click");
  assert.equal(mod.getState().phase, "onboarding", "onboarding cards surfaced for paste");
  assert.equal(env.document.getElementById("gog-paste").open, true, "paste box auto-opened");

  // The way back is a real footer — button plus privacy note — not a bare
  // button stuck under the dashed keys card.
  const foot = env.root.querySelector(".onboarding-footer");
  assert.ok(foot, "back button sits in the onboarding footer");
  assert.ok(foot.querySelectorAll("button").find((b) => b.dataset.action === "back"),
    "the back button is inside the footer");
  assert.ok(foot.querySelector(".trust-note"), "privacy note travels with it");

  env.root.querySelectorAll("button").find((b) => b.dataset.action === "back").dispatch("click");
  assert.equal(mod.getState().phase, "ready");
  assert.equal(env.root.querySelectorAll(".game-row").length, 3, "scan data intact");
});

test("the dashboard fills in store-by-store, not after the slowest one", async () => {
  const env = installEnv();
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.localStorage.setItem("epic_access_token", "epic-tok");

  // Epic holds its response open — as it does in real life, where its cursor
  // crawl runs a minute longer than Steam's single request.
  let releaseEpic;
  const epicGate = new Promise((r) => { releaseEpic = r; });
  env.fetchRoutes.push(async (url) => {
    if (url.includes("/api/steam_games")) return { json: steamFixture };
    if (url.includes("/api/prices")) return { json: { prices: PRICE_MAP, highs: HIGH_MAP, lows: LOW_MAP } };
    if (url.includes("/api/epic_games")) {
      await epicGate;
      return { json: { games: [{ id: "Epic:1", name: "Celeste", platform: "Epic", hours: 3 }] } };
    }
    return null;
  });
  caseId += 1;
  const mod = await import(`../../public/js/app.js?case=${caseId}`);
  await settle();

  assert.equal(mod.getState().phase, "ready", "the first store to land ends the skeleton wait");
  assert.ok(mod.getState().rows.some((r) => r.platform === "Steam"), "Steam rows are visible while Epic pends");
  assert.equal(mod.getState().prices["Steam:730"], 1113, "and priced already");
  assert.ok(mod.getState().scanSteps.some((s) => s.label === "Epic" && s.status === "pending"),
    "the stepper is still honest about Epic");

  releaseEpic();
  await settle();
  assert.ok(mod.getState().rows.some((r) => r.platform === "Epic"), "Epic joins when it lands");
  assert.equal(mod.getState().scanSteps, null, "the stepper clears when everything settles");
});

test("cached cover art is stamped on the cards and revealed when it loads", async () => {
  const env = installEnv();
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.localStorage.setItem("view_mode", "grid");
  env.localStorage.setItem("covers_cache", JSON.stringify({ "Steam:730": "https://cdn.example/730.png" }));
  routeScan(env);
  caseId += 1;
  await import(`../../public/js/app.js?case=${caseId}`);
  await settle();

  const img = env.root.querySelectorAll(".cover-img")
    .find((i) => i.dataset.coverId === "Steam:730");
  assert.ok(img, "cover slot rendered");
  assert.equal(img.getAttribute("src"), "https://cdn.example/730.png", "cached url stamped");
  assert.ok(!img.classList.contains("is-loaded"), "still faded out until the browser decodes it");
  img.dispatch("load");
  assert.ok(img.classList.contains("is-loaded"), "the load event fades it in");
});

test("dedupeGames collapses duplicate entitlements, keeping max playtime", async () => {
  const { mod } = await boot();
  const games = [
    { id: "Epic:CivBase", name: "Sid Meier's Civilization VI", platform: "Epic", hours: 50 },
    { id: "Epic:CivDLC1", name: "Sid Meier's Civilization VI", platform: "Epic", hours: 0 },
    { id: "Epic:CivDLC2", name: "Sid Meier's Civilization VI", platform: "Epic", hours: null },
    { id: "Epic:RL1", name: "Rocket League®", platform: "Epic", hours: 30 },
    { id: "Epic:RL2", name: "Rocket League", platform: "Epic", hours: 5 },
    { id: "Epic:Fortnite", name: "Fortnite", platform: "Epic", hours: 10 },
    { id: "Steam:730", name: "Hades", platform: "Steam", hours: 20 },
  ];
  const out = mod.dedupeGames(games);
  assert.equal(out.length, 4, "Civ + Rocket League + Fortnite + Steam Hades survive");
  assert.equal(out.find((g) => g.name.startsWith("Sid")).id, "Epic:CivBase", "keeps most playtime");
  assert.equal(out.find((g) => g.name.startsWith("Rocket")).id, "Epic:RL1", "symbol variants collapse");
});

test("dedupeGames keeps a tagged add-on distinct from its base game", async () => {
  const { mod } = await boot();
  // An add-on that shares its base game's exact name must not be folded away:
  // `kind` is part of the dedupe key, so the two are separate rows.
  const games = [
    { id: "Epic:CivBase", name: "Sid Meier's Civilization VI", platform: "Epic", hours: 50 },
    { id: "Epic:CivDLC", name: "Sid Meier's Civilization VI", platform: "Epic", hours: 0, kind: "dlc" },
    { id: "Epic:CivDLC2", name: "Sid Meier's Civilization VI", platform: "Epic", hours: null, kind: "dlc" },
  ];
  const out = mod.dedupeGames(games);
  assert.equal(out.length, 2, "base game + one surviving add-on");
  assert.equal(out.filter((g) => g.kind === "dlc").length, 1, "the two add-ons collapse to one");
  assert.ok(out.some((g) => g.id === "Epic:CivBase"), "the base game survives");
});

test("add-on spend is tallied apart and never skews the game metrics", async () => {
  // computeRegret is not re-exported from app; exercise it through the module
  // that owns it so the exclusion is pinned at the source.
  const { computeRegret } = await import("../../public/js/regret.js");
  const out = computeRegret([
    { id: "Steam:1", name: "Played", platform: "Steam", hours: 10, price: 100 },
    { id: "Steam:2", name: "Backlog", platform: "Steam", hours: 0, price: 300 },
    { id: "Epic:DLC", name: "Big Add-on", platform: "Epic", hours: null, price: 500, kind: "dlc" },
  ]);
  // Games only: library 400, backlog 300, regret 300/400 = 75%.
  assert.equal(out.libraryValue, 400, "the add-on's 500 is excluded from library value");
  assert.equal(out.backlogValue, 300, "the add-on is not backlog");
  assert.ok(Math.abs(out.regretScore - 0.75) < 1e-9, "regret is computed from games only");
  assert.equal(out.dlcValue, 500, "add-on spend is its own figure");
  assert.equal(out.dlcCount, 1, "one add-on counted");
});

test("changing display currency re-prices the library in that currency", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();
  assert.equal(mod.getState().phase, "ready");
  assert.equal(mod.getState().currency, "INR", "defaults to INR");

  const pickers = env.root.querySelectorAll(".currency-select");
  assert.equal(pickers.length, 1, "exactly one currency picker — the header's");
  const sel = env.root.querySelector(".header-currency");
  assert.ok(sel, "the picker lives in the header, not the filter bar");
  sel.value = "USD";
  sel.dispatch("change");
  await settle();

  assert.equal(mod.getState().currency, "USD", "state adopts the selection");
  assert.equal(env.localStorage.getItem("currency"), "USD", "choice persisted");
  const usdCalls = env.fetchCalls.filter((c) =>
    c.url.includes("/api/prices") &&
    c.opts.body && JSON.parse(c.opts.body).currency === "USD");
  assert.ok(usdCalls.length >= 1, "a /api/prices request carried the new currency");
});

test("Amazon Luna appears as a connectable library source", async () => {
  const { env, mod } = await boot();
  const amazonCard = env.root.querySelectorAll(".platform-card")
    .find((c) => c.dataset && c.dataset.platform === "amazon");
  assert.ok(amazonCard, "amazon card rendered in the collection links");
  assert.ok(env.document.getElementById("amazon-paste"), "paste surface for the redirect URL");
  assert.equal(mod.getState().accounts.amazon, false, "not linked by default");
});

test("Amazon login builds a PKCE signin and the pasted redirect exchanges it", async () => {
  const { env, mod } = await boot();
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/amazon_exchange")) {
      return { json: { access_token: "amz-tok", refresh_token: "amz-ref", serial: "AMZSER" } };
    }
    if (url.includes("/api/amazon_games")) {
      return { json: { games: [{ id: "Amazon:1", name: "Hades", platform: "Amazon", hours: null, appid: null }] } };
    }
    if (url.includes("/api/prices")) return { json: { prices: { "Amazon:1": 300 } } };
    return null;
  });

  // Connect: builds the PKCE signin URL and stashes verifier/serial.
  bringKey(env);
  byAction(env, "link", "amazon").dispatch("click");
  await settle();
  assert.equal(env.opened.length, 1, "signin opened");
  assert.ok(env.opened[0].url.includes("amazon.com/ap/signin"), "Amazon OpenID signin URL");
  const pkce = JSON.parse(env.sessionStorage.getItem("amazon_pkce"));
  assert.ok(pkce.clientId && pkce.verifier && pkce.serial, "PKCE state stashed");

  // Paste the amazon.com redirect URL (code in openid.oa2.authorization_code).
  const input = env.document.getElementById("amazon-code");
  input.value = "https://www.amazon.com/?openid.oa2.authorization_code=AMZ_CODE_123";
  byAction(env, "submit-amazon").dispatch("click");
  await settle();

  assert.equal(env.localStorage.getItem("amazon_access_token"), "amz-tok");
  assert.equal(env.localStorage.getItem("amazon_serial"), "AMZSER");
  assert.equal(mod.getState().phase, "ready");
  assert.equal(mod.getState().rows.length, 1, "scanned the Amazon library");
  assert.equal(mod.getState().rows[0].name, "Hades");
});

const mixedSeed = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.localStorage.setItem("epic_access_token", "epic-tok");
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) {
      return { json: { games: [{ id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, appid: 1145360 }] } };
    }
    if (url.includes("/api/epic_games")) {
      return { json: { games: [{ id: "Epic:1", name: "Celeste", platform: "Epic", hours: 5 },
                               { id: "Epic:2", name: "Hob", platform: "Epic", hours: null }] } };
    }
    if (url.includes("/api/gog_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 500, "Epic:1": 300, "Epic:2": 200 } } };
    return null;
  });
};

test("price/hour never exceeds the purchase price", async () => {
  const seed = (env) => {
    env.localStorage.setItem("steam_id", "76561198000000000");
    env.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) {
        return { json: { games: [
          { id: "Steam:1", name: "SubHour", platform: "Steam", hours: 0.5, price: null, appid: 1 },
          { id: "Steam:2", name: "NeverPlayed", platform: "Steam", hours: 0, price: null, appid: 2 },
          { id: "Steam:3", name: "Normal", platform: "Steam", hours: 10, price: null, appid: 3 },
        ] } };
      }
      if (url.includes("/api/gog_games")) return { json: { games: [] } };
      if (url.includes("/api/epic_games")) return { json: { games: [] } };
      if (url.includes("/api/prices")) {
        return { json: { prices: { "Steam:1": 500, "Steam:2": 500, "Steam:3": 500 } } };
      }
      return null;
    });
  };

  const { env } = await boot({ seed });
  const rows = env.root.querySelectorAll(".game-row");
  assert.equal(rows.length, 3);
  const cell = (tr, i) => tr.querySelectorAll("td")[i].textContent;
  const rowFor = (name) => rows.find((tr) => cell(tr, 0) === name);

  assert.equal(cell(rowFor("SubHour"), 4), "₹500/h", "0.5h caps at the price, not ₹1000/h");
  assert.equal(cell(rowFor("NeverPlayed"), 4), "∞/h", "0h is an infinite rate");
  assert.equal(cell(rowFor("Normal"), 4), "₹50/h", "10h divides normally");
});

test("platform filter narrows the table to the chosen platform", async () => {
  const { env, mod } = await boot({ seed: mixedSeed });
  await settle();
  assert.equal(mod.getState().rows.length, 3, "mixed platforms scanned");

  const sel = env.root.querySelector(".platform-select");
  assert.ok(sel, "platform picker rendered");
  assert.equal(sel.value, "All");

  sel.value = "Steam";
  sel.dispatch("change");
  await settle();
  assert.equal(mod.getState().platform, "Steam");
  assert.equal(mod.getState().rows.length, 1, "only the Steam row");
  assert.equal(mod.getState().rows[0].platform, "Steam");

  sel.value = "Epic";
  sel.dispatch("change");
  await settle();
  assert.equal(mod.getState().rows.length, 2, "only the Epic rows");

  sel.value = "All";
  sel.dispatch("change");
  await settle();
  assert.equal(mod.getState().rows.length, 3, "back to everything");
});

test("view toggle switches between list and grid and persists", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  const btn = (mode) => env.root.querySelectorAll(".view-btn").find((b) => b.dataset.view === mode);
  assert.ok(btn("list") && btn("grid"), "both toggle buttons rendered");

  assert.equal(mod.getState().viewMode, "list");
  assert.equal(env.root.querySelector(".grid-wrap").hidden, true);
  assert.equal(env.root.querySelector(".table-wrap").hidden, false);

  btn("grid").dispatch("click");
  await settle();
  assert.equal(mod.getState().viewMode, "grid");
  assert.equal(env.localStorage.getItem("view_mode"), "grid", "choice persists");
  assert.equal(env.root.querySelector(".grid-wrap").hidden, false);
  assert.equal(env.root.querySelector(".table-wrap").hidden, true);
  assert.ok(btn("grid").classList.contains("active"), "grid button marked active");
  assert.equal(env.root.querySelectorAll(".game-card").length, 3, "one card per row");
  const titles = env.root.querySelectorAll(".game-card")
    .map((c) => c.querySelector(".card-title").textContent);
  assert.ok(titles.some((t) => t.includes("Hades")), "titles rendered on the cards");
  assert.ok(env.root.querySelector(".game-card").dataset.id, "cards open the drawer");

  btn("list").dispatch("click");
  await settle();
  assert.equal(mod.getState().viewMode, "list");
  assert.equal(env.localStorage.getItem("view_mode"), "list");
  assert.equal(env.root.querySelector(".table-wrap").hidden, false);
  assert.equal(env.root.querySelector(".grid-wrap").hidden, true);
});

test("value by platform renders as a pie chart", async () => {
  const { env } = await boot({ seed: mixedSeed });
  await settle();

  const pie = env.root.querySelector(".platform-pie");
  assert.ok(pie, "pie svg rendered");
  assert.equal(pie.getAttribute("role"), "img");
  assert.equal(pie.querySelectorAll("path").length, 2, "one slice per platform (Steam + Epic)");

  const legend = env.root.querySelector(".platform-legend");
  assert.ok(legend, "legend rendered");
  assert.equal(legend.querySelectorAll(".platform-swatch").length, 2, "a swatch per slice");
  const names = legend.querySelectorAll(".platform-name").map((n) => n.textContent).sort();
  assert.deepEqual(names, ["Epic", "Steam"], "legend lists both platforms");
});

test("platform slices wear the store's brand colour, not a palette slot", async () => {
  // The old palette painted by rank index, so a store changed colour whenever
  // the ranking reshuffled. The colour now belongs to the store itself: Epic
  // stays Epic grey whether it ranks first or last.
  const { env } = await boot({ seed: mixedSeed });
  await settle();

  const legendRow = (name) => env.root.querySelector(".platform-legend")
    .querySelectorAll(".platform-row").find((r) => r.dataset.platform === name);
  assert.equal(legendRow("Epic").querySelector(".platform-swatch").style.background,
    "var(--brand-epic)", "Epic swatch");
  assert.equal(legendRow("Steam").querySelector(".platform-swatch").style.background,
    "var(--brand-steam)", "Steam swatch");

  const fills = env.root.querySelector(".platform-pie").querySelectorAll("path")
    .map((p) => p.getAttribute("fill"));
  assert.ok(fills.includes("var(--brand-epic)"), "Epic slice painted Epic grey");
  assert.ok(fills.includes("var(--brand-steam)"), "Steam slice painted Steam blue");
});

// Seven games chosen so each verdict lands exactly once (twice for Regret):
// four priced+played rates (1000, 50, 30, 10 → p25=25, p50=40) split into
// regret/fair/worth, plus one untouched, one free and one unpriced row.
const verdictSeed = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return { json: { games: [
      { id: "Steam:1", name: "Ripoff", platform: "Steam", hours: 1, appid: 1 },
      { id: "Steam:2", name: "Steep", platform: "Steam", hours: 10, appid: 2 },
      { id: "Steam:3", name: "Okay", platform: "Steam", hours: 10, appid: 3 },
      { id: "Steam:4", name: "Steal", platform: "Steam", hours: 10, appid: 4 },
      { id: "Steam:5", name: "Shelfwarmer", platform: "Steam", hours: 0, appid: 5 },
      { id: "Steam:6", name: "Gem", platform: "Steam", hours: 5, appid: 6 },
      { id: "Steam:7", name: "Mystery", platform: "Steam", hours: 8, appid: 7 },
    ] } };
    if (url.includes("/api/gog_games")) return { json: { games: [] } };
    if (url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) {
      const p = { "Steam:1": 1000, "Steam:2": 500, "Steam:3": 300, "Steam:4": 100, "Steam:5": 200, "Steam:6": 0 };
      return { json: { prices: p, highs: p, lows: p } };
    }
    return null;
  });
};

test("the verdict pie splits the library by verdict and filters on click", async () => {
  const { env, mod } = await boot({ seed: verdictSeed });
  await settle();

  const pie = env.root.querySelector(".verdict-pie");
  assert.ok(pie, "verdict pie rendered");
  assert.equal(pie.getAttribute("role"), "img");
  assert.equal(pie.getAttribute("aria-label"), "Games by verdict");
  assert.equal(pie.querySelectorAll("path").length, 6, "one slice per verdict present");

  const legend = env.root.querySelector(".verdict-legend");
  const names = legend.querySelectorAll(".verdict-name").map((n) => n.textContent);
  assert.deepEqual(names, ["Regret", "Untouched", "Fair", "Worth it", "Free", "Unpriced"],
    "the facet chips' vocabulary, in the facet chips' order");
  const counts = legend.querySelectorAll(".verdict-count").map((c) => c.textContent);
  assert.deepEqual(counts, ["2 games", "1 game", "1 game", "1 game", "1 game", "1 game"],
    "every game counted exactly once");

  const regretRow = legend.querySelectorAll(".verdict-row").find((r) => r.dataset.tier === "regret");
  assert.equal(regretRow.querySelector(".verdict-swatch").style.background, "var(--tier-regret)",
    "swatch wears the tier colour the badges use");

  regretRow.dispatch("click");
  await settle();
  assert.equal(mod.getState().tier, "regret", "click drives the same action as the chip");
  assert.equal(mod.getState().rows.length, 2, "table narrowed to the regretted pair");
  const chip = env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "regret");
  assert.equal(chip.getAttribute("aria-pressed"), "true", "the facet chip agrees with the chart");
});

test("the verdict card's carousel swaps to value by verdict", async () => {
  const { env, mod } = await boot({ seed: verdictSeed });
  await settle();

  const card = env.root.querySelector(".verdict-list").parentNode;
  assert.equal(card.querySelector("h3").textContent, "Games by verdict", "first slide counts games");
  const dots = card.querySelectorAll(".carousel-dot");
  assert.equal(dots.length, 2, "one dot per slide");

  dots.find((d) => d.dataset.slide === "value").dispatch("click");
  await settle();

  assert.equal(mod.getState().verdictSlide, "value", "the slide choice lives in state");
  assert.equal(card.querySelector("h3").textContent, "Value by verdict", "the title follows the slide");
  const active = dots.find((d) => d.classList.contains("active"));
  assert.equal(active && active.dataset.slide, "value", "the dot agrees");
  assert.equal(env.root.querySelector(".carousel-track").style.transform, "translateX(-50%)",
    "the track slid to the second slide");

  // Value slide: today's price summed per verdict — Regret holds ₹1,500
  // (₹1,000 + ₹500), Untouched ₹200, and the free/unpriced tiers hold nothing.
  const legends = env.root.querySelectorAll(".verdict-legend");
  assert.equal(legends.length, 2, "both slides stay in the deck");
  const values = legends[1].querySelectorAll(".verdict-count").map((c) => c.textContent);
  assert.deepEqual(values, ["₹1,500.00", "₹200.00", "₹300.00", "₹100.00", "₹0.00", "₹0.00"],
    "spend per verdict, in the chips' order");
});

test("clicking a pie slice filters the table to that platform", async () => {
  const { env, mod } = await boot({ seed: mixedSeed });
  await settle();

  const legendRow = (name) => env.root.querySelector(".platform-legend")
    .querySelectorAll(".platform-row").find((r) => r.dataset.platform === name);

  legendRow("Steam").dispatch("click");
  await settle();
  assert.equal(mod.getState().platform, "Steam");
  assert.equal(mod.getState().rows.length, 1, "table filtered to Steam");
  assert.ok(legendRow("Steam").classList.contains("is-active"), "active platform marked");

  // the pie keeps every slice while filtered — it is the control, not the view
  assert.equal(env.root.querySelector(".platform-pie").querySelectorAll("path").length, 2);

  legendRow("Steam").dispatch("click");   // click again to clear
  await settle();
  assert.equal(mod.getState().platform, "All");
  assert.equal(mod.getState().rows.length, 3, "back to everything");
});

test("verdict facets filter the table and expose aria-pressed", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  const facet = (t) => env.root.querySelectorAll(".tier-facet")
    .find((b) => b.dataset.tier === t);
  assert.ok(facet("All"), "the All facet is always offered");
  assert.equal(facet("All").getAttribute("aria-pressed"), "true");

  // 1 priced+played game → no quartiles yet, so Hades reads "unknown"
  // while the two unplayed ones are "untouched".
  assert.equal(mod.getState().bench.samples, 1);
  assert.equal(mod.getState().verdicts.get("Steam:730"), "unknown");
  assert.equal(mod.getState().verdicts.get("Steam:1091500"), "untouched");
  assert.equal(facet("untouched").getAttribute("aria-pressed"), "false");
  assert.equal(facet("worth").hidden, true, "a tier with no members is hidden, not dead");

  facet("untouched").dispatch("click");
  await settle();
  assert.equal(mod.getState().tier, "untouched");
  assert.equal(mod.getState().rows.length, 2, "only the unplayed games");
  assert.equal(facet("untouched").getAttribute("aria-pressed"), "true");
  assert.equal(facet("All").getAttribute("aria-pressed"), "false");
  const saved = JSON.parse(env.localStorage.getItem("ui_state"));
  assert.equal(saved.tier, "untouched", "the facet survives a reload");

  facet("All").dispatch("click");
  await settle();
  assert.equal(mod.getState().tier, "All");
  assert.equal(mod.getState().rows.length, 3, "back to everything");
});

test("the hero states the spend once, with the stats that back it", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  assert.equal(env.document.getElementById("hero").id, "hero");
  assert.equal(env.document.getElementById("hero-spend").textContent, "₹4,425.00");
  const line = env.document.getElementById("hero-line").textContent;
  assert.ok(line.includes("Worst buy:"), `headline reads: ${line}`);
  assert.ok(line.includes("Hades"), "the worst buy is named");

  // The old chips repeated three of the KPI cards verbatim, and as a separate
  // row they left a dead band under the figure. The stats now live inside the
  // hero card instead.
  assert.equal(env.root.querySelector(".hero-chips"), null, "no duplicate chips");
  assert.ok(env.root.querySelector(".kpi-grid"), "the stats sit inside the hero");
  assert.equal(env.document.getElementById("kpi-library"), null, "no second copy of the same figure");
  assert.ok(env.document.getElementById("hero-spend"), "the value lives once, in the hero");
});

test("the PlatPrices credit reaches the state the exports read", async () => {
  // view.setPricingAttribution feeds the footer; the exported cards read
  // state.pricingAttribution. One hand-off in applyPricingNotes, asserted so
  // neither half can be dropped while the other keeps passing. The credit
  // rides the PlayStation half of a pricing answer only — PlatPrices is its
  // sole source and /api/prices never sets it. The fixture settles PSN first
  // and Steam after, so this also pins that the last chunk's silence cannot
  // erase the credit an earlier one earned.
  const seed = (env) => {
    env.localStorage.setItem("steam_id", "76561198000000000");
    env.localStorage.setItem("psn_online_id", "FakePlayer_91");
    env.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: steamFixture };
      if (url.includes("/api/gog_games")) return { json: { games: [] } };
      if (url.includes("/api/epic_games")) return { json: { games: [] } };
      if (url.includes("/api/psn_games")) {
        return { json: { games: [{ id: "PSN:123", name: "Trophy Hunt",
                                    platform: "PlayStation", hours: 5, titleId: "PPSA1234" }] } };
      }
      if (url.includes("/api/psn_prices")) {
        return { json: { prices: { "PSN:123": 400 }, highs: {}, lows: {},
                          currency: "INR", attribution: "Powered by PlatPrices", reason: null } };
      }
      if (url.includes("/api/prices")) {
        return { json: { prices: PRICE_MAP, highs: HIGH_MAP, lows: LOW_MAP } };
      }
      return null;
    });
  };
  const { mod } = await boot({ seed });
  await settle();
  assert.equal(mod.getState().pricingAttribution, "Powered by PlatPrices",
    "the PlayStation half's credit is kept where cardSpec can find it");
});

test("the header offers each control exactly once, in plain words", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  // Scoped to the topbar: the rate-limit note in the footer offers the same
  // destination under different words, and only while a key is actually spent.
  const keysBtns = env.root.querySelector(".topbar").querySelectorAll("button")
    .filter((b) => b.dataset.action === "show-keys");
  assert.equal(keysBtns.length, 1, "one API-keys control, not two with two names");
  assert.equal(keysBtns[0].textContent, "API keys");
  assert.equal(keysBtns[0].hidden, false, "reachable from the dashboard");

  const labels = env.root.querySelectorAll(".source-action")
    .map((b) => `${b.dataset.action}:${b.textContent}`);
  assert.ok(labels.includes("unlink:Forget"), `a linked store reads Forget: ${labels}`);
  assert.ok(labels.includes("link:Link"), `an unlinked store reads Link: ${labels}`);
  // The wordmark stands alone: the pitch line moved off the header — the
  // landing hero says it now, and a subtitle was one line of clutter per
  // screen for a sentence nobody read twice.
  const wordmark = env.root.querySelector(".brand").querySelector("h1");
  assert.equal(wordmark.textContent, "EGRET",
    "the wordmark is caps — the ₹ is the hand-made vector glyph, not typed text");
  assert.ok(env.root.querySelector(".brand-mark").innerHTML.includes("rupee-glyph"),
    "the rupee is the same vector the shared heading and cards draw");
  assert.equal(env.root.querySelector(".brand-sub"), null,
    "no subtitle under the header brand");
  // The topbar shows only linkable stores — the still-planned Xbox chip is
  // absent, but PlayStation (now live) is present.
  const chipNames = env.root.querySelectorAll(".source-name").map((e) => e.textContent);
  assert.ok(!chipNames.includes("Xbox"),
    `planned Xbox stays out of the topbar: ${chipNames}`);
  assert.ok(chipNames.includes("PlayStation"),
    `live PlayStation is in the topbar: ${chipNames}`);
});

test("what-if slider recomputes the rate and persists the setting", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  const range = env.root.querySelector(".sim-range");
  assert.ok(range, "the what-if slider is rendered");
  assert.equal(range.getAttribute("aria-valuetext"), "10 hours");
  assert.ok(env.document.getElementById("sim-out").textContent.includes("today"));

  range.value = "40";
  range.dispatch("input");
  await settle();

  assert.equal(mod.getState().simHours, 40, "state follows the drag");
  assert.equal(JSON.parse(env.localStorage.getItem("ui_state")).simHours, 40);
  assert.equal(range.getAttribute("aria-valuetext"), "40 hours");
  assert.ok(env.document.getElementById("sim-out").textContent.includes("40 h"));
});

test("an over-narrow filter offers a way out instead of a dead end", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  // "No data" holds only Elden Ring; the "unknown" verdict holds only Hades.
  // Their intersection is empty — the classic dead end.
  env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === "No data").dispatch("click");
  await settle();
  env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "unknown")
    .dispatch("click");
  await settle();

  assert.equal(mod.getState().rows.length, 0, "filters combined to nothing");
  const empty = env.root.querySelector(".empty-state");
  assert.equal(empty.hidden, false, "the empty state is shown");
  assert.ok(empty.textContent.includes("No games match these filters"));

  const btn = empty.querySelector("button");
  assert.equal(btn.dataset.action, "clear-filters", "the action matches the cause");
  btn.dispatch("click");
  await settle();
  assert.equal(mod.getState().rows.length, 3, "and it gets you out");
  assert.equal(mod.getState().tier, "All");
  assert.equal(mod.getState().filter, "All");
});

test("the ranked insight lists name the worst and the best buy", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const worst = env.root.querySelector(".rank-worst");
  const best = env.root.querySelector(".rank-best");
  assert.ok(worst && best, "both ranked lists rendered");
  const nameOf = (list) => list.querySelectorAll(".rank-name").map((n) => n.textContent);
  assert.deepEqual(nameOf(worst), ["Hades"], "only played+priced games qualify");
  assert.deepEqual(nameOf(best), ["Hades"]);
  assert.ok(worst.querySelectorAll(".rank-rate")[0].textContent.includes("/h"));
});


// PlayStation carries no credential: the visitor types a public online ID and
// the server reads that profile's playtime with the operator's own reader
// account. This pins the shape a data provider was shown — a deployed build
// with no field asking for a PSN session — because the day one reappears, the
// approval that rests on it is void. Every assertion here is about absence.
test("PlayStation asks for an online ID and never for a token", async () => {
  const { env } = await boot();
  bringKey(env);

  byAction(env, "link", "psn").dispatch("click");
  await settle();

  assert.equal(env.opened.length, 0, "no popup: there is nothing to sign in to");

  const card = env.root.querySelectorAll(".platform-card")
    .find((c) => c.dataset.platform === "psn");
  assert.ok(card, "psn card rendered");

  const anchors = card.querySelectorAll("a").map((a) => String(a.href || ""));
  assert.deepEqual(anchors, [],
    "the card links nowhere — least of all to a Sony account endpoint");

  // One action on the whole card: there is no second "Link" button, because
  // nothing is being linked — Connect is the submit button for the field.
  const buttons = card.querySelectorAll("button");
  assert.equal(buttons.length, 1, "exactly one button: Connect PlayStation");
  assert.equal(buttons[0].dataset.action, "link", "and it is the connect action");

  const text = card.textContent.toLowerCase();
  assert.ok(!text.includes("npsso"), "no NPSSO wording anywhere in the card");
  assert.ok(!text.includes("ssocookie"), "no link to the SSO cookie endpoint");
  assert.ok(text.includes("online id"), "the field is an online ID");

  const paste = env.document.getElementById("psn-paste");
  assert.ok(paste, "the online ID field exists");
  assert.equal(paste.open, true, "visible, since the steps say 'below'");
});

test("an online ID is the whole link, and a malformed one is refused", async () => {
  const { env, mod } = await boot();
  bringKey(env);
  byAction(env, "link", "psn").dispatch("click");
  await settle();

  const input = env.document.getElementById("psn-code");

  // Not an online ID: nothing may be stored, and the field must say why.
  // The Connect button is the submit control — there is no second button.
  input.value = "not a valid!! id";
  byAction(env, "link", "psn").dispatch("click");
  await settle();
  assert.equal(env.localStorage.getItem("psn_online_id"), null,
    "a malformed ID is never stored");
  const err = env.document.getElementById("psn-error");
  assert.ok(err && err.hidden === false, "the refusal is visible");
  assert.ok(String(err.textContent).toLowerCase().includes("online id"),
    "and it names the field");

  // A real one, submitted the other way a field is normally submitted: Enter.
  input.value = "SomePlayer_91";
  input.dispatch("keydown", { key: "Enter" });
  await settle();
  assert.equal(env.localStorage.getItem("psn_online_id"), "SomePlayer_91");
  assert.equal(env.localStorage.getItem("psn_access_token"), null,
    "no session token is ever held by the browser");
  assert.equal(mod.getState().accounts.psn, true, "the ID alone marks it linked");
});

test("filtering a store leaves the ranked lists and the headline alone", async () => {
  const { env, mod } = await boot({ seed: withSteamAndGog });
  await settle();

  const names = (sel) => {
    const list = env.root.querySelector(sel);
    return list.querySelectorAll(".rank-name").map((n) => n.textContent);
  };

  const worstBefore = names(".rank-worst");
  const bestBefore = names(".rank-best");
  const metricsBefore = { ...mod.getState().metrics };
  assert.ok(worstBefore.includes("Hades") && worstBefore.includes("Disco Elysium"),
    `both stores rank unfiltered: ${worstBefore}`);
  const benchBefore = mod.getState().bench;

  // The spend-by-platform legend filters TO a store, which hides every other
  // one — the "hide a website" control.
  const gog = env.root.querySelectorAll(".platform-row")
    .find((r) => r.dataset.platform === "GOG");
  assert.ok(gog, "the legend offers GOG as a filter");
  gog.dispatch("click");
  await settle();

  assert.equal(mod.getState().platform, "GOG", "the filter took");
  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["Disco Elysium"],
    "the table narrowed to the store");
  assert.deepEqual(names(".rank-worst"), worstBefore,
    "the ranked lists still describe the whole library, not this view of it");
  assert.deepEqual(names(".rank-best"), bestBefore);
  assert.deepEqual(mod.getState().metrics, metricsBefore,
    "and so do the KPIs, the hero and the coverage line");
  assert.deepEqual(mod.getState().bench, benchBefore, "benchmark is untouched");

  gog.dispatch("click");   // the toggle clears itself
  await settle();
  assert.equal(mod.getState().platform, "All");
  assert.deepEqual(mod.getState().rows.map((r) => r.name).sort(),
    ["Cyberpunk 2077", "Disco Elysium", "Elden Ring", "Hades"], "the table comes back");
});

test("a filter that empties the table does not empty the insight cards", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  const worst = () => env.root.querySelector(".rank-worst");
  const worstNames = () => worst().querySelectorAll(".rank-name").map((n) => n.textContent);
  assert.deepEqual(worstNames(), ["Hades"], "Hades ranks unfiltered");

  env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === "Unplayed")
    .dispatch("click");
  await settle();

  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["Cyberpunk 2077"],
    "the table narrowed to the unplayed row");
  assert.deepEqual(worstNames(), ["Hades"],
    "the card still names the library's worst buy — it never spoke about the view");
  assert.ok(!worst().querySelector(".rank-empty"),
    "and it is not hiding behind an empty state that would now be a lie");

  env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === "All")
    .dispatch("click");
  await settle();
  assert.equal(mod.getState().rows.length, 3, "the table comes back");
});

test("filtering to a no-playtime store leaves the rate lists standing", async () => {
  const { env, mod } = await boot({ seed: withSteamAndAmazon });
  await settle();

  const cards = () => env.root.querySelectorAll(".rank-card");
  const names = (sel) => env.root.querySelector(sel)
    .querySelectorAll(".rank-name").map((n) => n.textContent);

  assert.equal(cards().length, 3, "three ranked cards ship");
  assert.ok(cards().every((c) => !c.hidden), "the library reports hours, so all three speak");
  const untouchedBefore = names(".rank-untouched");
  assert.deepEqual(untouchedBefore, ["Cyberpunk 2077", "Elden Ring", "Control", "Crysis"],
    "unopened, dearest first — the library's ordering, not the view's");

  const amazon = env.root.querySelectorAll(".platform-row")
    .find((r) => r.dataset.platform === "Amazon");
  assert.ok(amazon, "the legend offers Amazon as a filter");
  amazon.dispatch("click");
  await settle();

  assert.equal(mod.getState().platform, "Amazon", "the filter took");
  const rows = mod.getState().rows;
  assert.equal(rows.length, 2, "two Amazon rows on the table");
  assert.ok(rows.every((r) => r.hours == null), "…and not one of them carries playtime");
  assert.ok(cards().every((c) => !c.hidden),
    "the cards do not follow: the library still has hours, whatever the store shows");
  assert.deepEqual(names(".rank-untouched"), untouchedBefore,
    "and the untouched list still ranks the whole library");

  amazon.dispatch("click");               // the toggle clears itself
  await settle();
  assert.equal(mod.getState().platform, "All");
  assert.equal(cards().length, 3, "nothing about the cards depended on the filter");
});

test("the Free facet filters the table without rewriting the library's claims", async () => {
  const { env, mod } = await boot({ seed: (e) => {
    e.localStorage.setItem("steam_id", "76561198000000000");
    e.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: { games: [
        { id: "Steam:100", name: "Marathon F2P", platform: "Steam", hours: 300, appid: 100 },
        { id: "Steam:200", name: "Quick F2P", platform: "Steam", hours: 5, appid: 200 },
        { id: "Steam:300", name: "Mid F2P", platform: "Steam", hours: 40, appid: 300 },
        { id: "Steam:400", name: "Paid Title", platform: "Steam", hours: 20, appid: 400 },
      ] } };
      if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) {
        return { json: { games: [] } };
      }
      if (url.includes("/api/prices")) return { json: { prices: {
        "Steam:100": 0, "Steam:200": 0, "Steam:300": 0, "Steam:400": 500,
      } } };
      return null;
    });
  } });
  await settle();

  const names = (sel) => env.root.querySelector(sel)
    .querySelectorAll(".rank-name").map((n) => n.textContent);
  const worstBefore = names(".rank-worst");
  const bestBefore = names(".rank-best");
  assert.deepEqual(worstBefore, ["Paid Title"], "one paid game is the library's only bad buy");
  assert.deepEqual(bestBefore, ["Paid Title"], "…and also its best rate, at ₹25/h");

  env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "free")
    .dispatch("click");
  await settle();

  assert.equal(mod.getState().rows.length, 3,
    "the facet selects only played free games — unplayed free reads Untouched");
  assert.deepEqual(names(".rank-worst"), worstBefore,
    "Hall of shame still ranks the library, not the facet");
  assert.deepEqual(names(".rank-best"), bestBefore,
    "and Best value is a library claim too: a paid game beats every free rate");
  const cards = () => env.root.querySelectorAll(".rank-card");
  const untouched = cards().find((c) => c.querySelector(".rank-untouched"));
  assert.ok(untouched && untouched.hidden,
    "the untouched list leaves because the library has no unopened game with a "
    + "price — a fact about the library, not about the facet");
});

test("an all-free library ranks Best value by hours and drops Hall of shame", async () => {
  const { env } = await boot({ seed: (e) => {
    e.localStorage.setItem("steam_id", "76561198000000000");
    e.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: { games: [
        { id: "Steam:1", name: "Long One", platform: "Steam", hours: 300, appid: 1 },
        { id: "Steam:2", name: "Quick One", platform: "Steam", hours: 5, appid: 2 },
        { id: "Steam:3", name: "Mid One", platform: "Steam", hours: 40, appid: 3 },
      ] } };
      if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
      if (url.includes("/api/prices")) return { json: { prices: {
        "Steam:1": 0, "Steam:2": 0, "Steam:3": 0,
      } } };
      return null;
    });
  } });
  await settle();

  const cards = () => env.root.querySelectorAll(".rank-card");
  const find = (cls) => cards().find((c) => c.querySelector(cls));
  assert.ok(find(".rank-worst").hidden,
    "nothing was paid, so nothing can be a bad buy — the card leaves rather than promise one");
  const best = find(".rank-best");
  assert.ok(best && !best.hidden, "Best value keeps speaking, about play");
  assert.deepEqual(best.querySelectorAll(".rank-name").map((n) => n.textContent),
    ["Long One", "Mid One", "Quick One"], "most hours first");
  assert.equal(best.querySelector(".rank-rate").textContent, "₹0/h",
    "the rate column stays honest about what free costs per hour");
  assert.ok(find(".rank-untouched").hidden,
    "an all-free library has no spend to rank untouched by either");
});

test("a search narrows the table without touching the headline", async () => {
  const { env, mod } = await boot({ seed: withSteamAndGog });
  await settle();

  const metricsBefore = { ...mod.getState().metrics };
  const worstBefore = mod.getState().comparators.worst.map((t) => t.id);

  const input = env.root.querySelectorAll("input")
    .find((i) => i.dataset.action === "search");
  assert.ok(input, "the filter bar offers a search box");
  input.value = "Hades";
  input.dispatch("input");
  await settle();

  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["Hades"],
    "the table found the one title");
  assert.deepEqual(mod.getState().metrics, metricsBefore,
    "the KPIs, the hero and the coverage line are claims about the library, not the search");
  assert.deepEqual(mod.getState().comparators.worst.map((t) => t.id), worstBefore,
    "so is the hall of shame");
  assert.equal(env.root.querySelector(".rank-worst").querySelectorAll(".rank-name").length,
    worstBefore.length, "and the card still lists every one of them");
});

test("the coverage line counts one scope", async () => {
  const { env, mod } = await boot({ seed: withSteamAndAmazon });
  await settle();

  const line = () => env.root.querySelector(".coverage").textContent;
  assert.ok(line().includes("2 / 5 games have playtime"), line());

  env.root.querySelectorAll(".platform-row")
    .find((r) => r.dataset.platform === "Amazon")
    .dispatch("click");
  await settle();

  assert.deepEqual(mod.getState().rows.map((r) => r.platform), ["Amazon", "Amazon"],
    "the table narrowed");
  assert.ok(line().includes("2 / 5 games have playtime"),
    "numerator and denominator come from the library, so a filter cannot make them disagree");
});

// ---------- manual price and playtime ----------

/** Five titles, enough played-and-priced ones to form a benchmark, plus the
 *  two shapes an override has to handle: never opened, and never priced. */
const editSeed = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return { json: { games: [
      { id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, appid: 1145360 },
      { id: "Steam:4", name: "Bargain", platform: "Steam", hours: 10, appid: 4 },
      { id: "Steam:5", name: "Pricy", platform: "Steam", hours: 5, appid: 5 },
      { id: "Steam:2", name: "Idle Game", platform: "Steam", hours: 0, appid: 2 },
      { id: "Steam:3", name: "Fresh Game", platform: "Steam", hours: null, appid: 3 },
    ] } };
    if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) return { json: { prices: {
      "Steam:1": 1000, "Steam:4": 200, "Steam:5": 900, "Steam:2": 400, "Steam:3": 600,
    } } };
    return null;
  });
};

const editBox = (env, field) => [...env.root.querySelectorAll(".edit-input")]
  .find((i) => i.dataset.action === `edit-${field}`);
const editButton = (env, action, field) => [...env.root.querySelectorAll("button")]
  .find((b) => b.dataset.action === action && b.dataset.field === field);

async function openTitle(env, name) {
  const row = [...env.root.querySelectorAll(".game-row")]
    .find((r) => r.querySelector(".cell-name").textContent.startsWith(name));
  assert.ok(row, `${name} is on the table`);
  row.dispatch("click");
  await settle();
}

async function saveFigure(env, field, value) {
  const box = editBox(env, field);
  assert.ok(box, `the drawer offers a ${field} box`);
  box.value = String(value);
  editButton(env, "save-edit", field).dispatch("click");
  await settle();
}

test("a price typed in the drawer moves every figure that quotes it", async () => {
  const { env, mod } = await boot({ seed: editSeed });
  await settle();

  assert.equal(env.document.getElementById("hero-spend").textContent, "₹3,100.00",
    "the library starts at the store's own prices");
  const tierBefore = mod.getState().verdicts.get("Steam:1");

  await openTitle(env, "Hades");
  await saveFigure(env, "price", 100);

  assert.equal(env.document.getElementById("hero-spend").textContent, "₹2,200.00",
    "the hero figure follows the number the visitor typed (3,100 − 900)");
  assert.equal(mod.getState().pricesEff["Steam:1"], 100, "the price map agrees");
  assert.notEqual(mod.getState().verdicts.get("Steam:1"), tierBefore,
    "and the verdict moved with it — the benchmark is built from these rates");
  const row = [...env.root.querySelectorAll(".game-row")]
    .find((r) => r.querySelector(".cell-name").textContent.startsWith("Hades"));
  assert.ok(row.querySelector(".edited-chip"), "the row says whose number it is");
  assert.equal(row.querySelectorAll("td")[2].textContent, "₹100.00",
    "the table shows the number the metrics used");
  assert.deepEqual([...env.root.querySelectorAll(".platform-value")]
    .map((n) => n.textContent), ["₹2,200.00"],
    "and the platform pie totals the same money");
});

test("Reset puts the store's own price back, chip and all", async () => {
  const { env, mod } = await boot({ seed: editSeed });
  await settle();

  await openTitle(env, "Hades");
  await saveFigure(env, "price", 100);
  assert.equal(mod.getState().pricesEff["Steam:1"], 100, "the edit took");

  editButton(env, "reset-edit", "price").dispatch("click");
  await settle();

  assert.equal(mod.getState().pricesEff["Steam:1"], 1000, "back to what the store said");
  assert.equal(env.document.getElementById("hero-spend").textContent, "₹3,100.00",
    "and so is the hero figure, with no re-fetch");
  const row = [...env.root.querySelectorAll(".game-row")]
    .find((r) => r.querySelector(".cell-name").textContent.startsWith("Hades"));
  assert.equal(row.querySelector(".edited-chip"), null, "the marker leaves with the edit");
});

test("a playtime entered by hand moves a game out of Untouched", async () => {
  const { env, mod } = await boot({ seed: editSeed });
  await settle();

  assert.equal(mod.getState().verdicts.get("Steam:2"), "untouched",
    "never opened reads untouched to begin with");
  const playedBefore = mod.getState().tabCounts.Played;

  await openTitle(env, "Idle Game");
  await saveFigure(env, "hours", 12);

  assert.notEqual(mod.getState().verdicts.get("Steam:2"), "untouched",
    "with hours on the record the verdict is earned, not assumed");
  assert.equal(mod.getState().tabCounts.Played, playedBefore + 1,
    "the play-status tabs follow the same hours");
  assert.equal(mod.getState().comparators.untouched.some((t) => t.id === "Steam:2"), false,
    "and it drops out of the untouched list, which ranked it by spend");
});

test("a figure that is not a figure is refused, and nothing moves", async () => {
  const { env, mod } = await boot({ seed: editSeed });
  await settle();

  await openTitle(env, "Hades");
  const box = editBox(env, "price");
  box.value = "-5";
  editButton(env, "save-edit", "price").dispatch("click");
  await settle();

  const err = [...env.root.querySelectorAll(".edit-error")].pop();
  assert.ok(err && !err.hidden, "the drawer explains the refusal");
  assert.ok(err.textContent.includes("0 or more"), err.textContent);
  assert.equal(mod.getState().pricesEff["Steam:1"], 1000, "the store's price stands");
  assert.equal(env.document.getElementById("hero-spend").textContent, "₹3,100.00",
    "and no headline moved on a rejected number");
});

test("an edit survives a reload, because it is stored and the rows are not", async () => {
  const seed = (env) => {
    editSeed(env);
    // What a browser would already hold after a previous visit.
    env.localStorage.setItem("game_edits",
      JSON.stringify({ "Steam:1": { price: 100, currency: "INR" } }));
  };
  const { env, mod } = await boot({ seed });
  await settle();

  assert.equal(mod.getState().pricesEff["Steam:1"], 100, "the edit applied on boot");
  assert.equal(env.document.getElementById("hero-spend").textContent, "₹2,200.00");
  const basis = env.root.querySelector(".disclaimer-basis");
  assert.equal(basis.hidden, false, "the footer owns up to the changed basis");
  assert.ok(basis.textContent.includes("1 title"), basis.textContent);
});

test("a price entered in another currency keeps its number and its name", async () => {
  const { env, mod } = await boot({ seed: editSeed });
  await settle();

  await openTitle(env, "Hades");
  await saveFigure(env, "price", 500);

  const sel = env.root.querySelector(".header-currency");
  sel.value = "USD";
  sel.dispatch("change");
  await settle();

  assert.equal(mod.getState().currency, "USD", "the display currency moved");
  assert.equal(mod.getState().pricesEff["Steam:1"], 500,
    "the number did not — there is no FX in the app to move it with");
  await openTitle(env, "Hades");
  const notes = [...env.root.querySelectorAll(".edit-note")]
    .map((n) => n.textContent).join(" ");
  assert.ok(notes.includes("set in INR"), `the drawer names the currency: ${notes}`);
});

test("forget takes the visitor's own figures with everything else", async () => {
  const { env } = await boot({ seed: editSeed });
  await settle();
  await openTitle(env, "Hades");
  await saveFigure(env, "price", 100);
  assert.ok(env.localStorage.getItem("game_edits"), "the edit is stored");

  store.forget();

  assert.equal(env.localStorage.getItem("game_edits"), null, "gone with the credentials");
  assert.deepEqual(store.getEdits(), {}, "and nothing left to re-apply");
});

test("forget clears every credential a single unlink clears", async () => {
  const { env, mod } = await boot();
  await settle();

  // The two lists drifted once: KEY_STORES grew PlayStation, CRED_KEYS did not,
  // so "Forget my data" left a linked PSN account behind — visible as a store
  // that reported itself linked with nothing behind it. Keys with no store
  // entry (a pasted PlatPrices key) belong to Forget too.
  const keys = new Set(Object.values(mod.KEY_STORES).flat());
  keys.add("platprices_api_key");
  assert.ok(keys.has("psn_access_token"), "the fixture covers PlayStation");
  for (const k of keys) env.localStorage.setItem(k, "sentinel");

  store.forget();

  for (const k of keys) {
    assert.equal(env.localStorage.getItem(k), null, `${k} must not survive Forget my data`);
  }
});

test("forget a store while its scan is still running, then link another", async () => {
  // The reported flow, in one test: the answer arrives *after* the visitor has
  // forgotten the account. Without an epoch, that late answer restored the old
  // rows, wrote them back into the snapshot, and left state.scanning holding
  // the lock — so the next link never scanned, and only Forget my data fixed it.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { env, mod } = await boot({
    seed: (e) => {
      e.localStorage.setItem("steam_id", "76561198000000000");
      e.fetchRoutes.push((url) => {
        if (url.includes("/api/steam_games")) {
          return gate.then(() => ({ json: { games: [
            { id: "Steam:1", name: "Old Library Game", platform: "Steam", hours: 5, appid: 1 },
          ] } }));
        }
        // Nothing else is answered here: routes win in order, and a catch-all
        // in the first one would starve the library linked afterwards.
        return null;
      });
    },
  });
  await settle();
  assert.equal(mod.getState().scanning, true, "the Steam scan is held open");

  // Forget through the dialog, as a visitor would.
  [...env.root.querySelectorAll("button")]
    .find((b) => b.dataset.action === "confirm-forget").dispatch("click");
  await settle();
  [...env.root.querySelectorAll("button")]
    .find((b) => b.dataset.action === "do-forget").dispatch("click");
  await settle();

  assert.equal(mod.getState().scanning, false,
    "the scan in flight was abandoned instead of left holding the lock");
  assert.equal(env.localStorage.getItem("last_scan"), null, "and it wrote no snapshot");

  release();          // the forgotten library's answer lands now
  await settle();

  assert.equal(mod.getState().games.length, 0,
    "the abandoned scan's rows must not resurrect what was forgotten");
  assert.equal(env.localStorage.getItem("last_scan"), null,
    "…nor be written back to the snapshot, which is what forced Forget my data before");

  // Link a different library: it has to scan on its own.
  env.localStorage.setItem("epic_access_token", "epic-tok");
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/epic_games")) return { json: { games: [
      { id: "Epic:1", name: "New Library Game", platform: "Epic", hours: 7 },
    ] } };
    if (url.includes("/api/prices")) return { json: { prices: { "Epic:1": 700 } } };
    if (url.includes("/api/gog_games") || url.includes("/api/steam_games")) return { json: { games: [] } };
    return null;
  });
  env.window.emit("storage", { key: "epic_access_token" });
  await settle();

  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["New Library Game"],
    "the new library scans by itself — no Forget-my-data round trip needed");
  const snap = JSON.parse(env.localStorage.getItem("last_scan"));
  assert.deepEqual(snap.games.map((g) => g.id), ["Epic:1"],
    "and the snapshot holds the new library only");
});

// ---------- forgetting one account ----------

const unlinkButton = (env) => env.root.querySelectorAll(".source-action")
  .find((b) => b.dataset.action === "unlink" && b.dataset.platform === "steam");

test("forgetting one store takes that store's data, not everyone's", async () => {
  const { env, mod } = await boot({ seed: withSteamAndGog });
  await settle();
  assert.equal(mod.getState().rows.length, 4, "three Steam games and one GOG game");
  env.localStorage.setItem("game_edits", JSON.stringify({ "GOG:12345": { price: 99 } }));

  const steam = unlinkButton(env);
  assert.ok(steam, "the Steam chip offers Forget");
  steam.dispatch("click");
  await settle();

  assert.equal(mod.getState().accounts.steam, false, "the credential is gone");
  assert.equal(mod.getState().accounts.gog, true, "the other store is untouched");
  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["Disco Elysium"],
    "only GOG's game remains on the table");
  assert.equal(mod.getState().prices["Steam:730"], undefined, "and its prices with it");
  assert.equal(mod.getState().prices["GOG:12345"], 900, "the survivor's price stands");
  assert.deepEqual(store.getEdits(), { "GOG:12345": { price: 99 } },
    "a manual figure for a surviving title survives too");
  const snap = JSON.parse(env.localStorage.getItem("last_scan"));
  assert.ok(snap && snap.games.every((g) => g.platform === "GOG"),
    "the snapshot no longer carries the account that left");
});

test("forgetting the only store clears the snapshot, not just the rows", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();
  assert.equal(mod.getState().rows.length, 3);

  unlinkButton(env).dispatch("click");
  await settle();

  assert.equal(env.localStorage.getItem("last_scan"), null,
    "the snapshot goes with the last account: boot only scans when the library is empty, "
    + "so a surviving one would be restored under the next account forever");
  assert.equal(mod.getState().games.length, 0, "and the rows with it");
  assert.equal(mod.getState().phase, "onboarding");
});

test("linking a different Steam account works without forgetting everything", async () => {
  const oldAccount = (env) => {
    env.localStorage.setItem("steam_id", "76561198000000000");
    env.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: { games: [
        { id: "Steam:900", name: "Old Account Game", platform: "Steam", hours: 5, appid: 900 },
      ] } };
      if (url.includes("/api/prices")) return { json: { prices: { "Steam:900": 500 } } };
      if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
      return null;
    });
  };
  const { env, mod } = await boot({ seed: oldAccount });
  await settle();
  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["Old Account Game"],
    "the first account's library");

  unlinkButton(env).dispatch("click");
  await settle();
  assert.equal(env.localStorage.getItem("last_scan"), null, "the snapshot went with it");
  assert.equal(mod.getState().games.length, 0, "so did the library");

  // What the OpenID callback does next: a new id, a new library, and the
  // cross-window signal that a credential changed.
  env.localStorage.setItem("steam_id", "76561198000000001");
  env.fetchRoutes.length = 0;
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return { json: { games: [
      { id: "Steam:901", name: "New Account Game", platform: "Steam", hours: 7, appid: 901 },
    ] } };
    if (url.includes("/api/prices")) return { json: { prices: { "Steam:901": 700 } } };
    if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
    return null;
  });
  env.window.emit("storage", { key: "steam_id" });
  await settle();

  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["New Account Game"],
    "the new account's library — not the previous one's, and no Scan button needed");
});

test("the header carries forget my data, and it asks before it acts", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  assert.equal(env.root.querySelector(".menu"), null, "the hamburger menu is gone");
  assert.ok(![...env.root.querySelectorAll("button")]
    .some((b) => b.dataset.action === "toggle-menu"), "and nothing behind it remains");

  const header = [...env.root.querySelectorAll("button")]
    .find((b) => b.dataset.action === "confirm-forget" && b.classList.contains("danger-solid"));
  assert.ok(header, "a filled red Forget my data button sits in the header");
  const footer = env.root.querySelector(".footer-forget");
  assert.ok(footer, "and the footer repeats it, for whoever looks there");
  assert.equal(footer.dataset.action, "confirm-forget", "both ask first");

  const modal = env.root.querySelector(".forget-modal");
  assert.equal(modal.hidden, true, "hidden until asked for");
  header.dispatch("click");
  await settle();

  assert.equal(modal.hidden, false, "the confirmation opens");
  assert.ok(modal.querySelector("h3").textContent.includes("Forget"),
    "and names what it is about to do");
  assert.ok([...modal.querySelectorAll("button")].some((b) => b.dataset.action === "do-forget"),
    "with the destructive action offered");
  assert.ok(![...modal.querySelectorAll("button")].some((b) => b.classList.contains("icon")),
    "but no X to reach for: the two answers are the buttons");

  [...modal.querySelectorAll("button")].find((b) => b.dataset.action === "cancel-forget")
    .dispatch("click");
  await settle();
  assert.equal(modal.hidden, true, "Cancel dismisses it");
  assert.equal(mod.getState().accounts.steam, true, "and nothing was forgotten");

  header.dispatch("click");
  await settle();
  [...modal.querySelectorAll("button")].find((b) => b.dataset.action === "do-forget")
    .dispatch("click");
  await settle();

  assert.equal(mod.getState().phase, "onboarding", "the data is gone");
  assert.equal(env.localStorage.getItem("steam_id"), null, "credentials cleared");
  assert.equal(env.localStorage.getItem("last_scan"), null, "so is the library");
  assert.equal(modal.hidden, true, "the dialog dismisses itself once it has done the job");
  const done = env.root.querySelector(".forget-done");
  assert.ok(done && !done.hidden, "and the landing page says it worked");
  assert.ok(done.textContent.includes("deleted"), done.textContent);
});

test("the visitor's region defaults the currency until they choose one", async () => {
  const geo = (country) => (e) => {
    e.fetchRoutes.push((url) => (url.includes("/api/config") ? { json: {
      publicBaseUrl: "https://demo.test", country,
      requireUserKeys: true, keys: {},
    } } : null));
  };

  const { env, mod } = await boot({ seed: geo("DE") });
  await settle();

  assert.equal(mod.getState().currency, "EUR",
    "the edge reports the country and the display currency follows it");
  assert.equal(env.root.querySelector(".currency-select").value, "EUR",
    "the header picker shows the detected default");
  assert.match(env.root.querySelector(".toy-price").textContent, /€/,
    "and the landing-page toy repaints in the same currency — no hard-coded rupee");

  // A country we offer no currency for leaves the default alone.
  const unknown = await boot({ seed: geo("ZZ") });
  await settle();
  assert.equal(unknown.mod.getState().currency, "INR",
    "no offered currency, no change");

  // An explicit picker choice is never rivalled by detection.
  const chosen = await boot({ seed: (e) => {
    e.localStorage.setItem("currency", "JPY");
    geo("DE")(e);
  } });
  await settle();
  assert.equal(chosen.mod.getState().currency, "JPY", "the saved choice wins");
});

test("the Untouched facet filters the table and leaves the cards alone", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();

  const cards = () => env.root.querySelectorAll(".rank-card");
  const find = (cls) => cards().find((c) => c.querySelector(cls));
  const names = (cls) => find(cls).querySelectorAll(".rank-name").map((n) => n.textContent);
  assert.ok(cards().every((c) => !c.hidden), "all three lists start under All verdicts");
  const worstBefore = names(".rank-worst");
  const untouchedBefore = names(".rank-untouched");

  env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "untouched")
    .dispatch("click");
  await settle();

  assert.deepEqual(mod.getState().rows.map((r) => r.name), ["Cyberpunk 2077", "Elden Ring"],
    "the facet narrowed the table to the unopened games");
  assert.ok(cards().every((c) => !c.hidden),
    "the cards do not follow: a facet is a browsing choice, not a claim");
  assert.deepEqual(names(".rank-worst"), worstBefore, "Hall of shame still ranks the library");
  assert.deepEqual(names(".rank-untouched"), untouchedBefore,
    "and the untouched list still ranks the library's unopened games");

  env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "All")
    .dispatch("click");
  await settle();
  assert.equal(mod.getState().rows.length, 3, "clearing the facet restores the table");
});

test("a library nothing can rank takes the whole insights row away", async () => {
  // Every game free and never opened: no bad buy (nothing was paid), no rate
  // (no hours), nothing unopened-with-a-price to rank by spend. All three cards
  // are structurally silent, so the row leaves rather than showing three gaps.
  // This used to be triggered by picking a facet — which was the bug: a facet
  // is a browsing choice, not a claim about the library.
  const { env } = await boot({ seed: (e) => {
    e.localStorage.setItem("steam_id", "76561198000000000");
    e.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: { games: [
        { id: "Steam:1", name: "Free One", platform: "Steam", hours: null, appid: 1 },
        { id: "Steam:2", name: "Free Two", platform: "Steam", hours: null, appid: 2 },
      ] } };
      if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) return { json: { games: [] } };
      if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 0, "Steam:2": 0 } } };
      return null;
    });
  } });
  await settle();

  const cards = env.root.querySelectorAll(".rank-card");
  assert.ok(cards.every((c) => c.hidden), "no card can speak without a price or an hour");
  assert.equal(env.root.querySelector(".insights").hidden, true,
    "three empty cards in a row of gaps beats nothing; the row leaves instead");
});

test("every dashboard metric carries a wired explanation chip", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const chips = env.root.querySelectorAll(".info");
  // 7 KPI cards (incl. the add-on card, which is present-but-hidden without DLC)
  // + the hero label + the headline + all three ranked cards.
  // Root-scoped on purpose: it counts attached nodes only, which is what makes
  // it a real guard against a chip being detached from the page while its id
  // stays reachable — exactly what happened with the ₹/hour label.
  assert.equal(chips.length, 12,
    chips.map((c) => c.getAttribute("aria-describedby")).join(", "));

  for (const chip of chips) {
    assert.equal(chip.type, "button", "focusable by keyboard, and never a submit");
    assert.equal(chip.dataset.action, "info",
      "must stop closestAction here: inside a .rank-item this would open the drawer instead");
    const id = chip.getAttribute("aria-describedby");
    assert.ok(id, "referenced by id");
    const tip = env.document.getElementById(id);
    assert.ok(tip, `${id} resolves in the document`);
    assert.equal(tip.getAttribute("role"), "tooltip");
    assert.ok(tip.textContent.trim().length > 30,
      `"${tip.textContent.slice(0, 30)}…" is a stub, not an explanation`);
  }

  for (const key of ["kpi-regret", "kpi-vph", "hero-spend",
                     "rank-worst", "rank-best", "rank-untouched"]) {
    assert.ok(env.document.getElementById(`tip-${key}`), `tip-${key} exists`);
  }
});

test("the hero figure stays a bare figure", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  // The chip annotates the "Re-buy cost" label instead, because this
  // element's textContent is pinned by an existing assertion and a rupee total
  // with a stray "i" glued to it would read as corruption.
  const figure = env.document.getElementById("hero-spend");
  assert.equal(figure.querySelector(".info"), null, "no chip inside the figure");
  assert.match(figure.textContent, /^₹[\d,.]+$/, "still a bare amount");
  // Split selector: the test DOM stub has no descendant-selector support.
  const micro = env.root.querySelector(".micro");
  assert.ok(micro && micro.querySelector(".info"), "the label carries it instead");
});

test("the headline's chip rides at the end of the sentence, not on its own row", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const line = env.document.getElementById("hero-line");
  assert.ok(line.querySelector(".info"),
    "inside the paragraph, so it sits inline after the last word");

  // The bug this replaces: appended as a sibling of the paragraph, the chip
  // fell onto its own row and hung in the gap above the KPI grid.
  const orphanChip = env.document.getElementById("hero").children
    .some((el) => el.classList && el.classList.contains("info"));
  assert.ok(!orphanChip,
    "no chip as a direct child of the hero — only the labelled blocks belong there");

  // updateHero rewrites the sentence on every render; reaching this text
  // through the inner span proves the chip survived those rewrites instead of
  // being detached from the page at build time.
  assert.ok(line.textContent.includes("Worst buy:"),
    "the sentence still renders through the inner span");
});

test("every API-key field links to where the key is issued", async () => {
  const { env } = await boot();          // no stores linked: onboarding view
  await settle();

  const card = env.root.querySelector(".api-keys");
  assert.ok(card, "the keys card renders on the landing page");
  assert.equal(card.querySelectorAll(".key-field").length, 4,
    "IsThereAnyDeal, Steam Web, SteamGridDB and PlatPrices");

  const links = card.querySelectorAll(".key-link");
  assert.equal(links.length, 4, "each field says where to get its key");
  const hrefs = links.map((l) => l.href).join(" ");
  for (const url of ["https://isthereanydeal.com/apps/",
                     "https://steamcommunity.com/dev/apikey",
                     "https://steamgriddb.com/profile/preferences/api",
                     "https://platprices.com/api-request"]) {
    assert.ok(hrefs.includes(url), `${url} is linked`);
  }
  assert.ok(links.every((l) => l.target === "_blank"
    && (l.rel || "").includes("noopener")),
    "external links open a new tab without handing it the opener");

  // Nothing is filed under "optional extras": with no shared key three of
  // these four are load-bearing — Steam without its Web key cannot read a
  // single game, PlatPrices without one prices nothing on PlayStation.
  assert.ok(!card.textContent.includes("Optional extras"),
    "no optional-extras bin");
  assert.equal(card.querySelectorAll(".key-group-title").length, 0,
    "no column headings: the card's own title says what they are");
});

test("the keys card only says optional when the server really carries a key", async () => {
  // Config unreachable: state.server stays null, and calling keys optional
  // on no evidence is exactly the claim that shipped wrong.
  const bare = await boot();
  await settle();
  const bareTag = bare.env.root.querySelector(".api-keys").querySelector(".pc-tag");
  assert.equal(bareTag.textContent, "needed for pricing",
    "unverified is not the same as optional");

  // A shared-key instance: the quota framing finally becomes true.
  const shared = await boot({ seed: (env) => {
    env.fetchRoutes.push((url) => (url.includes("/api/config") ? { json: {
      publicBaseUrl: "https://demo.test",
      requireUserKeys: false,
      keys: { steam: true, itad: true, platprices: false },
    } } : null));
  } });
  await settle();
  const card = shared.env.root.querySelector(".api-keys");
  assert.equal(card.querySelector(".pc-tag").textContent, "optional");
  assert.ok(card.querySelector(".pc-blurb").textContent.includes("rate-limit quota"),
    "the shared-key instance explains the quota trade, not a requirement");
  assert.ok(card.textContent.includes("only if the shared Steam key is rate-limited"),
    "the Steam hint follows the same read of the server's keys");
});

test("BYO-key mode needs the visitor's key even when the server has one", async () => {
  // health.py's rule, mirrored: in BYO-key mode the server's own keys are
  // ignored, so a configured server key changes nothing for the visitor.
  const { env } = await boot({ seed: (e) => {
    e.fetchRoutes.push((url) => (url.includes("/api/config") ? { json: {
      requireUserKeys: true,
      keys: { steam: false, itad: true, platprices: false },
    } } : null));
  } });
  await settle();
  const card = env.root.querySelector(".api-keys");
  assert.equal(card.querySelector(".pc-tag").textContent, "needed for pricing");
  assert.ok(card.querySelector(".pc-blurb").textContent.includes(
    "no shared IsThereAnyDeal key"), "and says why");
  assert.ok(card.textContent.includes("needed to read Steam playtime"),
    "the Steam hint drops its rate-limit framing too");
});

test("the cost-per-hour chart names itself and explains each piece on hover", async () => {
  // The chart needs at least three priced, played games or benchmark() withholds
  // the quartiles and only the "draw a benchmark" note renders.
  const { env } = await boot({ seed: (e) => {
    e.localStorage.setItem("steam_id", "76561198000000000");
    e.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) return { json: { games: [
        { id: "Steam:1", name: "Alpha", platform: "Steam", hours: 4, appid: 1 },
        { id: "Steam:2", name: "Beta", platform: "Steam", hours: 20, appid: 2 },
        { id: "Steam:3", name: "Gamma", platform: "Steam", hours: 60, appid: 3 },
        { id: "Steam:4", name: "Delta", platform: "Steam", hours: 100, appid: 4 },
      ] } };
      if (url.includes("/api/gog_games") || url.includes("/api/epic_games")) {
        return { json: { games: [] } };
      }
      // Rates: Alpha 30, Beta 25, Delta 20, Gamma ~16.7 — a unique worst buy,
      // so the marker test cannot depend on sort tie-breaking.
      if (url.includes("/api/prices")) return { json: { prices: {
        "Steam:1": 120, "Steam:2": 500, "Steam:3": 1000, "Steam:4": 2000,
      } } };
      return null;
    });
  } });
  await settle();

  const dist = env.document.getElementById("dist");
  assert.equal(dist.querySelector(".dist-title").textContent,
    "Cost per hour across your library",
    "a visible name — it used to be aria-only, which is how it read as a slider");

  const ends = dist.querySelector(".dist-ends").textContent;
  assert.ok(ends.includes("₹0") && ends.includes("p90"),
    `axis ends are labelled: ${ends}`);

  const out = dist.querySelector(".dist-say");
  assert.ok(out, "explanation line present, in normal flow");
  assert.ok(out.textContent.includes("Hover the box"),
    "opens with the instruction — hover was undiscoverable without it");

  const marker = dist.querySelector(".dist-marker");
  assert.ok(marker, "worst-buy dot drawn");
  assert.equal(marker.getAttribute("data-stat"), "worst",
    "the shapes declare which statistic they carry");
  marker.dispatch("mouseover");
  assert.ok(out.textContent.includes("Worst buy: Alpha"), `line reads: ${out.textContent}`);
  assert.ok(out.textContent.includes("per hour"), "and states the rate with its unit");
  assert.equal(out.classList.contains("on"), true, "marked while explaining");

  const median = dist.querySelector(".dist-median");
  median.dispatch("mouseover");
  assert.ok(out.textContent.includes("Median:"), "moving to another piece rewrites the line");

  median.dispatch("mouseout");
  assert.ok(out.textContent.includes("Hover the box"),
    "leaving restores the instruction rather than going blank");
  assert.equal(out.classList.contains("on"), false);
});

test("the explanations still describe the actual maths", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();
  const tip = (key) => env.document.getElementById(`tip-${key}`).textContent;

  // Regret is backlog ÷ known value; unknown playtime is excluded from both.
  assert.ok(tip("kpi-regret").includes("÷"), "states the ratio");
  assert.ok(tip("kpi-regret").includes("unknown playtime"),
    "must keep saying unknown-playtime titles are excluded");
  // value per hour is a division of price by recorded hours.
  assert.ok(tip("kpi-vph").includes("divided by"));
  // both ranked lists are gated on an hour of play, per comparators().
  assert.ok(tip("rank-worst").includes("hour or more of play"));
  assert.ok(tip("rank-best").includes("hour or more of play"));
});

test("the demo asks the store for the hero's real regional price", async () => {
  // Converting ₹690 at an FX rate would show a US visitor $7.84 — a number
  // no store charges. Regional pricing is its own thing, so the landing page
  // prices the one real game in the batch and anchors the demo on it.
  const { env, mod } = await boot({ seed: (e) => {
    e.fetchRoutes.push((url) => {
      if (url.includes("/api/config")) {
        return { json: { country: "US", requireUserKeys: false, keys: { itad: true } } };
      }
      if (url.includes("/api/prices")) {
        return { json: { prices: { "toy-hero": 14.99 }, currency: "USD" } };
      }
      return null;
    });
  } });
  await settle();

  assert.equal(mod.getState().currency, "USD", "the region picked the currency first");
  assert.equal(env.root.querySelector(".toy-price").textContent, "$14.99",
    "the store's US price, not an FX conversion of India's list price");
});

test("the Share button ships with the dashboard and opens the deck", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const shareBtn = env.root.querySelectorAll("button")
    .find((b) => b.dataset.action === "share");
  assert.ok(shareBtn, "the dashboard invites sharing");
  assert.equal(shareBtn.textContent, "Share");
  shareBtn.dispatch("click");
  await settle();

  const drawer = env.root.querySelector(".drawer");
  assert.equal(drawer.classList.contains("hidden"), false,
    "the deck opens in the drawer the game inspector already uses");
  assert.equal(env.document.getElementById("drawer-title").textContent, "Share your card");
  assert.ok(env.root.querySelector(".export-prompt").textContent.includes("send it to someone"),
    "the drawer opens by prompting a share, not by naming a file format");
  const chips = env.root.querySelector(".export-chips").children.map((c) => c.textContent);
  assert.deepEqual(chips,
    ["Wrapped", "Hall of shame", "Best value", "Untouched", "No benchmark", "This view"],
    "one chip per card this library can fill — Untouched appears once, library-wide");
  const canvas = env.document.getElementById("export-canvas");
  assert.ok(canvas, "a live preview sits in the drawer");
  assert.equal(canvas.width, 1080);
  const linkBox = env.root.querySelector(".export-link");
  assert.match(linkBox.textContent, /#card=/, "the drawer shows the link it will copy");
  assert.ok(SHARE_NUDGE_SETS.shame.includes(env.root.querySelector(".export-caption").textContent),
    "the nudge matches the shelf's band — this fixture sits at 62.5% regret");
  const worstChip = env.root.querySelectorAll(".tab")
    .find((b) => b.dataset.kind === "worst");
  const beforeLink = linkBox.textContent;
  worstChip.dispatch("click");
  await settle();
  assert.notEqual(env.root.querySelector(".export-link").textContent, beforeLink,
    "the link follows the card on the preview");

  // No clipboard in the stub, so the link itself is shown — still useful.
  const copy = env.root.querySelectorAll("button")
    .find((b) => b.dataset.action === "export-copy");
  copy.dispatch("click");
  await settle();
  assert.match(env.root.querySelector(".export-status").textContent, /#card=/,
    "Copy link surfaces a URL that opens this exact card");
});

test("Copy link asks is.gd once, only on the click, and a refusal keeps the plain link", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();
  env.fetchRoutes.push((url) => (url.includes("is.gd/create.php")
    ? { json: { shorturl: "https://is.gd/ab12cd" } } : null));

  const shareBtn = env.root.querySelectorAll("button")
    .find((b) => b.dataset.action === "share");
  shareBtn.dispatch("click");
  await settle();
  assert.ok(!env.fetchCalls.some((c) => c.url.includes("is.gd")),
    "opening the drawer sends nothing: the card travels only on the click");

  const copy = env.root.querySelectorAll("button")
    .find((b) => b.dataset.action === "export-copy");
  copy.dispatch("click");
  await settle();
  assert.equal(env.fetchCalls.filter((c) => c.url.includes("is.gd")).length, 1,
    "exactly one shortening request per copy");
  assert.match(env.root.querySelector(".export-status").textContent, /is\.gd\/ab12cd/,
    "the short link is what gets surfaced (no clipboard in the stub, so it shows)");

  // The shortener is optional: with it gone, the plain link still arrives.
  env.fetchRoutes.pop();
  copy.dispatch("click");
  await settle();
  assert.match(env.root.querySelector(".export-status").textContent, /#card=/,
    "a refused shortener falls back to the full link");
});

test("the Share button waits for a library", async () => {
  const { env } = await boot();
  await settle();
  const btn = env.root.querySelectorAll("button")
    .find((b) => b.dataset.action === "share");
  assert.ok(btn && btn.hidden === true, "nothing to share before a scan");
});

test("a shared card link shows the snapshot, not a signup wall", async () => {
  const payload = {
    v: 1, kind: "wrapped", title: "WRAPPED", src: "friend.example", at: Date.now(),
    who: "Sir Regrets",
    eyebrow: "YOUR LIBRARY, JUDGED", badge: "12 GAMES", stats: [], rows: [], footnote: "",
  };
  // Encoded before boot: seeds are synchronous, and the hash must be in place
  // before the app reads it.
  const hash = `#card=${await encodeCard(payload)}`;
  const { env, mod } = await boot({ seed: (e) => {
    e.window.location.hash = hash;
  } });
  await settle();

  assert.equal(mod.getState().phase, "shared", "the link decides the phase");
  assert.ok(env.root.querySelector(".shared-card"), "the card lands full size");
  const note = env.root.querySelector(".shared-note").textContent;
  assert.ok(note.includes("Sir Regrets"),
    "signed with the sharer's Steam name — not the hostname they happened to use");
  assert.ok(!note.includes("friend.example"),
    "the hostname only stands in when no name was known");
  assert.ok(env.document.getElementById("shared-canvas"), "the snapshot is drawn, not described");
  const makeOwn = env.root.querySelectorAll("button")
    .find((b) => b.dataset.action === "make-own");
  assert.ok(makeOwn, "the way in is offered");
  assert.equal(makeOwn.textContent, "Judge my library");
  const invite = env.root.querySelector(".shared-invite");
  assert.equal(invite.textContent, "Your library, up next.",
    "the invitation speaks the deck's own language");
  const kids = [...env.root.querySelector(".shared-card").children];
  assert.ok(kids.indexOf(invite) < kids.indexOf(env.document.getElementById("shared-canvas")),
    "and comes before the card, not buried under a 4:5 canvas on a phone");
  assert.equal(env.root.querySelector(".export-preview"), null,
    "no app chrome on a shared card");

  makeOwn.dispatch("click");
  await settle();
  assert.equal(mod.getState().phase, "onboarding",
    "Judge my library returns to the landing page, hash or not");
  assert.equal(env.root.querySelector(".shared-card"), null, "the shared card leaves");
});

test("a shared card reads its verdict from the score the card carries", async () => {
  const base = {
    v: 1, kind: "wrapped", title: "WRAPPED", at: Date.now(), who: "Sir Regrets",
    eyebrow: "YOUR LIBRARY, JUDGED", badge: "12 GAMES", rows: [], footnote: "",
  };
  // The score rides the spec now; links minted before it still read their
  // printed stat, and neither reads as Unknown rather than a guess.
  const scoredHash = `#card=${await encodeCard({ ...base, regret: 0.7 })}`;
  const scored = await boot({ seed: (e) => {
    e.window.location.hash = scoredHash;
  } });
  await settle();
  assert.ok(SHARED_VERDICTS.ruin.includes(
    scored.env.root.querySelector(".shared-verdict").textContent),
    "a scored link reads the Ruin band");

  const legacyHash = `#card=${await encodeCard({
    ...base, stats: [{ label: "REGRET SCORE", value: "70%" }],
  })}`;
  const legacy = await boot({ seed: (e) => {
    e.window.location.hash = legacyHash;
  } });
  await settle();
  assert.ok(SHARED_VERDICTS.ruin.includes(
    legacy.env.root.querySelector(".shared-verdict").textContent),
    "a pre-score link still reads its printed stat");

  const bareHash = `#card=${await encodeCard({ ...base, stats: [] })}`;
  const bare = await boot({ seed: (e) => {
    e.window.location.hash = bareHash;
  } });
  await settle();
  assert.ok(SHARED_VERDICTS.unknown.includes(
    bare.env.root.querySelector(".shared-verdict").textContent),
    "with nothing to judge by, the Unknown set says so");
});

test("the wordmark takes you back to the landing page", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();
  assert.equal(mod.getState().phase, "ready");

  const home = env.root.querySelector(".brand-home");
  assert.ok(home, "the wordmark is a button");
  assert.equal(home.dataset.action, "home");
  home.dispatch("click");
  await settle();

  assert.equal(mod.getState().phase, "onboarding",
    "the landing page — store links and API keys — is one click away");
  assert.ok(env.root.querySelector(".api-keys"), "the keys card is there");
  assert.equal(env.root.querySelector(".sources").hidden, true,
    "the dashboard chrome stands down");

  home.dispatch("click");          // same node: the shell never rebuilds
  await settle();
  assert.equal(mod.getState().phase, "onboarding",
    "already home — clicking again does nothing dramatic");
});

const limitedSeed = (extra = {}) => (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  Object.entries(extra).forEach(([k, v]) => env.localStorage.setItem(k, v));
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) {
      return { json: { games: [{ id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, appid: 1145360 }] } };
    }
    if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 500 }, limited: { itad: true } } };
    return null;
  });
};

test("a rate-limited shared key tells the visitor to bring their own", async () => {
  const { env } = await boot({ seed: limitedSeed() });
  await settle();

  const note = env.root.querySelector(".disclaimer-limit-note");
  assert.ok(note, "the rate-limit note is in the footer");
  assert.equal(note.hidden, false, "a spent shared key puts it up");
  assert.ok(note.textContent.includes("rate-limited"), note.textContent);
  assert.ok(note.textContent.includes("IsThereAnyDeal"),
    "it names the key to paste, not just that something failed");
  assert.equal(note.querySelector("button").dataset.action, "show-keys",
    "the fix is one click from the news");
});

test("with a key of their own, the note says wait rather than paste", async () => {
  const { env } = await boot({ seed: limitedSeed({ itad_api_key: "mine" }) });
  await settle();

  const note = env.root.querySelector(".disclaimer-limit-note");
  assert.ok(note.textContent.includes("wait a few minutes"), note.textContent);
  assert.ok(!note.textContent.includes("paste your own"),
    "a visitor who already brought a key is told to wait, not to bring one");
});

test("a scan that prices normally leaves no rate-limit note", async () => {
  const { env } = await boot({
    seed: (e) => {
      e.localStorage.setItem("steam_id", "76561198000000000");
      e.fetchRoutes.push((url) => {
        if (url.includes("/api/steam_games")) {
          return { json: { games: [{ id: "Steam:1", name: "Hades", platform: "Steam", hours: 20, appid: 1145360 }] } };
        }
        if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 500 }, limited: {} } };
        return null;
      });
    },
  });
  await settle();

  assert.equal(env.root.querySelector(".disclaimer-limit-note").hidden, true,
    "nothing was refused, so nothing is said");
});

test("findDuplicates flags a title held on two stores, and only that", async () => {
  const { mod } = await boot();
  const out = mod.findDuplicates([
    { id: "Steam:1", name: "Hades", platform: "Steam", hours: 40 },
    { id: "Epic:9", name: "Hades", platform: "Epic", hours: 3 },
    { id: "GOG:5", name: "Hades II", platform: "GOG", hours: 1 },
    { id: "Steam:7", name: "Doom", platform: "Steam", hours: 0, kind: "dlc" },
    { id: "Epic:7", name: "Doom", platform: "Epic", hours: 0, kind: "dlc" },
  ]);

  assert.equal(out.size, 2, "both copies of Hades are marked, nothing else");
  assert.deepEqual(out.get("Steam:1").map((o) => o.id), ["Epic:9"], "the Steam copy names Epic");
  assert.deepEqual(out.get("Epic:9").map((o) => o.id), ["Steam:1"], "and Epic names Steam back");
  assert.ok(!out.has("GOG:5"), "Hades II is a different game, not a duplicate");
  assert.ok(!out.has("Steam:7") && !out.has("Epic:7"),
    "add-ons are never matched: the base game is the purchase");
});

test("editions of one title match across stores, different products do not", async () => {
  const { mod } = await boot();
  const out = mod.findDuplicates([
    { id: "Steam:1", name: "The Witcher 3: Wild Hunt - Game of the Year Edition", platform: "Steam", hours: 40 },
    { id: "GOG:1", name: "The Witcher 3: Wild Hunt - Complete Edition", platform: "GOG", hours: 12 },
    { id: "Steam:2", name: "The Witcher 3: Wild Hunt", platform: "Steam", hours: 5 },
    { id: "Epic:2", name: "The Witcher 3: Wild Hunt - Remastered", platform: "Epic", hours: 0 },
    { id: "Steam:3", name: "Doom", platform: "Steam", hours: 1 },
    { id: "Epic:3", name: "Doom Eternal", platform: "Epic", hours: 0 },
    { id: "GOG:4", name: "Edition", platform: "GOG", hours: 1 },
    { id: "Steam:4", name: "Hades", platform: "Steam", hours: 1 },
  ]);

  assert.ok(out.has("Steam:1") && out.has("GOG:1"),
    "Steam's Game of the Year and GOG's Complete are one game, not two");
  assert.ok(out.has("Steam:2") && out.has("Epic:2"),
    "the plain base title matches its own Remastered listing");
  assert.ok(!out.has("Steam:3") && !out.has("Epic:3"),
    "Doom and Doom Eternal stay different products: 'Eternal' is not an edition");
  assert.ok(!out.has("GOG:4"),
    "a title that is only the word Edition never matches everything else");
});

test("the grid marks a duplicate as an ear on the cover, not inline text", async () => {
  const { env } = await boot({
    seed: (e) => {
      e.localStorage.setItem("steam_id", "76561198000000000");
      e.localStorage.setItem("epic_access_token", "epic-tok");
      e.localStorage.setItem("view_mode", "grid");
      e.fetchRoutes.push((url) => {
        if (url.includes("/api/steam_games")) return { json: { games: [
          { id: "Steam:1", name: "Surviving Mars", platform: "Steam", hours: 40, appid: 1 },
        ] } };
        if (url.includes("/api/epic_games")) return { json: { games: [
          { id: "Epic:1", name: "Surviving Mars", platform: "Epic", hours: 4 },
        ] } };
        if (url.includes("/api/gog_games")) return { json: { games: [] } };
        if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 500, "Epic:1": 300 } } };
        return null;
      });
    },
  });
  await settle();

  const covers = [...env.root.querySelectorAll(".cover")];
  assert.equal(covers.length, 2, "both copies render as cards");
  for (const cover of covers) {
    const ear = cover.querySelector(".dup-ear");
    assert.ok(ear, "the marker hangs on the cover itself");
    assert.equal(ear.textContent, "DUP");
    assert.ok(ear.getAttribute("aria-label").startsWith("Also owned on"),
      "and still names the other store, since the marker does not");
  }
  assert.ok([...env.root.querySelectorAll(".card-title")]
    .every((t) => !t.querySelector(".dupe-chip")),
    "nothing trails the title text any more");
});

test("two rows on one store are not a cross-library duplicate", async () => {
  const { mod } = await boot();
  // dedupeGames has already collapsed these within a platform; the platform
  // guard keeps the claim honest even if a pair ever survives it.
  const out = mod.findDuplicates([
    { id: "Steam:1", name: "Hades", platform: "Steam", hours: 40 },
    { id: "Steam:2", name: "Hades", platform: "Steam", hours: 3 },
  ]);
  assert.equal(out.size, 0, "one store holding a title twice says nothing");
});

test("a title match cannot tell two different games apart — the known ceiling", async () => {
  const { mod } = await boot();
  // DOOM (1993) and DOOM (2016) share a display name, and the data carries no
  // year or cross-store id to separate them, so they are flagged. Pinned on
  // purpose: the matcher claims "also on", never "you paid twice", and this
  // assertion should be the one to fail when a real identity source lands.
  const out = mod.findDuplicates([
    { id: "Steam:239160", name: "DOOM", platform: "Steam", hours: 10 },
    { id: "Epic:doom2016", name: "DOOM", platform: "Epic", hours: 0 },
  ]);
  assert.equal(out.size, 2, "flagged, because the matcher only sees the name");
});

test("a title owned on two stores is flagged in the list and explained in the drawer", async () => {
  const seed = (env) => {
    env.localStorage.setItem("steam_id", "76561198000000000");
    env.localStorage.setItem("epic_access_token", "epic-tok");
    env.fetchRoutes.push((url) => {
      if (url.includes("/api/steam_games")) {
        return { json: { games: [{ id: "Steam:1", name: "Hades", platform: "Steam", hours: 40, appid: 1145360 }] } };
      }
      if (url.includes("/api/epic_games")) {
        return { json: { games: [{ id: "Epic:9", name: "Hades", platform: "Epic", hours: 3 }] } };
      }
      if (url.includes("/api/gog_games")) return { json: { games: [] } };
      if (url.includes("/api/prices")) return { json: { prices: { "Steam:1": 500, "Epic:9": 300 } } };
      return null;
    });
  };
  const { env } = await boot({ seed });
  await settle();

  const rows = [...env.root.querySelectorAll(".game-row")];
  assert.equal(rows.length, 2, "each copy keeps its own row and its own price");
  const chips = rows.map((r) => r.querySelector(".dupe-chip"));
  assert.ok(chips.every(Boolean), "every copy points at the other store");
  assert.deepEqual(chips.map((c) => c.textContent).sort(), ["DUP", "DUP"],
    "the chip claims the fact, not the store — the column beside it already says that");
  assert.deepEqual(chips.map((c) => c.getAttribute("aria-label")).sort(),
    ["Also owned on Epic", "Also owned on Steam"],
    "the tooltip still names each store, since nothing else does");
  const nameIn = rows[0].querySelector(".cell-name-in");
  assert.ok(nameIn, "the name cell wraps its contents so the chips can align");
  assert.equal(nameIn.querySelector("span").textContent, "Hades", "the title leads the cell");
  assert.ok(nameIn.querySelector(".dupe-chip"), "and the marker sits after it, at the right edge");

  // The drawer spells the other copy out: store, its price today, its playtime.
  rows[0].dispatch("click");
  await settle();
  const dupeRow = [...env.root.querySelectorAll(".drawer-row")]
    .find((r) => r.querySelector("span").textContent === "Also owned on");
  assert.ok(dupeRow, "the drawer explains the overlap instead of hiding it");
  assert.equal(dupeRow.querySelector("strong").textContent, "Epic · ₹300.00 · 3.0 h",
    "the other copy's store, price and playtime, beside this one's");
});

test("a library from one store wears no duplicate chip", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  assert.equal(env.root.querySelectorAll(".dupe-chip").length, 0,
    "nothing to compare against — the chip would be noise");
});

test("a restored snapshot finds its cross-store copies again", async () => {
  // The snapshot stores only rows and prices, so duplicates must be recomputed
  // on boot or a page refresh silently loses every chip.
  const seed = (env) => {
    env.localStorage.setItem("steam_id", "76561198000000000");
    env.localStorage.setItem("last_scan", JSON.stringify({
      v: 1, at: Date.now(), currency: "INR",
      games: [
        { id: "Steam:1", name: "Hades", platform: "Steam", hours: 40 },
        { id: "Epic:9", name: "Hades", platform: "Epic", hours: 3 },
      ],
      prices: { "Steam:1": 500, "Epic:9": 300 },
    }));
  };
  const { env, mod } = await boot({ seed });
  await settle();

  assert.equal(mod.getState().phase, "ready", "the snapshot alone makes it ready");
  assert.equal(env.root.querySelectorAll(".game-row").length, 2,
    "rows came from the snapshot, not a fresh scan");
  assert.equal(env.root.querySelectorAll(".dupe-chip").length, 2,
    "a refresh keeps the flags");
});

// ---------- the open drawer follows its own saves ----------

const drawerValue = (env, label) => {
  const row = [...env.root.querySelectorAll(".drawer-row")]
    .find((r) => r.querySelector("span").textContent === label);
  return row ? row.querySelector("strong").textContent : null;
};

test("saving in the drawer updates the drawer itself", async () => {
  const { env } = await boot({ seed: editSeed });
  await settle();
  await openTitle(env, "Hades");

  assert.equal(drawerValue(env, "Current price"), "₹1,000.00", "opens on the store's price");
  assert.equal(drawerValue(env, "₹ / hour"), "₹50/h", "and the rate it implies");

  await saveFigure(env, "price", 100);

  assert.equal(drawerValue(env, "Current price"), "₹100.00",
    "the price row follows the save — it used to keep the old number forever");
  assert.equal(drawerValue(env, "₹ / hour"), "₹5/h",
    "and the rate is recomputed from it");
  assert.equal(drawerValue(env, "Playtime"), "20.0 h", "rows the edit did not touch keep their own");
  const ref = env.root.querySelector(".edit-ref").textContent;
  assert.ok(ref.includes("₹1,000.00"),
    `the API reference still names the store's figure: ${ref}`);
});

test("an open Share preview is never replaced by the inspector's repaint", async () => {
  const { env } = await boot({ seed: editSeed });
  await settle();
  await openTitle(env, "Hades");
  assert.equal(env.root.querySelector("#drawer-title").textContent, "Game details");

  [...env.root.querySelectorAll("button")].find((b) => b.dataset.action === "share")
    .dispatch("click");
  await settle();
  assert.equal(env.root.querySelector("#drawer-title").textContent, "Share your card",
    "the export preview took the panel");

  // Anything that re-renders must leave it — openId is still set on a game, so
  // a guard keyed on that alone would hand the panel back to the inspector.
  env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "regret")
    .dispatch("click");
  await settle();

  assert.equal(env.root.querySelector("#drawer-title").textContent, "Share your card",
    "the preview keeps the panel through a full re-render");
  assert.ok(env.root.querySelector(".export-preview"), "and its canvas");
});

test("an unrelated re-render does not wipe a half-typed figure", async () => {
  const { env } = await boot({ seed: editSeed });
  await settle();
  await openTitle(env, "Hades");

  editBox(env, "price").value = "123";
  env.root.querySelectorAll(".tier-facet").find((b) => b.dataset.tier === "regret")
    .dispatch("click");
  await settle();

  assert.equal(editBox(env, "price").value, "123",
    "the drawer body was rebuilt, so the value has to be carried across it");
});

test("a repaint does not blank the cover art", async () => {
  const seed = (env) => {
    editSeed(env);
    env.localStorage.setItem("covers_cache",
      JSON.stringify({ "Steam:1": "https://cdn.example/hades.png" }));
  };
  const { env } = await boot({ seed });
  await settle();
  await openTitle(env, "Hades");

  const src = () => {
    const cover = env.root.querySelector(".drawer-cover");
    const img = cover && cover.querySelector(".cover-img");
    return img ? img.getAttribute("src") : null;
  };
  assert.equal(src(), "https://cdn.example/hades.png", "stamped when the drawer opened");

  await saveFigure(env, "price", 100);

  assert.equal(src(), "https://cdn.example/hades.png",
    "and stamped again after the rebuild — renderDrawer paints a fresh img at opacity 0");
});
