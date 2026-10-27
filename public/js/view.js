/** DOM builders. textContent only — never innerHTML with user data. */
import { money, symbol, hours, perHour, pricePerHour, CURRENCIES } from "./format.js";

const PLATFORMS = [
  {
    key: "steam",
    name: "Steam",
    platform: "Steam",
    blurb: "Playtime and current replacement price. Best data of the three.",
    cta: "Connect Steam",
  },
  {
    key: "gog",
    name: "GOG",
    platform: "GOG",
    blurb: "Owned games via one-click sign-in.",
    cta: "Connect GOG",
  },
  {
    key: "epic",
    name: "Epic Games",
    platform: "Epic",
    blurb: "Owned games. Epic needs one extra step — we walk you through it.",
    cta: "Connect Epic",
  },
  {
    key: "amazon",
    name: "Amazon Luna",
    platform: "Amazon",
    blurb: "Owned Amazon Games titles from your Prime/Luna library. Amazon exposes no playtime, so they're priced but left out of per-hour ratios.",
    cta: "Connect Amazon Luna",
  },
];

/** SVG arc path for a pie slice spanning angles a0→a1 (radians; -π/2 = top). */
function pieSlice(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export const view = {
  /** Active display currency (ISO 4217); synced from state in render(). */
  currency: "INR",

  el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  },

  /** Alias kept for callers that used view.view(). */
  view(tag, cls, text) {
    return this.el(tag, cls, text);
  },

  /** Build the static frame once. `root` is #app. */
  shell(root) {
    const main = this.el("main", "app");

    const topbar = this.el("header", "topbar");
    const brand = this.el("div", "brand");
    brand.appendChild(this.el("span", "brand-mark", "₹"));
    brand.appendChild(this.el("h1", null, "regret"));

    const sources = this.el("div", "sources");
    const actions = this.el("div", "topbar-actions");
    const scanBtn = this.el("button", "button primary", "Scan library");
    scanBtn.dataset.action = "scan";
    const menuBtn = this.el("button", "button ghost icon", "⋮");
    menuBtn.dataset.action = "toggle-menu";
    menuBtn.setAttribute("aria-label", "Menu");
    actions.appendChild(scanBtn);
    actions.appendChild(menuBtn);

    topbar.appendChild(brand);
    topbar.appendChild(sources);
    topbar.appendChild(actions);

    const phaseEl = this.el("div", "phase");

    const menu = this.el("div", "menu hidden");
    const forget = this.el("button", null, "Forget my data");
    forget.dataset.action = "forget";
    const closeMenu = this.el("button", null, "Close");
    closeMenu.dataset.action = "toggle-menu";
    menu.appendChild(forget);
    menu.appendChild(closeMenu);

    const drawer = this.el("aside", "drawer hidden");
    const drawerHeader = this.el("div", "drawer-header");
    drawerHeader.appendChild(this.el("h3", null, "Game details"));
    const closeDrawerBtn = this.el("button", "button ghost icon", "✕");
    closeDrawerBtn.dataset.action = "close-drawer";
    closeDrawerBtn.setAttribute("aria-label", "Close");
    drawerHeader.appendChild(closeDrawerBtn);
    const drawerBody = this.el("div", "drawer-body");
    drawer.appendChild(drawerHeader);
    drawer.appendChild(drawerBody);

    const footer = this.el("footer", "disclaimer");
    footer.appendChild(this.el("p", null, "Prices are today's cheapest price (IsThereAnyDeal) in your selected currency — a replacement-cost estimate, not what you actually paid. Games with unknown playtime are excluded from every ratio, never counted as zero."));
    footer.appendChild(this.el("p", null, "GOG and Epic use the unofficial credentials baked into their own launchers. Tokens stay in this browser's localStorage and are never logged or stored server-side."));

    main.appendChild(topbar);
    main.appendChild(phaseEl);
    main.appendChild(footer);
    main.appendChild(menu);
    main.appendChild(drawer);
    root.appendChild(main);

    Object.assign(this, { main, topbar, sources, scanBtn, menuBtn, menu, phaseEl, drawer, drawerBody, footer });
    this._builtPhase = null;
    return this;
  },


  /** Compact per-platform strip in the topbar (ready/loading phases). */
  renderSources(state) {
    const box = this.sources;
    box.textContent = "";
    for (const p of PLATFORMS) {
      const linked = Boolean(state.accounts[p.key]);
      const chip = this.el("span", `source${linked ? " linked" : ""}`);

      chip.appendChild(this.el("span", "dot"));
      chip.appendChild(this.el("span", "source-name", p.name));

      if (linked) {
        const n = state.counts ? state.counts[p.platform] : null;
        chip.appendChild(this.el("span", "source-count", n == null ? "—" : String(n)));
      }

      const btn = this.el("button", "source-action", linked ? "unlink" : "link");
      btn.dataset.action = linked ? "unlink" : "link";
      btn.dataset.platform = p.key;
      chip.appendChild(btn);

      box.appendChild(chip);
    }

    // Always-reachable shortcut to the API-keys card on the onboarding screen.
    const keysBtn = this.el("button", "source-action keys-btn", "keys");
    keysBtn.dataset.action = "show-keys";
    box.appendChild(keysBtn);
  },

  /** One bring-your-own-API-key row: masked input + Save. */
  keyField(kind, label, hint) {
    const field = this.el("div", "key-field");
    const row = this.el("div", "key-row");
    const input = this.el("input", null);
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = localStorage.getItem(`${kind}_api_key`) ? "••••••••  (saved — type to replace)" : label;
    input.id = `${kind}-key`;
    input.dataset.action = "key-input";
    input.dataset.kind = kind;
    const btn = this.el("button", "button small", "Save");
    btn.dataset.action = "save-key";
    btn.dataset.kind = kind;
    row.appendChild(input);
    row.appendChild(btn);
    field.appendChild(row);
    field.appendChild(this.el("p", "key-hint", hint));
    return field;
  },

  /** Display-currency picker (reused in the dashboard toolbar and keys card). */
  buildCurrencySelect(currency) {
    const sel = this.el("select", "sort currency-select");
    sel.dataset.action = "currency";
    CURRENCIES.forEach((code) => {
      const o = this.el("option", null, `${symbol(code)} ${code}`);
      o.value = code;
      sel.appendChild(o);
    });
    sel.value = currency || "INR";
    return sel;
  },

  /** Platform filter (options are repopulated from the data in updateReady). */
  buildPlatformSelect() {
    const sel = this.el("select", "sort platform-select");
    sel.dataset.action = "platform";
    return sel;
  },

  /** Collapsed paste fallback used by both GOG and Epic cards. */
  pasteBlock(kind, label, placeholder) {
    const d = this.el("details", "paste");
    d.id = `${kind}-paste`;
    d.appendChild(this.el("summary", null, label));
    const input = this.el("input", null);
    input.type = "text";
    input.placeholder = placeholder;
    input.id = `${kind}-code`;
    input.dataset.action = "code-input";
    input.dataset.kind = kind;
    const btn = this.el("button", "button small", "Link");
    btn.dataset.action = `submit-${kind}`;
    const err = this.el("p", "form-error", "");
    err.id = `${kind}-error`;
    err.hidden = true;
    d.appendChild(input);
    d.appendChild(btn);
    d.appendChild(err);
    return d;
  },

  /** First-run screen: hero + one card per store + trust note. */
  renderOnboarding(state) {
    const wrap = this.el("section", "onboarding");
    wrap.appendChild(this.el("h1", "hero-title", "What is your library actually worth?"));
    wrap.appendChild(this.el("p", "hero-sub",
      "Link a store. We price every game you own at today's cheapest price and show what each hour of play has cost you — including the ones you never opened."));

    const cards = this.el("div", "platform-cards");
    for (const p of PLATFORMS) {
      const card = this.el("article", "platform-card");
      card.dataset.platform = p.key;

      const head = this.el("div", "pc-head");
      head.appendChild(this.el("span", `dot ${p.key}`));
      head.appendChild(this.el("h2", null, p.name));
      card.appendChild(head);
      card.appendChild(this.el("p", "pc-blurb", p.blurb));

      const linked = Boolean(state.accounts && state.accounts[p.key]);
      if (linked) card.appendChild(this.el("p", "pc-status linked", "✓ Linked"));

      const cta = this.el("button", "button primary", linked ? "Relink" : p.cta);
      cta.dataset.action = "link";
      cta.dataset.platform = p.key;
      card.appendChild(cta);

      if (p.key === "gog") {
        card.appendChild(this.el("p", "pc-hint",
          "After signing in, GOG lands you on embed.gog.com — copy that page's full URL and paste it below."));
        card.appendChild(this.pasteBlock("gog", "Paste the redirect URL",
          "https://embed.gog.com/on_login_success?origin=client&code=…"));
      }
      if (p.key === "epic") {
        card.appendChild(this.el("p", "pc-hint",
          "Epic only allows its own redirect. Log in, then copy the whole JSON page it lands on and paste it below."));
        card.appendChild(this.pasteBlock("epic", "Paste the JSON page", "authorizationCode or the whole JSON blob"));
      }
      if (p.key === "amazon") {
        card.appendChild(this.el("p", "pc-hint",
          "Sign in on Amazon's own page, then copy the amazon.com URL you land on and paste it below."));
        card.appendChild(this.pasteBlock("amazon", "Paste the redirect URL",
          "https://www.amazon.com/?openid.oa2.authorization_code=…"));
      }
      cards.appendChild(card);
    }
    wrap.appendChild(cards);

    // Bring-your-own-API-keys card: each user can supply their own
    // IsThereAnyDeal / Steam keys so they use their own rate-limit quota
    // instead of the shared server key (matters when self-hosted for a group).
    const keysCard = this.el("article", "platform-card api-keys");
    const kh = this.el("div", "pc-head");
    kh.appendChild(this.el("h2", null, "Your API keys"));
    keysCard.appendChild(kh);
    keysCard.appendChild(this.el("p", "pc-blurb",
      "Optional. Bring your own keys to use your own rate-limit quota instead of the shared server key. Stored only in this browser and sent only with your own requests."));
    keysCard.appendChild(this.keyField("itad", "IsThereAnyDeal API key", "used for game pricing"));
    keysCard.appendChild(this.keyField("steam", "Steam Web API key", "optional — Steam library"));
    keysCard.appendChild(this.keyField("sgdb", "SteamGridDB API key", "optional — cover art in grid view"));
    const cwrap = this.el("div", "currency-field");
    cwrap.appendChild(this.el("label", null, "Display currency"));
    cwrap.appendChild(this.buildCurrencySelect(state.currency));
    keysCard.appendChild(cwrap);
    wrap.appendChild(keysCard);

    if (Object.values(state.accounts || {}).some(Boolean)) {
      const back = this.el("button", "button ghost small", "← Back to dashboard");
      back.dataset.action = "back";
      wrap.appendChild(back);
    }
    wrap.appendChild(this.el("p", "trust-note",
      "Tokens stay in this browser's localStorage. Only game IDs are sent to this server for pricing — nothing about you is stored."));
    return wrap;
  },

  /** Results frame: KPI row, table + sidebar. */
  buildReady() {
    const wrap = this.el("section", "ready");

    const kpi = this.el("div", "kpi-row");
    let ringSvg = null;
    [
      ["kpi-library", "Library value", "est. re-buy cost"],
      ["kpi-high", "Highest ever value", "all-time high"],
      ["kpi-low", "Lowest ever value", "all-time low"],
      ["kpi-backlog", "Backlog value", "unplayed (<1 hr)"],
      ["kpi-regret", "Regret score", "of known value"],
      ["kpi-vph", "₹ / hour", "played games only"],
      ["kpi-hours", "Total hours", "on record"],
    ].forEach(([id, label, sub]) => {
      const card = this.el("article", "kpi-card");
      const lab = this.el("p", "kpi-label",
        id === "kpi-vph" ? `${symbol(this.currency)} / hour` : label);
      lab.id = `${id}-label`;
      card.appendChild(lab);
      card.appendChild(this.el("p", "kpi-sub", sub));
      const v = this.el("p", "kpi-value", "—");
      v.id = id;
      if (id === "kpi-regret") {
        // The gauge and its number share this one card — the sidebar used to
        // show the same figure again as a separate ring card.
        ringSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        ringSvg.setAttribute("class", "kpi-ring");
        ringSvg.setAttribute("viewBox", "0 0 80 80");
        const gauge = this.el("div", "kpi-gauge");
        gauge.appendChild(ringSvg);
        gauge.appendChild(v);
        card.appendChild(gauge);
      } else {
        card.appendChild(v);
      }
      kpi.appendChild(card);
    });
    wrap.appendChild(kpi);

    const bodyEl = this.el("div", "dashboard-body");
    const panel = this.el("section", "panel");

    const filterBar = this.el("div", "filter-bar");
    const tabs = [];
    for (const f of ["All", "Unplayed", "Played", "No data"]) {
      const b = this.el("button", `tab${f === "All" ? " active" : ""}`, f);
      b.dataset.action = "filter";
      b.dataset.filter = f;
      tabs.push(b);
      filterBar.appendChild(b);
    }
    const search = this.el("input", "search");
    search.type = "search";
    search.placeholder = "Search games…";
    search.dataset.action = "search";
    const sort = this.el("select", "sort");
    sort.dataset.action = "sort";
    [["price-desc", "price ↓"], ["price-asc", "price ↑"], ["name-asc", "name ↑"], ["hours-desc", "hours ↓"]]
      .forEach(([value, label]) => {
        const o = this.el("option", null, label);
        o.value = value;
        sort.appendChild(o);
      });
    filterBar.appendChild(search);
    filterBar.appendChild(sort);
    const currencySelect = this.buildCurrencySelect(this.currency);
    filterBar.appendChild(currencySelect);
    const platformSelect = this.buildPlatformSelect();
    filterBar.appendChild(platformSelect);
    const viewToggle = this.el("div", "view-toggle");
    [["list", "List"], ["grid", "Grid"]].forEach(([mode, label]) => {
      const b = this.el("button", `view-btn${mode === "list" ? " active" : ""}`, label);
      b.dataset.action = "view";
      b.dataset.view = mode;
      viewToggle.appendChild(b);
    });
    filterBar.appendChild(viewToggle);
    panel.appendChild(filterBar);

    const tableWrap = this.el("div", "table-wrap");
    const table = this.el("table");
    const thead = this.el("thead");
    const hrow = this.el("tr");
    const headerCells = ["Game", "Platform", "Price", "Hours", `${symbol(this.currency)} / hour`]
      .map((h) => { const th = this.el("th", null, h); hrow.appendChild(th); return th; });
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = this.el("tbody");
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const gridWrap = this.el("div", "grid-wrap");
    gridWrap.hidden = true;
    panel.appendChild(gridWrap);

    const empty = this.el("p", "empty-state",
      "Nothing scanned yet — hit “Scan library” to pull your games and today's prices.");
    panel.appendChild(empty);

    const coverage = this.el("p", "coverage");
    panel.appendChild(coverage);

    const sidebar = this.el("aside", "sidebar");
    const platCard = this.el("div", "chart-card");
    platCard.appendChild(this.el("h3", null, "Value by platform"));
    const platformList = this.el("div", "platform-list");
    platCard.appendChild(platformList);
    sidebar.appendChild(platCard);

    bodyEl.appendChild(panel);
    bodyEl.appendChild(sidebar);
    wrap.appendChild(bodyEl);

    return { wrap, kpi, tabs, tbody, tableWrap, gridWrap, viewToggle, empty, coverage, ringSvg, platformList, filterBar, search, sort, currencySelect, platformSelect, headerCells };
  },

  /** Called on every state change. Rebuilds the phase only when it changes. */
  render(state) {
    this.currency = state.currency || "INR";
    this.renderSources(state);
    const showChrome = state.phase !== "onboarding";
    this.sources.hidden = !showChrome;
    this.scanBtn.hidden = !showChrome;

    if (state.phase === "onboarding") {
      if (this._builtPhase !== "onboarding") {
        this.phaseEl.textContent = "";
        this.phaseEl.appendChild(this.renderOnboarding(state));
        this._builtPhase = "onboarding";
      }
      return;
    }

    if (this._builtPhase !== "ready") {
      this.phaseEl.textContent = "";
      const r = this.buildReady();
      Object.assign(this, {
        kpi: r.kpi, tabs: r.tabs, tbody: r.tbody, tableWrap: r.tableWrap,
        gridWrap: r.gridWrap, viewToggle: r.viewToggle,
        emptyState: r.empty, coverage: r.coverage, ringSvg: r.ringSvg,
        platformList: r.platformList, filterBar: r.filterBar, search: r.search, sort: r.sort,
        currencySelect: r.currencySelect, platformSelect: r.platformSelect, headerCells: r.headerCells,
      });
      this.phaseEl.appendChild(r.wrap);
      this._builtPhase = "ready";
    }
    this.updateReady(state);
  },

  updateReady(state) {
    const { rows, scanning, metrics } = state;
    this.renderKpis(this.kpi, metrics);
    this.renderRegretRing(this.ringSvg, metrics.regretScore);
    this.renderPlatforms(this.platformList, state.games, state.prices, state.platform);
    const gridMode = state.viewMode === "grid";
    if (gridMode) this.renderGrid(this.gridWrap, rows, state.prices, scanning);
    else this.renderTable(this.tbody, rows, state.prices, scanning);

    const nothing = !scanning && rows.length === 0;
    this.tableWrap.hidden = gridMode || nothing;
    if (this.gridWrap) this.gridWrap.hidden = !gridMode || nothing;
    if (this.viewToggle) {
      for (const b of this.viewToggle.children) {
        b.classList.toggle("active", b.dataset.view === (state.viewMode || "list"));
      }
    }
    this.emptyState.hidden = scanning || rows.length > 0;
    this.coverage.textContent = state.coverageText;
    this.phaseEl.classList.toggle("is-scanning", Boolean(scanning));
    this.phaseEl.setAttribute("aria-busy", scanning ? "true" : "false");

    if (this.tabs) {
      for (const b of this.tabs) b.classList.toggle("active", b.dataset.filter === state.filter);
    }
    if (this.sort) this.sort.value = state.sort;
    if (this.currencySelect) this.currencySelect.value = this.currency;
    if (this.headerCells && this.headerCells[4]) this.headerCells[4].textContent = `${symbol(this.currency)} / hour`;
    if (this.platformSelect) {
      const plats = [...new Set((state.games || []).map((g) => g.platform))].sort();
      const sig = plats.join("\u0000");
      if (this.platformSelect.dataset.sig !== sig) {
        this.platformSelect.textContent = "";
        for (const value of ["All", ...plats]) {
          const opt = this.el("option", null, value === "All" ? "All platforms" : value);
          opt.value = value;
          this.platformSelect.appendChild(opt);
        }
        this.platformSelect.dataset.sig = sig;
      }
      this.platformSelect.value = state.platform || "All";
    }
  },

  renderError(err) {
    const box = this.el("div", "error-box");
    box.appendChild(this.el("strong", null, "Something went wrong."));
    box.appendChild(this.el("p", null, String(err && err.message ? err.message : err)));
    return box;
  },


  renderKpis(container, metrics) {
    if (!container) return;
    const cur = this.currency;
    const fmt = (id, val) => {
      const el = container.querySelector(`#${id}`);
      if (el) el.textContent = val;
    };
    fmt("kpi-library", money(metrics.libraryValue, cur));
    fmt("kpi-high", money(metrics.highestEver ?? 0, cur));
    fmt("kpi-low", money(metrics.lowestEver ?? 0, cur));
    fmt("kpi-backlog", money(metrics.backlogValue, cur));
    fmt("kpi-regret", metrics.regretScore == null ? "—" : `${(metrics.regretScore * 100).toFixed(1)} %`);
    fmt("kpi-vph", metrics.valuePerHour == null ? "—" : perHour(metrics.valuePerHour, cur));
    fmt("kpi-hours", hours(metrics.totalHours ?? 0));
    const vlab = container.querySelector("#kpi-vph-label");
    if (vlab) vlab.textContent = `${symbol(cur)} / hour`;
  },

  renderTable(tbody, rows, prices, skeleton = false) {
    if (!tbody) return;
    tbody.textContent = "";

    if (skeleton) {
      for (let i = 0; i < 6; i += 1) {
        const tr = this.el("tr", "skeleton-row");
        for (let c = 0; c < 5; c += 1) {
          const td = this.el("td");
          td.appendChild(this.el("span", "skeleton"));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      return;
    }

    for (const game of rows) {
      const price = prices[game.id];
      const tr = this.el("tr", "game-row");
      tr.dataset.action = "open";
      tr.dataset.id = game.id;
      if (game.hours != null && game.hours < 1) tr.classList.add("unplayed");

      const rate = pricePerHour(price, game.hours);
      const cells = [
        game.name,
        game.platform,
        typeof price === "number" ? money(price, this.currency) : "—",
        game.hours == null ? "unknown" : hours(game.hours),
        rate == null ? "—" : perHour(rate, this.currency),
      ];
      cells.forEach((text, i) => {
        tr.appendChild(this.el("td", i === 0 ? "cell-name" : null, text));
      });
      tbody.appendChild(tr);
    }
  },

  /** Grid of cover cards — the alternative to the table. Placeholders until a
   *  SteamGridDB key resolves art (the loader fills .cover-img in app.js). */
  renderGrid(wrap, rows, prices, skeleton = false) {
    if (!wrap) return;
    wrap.textContent = "";
    if (skeleton) {
      for (let i = 0; i < 8; i += 1) wrap.appendChild(this.el("div", "game-card is-skeleton"));
      return;
    }
    const hasKey = typeof localStorage !== "undefined" && !!localStorage.getItem("sgdb_api_key");
    for (const game of rows) {
      const price = prices[game.id];
      const card = this.el("article", "game-card");
      card.dataset.action = "open";
      card.dataset.id = game.id;

      const art = this.el("div", "cover");
      const img = this.el("img", "cover-img");
      img.alt = "";
      img.dataset.coverId = game.id;
      art.appendChild(img);
      card.appendChild(art);

      const meta = this.el("div", "card-meta");
      meta.appendChild(this.el("p", "card-title", game.name));
      meta.appendChild(this.el("p", "card-sub",
        `${game.platform} · ${typeof price === "number" ? money(price, this.currency) : "—"}`));
      card.appendChild(meta);

      if (game.hours != null && game.hours < 1) card.classList.add("unplayed");
      wrap.appendChild(card);
    }
    if (!hasKey) {
      wrap.appendChild(this.el("p", "muted grid-hint",
        "Add a SteamGridDB API key under API keys to load cover art."));
    }
  },

  renderDrawer(drawerBody, game, price) {
    if (!drawerBody) return;
    drawerBody.textContent = "";
    drawerBody.appendChild(this.el("h3", null, game.name));
    drawerBody.appendChild(this.el("p", "muted", game.platform));

    const priceRow = this.el("div", "drawer-row");
    priceRow.appendChild(this.el("span", null, "Current price"));
    priceRow.appendChild(this.el("strong", null, typeof price === "number" ? money(price, this.currency) : "—"));
    drawerBody.appendChild(priceRow);

    const hoursRow = this.el("div", "drawer-row");
    hoursRow.appendChild(this.el("span", null, "Playtime"));
    hoursRow.appendChild(this.el("strong", null, game.hours == null ? "unknown" : hours(game.hours)));
    drawerBody.appendChild(hoursRow);

    const vphRow = this.el("div", "drawer-row");
    vphRow.appendChild(this.el("span", null, `${symbol(this.currency)} / hour`));
    vphRow.appendChild(this.el("strong", null,
      perHour(pricePerHour(price, game.hours), this.currency)));
    drawerBody.appendChild(vphRow);
  },


  renderRegretRing(svg, score) {
    if (!svg) return;
    svg.textContent = "";
    const cx = 40, cy = 40, r = 30;
    const circumference = 2 * Math.PI * r;
    const pct = score == null ? 0 : Math.min(1, Math.max(0, score));

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bg.setAttribute("cx", cx); bg.setAttribute("cy", cy); bg.setAttribute("r", r);
    bg.setAttribute("fill", "none"); bg.setAttribute("stroke", "var(--border)"); bg.setAttribute("stroke-width", "8");
    svg.appendChild(bg);

    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", cx); ring.setAttribute("cy", cy); ring.setAttribute("r", r);
    ring.setAttribute("fill", "none"); ring.setAttribute("stroke", "var(--accent)");
    ring.setAttribute("stroke-width", "8");
    ring.setAttribute("stroke-dasharray", String(circumference));
    ring.setAttribute("stroke-dashoffset", String(circumference * (1 - pct)));
    ring.setAttribute("stroke-linecap", "round");
    ring.setAttribute("transform", "rotate(-90 40 40)");
    svg.appendChild(ring);
    // No centre label: the precise score sits right beside the gauge in the
    // KPI card, so repeating a rounded version here would be the duplicate
    // we just removed.
  },

  renderPlatforms(listEl, games, prices, active) {
    if (!listEl) return;
    listEl.textContent = "";
    const byPlatform = {};
    for (const g of games) {
      const p = byPlatform[g.platform] || { value: 0, count: 0 };
      const price = prices[g.id];
      if (typeof price === "number") { p.value += price; p.count += 1; }
      byPlatform[g.platform] = p;
    }
    const entries = Object.entries(byPlatform).sort((a, b) => b[1].value - a[1].value);
    if (entries.length === 0) {
      listEl.appendChild(this.el("p", "muted", "No priced games yet."));
      return;
    }
    const total = entries.reduce((s, [, p]) => s + p.value, 0);
    const colorFor = (i) => `var(--pie-${(i % 8) + 1})`;

    // Pie: one slice per platform, coloured from the --pie-* palette.
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "platform-pie");
    svg.setAttribute("viewBox", "0 0 80 80");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Value by platform");
    const cx = 40, cy = 40, r = 36;
    let a0 = -Math.PI / 2;   // start at 12 o'clock
    entries.forEach(([platform, data], i) => {
      const frac = total ? data.value / total : 0;
      const a1 = a0 + frac * 2 * Math.PI;
      const fill = colorFor(i);
      const pct = total ? Math.round((data.value / total) * 100) : 0;
      let slice = null;
      if (frac >= 0.9999) {                       // single platform = full circle
        slice = document.createElementNS(NS, "circle");
        slice.setAttribute("cx", cx); slice.setAttribute("cy", cy); slice.setAttribute("r", r);
        slice.setAttribute("fill", fill);
      } else if (frac > 0) {
        slice = document.createElementNS(NS, "path");
        slice.setAttribute("d", pieSlice(cx, cy, r, a0, a1));
        slice.setAttribute("fill", fill);
        slice.setAttribute("stroke", "var(--surface)");   // separate slices
        slice.setAttribute("stroke-width", "1");
      }
      if (slice) {
        const title = document.createElementNS(NS, "title");   // native hover tooltip
        title.textContent = `${platform} — ${money(data.value, this.currency)} (${pct}%)`;
        slice.appendChild(title);
        slice.dataset.action = "filter-platform";             // click to filter the table
        slice.dataset.platform = platform;
        if (platform === active) slice.classList.add("is-active");
        svg.appendChild(slice);
      }
      a0 = a1;
    });
    listEl.appendChild(svg);

    // Legend: colour swatch, platform, value.
    const legend = this.el("div", "platform-legend");
    entries.forEach(([platform, data], i) => {
      const row = this.el("div", "platform-row");
      row.dataset.action = "filter-platform";
      row.dataset.platform = platform;
      if (platform === active) row.classList.add("is-active");
      const swatch = this.el("span", "platform-swatch");
      swatch.style.background = colorFor(i);
      row.appendChild(swatch);
      row.appendChild(this.el("span", "platform-name", platform));
      row.appendChild(this.el("span", "platform-value", money(data.value, this.currency)));
      legend.appendChild(row);
    });
    listEl.appendChild(legend);
  },
};

