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
  env.root.querySelectorAll(".button, .source-action, .tab, .game-row, .basis-btn")
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

function routeScan(env, { steam = true } = {}) {
  env.fetchRoutes.push((url) => {
    if (url.includes("/api/steam_games")) return steam ? { json: steamFixture } : { ok: false, status: 500, json: {} };
    if (url.includes("/api/gog_games")) return { json: { games: [] } };
    if (url.includes("/api/epic_games")) return { json: { games: [] } };
    if (url.includes("/api/prices")) return { json: { prices: PRICE_MAP } };
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
  assert.equal(env.root.querySelectorAll(".platform-card").length, 4, "three store cards + API keys card");
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
  assert.equal(env.document.getElementById("kpi-backlog").textContent, "₹1,855.00");
  assert.equal(env.document.getElementById("kpi-regret").textContent, "62.5 %");
  assert.equal(env.document.getElementById("kpi-vph").textContent, "₹56/h");

  assert.equal(env.root.querySelectorAll(".game-row").length, 3);
  assert.ok(env.root.querySelector(".coverage").textContent.includes("2 / 3"));
  assert.ok(env.root.querySelector(".coverage").textContent.includes("67.1%"));
  assert.equal(env.root.querySelector(".empty-state").hidden, true, "empty state hidden after scan");
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

test("row click opens the drawer; paid override feeds the paid basis", async () => {
  const { env, mod } = await boot({ seed: withSteam });
  const row = env.root.querySelectorAll(".game-row").find((r) => r.dataset.id === "Steam:730");
  row.dispatch("click");
  const drawer = env.root.querySelector(".drawer");
  assert.equal(drawer.classList.contains("hidden"), false, "drawer opens");
  assert.ok(drawer.textContent.includes("Hades"));

  const paidInput = drawer.querySelector(".paid-input");
  assert.equal(paidInput.dataset.id, "Steam:730");
  paidInput.value = "499";
  paidInput.dispatch("change");
  assert.equal(mod.getState().rows.find((g) => g.id === "Steam:730").paid, 499, "paid override applied");

  env.root.querySelectorAll(".basis-btn").find((b) => b.dataset.basis === "paid").dispatch("click");
  assert.equal(env.document.getElementById("kpi-library").textContent, "₹3,811.00", "499 + 1855 + 1457");

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
