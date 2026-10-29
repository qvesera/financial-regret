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
  assert.equal(env.document.getElementById("kpi-library"), null, "no KPIs before linking");
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
  assert.equal(env.root.querySelectorAll(".key-group").length, 3, "keys grouped by purpose");
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
  // "Unpriced" — the phrase means exactly one thing in the UI.
  const facetNames = env.root.querySelectorAll(".tier-facet")
    .map((b) => b.querySelector(".tier-name").textContent);
  assert.ok(facetNames.includes("Unpriced"), `verdict facets read: ${facetNames}`);
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
  assert.ok(env.document.getElementById("kpi-library"), "library value is still reported, once");
});

test("the header offers each control exactly once, in plain words", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const keysBtns = env.root.querySelectorAll("button")
    .filter((b) => b.dataset.action === "show-keys");
  assert.equal(keysBtns.length, 1, "one API-keys control, not two with two names");
  assert.equal(keysBtns[0].textContent, "API keys");
  assert.equal(keysBtns[0].hidden, false, "reachable from the dashboard");

  const labels = env.root.querySelectorAll(".source-action")
    .map((b) => `${b.dataset.action}:${b.textContent}`);
  assert.ok(labels.includes("unlink:Forget"), `a linked store reads Forget: ${labels}`);
  assert.ok(labels.includes("link:Link"), `an unlinked store reads Link: ${labels}`);
  assert.equal(env.root.querySelector(".brand-sub").textContent,
    "what your library actually cost");
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


// Sony has no approval screen, so PlayStation linking is two manual steps and
// the Connect button may only perform step one: get a signed-in session on
// playstation.com. This pins the order, because getting it wrong is invisible
// in code review and instantly visible to the user: the NPSSO endpoint opened
// cold answers a signed-out browser with `invalid_grant` JSON, never a login
// form, so there is nothing there to sign in on.
test("PSN connect opens the sign-in page, never the NPSSO endpoint", async () => {
  const { env } = await boot();

  byAction(env, "link", "psn").dispatch("click");
  await settle();

  assert.equal(env.opened.length, 1, "one popup, for the sign-in step");
  const signIn = new URL(env.opened[0].url);
  assert.equal(signIn.origin, "https://www.playstation.com", "step one is the sign-in page");
  assert.ok(!env.opened[0].url.includes("ssocookie"),
    "must not open the NPSSO endpoint cold — it answers invalid_grant");
  assert.ok(!env.opened[0].url.includes("ca.account.sony.com"),
    "no Sony account endpoint on the first step");

  const card = env.root.querySelectorAll(".platform-card")
    .find((c) => c.dataset.platform === "psn");
  assert.ok(card, "psn card rendered");

  // Step two must be reachable: the paste block carries a real link to the
  // NPSSO page, because that is where the value to paste actually lives.
  const paste = env.document.getElementById("psn-paste");
  assert.ok(paste, "psn paste block exists");
  assert.equal(paste.open, true, "paste block visible, since the steps say 'below'");

  const linkRow = paste.querySelector(".paste-link");
  assert.ok(linkRow, "paste block links to the NPSSO page");
  const anchor = linkRow.children.find((c) => String(c.tagName).toLowerCase() === "a");
  assert.ok(anchor, "the link is a real anchor, not plain text");
  assert.equal(anchor.href, "https://ca.account.sony.com/api/v1/ssocookie");
  assert.equal(anchor.target, "_blank", "opens beside the app, not in place");

  // And the copy has to lead with the sign-in, then the token.
  const steps = card.querySelector(".pc-steps").textContent.toLowerCase();
  assert.ok(steps.includes("sign in"), "step one says to sign in");
  assert.ok(steps.indexOf("sign in") < steps.indexOf("npsso"),
    "signing in comes before fetching the NPSSO");
});

test("filtering to a store takes the other stores' games out of the ranked lists", async () => {
  const { env, mod } = await boot({ seed: withSteamAndGog });
  await settle();

  const names = (sel) => {
    const list = env.root.querySelector(sel);
    return list.querySelectorAll(".rank-name").map((n) => n.textContent);
  };

  const worst = names(".rank-worst");
  assert.ok(worst.includes("Hades") && worst.includes("Disco Elysium"),
    `both stores rank before filtering: ${worst}`);
  const benchBefore = mod.getState().bench;

  // The spend-by-platform legend filters TO a store, which hides every other
  // one — the "hide a website" control.
  const gog = env.root.querySelectorAll(".platform-row")
    .find((r) => r.dataset.platform === "GOG");
  assert.ok(gog, "the legend offers GOG as a filter");
  gog.dispatch("click");
  await settle();

  assert.equal(mod.getState().platform, "GOG", "the filter took");
  const after = names(".rank-worst");
  assert.ok(!after.includes("Hades"), "the hidden store's game is gone");
  assert.ok(after.includes("Disco Elysium"), "the visible store's game survives");
  assert.deepEqual(names(".rank-best"), ["Disco Elysium"],
    "best value re-ranks from what is still visible, not from a stale list");

  // Scoring must not follow the filter — only selection does. A filter that
  // redefined the benchmark would move every verdict on screen.
  assert.deepEqual(mod.getState().bench, benchBefore, "benchmark is untouched");

  gog.dispatch("click");   // the toggle clears itself
  await settle();
  assert.equal(mod.getState().platform, "All");
  const restored = names(".rank-worst");
  assert.ok(restored.includes("Disco Elysium") && restored.includes("Hades"),
    "both return when the filter clears");
});

test("a rank list emptied by a filter says so, and recovers when cleared", async () => {
  const { env } = await boot({ seed: withSteam });
  await settle();

  const worst = () => env.root.querySelector(".rank-worst");
  assert.equal(worst().querySelectorAll(".rank-name").length, 1, "Hades ranks unfiltered");

  env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === "Unplayed")
    .dispatch("click");
  await settle();

  assert.equal(worst().querySelectorAll(".rank-name").length, 0,
    "unplayed games are not evidence about value, so nothing ranks");
  const empty = worst().querySelector(".rank-empty");
  assert.ok(empty, "the empty list explains itself");
  assert.ok(empty.textContent.includes("Nothing in this view"),
    "a filtered-empty list must not claim you have no qualifying games");

  env.root.querySelectorAll(".tab").find((t) => t.dataset.filter === "All")
    .dispatch("click");
  await settle();
  assert.equal(worst().querySelectorAll(".rank-name").length, 1, "restores when cleared");
});
