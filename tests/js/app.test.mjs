/**
 * Integration tests for the app wiring: boot phases, delegated link buttons,
 * scan pipeline, filters, drawer, unlink. Uses a minimal fake DOM (dom-stub)
 * and imports a fresh app.js per test via a ?case= query so module state resets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installEnv } from "./dom-stub.mjs";

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

const withSteam = (env) => {
  env.localStorage.setItem("steam_id", "76561198000000000");
  routeScan(env);
};

test("cold start shows onboarding, hides metrics chrome", async () => {
  const { env, mod } = await boot();
  assert.equal(mod.getState().phase, "onboarding");
  assert.ok(env.root.querySelector(".onboarding"), "onboarding section rendered");
  assert.ok(env.root.querySelector(".hero-title"), "hero rendered");
  assert.equal(env.root.querySelectorAll(".platform-card").length, 5, "four store cards + API keys card");
  assert.ok(env.root.querySelector(".api-keys"), "API keys card rendered");
  assert.equal(env.document.getElementById("kpi-library"), null, "no KPIs before linking");
  assert.equal(env.root.querySelector(".sources").hidden, true, "sources strip hidden on onboarding");
});

test("Steam link navigates to OpenID checkid_setup with return_to", async () => {
  const { env } = await boot();
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

test("GOG link opens auth popup and stores oauth state", async () => {
  const { env } = await boot();
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

  assert.equal(env.document.getElementById("kpi-library").textContent, "₹4,425.00");
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
  assert.deepEqual(headings, ["Value by platform"],
    "the duplicate Regret card is gone from the sidebar");
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

  drawer.querySelectorAll("button").find((b) => b.dataset.action === "close-drawer").dispatch("click");
  assert.equal(env.root.querySelector(".drawer").classList.contains("hidden"), true, "drawer closes");
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
  assert.equal(env.document.getElementById("kpi-library").textContent, "₹300.00");
});

test("GOG paste with mismatched OAuth state is rejected before any exchange", async () => {
  const { env, mod } = await boot();
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
  assert.equal(mod.getState().phase, "ready");

  env.root.querySelectorAll(".source-action").find((b) => b.dataset.platform === "gog").dispatch("click");
  assert.equal(mod.getState().phase, "onboarding", "onboarding cards surfaced for paste");
  assert.equal(env.document.getElementById("gog-paste").open, true, "paste box auto-opened");

  env.root.querySelectorAll("button").find((b) => b.dataset.action === "back").dispatch("click");
  assert.equal(mod.getState().phase, "ready");
  assert.equal(env.root.querySelectorAll(".game-row").length, 3, "scan data intact");
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

test("changing display currency re-prices the library in that currency", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  await settle();
  assert.equal(mod.getState().phase, "ready");
  assert.equal(mod.getState().currency, "INR", "defaults to INR");

  const sel = env.root.querySelector(".currency-select");
  assert.ok(sel, "currency picker rendered on the dashboard");
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
