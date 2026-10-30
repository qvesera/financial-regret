/** Boot + scan orchestration. Wires store, api, view, regret together.
 *
 *  Single delegated-event model: view.js emits `data-action` attributes on
 *  every interactive element, and exactly one listener per event type on
 *  #app routes them. Elements are rebuilt whenever the phase changes, so
 *  per-node listeners would silently die — delegation does not.
 */
import { store } from "./store.js";
import * as api from "./api.js";
import { view } from "./view.js";
import { computeRegret } from "./regret.js";
import { currencyForCountry } from "./format.js";
import { paintVerdictToy, repaintVerdictToy, setToyAnchor, TOY_GAME } from "./arcade.js";
import { cardSpec, cardBlob, renderCardTo, shareUrl, decodeCard, exportKinds } from "./export.js";
import { benchmark, verdictMap, comparators as rankGames } from "./verdict.js";
import { applyEdits, parseEdit } from "./edits.js";

/** UI state worth keeping across reloads — filters and the what-if setting.
 *  `view_mode` stays in its own key: several tests assert it by name. */
const UI_STATE_KEY = "ui_state";

/** Human wording for /api/psn_prices' `reason`. An unpriced PlayStation row is
 *  normal and needs no comment, but when every one of them is unpriced the user
 *  deserves to know which of four very different causes it is. */
const PSN_PRICING_NOTE = {
  no_key: "PlayStation prices need a PlatPrices key — add one under API keys. Playtime is unaffected.",
  no_region: "PlatPrices has no PlayStation Store for this display currency, so PSN rows stay unpriced.",
  upstream_failed: "PlatPrices did not answer, so PlayStation prices are unavailable right now.",
  no_match: "PlatPrices carries no price for these PlayStation titles, so they stay unpriced.",
};

const psnNoteFor = (reason) => (reason ? PSN_PRICING_NOTE[reason] || null : null);

/** Human wording for a rate-limited pricing source. Whose key is in play
 *  changes what to do next: a shared key means "bring your own", their own
 *  key means "wait". Providers are named one by one because pasting an ITAD
 *  key cannot fix a spent PlatPrices quota. */
const LIMIT_SHARED = {
  // Cause-neutral on purpose: a 429 reaches us from a provider's quota or from
  // this instance's own per-IP limiter, and both read the same way -- wait, and
  // bring a key if it keeps happening.
  itad: "Prices are rate-limited right now — wait a minute, then rescan. If it keeps happening, paste your own IsThereAnyDeal key under API keys.",
  platprices: "PlayStation prices are rate-limited right now — wait a minute, then rescan. If it keeps happening, paste your own PlatPrices key under API keys.",
};

const limitNoteFor = (limited, hasOwnKey) => {
  const names = Object.keys(limited || {});
  if (!names.length) return null;
  if (hasOwnKey) return "Your API key is being rate-limited — wait a few minutes, then rescan.";
  const wording = names.map((n) => LIMIT_SHARED[n]).filter(Boolean);
  return wording.length ? wording.join(" ") : null;
};

/** Whether the visitor brings a pricing key of their own. */
const ownKeyPresent = () => Boolean(
  localStorage.getItem("itad_api_key") || localStorage.getItem("platprices_api_key"),
);

/** Attribution, the PlayStation explanation and the rate-limit note all travel
 *  on a pricing answer; one place applies them so a new call site cannot
 *  forget one. Limits accumulate -- a chunk that holds no PlayStation rows
 *  never asks PlatPrices, so its silence is not a clean bill of health. */
function applyPricingNotes(priced) {
  view.setPricingAttribution(priced.attribution);
  view.setPsnPricingNote(psnNoteFor(priced.psnReason));
  const incoming = priced.limited || {};
  if (Object.keys(incoming).length) state.limited = { ...state.limited, ...incoming };
  view.setLimitNote(limitNoteFor(state.limited, ownKeyPresent()));
}

/** A fresh pricing attempt starts clean: last attempt's rate-limit note must
 *  not outlive the attempt that produced it. */
function beginPricingAttempt() {
  state.limited = {};
  view.setLimitNote(null);
}

/** Save — or, with an empty box, clear — one manual figure for one title.
 *
 *  The box is read back from the view rather than passed in: the drawer is
 *  rebuilt on every render, so a node captured at click time would be one that
 *  no longer exists. Buttons rather than autosave for the same reason — an
 *  unsaved box would be wiped mid-typing. */
function saveEdit(id, field, raw) {
  const input = view.editInput(field);
  const parsed = parseEdit(field, raw !== undefined ? raw : (input ? input.value : ""));
  if (!parsed.ok) { view.setEditError(parsed.why); return; }
  view.setEditError(null);
  // The currency travels with a price: there is no FX in the app, so a number
  // entered in another currency must be labelled rather than relabelled.
  state.edits = store.setEdit(id, {
    [field]: parsed.value,
    ...(field === "price"
      ? { currency: parsed.value === null ? null : state.currency }
      : {}),
  });
  renderAll();
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function saveUiState(patch) {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({ ...loadUiState(), ...patch }));
  } catch { /* private mode / quota — filters just won't persist */ }
}

const savedUi = loadUiState();


const KEY_STORES = {
  steam: ["steam_id"],
  gog: ["gog_access_token", "gog_refresh_token", "gog_user_id"],
  epic: ["epic_access_token", "epic_refresh_token", "epic_account_id"],
  amazon: ["amazon_access_token", "amazon_refresh_token", "amazon_serial"],
  psn: ["psn_access_token", "psn_refresh_token"],
};

let state = {
  phase: "onboarding",   // "onboarding" | "ready" | "loading"
  accounts: { steam: false, gog: false, epic: false, amazon: false, psn: false },
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
  filter: "All",
  platform: "All",
  tier: "All",
  verdictSlide: "games",
  viewMode: "list",
  sort: "price-desc",
  search: "",
  scanning: false,
  openId: null,
  // Card exports: which deck the export drawer is showing, and — on a
  // #card= link — the snapshot another visitor shared.
  exportKind: "wrapped",
  sharedSpec: null,
  // The visitor's Steam display name — signs shared cards. Filled by the
  // scan, kept across reloads via the snapshot.
  steamPersona: null,
  // derived: filled in by renderAll before anything reads them
  bench: { samples: 0, p25: null, p50: null, p75: null, p90: null, max: null },
  verdicts: new Map(),
  // Which shared pricing key refused the last attempt: {itad: true} or
  // {platprices: true}. Cleared when a new attempt starts, so the note it
  // drives never outlives its own cause.
  limited: {},
  // Titles held on more than one store: {gameId: [other copies]}. Derived from
  // identity alone, so it is recomputed wherever the game list is rebuilt
  // rather than persisted with the snapshot.
  dupes: new Map(),
  // What the visitor typed over a store's own figures: {id: {price?, hours?}}.
  // Read from localStorage at boot and replaced wholesale after a save, so a
  // reload never resurrects a stale copy.
  edits: {},
  // The price map with the edits layered in — what every view consumer of a
  // price reads. state.prices stays the raw store answer, which is what the
  // snapshot persists and what Reset restores from.
  pricesEff: {},
  comparators: { worst: [], best: [] },
  simTarget: savedUi.simTarget || null,
  simHours: Number(savedUi.simHours) || 10,
  scanSteps: null,
  // /api/config, fetched at boot: whether this instance can price anything
  // without the visitor's own keys. null until it lands, and stays null if
  // the fetch fails.
  server: null,
  page: 1,                 // 1-based library page; never persisted
  // Set by forget(): the landing page shows one line confirming that the
  // browser's copy of everything is gone. Not persisted — it describes a
  // moment, not a setting.
  forgot: false,
  tabCounts: { All: 0, Unplayed: 0, Played: 0, "No data": 0 },
};


function linkedAccounts() {
  return {
    steam: Boolean(localStorage.getItem("steam_id")),
    gog: Boolean(localStorage.getItem("gog_access_token")),
    epic: Boolean(localStorage.getItem("epic_access_token")),
    amazon: Boolean(localStorage.getItem("amazon_access_token")),
    psn: Boolean(localStorage.getItem("psn_access_token")),
  };
}

function anyLinked(acc = linkedAccounts()) {
  return Object.values(acc).some(Boolean);
}

function computeRows({ skipPlayFilter = false } = {}) {
  let g = state.games;
  if (state.platform && state.platform !== "All") g = g.filter((x) => x.platform === state.platform);
  // Tier is read from the verdict map, which is built against the whole
  // library — so narrowing by verdict never moves the goalposts.
  if (state.tier && state.tier !== "All") {
    g = g.filter((x) => (state.verdicts.get(x.id) || "nodata") === state.tier);
  }
  // skipPlayFilter: the tabs count their own options from this pool, so
  // selecting "Unplayed" never shrinks the Unplayed badge to zero.
  if (!skipPlayFilter) {
    if (state.filter === "Unplayed") g = g.filter((x) => x.hours != null && x.hours < 1);
    else if (state.filter === "Played") g = g.filter((x) => x.hours != null && x.hours >= 1);
    else if (state.filter === "No data") g = g.filter((x) => x.hours == null);
  }

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
// ---------- cover art (grid view) ----------
// SteamGridDB urls come back from /api/covers and are memoised here (persisted)
// so a re-render or a restart never refetches art. Loading is lazy: only cards
// scrolling into view are requested, which keeps a 500-game library inside one
// rate-limit window. Without an SGDB key the grid just keeps its placeholders.
const coversCache = new Map();      // gameId -> image url
let coverPending = new Set();       // ids queued for the next batch
let coverInflight = new Set();      // ids currently being fetched
let coverTimer = null;
let coverObserver = null;

function loadCoversCache() {
  try {
    const raw = JSON.parse(localStorage.getItem("covers_cache") || "{}");
    for (const [id, url] of Object.entries(raw)) if (url) coversCache.set(id, url);
  } catch { /* corrupt cache is simply ignored */ }
}

function persistCovers() {
  try {
    localStorage.setItem("covers_cache", JSON.stringify(Object.fromEntries(coversCache)));
  } catch { /* quota exceeded: the cache is an optimisation, never fatal */ }
}

/** Stamp every rendered placeholder whose url we already know. */
function applyCovers() {
  for (const img of document.querySelectorAll(".cover-img")) {
    if (img.dataset.loaded) continue;
    const url = coversCache.get(img.dataset.coverId);
    if (url) {
      img.setAttribute("src", url);
      img.dataset.loaded = "1";
      // A memory-cache hit can be complete before any load event listener
      // has a say — reveal it either way.
      if (img.complete) img.classList.add("is-loaded");
    }
  }
}

/** Watch cards entering the viewport and fetch only those covers. */
function observeCovers() {
  if (typeof IntersectionObserver === "undefined") return;
  if (coverObserver) coverObserver.disconnect();
  coverObserver = new IntersectionObserver((entries) => {
    const need = [];
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.coverId;
      coverObserver.unobserve(e.target);
      if (id && !coversCache.has(id)) need.push(id);
    }
    if (need.length) queueCovers(need);
  }, { rootMargin: "300px" });
  for (const img of document.querySelectorAll(".cover-img")) {
    if (!img.dataset.loaded && !coversCache.has(img.dataset.coverId)) coverObserver.observe(img);
  }
}

function queueCovers(ids) {
  if (!localStorage.getItem("sgdb_api_key")) return;
  for (const id of ids) {
    if (!coversCache.has(id) && !coverInflight.has(id)) coverPending.add(id);
  }
  if (!coverPending.size) return;
  clearTimeout(coverTimer);
  coverTimer = setTimeout(flushCovers, 250);
}

async function flushCovers() {
  const key = localStorage.getItem("sgdb_api_key");
  if (!key || !coverPending.size) return;
  const batch = [...coverPending].slice(0, 40);
  for (const id of batch) { coverPending.delete(id); coverInflight.add(id); }

  const byId = new Map(state.games.map((g) => [g.id, g]));
  const payload = batch
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((g) => ({ id: g.id, title: g.name, appid: g.appid || null }));

  try {
    if (payload.length) {
      const resp = await fetch(api.apiUrl("/api/covers"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SGDB-Key": key },
        body: JSON.stringify({ games: payload }),
      });
      if (resp.ok) {
        const data = await resp.json();
        for (const [id, url] of Object.entries(data.covers || {})) {
          if (url) coversCache.set(id, url);
        }
        persistCovers();
        applyCovers();
      }
    }
  } catch { /* network blip: placeholders stay, the next observe retries */ }
  for (const id of batch) coverInflight.delete(id);
  if (coverPending.size) flushCovers();   // keep draining the queue
}

function renderAll() {
  state.accounts = linkedAccounts();
  if (state.platform && state.platform !== "All" && !state.games.some((g) => g.platform === state.platform)) {
    state.platform = "All";   // selected platform vanished (rescan / unlink)
  }
  // Manual edits layer over the store's own figures first: everything below
  // reads the edited library, so a price the visitor typed moves the verdict,
  // the benchmark, the KPIs, the pies and the export without any of them
  // knowing overrides exist.
  const eff = applyEdits(state.games, state.prices, state.edits, state.currency);
  state.games = eff.games;
  state.pricesEff = eff.prices;
  // Verdicts are derived from the whole library, not the filtered rows: a
  // filter must not redefine the benchmark it filters against. That holds
  // however the table is filtered — what varies is *which* games get ranked,
  // which is a selection question rather than a scoring one. Add-ons are the
  // exception: they carry no independent playtime, so they are kept out of the
  // quartile basis, the verdict map and the ranked lists entirely — their
  // spend is read from the Add-on value KPI instead (see computeRegret).
  const scored = state.games.filter((g) => g.kind !== "dlc");
  state.bench = benchmark(scored);
  state.verdicts = verdictMap(scored, state.bench);
  state.rows = computeRows();
  // Claims about the library are made from the library, never from the browsing
  // subset: a search for one title must not make it "the worst buy", restate the
  // regret score as that title's own, or shrink "your whole library" to one row.
  // A filter is a question about what to look at, not a question about the
  // library's worth. Add-ons stay out: they carry no independent playtime, so
  // their spend is read from the Add-on value KPI instead (see computeRegret).
  state.comparators = rankGames(scored);
  if (!state.comparators.worst.some((t) => t.id === state.simTarget)) {
    state.simTarget = state.comparators.worst.length ? state.comparators.worst[0].id : null;
  }
  // Play-status counts for the tabs, taken from the pool the tab filter
  // itself is excluded from — a filter must never shrink its own option.
  const statusPool = computeRows({ skipPlayFilter: true });
  state.tabCounts = {
    All: statusPool.length,
    Unplayed: statusPool.filter((x) => x.hours != null && x.hours < 1).length,
    Played: statusPool.filter((x) => x.hours != null && x.hours >= 1).length,
    "No data": statusPool.filter((x) => x.hours == null).length,
  };
  state.counts = countByPlatform(state.games);
  // Library-wide too, for the same reason as the cards above — and `state.games`
  // rather than `scored`, because computeRegret pulls add-ons out of the game
  // metrics itself to report them as their own KPI.
  state.metrics = computeRegret(state.games);
  state.coverageText = coverageLine();
  // The footer's "not what you actually paid" line is a half-truth once the
  // visitor has entered prices of their own, so say so — only while it is true.
  view.setBasisNote(state.games.filter((g) => g.edited).length);
  view.render(state);
  if (state.phase === "ready" && state.viewMode === "grid") {
    applyCovers();
    observeCovers();
  }
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

/** Alnum-folded title: case, symbol and spacing variants of one display name
 *  collapse, so "DOOM (2016)" and "doom 2016" are one title. Used by
 *  dedupeGames, where the key must stay strict — two editions sold on one
 *  store are two entitlements. */
const foldName = (name) => (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Words-with-spaces normalisation for cross-store matching: unlike foldName,
 *  it keeps word boundaries, so "Hunt - Game" never fuses into "huntedgame". */
const wordFold = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Trailing edition phrases stripped before comparing two stores' listings,
 *  longest first so a phrase containing another never stops halfway. Every
 *  entry appears in wordFold's shape ("Collector's Edition" -> "collector s
 *  edition"). */
const EDITION_PHRASES = [
  "game of the year edition",
  "game of the year",
  "goty",
  "complete edition",
  "definitive edition",
  "remastered edition",
  "remastered",
  "remaster",
  "deluxe edition",
  "ultimate edition",
  "premium edition",
  "legendary edition",
  "anniversary edition",
  "enhanced edition",
  "collector s edition",
  "deluxe",
  "collection",
  "bundle",
  "edition",
];

/**
 * One title as two stores would each describe it: words, lowercased, with any
 * trailing edition phrase removed at a word boundary.
 *
 * Steam's "… - Game of the Year Edition" and GOG's "… - Complete Edition" both
 * reduce to the base title and are flagged as one game owned twice; "Doom" and
 * "Doom Eternal" do not, because "Eternal" is not an edition of anything. A
 * bare edition phrase is never the whole key: the length guard leaves a title
 * that is only "Edition" alone rather than matching it against every other.
 */
export function baseTitle(name) {
  let s = wordFold(name);
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const phrase of EDITION_PHRASES) {
      if (s.length > phrase.length && s.endsWith(` ${phrase}`)) {
        s = s.slice(0, -(phrase.length + 1)).trim();
        stripped = true;
        break;
      }
    }
  }
  return s;
}

/** Collapse duplicate entitlements of the same game. Epic returns the base
 *  title plus each DLC/expansion as separate records that share a sandbox, so
 *  they all surface under one display name; keep the copy with the most
 *  playtime (the base game) and drop the rest. `kind` joins the key so an
 *  add-on never collapses into the base game it shares a name with. */
export function dedupeGames(games) {
  const best = new Map();
  for (const g of games) {
    const key = `${g.platform}\u0000${g.kind || "game"}\u0000${foldName(g.name)}`;
    const prev = best.get(key);
    if (!prev || (g.hours || 0) > (prev.hours || 0)) best.set(key, g);
  }
  return [...best.values()];
}

/** Titles held on more than one store: {id: [the other copies' rows]}.
 *
 *  Two purchases of one game are a regret the dashboard otherwise cannot see:
 *  each copy is its own row with its own price and nothing ties them together.
 *  Matching normalises to words and drops trailing edition phrases, so
 *  Steam's "… Game of the Year Edition" and GOG's "… Complete Edition" are one
 *  title, while "Doom" and "Doom Eternal" stay different products. A real
 *  name collision (DOOM 1993 vs 2016) still matches: there is no year or
 *  cross-store id in the data to separate those. The UI therefore claims
 *  "also on Epic", never "you paid twice".
 *
 *  Add-ons are skipped: they carry no verdict of their own and the base game
 *  is the purchase. Same-store pairs cannot occur — dedupeGames has already
 *  collapsed them — and the platform guard keeps that true regardless. */
export function findDuplicates(games) {
  const byTitle = new Map();
  for (const g of games) {
    if (g.kind === "dlc") continue;
    const key = baseTitle(g.name);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(g);
  }
  const dupes = new Map();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    for (const g of group) {
      // Only a copy on a *different* store counts; the id/platform guards make
      // "two stores, one game" the sole condition, not a near-miss.
      const others = group.filter((o) => o.id !== g.id && o.platform !== g.platform);
      if (others.length) dupes.set(g.id, others);
    }
  }
  return dupes;
}

async function scan() {
  if (state.scanning) return;
  const acc = linkedAccounts();
  if (!anyLinked(acc)) { state.phase = "onboarding"; renderAll(); return; }

  state.scanning = true;
  state.phase = "loading";
  state.scanError = null;
  beginPricingAttempt();   // a fresh scan re-asks every provider
  // One step per linked source; each flips to done/failed as its promise
  // settles, so the list is honest about which store is slow or broken.
  const specs = [
    acc.steam && ["Steam", async () => {
      const { games, persona } = await api.fetchSteamGames(localStorage.getItem("steam_id"));
      // Signs shared cards with the visitor's Steam name rather than a
      // hostname. Snapshot-restored sessions keep it from the last scan.
      if (persona) state.steamPersona = persona;
      return games;
    }],
    acc.gog && ["GOG", () => api.fetchGogGames()],
    acc.epic && ["Epic", () => fetchAllEpicGames()],
    acc.amazon && ["Amazon Luna", () => api.fetchAmazonGames()],
    acc.psn && ["PlayStation", () => api.fetchPsnGames()],
  ].filter(Boolean);
  state.scanSteps = specs.map(([label]) => ({ label, status: "pending" }));
  renderAll();

  // Each store lands on its own clock — Epic's cursor crawl can run a
  // minute longer than Steam's single request. Adopt every source the
  // moment it settles (rows first, then its prices) so the dashboard fills
  // in store-by-store instead of holding everything hostage to the slowest.
  const seen = new Map();
  let highs = {}, lows = {};
  const bake = () => {
    state.games = state.games.map((g) => ({
      ...g,
      price: state.prices[g.id] ?? null,
      // Captured beside the price so an override can be cleared with no
      // re-fetch, and refreshed here — wherever raw prices land — never by
      // applyEdits, which would otherwise latch onto its own output.
      apiPrice: state.prices[g.id] ?? null,
      high: highs[g.id] ?? null,
      low: lows[g.id] ?? null,
    }));
  };
  const adopt = async (chunk) => {
    for (const g of chunk) {
      const prev = seen.get(g.id);
      if (!prev || (g.hours || 0) > (prev.hours || 0)) seen.set(g.id, g);
    }
    state.games = dedupeGames([...seen.values()]);
    // Identity-only, so recompute whenever the list changes — never persisted.
    state.dupes = findDuplicates(state.games);
    state.phase = "ready";          // real rows beat skeletons the instant they exist
    renderAll();
    try {
      const priced = await api.fetchPrices(chunk, state.currency);
      state.prices = { ...state.prices, ...priced.prices };
      highs = { ...highs, ...(priced.highs || {}) };
      lows = { ...lows, ...(priced.lows || {}) };
      if (priced.currency) state.currency = priced.currency;
      applyPricingNotes(priced);
      bake();
      renderAll();
    } catch {
      // This store's prices stay "—" — the rows and hours are still worth
      // showing, and the next scan retries them.
    }
  };

  try {
    const results = await Promise.allSettled(specs.map(([, run], i) => Promise.resolve()
      .then(run)
      .then(
        async (value) => { state.scanSteps[i].status = "done"; await adopt(value); return value; },
        (err) => { state.scanSteps[i].status = "failed"; renderAll(); throw err; },
      )));
    const errors = results
      .filter((r) => r.status === "rejected")
      .map((r) => (r.reason && r.reason.message) || String(r.reason));
    state.scanError = errors.length ? errors.join(" · ") : null;
    store.setSnapshot({ games: state.games, prices: state.prices, counts: state.counts, currency: state.currency, persona: state.steamPersona });
  } catch (e) {
    state.scanError = (e && e.message) || String(e);
  } finally {
    state.scanning = false;
    state.scanProgress = null;
    state.scanSteps = null;   // the stepper is a loading affordance, not history
    state.phase = "ready";
    state.openId = null;
    state.page = 1;           // new data, fresh start at the top
    renderAll();
  }
}

/** After a page flip the panel's top is above the viewport — bring it back. */
function scrollToPanel() {
  const p = view.panel || document.querySelector(".panel");
  if (p && typeof p.scrollIntoView === "function") p.scrollIntoView({ block: "start" });
}

/** Re-price the existing library after the display currency changes. The
 *  games are unchanged — only the price map (and the currency label) is
 *  refreshed. On failure the previous currency is kept so the still-old
 *  amounts remain honestly labelled; the change is only persisted on success. */
async function reprice(nextCurrency) {
  if (state.scanning) { renderAll(); return; }
  const prev = state.currency;
  state.currency = nextCurrency || prev;
  beginPricingAttempt();   // reprice re-asks every provider too
  try {
    const priced = await api.fetchPrices(state.games, state.currency);
    state.prices = priced.prices;
    if (priced.currency) state.currency = priced.currency;
    applyPricingNotes(priced);
    const highs = priced.highs || {}, lows = priced.lows || {};
    state.games = state.games.map((g) => ({
      ...g,
      price: state.prices[g.id] ?? null,
      apiPrice: state.prices[g.id] ?? null,   // see bake(): the raw copy Reset restores
      high: highs[g.id] ?? null,
      low: lows[g.id] ?? null,
    }));
    store.setSnapshot({ games: state.games, prices: state.prices, counts: state.counts, currency: state.currency, persona: state.steamPersona });
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

// ---------- bring-your-own-key gate ----------

/** The four keys the keys card accepts, stored as `${kind}_api_key`. */
const USER_KEY_KINDS = ["itad", "steam", "platprices", "sgdb"];

/** Did this visitor bring at least one key of their own? This is a
 *  bring-your-own-key app: a store linked without one could not be priced
 *  (or, for Steam, read at all), so linking is gated on this. */
function hasUserKeys() {
  return USER_KEY_KINDS.some((k) => !!localStorage.getItem(`${k}_api_key`));
}

/** No keys: refuse the store login and land on the keys card instead —
 *  highlight it, reveal the note that says why, scroll the fields into view
 *  and focus the first one. Saving a key rebuilds the onboarding card, which
 *  clears both the note and the highlight. */
function goToKeysCard() {
  if (state.phase !== "onboarding") {
    closeDrawer();
    state.phase = "onboarding";
    renderAll();
  }
  const card = document.querySelector(".api-keys");
  if (card) card.classList.add("needs-keys");
  const note = document.getElementById("keys-lock");
  if (note) note.hidden = false;
  const first = document.getElementById("itad-key");
  const target = first || card;
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (first && typeof first.focus === "function") first.focus({ preventScroll: true });
}

function linkPlatform(platform) {
  // The receipt is spent the moment a new link begins.
  state.forgot = false;
  // The gate: no key this browser has ever been given, no login flow started.
  // Clicking Connect would otherwise open a store login the visitor could not
  // finish usefully — send them to the keys card instead.
  if (!hasUserKeys()) {
    goToKeysCard();
    return;
  }
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
  } else if (platform === "amazon") {
    ensurePasteSurface(platform);
    api.loginAmazon()
      .then(({ url }) => {
        const w = window.open(url, "amazon-link", "width=520,height=700");
        if (!w) showFormError("amazon", "Popup blocked — allow popups, then paste the redirect URL below.");
      })
      .catch((e) => showFormError("amazon", String((e && e.message) || e)));
  } else if (platform === "psn") {
    // Sony offers no approval screen, so this is a two-step manual flow and the
    // button only performs step one: get a signed-in session on playstation.com.
    // The NPSSO URL answers a signed-out browser with invalid_grant JSON, never
    // a login form — so we must not send them there first. Step two (grab the
    // NPSSO) is the link inside the paste block, which the steps point at.
    ensurePasteSurface(platform);
    window.open(api.PSN_SIGNIN_URL, "psn-signin", "width=520,height=700");
  }
}

/** Everything one account brought: its rows, its prices, its manual edits and
 *  its share of the scan snapshot. Called on unlink so a different account can
 *  be linked next without inheriting this one's library — the in-memory stores
 *  and the on-disk snapshot must all agree, or a reload quietly restores what
 *  was just deleted. */
function dropStoreData(name) {
  const dropped = new Set(
    state.games.filter((g) => g.platform === name).map((g) => g.id));
  state.games = state.games.filter((g) => g.platform !== name);
  state.dupes = findDuplicates(state.games);
  const prices = {};
  for (const [id, p] of Object.entries(state.prices || {})) {
    if (!dropped.has(id)) prices[id] = p;
  }
  state.prices = prices;
  // A manual figure is keyed by game id — and Steam ids are appids, so an edit
  // made for this account's Hades would silently apply to the next account's.
  // It leaves with the account that made it.
  const edits = store.getEdits();
  let touched = false;
  for (const id of dropped) {
    if (id in edits) { delete edits[id]; touched = true; }
  }
  if (touched) {
    localStorage.setItem("game_edits", JSON.stringify(edits));
    state.edits = edits;
  }
  const snap = store.getSnapshot();
  if (snap) {
    const games = (snap.games || []).filter((g) => g.platform !== name);
    if (games.length) store.setSnapshot({ ...snap, games, prices });
    else store.clearSnapshot();
  }
}

function unlinkPlatform(platform, displayName) {
  for (const k of KEY_STORES[platform] || []) localStorage.removeItem(k);
  // This account's own data leaves with it either way. Relinking a different
  // account must never inherit this one's library.
  if (displayName) dropStoreData(displayName);
  const acc = linkedAccounts();
  if (!anyLinked(acc)) {
    state.phase = "onboarding";
    state.games = [];
    state.dupes = new Map();
    state.rows = [];
    state.prices = {};
    state.metrics = null;
    state.counts = {};
    state.epicScanned = 0;
    state.epicFiltered = 0;
    state.coverageText = "";
    state.scanError = null;
    // The snapshot goes with the last account too. Boot only scans when the
    // library is empty, so a surviving snapshot would show the old account's
    // games under the new one until somebody pressed Scan by hand.
    store.clearSnapshot();
    closeDrawer();
  } else if (state.openId && !state.games.some((g) => g.id === state.openId)) {
    closeDrawer();   // the open drawer belonged to the account just removed
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
  if (kind === "psn") {
    // A raw NPSSO token, not a redirect URL or auth code — it must clear the
    // parse below, which would reject it, so it branches here instead.
    finishPsnExchange(text);
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
  if (kind === "amazon") {
    finishAmazonExchange(code);
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

/** Exchange a pasted Amazon code for a device bearer token, then rescan. */
async function finishAmazonExchange(code) {
  try {
    const raw = sessionStorage.getItem("amazon_pkce");
    if (!raw) throw new Error("Run Connect Amazon Luna again for a fresh sign-in link.");
    const { clientId, verifier, serial } = JSON.parse(raw);
    const data = await api.exchangeAmazon({
      code,
      client_id: clientId,
      code_verifier: verifier,
      serial,
    });
    if (!data.access_token) throw new Error("Amazon exchange returned no access token");
    localStorage.setItem("amazon_access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("amazon_refresh_token", data.refresh_token);
    if (data.serial) localStorage.setItem("amazon_serial", data.serial);
    sessionStorage.removeItem("amazon_pkce");
    const box = document.getElementById("amazon-code");
    if (box) box.value = "";
    await scan();
  } catch (e) {
    showFormError("amazon", String((e && e.message) || e));
  }
}

/** Exchange a pasted PSN NPSSO for tokens, then rescan. */
async function finishPsnExchange(npsso) {
  try {
    const data = await api.exchangePsn(npsso.trim());
    if (!data.access_token) throw new Error("PlayStation exchange returned no access token");
    localStorage.setItem("psn_access_token", data.access_token);
    if (data.refresh_token) localStorage.setItem("psn_refresh_token", data.refresh_token);
    const box = document.getElementById("psn-code");
    if (box) box.value = "";
    await scan();
  } catch (e) {
    showFormError("psn", String((e && e.message) || e));
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
  // Remember where focus came from so closing can put it back.
  lastFocus = document.activeElement && document.activeElement.focus
    ? document.activeElement : null;
  view.renderDrawer(view.drawerBody, game, (state.pricesEff || state.prices)[id], state);
  view.drawer.classList.remove("hidden");
  applyCovers();                                // stamp the art if its url is cached
  if (!coversCache.has(id)) queueCovers([id]);  // else fetch it — someone wants to look at it
  const close = document.getElementById("drawer-close");
  if (close && typeof close.focus === "function") close.focus();
}

function closeDrawer() {
  state.openId = null;
  if (view.drawer) view.drawer.classList.add("hidden");
  const main = document.getElementById("main");
  if (main && typeof main.focus === "function") main.focus();
  if (lastFocus && typeof lastFocus.focus === "function" && lastFocus.isConnected !== false) {
    lastFocus.focus();
  }
  lastFocus = null;
}

// ---------- card exports ----------

function currentExportSpec() {
  return cardSpec(state, state.exportKind || "wrapped");
}

/** The drawer's preview is painted through the same path as the export, so
 *  the file you get is the picture you saw. */
async function repaintExportPreview() {
  const cv = document.getElementById("export-canvas");
  if (!cv) return;
  const spec = currentExportSpec();
  if (!spec) { view.exportStatus("Nothing to export in this view."); return; }
  await renderCardTo(cv, spec);
}

function openExporter() {
  if (!state.games.length) return;
  // The chosen kind can outlive the view that filled it (a facet cleared, a
  // store unlinked) — fall back to the card that is always available.
  const kinds = exportKinds(state);
  if (!kinds.includes(state.exportKind)) state.exportKind = "wrapped";
  lastFocus = document.activeElement && document.activeElement.focus
    ? document.activeElement : null;
  view.renderExporter(state);
  view.drawer.classList.remove("hidden");
  repaintExportPreview();
  const close = document.getElementById("drawer-close");
  if (close && typeof close.focus === "function") close.focus();
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  const url = (typeof URL !== "undefined" && URL.createObjectURL && blob)
    ? URL.createObjectURL(blob) : null;
  a.href = url || "#";
  a.download = name;
  document.body.appendChild(a);
  if (typeof a.click === "function") a.click();
  else if (typeof a.dispatch === "function") a.dispatch("click");
  if (url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(url);
}

const exportFileName = (spec) => `regret-${String(spec.kind || "card").replace(/:/g, "-")}.png`;

async function downloadExport() {
  const spec = currentExportSpec();
  if (!spec) return view.exportStatus("Nothing to export in this view.");
  const blob = await cardBlob(spec);
  if (!blob) return view.exportStatus("This browser cannot render the card.");
  downloadBlob(blob, exportFileName(spec));
  view.exportStatus("PNG saved.");
}

async function shareExport() {
  const spec = currentExportSpec();
  if (!spec) return view.exportStatus("Nothing to export in this view.");
  const blob = await cardBlob(spec);
  if (!blob) return view.exportStatus("This browser cannot render the card.");
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const file = typeof File !== "undefined"
    ? new File([blob], exportFileName(spec), { type: "image/png" }) : null;
  if (file && typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: spec.title, text: "My library, judged." });
      view.exportStatus("Shared.");
      return;
    } catch { /* dismissed: fall through to a download */ }
  }
  downloadBlob(blob, exportFileName(spec));
  view.exportStatus("No share sheet here — the PNG was saved instead.");
}

async function copyExportLink() {
  const spec = currentExportSpec();
  if (!spec) return view.exportStatus("Nothing to export in this view.");
  const url = shareUrl(spec);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard
        && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(url);
      view.exportStatus("Link copied — it opens this exact card for anyone.");
      return;
    }
  } catch { /* clipboard refused: show the link so it can be copied by hand */ }
  view.exportStatus(url);
}

function makeYourOwn() {
  state.sharedSpec = null;
  state.phase = anyLinked(state.accounts) ? "ready" : "onboarding";
  try {
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", window.location.pathname || "/");
    }
  } catch { /* the hash stays until the next navigation; harmless */ }
  renderAll();
  if (state.phase === "ready" && !state.games.length) scan();
}

let lastFocus = null;

function forget() {
  store.forget();
  coversCache.clear();
  state.games = [];
  state.dupes = new Map();
  state.rows = [];
  state.prices = {};
  state.counts = {};
  state.epicScanned = 0;
  state.epicFiltered = 0;
  state.metrics = null;
  state.phase = "onboarding";
  // So the landing page can say it worked: the deletion itself leaves no other
  // visible trace the moment it happens.
  state.forgot = true;
  state.scanError = null;
  state.search = "";
  state.filter = "All";
  state.tier = "All";
  saveUiState({ tier: "All" });
  closeDrawer();
  renderAll();
}

// ---------- delegated events ----------

/** Persist a bring-your-own API key to localStorage. It is forwarded with the
 *  user's own pricing/library requests (as a header) and never stored server-side.
 *
 *  The shared term fills all four fields at once — each provider reads only its
 *  own header, so one entry opts every provider into the instance's default keys
 *  (recognised by the backend when the instance configures that term). Saving it
 *  replaces whatever was in the other fields; that is the point of the switch. */
function saveApiKey(kind) {
  const input = document.getElementById(`${kind}-key`);
  const val = ((input && input.value) || "").trim();
  const shared = val.toLowerCase() === "superuser";
  const kinds = shared ? USER_KEY_KINDS : [kind];
  for (const k of kinds) {
    if (val) localStorage.setItem(`${k}_api_key`, val);
    else localStorage.removeItem(`${k}_api_key`);
  }
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
    // The drawer's scrim is its own ::before, so a click landing on the
    // drawer element itself (not its content) is a click "outside".
    if (view.drawer && e.target === view.drawer
        && !view.drawer.classList.contains("hidden")) closeDrawer();
    return;
  }
  const platform = t.dataset.platform;
  switch (t.dataset.action) {
    case "link": linkPlatform(platform); break;
    // The metric explanation chip. Its data-action exists purely to stop
    // closestAction() at the chip — clicking one inside a ranked row must not
    // bubble up to data-action="open" and open the drawer. Showing the text is
    // entirely CSS, so there is nothing to do here.
    case "info": break;
    case "unlink": unlinkPlatform(platform, t.dataset.name); break;
    case "scan": scan(); break;
    case "filter": state.filter = t.dataset.filter; state.page = 1; renderAll(); break;
    case "tier":
      state.tier = t.dataset.tier || "All";
      state.page = 1;
      saveUiState({ tier: state.tier });
      renderAll();
      break;
    case "verdict-slide":
      state.verdictSlide = t.dataset.slide === "value" ? "value" : "games";
      renderAll();
      break;
    case "clear-filters":
      state.tier = "All";
      state.platform = "All";
      state.filter = "All";
      state.search = "";
      state.page = 1;
      saveUiState({ tier: "All" });
      renderAll();
      break;
    case "view":
      state.viewMode = t.dataset.view === "grid" ? "grid" : "list";
      localStorage.setItem("view_mode", state.viewMode);
      state.page = 1;
      renderAll();
      break;
    case "filter-platform":
      state.platform = state.platform === platform ? "All" : platform;
      state.page = 1;
      renderAll();
      break;
    case "page-prev":
      state.page = Math.max(1, (state.page || 1) - 1);
      renderAll();
      scrollToPanel();
      break;
    case "page-next":
      state.page = (state.page || 1) + 1;
      renderAll();
      scrollToPanel();
      break;
    case "page-go":
      state.page = Number(t.dataset.page) || 1;
      renderAll();
      scrollToPanel();
      break;
    case "open": openDrawer(t.dataset.id); break;
    case "close-drawer": closeDrawer(); break;
    case "share": openExporter(); break;
    case "export-kind":
      state.exportKind = t.dataset.kind || "wrapped";
      view.renderExporter(state);
      repaintExportPreview();
      break;
    case "export-download": downloadExport(); break;
    case "export-share": shareExport(); break;
    case "export-copy": copyExportLink(); break;
    case "make-own": makeYourOwn(); break;
    // Forget my data is the only destructive action in the app, so it asks
    // first: the menu this used to hide behind is gone, and the confirmation
    // has no X — the two answers are the buttons.
    case "confirm-forget": view.showForgetModal(true); break;
    case "cancel-forget": view.showForgetModal(false); break;
    case "do-forget":
      view.showForgetModal(false);
      forget();
      break;
    case "submit-gog": submitPaste("gog"); break;
    case "submit-epic": submitPaste("epic"); break;
    case "submit-amazon": submitPaste("amazon"); break;
    case "submit-psn": submitPaste("psn"); break;
    case "save-key": saveApiKey(t.dataset.kind); break;
    case "save-edit": saveEdit(t.dataset.id, t.dataset.field); break;
    case "reset-edit": saveEdit(t.dataset.id, t.dataset.field, ""); break;
    case "show-keys":
      state.phase = "onboarding";
      renderAll();
      break;
    case "home":
      // The wordmark is the way back to the landing page — store links and
      // API keys — from wherever the app sits. Already there: nothing to do.
      if (state.phase !== "onboarding") {
        closeDrawer();
        state.phase = "onboarding";
        renderAll();
      }
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
    state.page = 1;
    renderAll();
  } else if (t.dataset.action === "sim") {
    // Range input: the view updates in place, so focus stays on the thumb.
    state.simHours = Number(t.value) || 10;
    saveUiState({ simHours: state.simHours });
    renderAll();
  } else if (t.dataset.action === "toy") {
    // Attract-mode toy on the landing page. Repaints in place and never
    // re-renders: rebuilding the onboarding mid-drag would take the thumb out
    // from under the pointer (the same reason buildSim is built once).
    paintVerdictToy(Number(t.value));
  }
}

function onChange(e) {
  const t = closestAction(e.target);
  if (!t) return;
  if (t.dataset.action === "sort") {
    state.sort = t.value;
    state.page = 1;
    renderAll();
  } else if (t.dataset.action === "platform") {
    state.platform = t.value || "All";
    state.page = 1;
    renderAll();
  } else if (t.dataset.action === "sim-target") {
    state.simTarget = t.value;
    saveUiState({ simTarget: state.simTarget });
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
      anchorToyPrice();   // the demo re-asks the store for its hero's new price
    }
  }
}

function onKeydown(e) {
  const t = closestAction(e.target);
  if (!t) return;
  if (t.dataset.action === "code-input" && e.key === "Enter") {
    e.preventDefault();
    submitPaste(t.dataset.kind);
    return;
  }
  if (e.key === "Escape") {
    if (state.openId) closeDrawer();
    return;
  }
  // Cards and rows carry data-action="open" but are not <button>s: give them
  // the keyboard behaviour that role promises. tabIndex>=0 means the element
  // is actually in the tab order.
  if ((e.key === "Enter" || e.key === " ") && t.dataset.action === "open" && t.tabIndex >= 0) {
    e.preventDefault();
    openDrawer(t.dataset.id);
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
    if (!e.key || !/^(gog_|steam_|epic_|amazon_)/.test(e.key)) return;
    state.accounts = linkedAccounts();
    renderAll();
    if (anyLinked(state.accounts) && state.phase !== "loading") scan();
  });
}

// ---------- boot ----------

export function getState() { return state; }

/** The demo's hero price, asked of the store instead of converted: regional
 *  pricing ignores FX (Hollow Knight is about $14.99 in the US, not the $7.84
 *  that ₹690 converts to). One real number anchors every toy figure together
 *  — the verdict arc is scale-invariant, so only the money becomes true for
 *  this region. A keyless instance, a missing key or an offline API simply
 *  leave the static conversion standing: pricing is optional, the demo is
 *  not allowed to be. */
async function anchorToyPrice() {
  if (state.phase !== "onboarding" || state.currency === "INR") return;
  try {
    const res = await api.fetchPrices([{
      id: "toy-hero",
      name: TOY_GAME.name,
      appid: TOY_GAME.appid,
      platform: "Steam",
    }], state.currency);
    const price = res.prices && res.prices["toy-hero"];
    // Only when the store priced it in the currency we asked for — an
    // upstream relabel would otherwise stamp one region's price on another.
    if (price > 0 && (!res.currency || res.currency === state.currency)) {
      setToyAnchor(state.currency, price / TOY_GAME.price);
    }
  } catch { /* the converted figure stands */ }
  repaintVerdictToy(state.currency);
}

export async function boot() {
  const root = document.getElementById("app") || document.body;
  view.shell(root);
  state.accounts = linkedAccounts();
  state.currency = localStorage.getItem("currency") || "INR";
  // Phones get the cover grid by default — cards suit a narrow screen far
  // better than a table. An explicit earlier choice always wins.
  const savedView = localStorage.getItem("view_mode");
  state.viewMode = savedView === "grid" || (savedView == null && window.innerWidth < 700)
    ? "grid" : "list";
  state.tier = savedUi.tier || "All";
  state.edits = store.getEdits();
  loadCoversCache();
  const snap = store.getSnapshot();
  if (snap) {
    state.games = snap.games || [];
    // Recomputed on every boot: a snapshot carries only rows and prices, so a
    // restored session must find its cross-store copies again.
    state.dupes = findDuplicates(state.games);
    state.prices = snap.prices || {};
    state.steamPersona = snap.persona || null;
  }
  // A shared card link (#card=…) renders the snapshot it carries, before the
  // visitor is asked for anything. A malformed payload boots normally — a
  // link must never be able to break the app.
  const hash = (window.location && window.location.hash) || "";
  const shared = hash.includes("card=") ? decodeCard(hash) : null;
  if (shared) {
    state.sharedSpec = shared;
    state.phase = "shared";
  } else {
    state.phase = anyLinked(state.accounts) ? "ready" : "onboarding";
  }
  wire(root);
  wireCrossWindow();
  renderAll();
  if (state.phase === "shared" && state.sharedSpec) {
    const cv = document.getElementById("shared-canvas");
    if (cv) renderCardTo(cv, state.sharedSpec);
  }
  // /api/config arrives after the first paint and decides two things: how the
  // keys card describes itself, and — when the visitor has never touched the
  // currency picker — which currency the first price fetch is denominated in.
  // Awaiting it before the first scan is deliberate: a scan priced in the
  // default and re-priced after detection would spend the visitor's API quota
  // twice. A failed fetch just leaves state.server null — the keys card then
  // assumes the visitor's key is required, which is the safe direction:
  // assuming "optional" is the mistake that shipped.
  let cfg = null;
  try { cfg = await api.fetchConfig(); } catch { /* keep the worst-case copy */ }
  state.server = cfg;
  if (!localStorage.getItem("currency")) {
    // The edge tells us the visitor's country (Vercel's x-vercel-ip-country,
    // Cloudflare's cf-ipcountry); a self-hosted server.py reports none and the
    // INR default simply stands. An explicit picker choice is never rivalled —
    // detection fills the blank, it never overwrites.
    const local = cfg && currencyForCountry(cfg.country);
    if (local && local !== state.currency) state.currency = local;
  }
  renderAll();
  await anchorToyPrice();   // the landing page's demo, before anything else reads it
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
