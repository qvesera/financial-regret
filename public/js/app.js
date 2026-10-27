/** Boot + scan orchestration. Wires store, api, view, regret together.
 *
 *  Single delegated-event model: view.js emits `data-action` attributes on
 *  every interactive element, and exactly one listener per event type on
 *  #app routes them. Elements are rebuilt whenever the phase changes, so
 *  per-node listeners would silently die — delegation does not.
 */
import { store, applyPaidOverrides } from "./store.js";
import * as api from "./api.js";
import { view } from "./view.js";
import { computeRegret } from "./regret.js";

const KEY_STORES = {
  steam: ["steam_id"],
  gog: ["gog_access_token", "gog_refresh_token", "gog_user_id"],
  epic: ["epic_access_token", "epic_refresh_token", "epic_account_id"],
};

let state = {
  phase: "onboarding",   // "onboarding" | "ready" | "loading"
  accounts: { steam: false, gog: false, epic: false },
  games: [],
  rows: [],
  prices: {},
  currency: "INR",
  counts: {},
  epicScanned: 0,
  epicFiltered: 0,
  metrics: null,
  coverageText: "",
  scanProgress: null,
  scanError: null,
  basis: "price",
  filter: "All",
  sort: "price-desc",
  search: "",
  scanning: false,
  openId: null,
};

function linkedAccounts() {
  return {
    steam: Boolean(localStorage.getItem("steam_id")),
    gog: Boolean(localStorage.getItem("gog_access_token")),
    epic: Boolean(localStorage.getItem("epic_access_token")),
  };
}

function anyLinked(acc = linkedAccounts()) {
  return Object.values(acc).some(Boolean);
}

function computeRows() {
  let g = state.games;
  if (state.filter === "Unplayed") g = g.filter((x) => x.hours != null && x.hours < 1);
  else if (state.filter === "Played") g = g.filter((x) => x.hours != null && x.hours >= 1);
  else if (state.filter === "No data") g = g.filter((x) => x.hours == null);

  const q = state.search.trim().toLowerCase();
  if (q) g = g.filter((x) => x.name && x.name.toLowerCase().includes(q));

  if (state.sort === "price-desc") g = [...g].sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  else if (state.sort === "price-asc") g = [...g].sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  else if (state.sort === "name-asc") g = [...g].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (state.sort === "hours-desc") g = [...g].sort((a, b) => (b.hours ?? -1) - (a.hours ?? -1));
  return g;
}

function countByPlatform(games) {
  const counts = {};
  for (const g of games) counts[g.platform] = (counts[g.platform] || 0) + 1;
  return counts;
}

function coverageLine() {
  if (state.scanProgress) return state.scanProgress;
  if (state.scanError) return `Scan problem: ${state.scanError}`;
  if (!state.games.length) return "";
  const m = state.metrics;
  const cov = m.coverage == null ? "—" : `${(m.coverage * 100).toFixed(1)}%`;
  let line = `${m.knownCount} / ${state.games.length} games have playtime · ${cov} of value is covered`;
  if (state.epicScanned) {
    line += ` · Epic: ${state.counts.Epic || 0} games from ${state.epicScanned} library items (${state.epicFiltered} non-games filtered)`;
  }
  return line;
}

/** Recompute derived state and hand it to the view. */
function renderAll() {
  state.accounts = linkedAccounts();
  state.rows = computeRows();
  state.counts = countByPlatform(state.games);
  state.metrics = computeRegret(state.rows, state.basis);
  state.coverageText = coverageLine();
  view.render(state);
}

// ---------- scanning ----------

const MAX_EPIC_PAGES = 100;

/** Page through Epic's library one short request at a time, reporting
 *  progress between pages — a huge account no longer hangs one call. */
async function fetchAllEpicGames() {
  const games = [];
  let cursor = null;
  let scanned = 0, filtered = 0;
  for (let page = 0; page < MAX_EPIC_PAGES; page += 1) {
    const res = await api.fetchEpicGames(cursor);
    games.push(...res.games);
    scanned += res.games.length + (res.filtered || 0);
    filtered += res.filtered || 0;
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
    state.scanProgress = `Epic: ${games.length} games from ${scanned} library items — fetching page ${page + 2}…`;
    renderAll();
  }
  state.epicScanned = scanned;
  state.epicFiltered = filtered;
  return games;
}

/** Collapse duplicate entitlements of the same game. Epic returns the base
 *  title plus each DLC/expansion as separate records that share a sandbox, so
 *  they all surface under one display name; keep the copy with the most
 *  playtime (the base game) and drop the rest. */
export function dedupeGames(games) {
  const best = new Map();
  for (const g of games) {
    // alnum-fold the name so symbol/case variants of one title collapse too
    const key = `${g.platform}\u0000${(g.name || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const prev = best.get(key);
    if (!prev || (g.hours || 0) > (prev.hours || 0)) best.set(key, g);
  }
  return [...best.values()];
}

async function scan() {
  if (state.scanning) return;
  const acc = linkedAccounts();
  if (!anyLinked(acc)) { state.phase = "onboarding"; renderAll(); return; }

  state.scanning = true;
  state.phase = "loading";
  state.scanError = null;
  renderAll();

  try {
    const results = await Promise.allSettled([
      acc.steam ? api.fetchSteamGames(localStorage.getItem("steam_id")) : [],
      acc.gog ? api.fetchGogGames() : [],
      acc.epic ? fetchAllEpicGames() : [],
    ]);
    const games = dedupeGames(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
    const errors = results
      .filter((r) => r.status === "rejected")
      .map((r) => (r.reason && r.reason.message) || String(r.reason));
    state.games = applyPaidOverrides(games);
    state.scanError = errors.length ? errors.join(" · ") : null;
    try {
      const priced = await api.fetchPrices(state.games, state.currency);
      state.prices = priced.prices;
      // Adopt the currency the server actually priced in so labels match numbers.
      if (priced.currency) state.currency = priced.currency;
    } catch {
      state.prices = {};
    }
    // Prices arrive as a separate id-keyed map — bake them into the rows so
    // the regret math and the table agree.
    state.games = state.games.map((g) => ({ ...g, price: state.prices[g.id] ?? null }));
    store.setSnapshot({ games: state.games, prices: state.prices, counts: state.counts, currency: state.currency });
  } catch (e) {
    state.scanError = (e && e.message) || String(e);
  } finally {
    state.scanning = false;
    state.scanProgress = null;
    state.phase = "ready";
    state.openId = null;
    renderAll();
  }
}

/** Re-price the existing library after the display currency changes. The
 *  games are unchanged — only the price map (and the currency label) is
 *  refreshed. On failure the previous currency is kept so the still-old
 *  amounts remain honestly labelled; the change is only persisted on success. */
async function reprice(nextCurrency) {
  if (state.scanning) { renderAll(); return; }
  const prev = state.currency;
  state.currency = nextCurrency || prev;
  try {
    const priced = await api.fetchPrices(state.games, state.currency);
    state.prices = priced.prices;
    if (priced.currency) state.currency = priced.currency;
    state.games = state.games.map((g) => ({ ...g, price: state.prices[g.id] ?? null }));
    store.setSnapshot({ games: state.games, prices: state.prices, counts: state.counts, currency: state.currency });
    localStorage.setItem("currency", state.currency);
  } catch {
    state.currency = prev;   // keep prior prices labelled correctly
  }
  renderAll();
}

// ---------- linking ----------

/** The paste boxes live on the onboarding cards; surface one when the
 *  dashboard is what's on screen (linking a second store from the strip). */
function ensurePasteSurface(platform) {
  if (state.phase !== "onboarding") {
    state.phase = "onboarding";
    renderAll();
  }
  const box = document.getElementById(`${platform}-paste`);
  if (box) box.open = true;
}

function linkPlatform(platform) {
  if (platform === "steam") {
    window.location.href = api.loginSteam(`${window.location.origin}/steam-callback.html`);
  } else if (platform === "gog") {
    ensurePasteSurface(platform);
    api.loginGog()
      .then((url) => {
        const w = window.open(url, "gog-link", "width=520,height=700");
        if (!w) showFormError("gog", "Popup blocked — allow popups, then paste the redirect URL below.");
      })
      .catch((e) => showFormError("gog", String(e && e.message ? e.message : e)));
  } else if (platform === "epic") {
    ensurePasteSurface(platform);
    const w = window.open(api.loginEpic(), "epic-link", "width=520,height=700");
    if (!w) showFormError("epic", "Popup blocked — allow popups, then paste the JSON page below.");
  }
}

function unlinkPlatform(platform) {
  for (const k of KEY_STORES[platform] || []) localStorage.removeItem(k);
  const acc = linkedAccounts();
  if (!anyLinked(acc)) {
    state.phase = "onboarding";
    state.games = [];
    state.rows = [];
    state.metrics = null;
    state.counts = {};
    state.epicScanned = 0;
    state.epicFiltered = 0;
    state.coverageText = "";
    state.scanError = null;
    closeDrawer();
  }
  renderAll();
}

function showFormError(kind, msg) {
  const el = document.getElementById(`${kind}-error`);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  const box = document.getElementById(`${kind}-paste`);
  if (box) box.open = true;
}

function submitPaste(kind) {
  const input = document.getElementById(`${kind}-code`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    showFormError(kind, kind === "epic" ? "Paste the authorizationCode." : "Paste the landing URL.");
    return;
  }
  const code = api.parseAuthCode(text);
  if (!code) {
    showFormError(kind, "That did not look like a redirect URL or auth code.");
    return;
  }
  if (kind === "gog") {
    // OAuth state check when the pasted URL carries one (GOG echoes it back).
    const m = /[?&]state=([^&#]+)/.exec(text);
    const expected = sessionStorage.getItem("gog_oauth_state");
    if (m && (!expected || decodeURIComponent(m[1]) !== expected)) {
      showFormError("gog", "OAuth state mismatch — run Connect GOG again and paste the fresh URL.");
      return;
    }
    finishGogExchange(code);
    return;
  }
  finishEpicExchange(code);
}

/** Exchange a pasted GOG code in this window — no callback page needed. */
async function finishGogExchange(code) {
  try {
    const data = await api.exchangeGog(code, api.GOG_REDIRECT_URI);
    if (!data.access_token) throw new Error("GOG exchange returned no access token");
    localStorage.setItem("gog_access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("gog_refresh_token", data.refresh_token);
    if (data.user_id) localStorage.setItem("gog_user_id", data.user_id);
    sessionStorage.removeItem("gog_oauth_state");
    const box = document.getElementById("gog-code");
    if (box) box.value = "";
    await scan();
  } catch (e) {
    showFormError("gog", String((e && e.message) || e));
  }
}

/** Exchange a pasted Epic authorizationCode in this window — no callback page. */
async function finishEpicExchange(code) {
  try {
    const data = await api.exchangeEpic(code);
    if (!data.access_token) throw new Error("Epic exchange returned no access token");
    localStorage.setItem("epic_access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("epic_refresh_token", data.refresh_token);
    if (data.account_id) localStorage.setItem("epic_account_id", data.account_id);
    const box = document.getElementById("epic-code");
    if (box) box.value = "";
    await scan();
  } catch (e) {
    showFormError("epic", String((e && e.message) || e));
  }
}

// ---------- drawer ----------

function openDrawer(id) {
  const game = state.rows.find((g) => g.id === id);
  if (!game || !view.drawer) return;
  state.openId = id;
  view.renderDrawer(view.drawerBody, game, state.prices[id], store.getPaid(id), (gid, v) => {
    store.setPaidOverride(gid, v);
    state.games = applyPaidOverrides(state.games);
    renderAll();
  });
  view.drawer.classList.remove("hidden");
}

function closeDrawer() {
  state.openId = null;
  if (view.drawer) view.drawer.classList.add("hidden");
}

function forget() {
  store.forget();
  state.games = [];
  state.rows = [];
  state.prices = {};
  state.counts = {};
  state.epicScanned = 0;
  state.epicFiltered = 0;
  state.metrics = null;
  state.phase = "onboarding";
  state.scanError = null;
  state.search = "";
  state.filter = "All";
  closeDrawer();
  renderAll();
}

// ---------- delegated events ----------

/** Persist a bring-your-own API key to localStorage. It is forwarded with the
 *  user's own pricing/library requests (as a header) and never stored server-side. */
function saveApiKey(kind) {
  const input = document.getElementById(`${kind}-key`);
  const val = ((input && input.value) || "").trim();
  if (val) localStorage.setItem(`${kind}_api_key`, val);
  else localStorage.removeItem(`${kind}_api_key`);
  if (view) view._builtPhase = null; // rebuild onboarding so the "saved" placeholder shows
  renderAll();
}

/** Walk up from the event target to the nearest [data-action]. */
function closestAction(el) {
  let n = el;
  while (n && n !== document) {
    if (n.dataset && n.dataset.action) return n;
    n = n.parentNode || n.parentElement;
  }
  return null;
}

function onClick(e) {
  const t = closestAction(e.target);
  if (!t) {
    if (view.menu && !view.menu.classList.contains("hidden")) view.menu.classList.add("hidden");
    return;
  }
  const platform = t.dataset.platform;
  switch (t.dataset.action) {
    case "link": linkPlatform(platform); break;
    case "unlink": unlinkPlatform(platform); break;
    case "scan": scan(); break;
    case "filter": state.filter = t.dataset.filter; renderAll(); break;
    case "basis": state.basis = t.dataset.basis; renderAll(); break;
    case "open": openDrawer(t.dataset.id); break;
    case "close-drawer": closeDrawer(); break;
    case "toggle-menu":
      if (view.menu) view.menu.classList.toggle("hidden");
      break;
    case "submit-gog": submitPaste("gog"); break;
    case "submit-epic": submitPaste("epic"); break;
    case "save-key": saveApiKey(t.dataset.kind); break;
    case "show-keys":
      state.phase = "onboarding";
      renderAll();
      break;
    case "back":
      state.phase = "ready";
      renderAll();
      if (!state.games.length) scan();
      break;
    case "forget": forget(); break;
    default: break;
  }
}

function onInput(e) {
  const t = closestAction(e.target);
  if (!t) return;
  if (t.dataset.action === "code-input") {
    const err = document.getElementById(t.id.replace("-code", "-error"));
    if (err) { err.hidden = true; err.textContent = ""; }
  } else if (t.dataset.action === "search") {
    state.search = t.value;
    renderAll();
  }
}

function onChange(e) {
  const t = closestAction(e.target);
  if (!t) return;
  if (t.dataset.action === "sort") {
    state.sort = t.value;
    renderAll();
  } else if (t.dataset.action === "currency") {
    const cur = (t.value || "").toUpperCase();
    if (!cur || cur === state.currency) return;
    if (state.games.length) reprice(cur);   // persists on success, reverts on failure
    else {
      // Nothing priced yet (onboarding): just remember the choice.
      state.currency = cur;
      localStorage.setItem("currency", cur);
      renderAll();
    }
  }
}

function onKeydown(e) {
  const t = closestAction(e.target);
  if (t && t.dataset.action === "code-input" && e.key === "Enter") {
    e.preventDefault();
    submitPaste(t.dataset.kind);
  }
}

function wire(root) {
  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("keydown", onKeydown);
}

/** Cross-tab sync: a link/unlink in another tab re-renders and rescans. */
function wireCrossWindow() {
  window.addEventListener("storage", (e) => {
    if (!e.key || !/^(gog_|steam_|epic_)/.test(e.key)) return;
    state.accounts = linkedAccounts();
    renderAll();
    if (anyLinked(state.accounts) && state.phase !== "loading") scan();
  });
}

// ---------- boot ----------

export function getState() { return state; }

export async function boot() {
  const root = document.getElementById("app") || document.body;
  view.shell(root);
  state.accounts = linkedAccounts();
  state.currency = localStorage.getItem("currency") || "INR";
  const snap = store.getSnapshot();
  if (snap) {
    state.games = snap.games || [];
    state.prices = snap.prices || {};
  }
  state.phase = anyLinked(state.accounts) ? "ready" : "onboarding";
  wire(root);
  wireCrossWindow();
  renderAll();
  if (state.phase === "ready" && state.games.length === 0) {
    await scan();
  } else if (state.games.length && snap && snap.currency && snap.currency !== state.currency) {
    // Restored snapshot was priced in a different currency — re-price to match.
    await reprice();
  }
}

function reportBootError(err) {
  console.error(err);
  const root = document.getElementById("app");
  if (!root) return;
  const box = document.createElement("div");
  box.className = "error-box";
  box.textContent = `Boot failed: ${err && err.message ? err.message : err}`;
  root.appendChild(box);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot().catch(reportBootError); });
  } else {
    boot().catch(reportBootError);
  }
}
