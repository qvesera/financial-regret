/** DOM builders. textContent only — never innerHTML with user data. */
import { money, symbol, hours, perHour, CURRENCIES } from "./format.js";

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
];

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

  /** Results frame: KPI row, basis toggle, table + sidebar. */
  buildReady() {
    const wrap = this.el("section", "ready");

    const kpi = this.el("div", "kpi-row");
    [
      ["kpi-library", "Library value", "est. re-buy cost"],
      ["kpi-backlog", "Backlog value", "unplayed (<1 hr)"],
      ["kpi-regret", "Regret score", "of known value"],
      ["kpi-vph", "₹ / hour", "played games only"],
    ].forEach(([id, label, sub]) => {
      const card = this.el("article", "kpi-card");
      const lab = this.el("p", "kpi-label",
        id === "kpi-vph" ? `${symbol(this.currency)} / hour` : label);
      lab.id = `${id}-label`;
      card.appendChild(lab);
      card.appendChild(this.el("p", "kpi-sub", sub));
      const v = this.el("p", "kpi-value", "—");
      v.id = id;
      card.appendChild(v);
      kpi.appendChild(card);
    });
    wrap.appendChild(kpi);

    const basis = this.el("div", "basis-toggle");
    [["price", "Current price"], ["paid", "What I paid"]].forEach(([mode, label], i) => {
      const b = this.el("button", i === 0 ? "basis-btn active" : "basis-btn", label);
      b.dataset.action = "basis";
      b.dataset.basis = mode;
      basis.appendChild(b);
    });
    wrap.appendChild(basis);

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

    const empty = this.el("p", "empty-state",
      "Nothing scanned yet — hit “Scan library” to pull your games and today's prices.");
    panel.appendChild(empty);

    const coverage = this.el("p", "coverage");
    panel.appendChild(coverage);

    const sidebar = this.el("aside", "sidebar");
    const ringCard = this.el("div", "chart-card");
    ringCard.appendChild(this.el("h3", null, "Regret"));
    const ringSvg = this.el("svg", "regret-ring");
    ringSvg.setAttribute("viewBox", "0 0 80 80");
    ringCard.appendChild(ringSvg);
    sidebar.appendChild(ringCard);

    const platCard = this.el("div", "chart-card");
    platCard.appendChild(this.el("h3", null, "Value by platform"));
    const platformList = this.el("div", "platform-list");
    platCard.appendChild(platformList);
    sidebar.appendChild(platCard);

    bodyEl.appendChild(panel);
    bodyEl.appendChild(sidebar);
    wrap.appendChild(bodyEl);

    return { wrap, kpi, basis, tabs, tbody, tableWrap, empty, coverage, ringSvg, platformList, filterBar, search, sort, currencySelect, headerCells };
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
        kpi: r.kpi, basisToggle: r.basis, tabs: r.tabs, tbody: r.tbody, tableWrap: r.tableWrap,
        emptyState: r.empty, coverage: r.coverage, ringSvg: r.ringSvg,
        platformList: r.platformList, filterBar: r.filterBar, search: r.search, sort: r.sort,
        currencySelect: r.currencySelect, headerCells: r.headerCells,
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
    this.renderPlatforms(this.platformList, rows, state.prices, state.counts);
    this.renderTable(this.tbody, rows, state.prices, scanning);

    this.tableWrap.hidden = !scanning && rows.length === 0;
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
    if (this.basisToggle) {
      for (const b of this.basisToggle.children) b.classList.toggle("active", b.dataset.basis === state.basis);
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
    fmt("kpi-backlog", money(metrics.backlogValue, cur));
    fmt("kpi-regret", metrics.regretScore == null ? "—" : `${(metrics.regretScore * 100).toFixed(1)} %`);
    fmt("kpi-vph", metrics.valuePerHour == null ? "—" : perHour(metrics.valuePerHour, cur));
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

      const rate = game.hours && price != null ? price / game.hours : null;
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

  renderDrawer(drawerBody, game, price, paid, onPaidChange) {
    if (!drawerBody) return;
    drawerBody.textContent = "";
    drawerBody.appendChild(this.el("h3", null, game.name));
    drawerBody.appendChild(this.el("p", "muted", game.platform));

    const priceRow = this.el("div", "drawer-row");
    priceRow.appendChild(this.el("span", null, "Current price"));
    priceRow.appendChild(this.el("strong", null, typeof price === "number" ? money(price, this.currency) : "—"));
    drawerBody.appendChild(priceRow);

    const paidRow = this.el("div", "drawer-row");
    paidRow.appendChild(this.el("span", null, `I paid ${symbol(this.currency)}`));
    const paidInput = this.el("input", "paid-input");
    paidInput.type = "number";
    paidInput.min = "0";
    paidInput.placeholder = "optional";
    paidInput.dataset.id = game.id;
    if (paid != null) paidInput.value = paid;
    paidInput.addEventListener("change", (e) => {
      const v = e.target.value.trim();
      onPaidChange(game.id, v ? Number(v) : null);
    });
    paidRow.appendChild(paidInput);
    drawerBody.appendChild(paidRow);

    const hoursRow = this.el("div", "drawer-row");
    hoursRow.appendChild(this.el("span", null, "Playtime"));
    hoursRow.appendChild(this.el("strong", null, game.hours == null ? "unknown" : hours(game.hours)));
    drawerBody.appendChild(hoursRow);

    const vphRow = this.el("div", "drawer-row");
    vphRow.appendChild(this.el("span", null, `${symbol(this.currency)} / hour`));
    const cost = paid != null ? paid : price;
    vphRow.appendChild(this.el("strong", null,
      game.hours && cost != null ? perHour(cost / game.hours, this.currency) : "—"));
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

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", cx); text.setAttribute("y", cy + 5);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "15");
    text.setAttribute("font-weight", "700");
    text.setAttribute("fill", score == null ? "var(--muted)" : "var(--text)");
    text.textContent = score == null ? "—" : `${Math.round(pct * 100)}%`;
    svg.appendChild(text);
  },

  renderPlatforms(listEl, rows, prices) {
    if (!listEl) return;
    listEl.textContent = "";
    const byPlatform = {};
    for (const g of rows) {
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
    for (const [platform, data] of entries) {
      const row = this.el("div", "platform-row");
      row.appendChild(this.el("span", null, platform));
      const barWrap = this.el("span", "platform-bar-wrap");
      const bar = this.el("span", "platform-bar");
      bar.style.width = total ? `${(data.value / total) * 100}%` : "0%";
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      row.appendChild(this.el("span", "platform-value", money(data.value, this.currency)));
      listEl.appendChild(row);
    }
  },
};

