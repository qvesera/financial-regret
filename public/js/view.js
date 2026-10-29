/** DOM builders. textContent only — never innerHTML with user data. */
import { money, symbol, hours, perHour, pricePerHour, CURRENCIES } from "./format.js";
import { TIER_LABEL, coverHue, headline as buildHeadline, whatIf } from "./verdict.js";
import { renderVerdictToy } from "./arcade.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Games per page in the table/grid. Big enough that small libraries never
 *  see a pager, small enough that a filter keystroke re-renders 24 nodes
 *  instead of 892. */
export const PAGE_SIZE = 24;

/** Windowed page numbers: first, last, and the neighbours of the current
 *  page, with "…" where a run is skipped. 38 pages at page 14 reads
 *  [1, "…", 13, 14, 15, "…", 38] — jump targets without a 38-button strip.
 * Seven pages or fewer are all shown outright. */
export function pageWindow(cur, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = [1];
  const lo = Math.max(2, cur - 1);
  const hi = Math.min(pages - 1, cur + 1);
  if (lo > 2) out.push("…");
  for (let p = lo; p <= hi; p += 1) out.push(p);
  if (hi < pages - 1) out.push("…");
  out.push(pages);
  return out;
}

/** Inline SVG icons. No icon font (the CSP allows no external font host) and
 *  no emoji standing in for a control; stroke:currentColor follows the theme. */
const ICON_PATHS = {
  close: "M6 6l12 12M18 6 6 18",
  dots: "M12 5h.01M12 12h.01M12 19h.01",
  list: "M4 6h16M4 12h16M4 18h16",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  check: "M5 13l4 4L19 7",
  alert: "M12 4 2 20h20L12 4ZM12 10v5M12 18h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2",
};

function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICON_PATHS[name] || ICON_PATHS.dots);
  svg.appendChild(path);
  return svg;
}

/** Verdict pill. Colour comes from the tier class, never an inline style, so
 *  the light theme can override every one of them in CSS. */
function tierBadge(tier) {
  const t = tier || "nodata";
  const b = document.createElement("span");
  b.className = `badge badge-${t}`;
  b.setAttribute("data-tier", t);
  b.textContent = TIER_LABEL[t] || t;
  return b;
}

/** Plain-language explanation of what a tier actually means — the drawer is
 *  where the maths gets said out loud. */
function tierNote(tier) {
  if (tier === "worth") return "Cheaper per hour than your library's first quartile.";
  if (tier === "fair") return "In line with what you usually pay per hour.";
  if (tier === "regret") return "Above your library's median cost per hour.";
  if (tier === "untouched") return "Bought but never really played.";
  if (tier === "unknown") return "Not enough priced games yet to place this one.";
  return "No price recorded, so there is nothing to judge.";
}

/** Is the table narrower than the library? Distinguishes "your filters hid
 *  everything" from "you have no qualifying games yet" — two very different
 *  things to say to someone looking at an empty hall of shame. */
function filtersActive(state) {
  if (!state) return false;
  return Boolean(
    (state.tier && state.tier !== "All") ||
    (state.filter && state.filter !== "All") ||
    (state.platform && state.platform !== "All") ||
    (state.search || "").trim()
  );
}

/** Explanations for every number on the dashboard.
 *
 *  Written from computeRegret() and comparators() rather than from the labels
 *  on screen: several labels are deliberately terse ("of known value", "on
 *  record") and two of them are looser than the maths. Keyed by element id so a
 *  tip cannot exist without its copy — infoTip() returns nothing otherwise. */
const METRIC_TIPS = {
  // Attached to the .micro label, not to #hero-spend: that element's
  // textContent is pinned by tests and must stay a bare figure.
  "hero-spend": "Your whole library repriced at today's cheapest price for each "
    + "game — what buying it all again would cost right now. It is not what you "
    + "paid: no connected store reports purchase history.",
  "hero-line": "The percentage is how much of your library you've actually "
    + "touched. 'Worst buy' is the most expensive hour in it: highest price per "
    + "hour among games with at least an hour of play.",
  "kpi-library": "Today's cheapest price for every game, added up. Games with "
    + "no price found count as zero, so a library of unpriced titles reads low.",
  "kpi-high": "The same library priced at each game's all-time high. Where "
    + "there is no price history, today's price stands in rather than leaving a gap.",
  "kpi-low": "The same library priced at each game's all-time low — the "
    + "cheapest these games have ever been. Falls back to today's price when "
    + "history is missing.",
  "kpi-backlog": "Today's cheapest price of the games you own but have played "
    + "for under an hour. Only games with known playtime count, so unknown-hours "
    + "titles are left out.",
  "kpi-regret": "Backlog value ÷ the value of games whose playtime you know — "
    + "the share of your known money sitting in games you have barely touched. "
    + "Games with unknown playtime are excluded from both halves.",
  "kpi-vph": "The price of everything you've actually played, divided by your "
    + "recorded hours across those games. A game you've never opened adds "
    + "neither cost nor time.",
  "kpi-hours": "Every hour the connected stores have recorded, summed. Titles "
    + "with unknown playtime add nothing — they are never counted as zero-played.",
  "rank-worst": "Your most expensive hour, ranked by price ÷ hours, highest "
    + "first. Only games with an hour or more of play qualify: a ten-minute "
    + "session proves nothing.",
  "rank-best": "The same ranking cheapest per hour first — the most play for "
    + "the least money. Games need an hour or more of play to qualify.",
};

/** Two-letter placeholder for a cover that has no art (yet). */
function coverInitials(name) {
  const parts = String(name || "?").split(/[\s:]+/).filter(Boolean);
  const first = (parts[0] || "?")[0];
  const second = parts[1] ? parts[1][0] : (parts[0] || "?")[1] || "";
  return (first + second).toUpperCase();
}


const PLATFORMS = [
  {
    key: "steam",
    name: "Steam",
    platform: "Steam",
    blurb: "Playtime and current replacement price. Best data of the four.",
    cta: "Connect Steam",
    steps: [
      "Click Connect — you'll approve access on steamcommunity.com, then land right back here.",
      "We pull your playtime and price every game at today's cheapest price.",
    ],
  },
  {
    key: "gog",
    name: "GOG",
    platform: "GOG",
    blurb: "Owned games via one-click sign-in.",
    cta: "Connect GOG",
    steps: [
      "Click Connect and sign in on GOG's own page.",
      "Copy the full URL of the page you land on (embed.gog.com/…).",
      "Paste it below — we never see your password.",
    ],
  },
  {
    key: "epic",
    name: "Epic Games",
    platform: "Epic",
    blurb: "Owned games. Epic allows no custom redirect, so it takes one extra step.",
    cta: "Connect Epic",
    steps: [
      "Click Connect and sign in on Epic's own page.",
      "Copy the full JSON of the page you land on.",
      "Paste it below — the code is inside.",
    ],
  },
  {
    key: "amazon",
    name: "Amazon Luna",
    platform: "Amazon",
    blurb: "Owned Amazon Games titles from your Prime/Luna library.",
    cta: "Connect Amazon Luna",
    steps: [
      "Click Connect and sign in on Amazon's own page.",
      "Copy the full URL you land on (amazon.com/…).",
      "Paste it below. Amazon exposes no playtime, so these games are priced but left out of per-hour ratios.",
    ],
  },
  // Scaffolded, not linkable: shown so the roadmap is visible and the gap is
  // explained, but renderSources skips them and onboarding offers no button.
  {
    key: "xbox",
    name: "Xbox",
    platform: "Xbox",
    planned: true,
    blurb: "Owned games via Microsoft's official API.",
    why: "Official and durable — but Microsoft's API exposes last-played, not hours played. Xbox titles would price where IsThereAnyDeal covers the Microsoft Store and land in “Unknown hours” otherwise, priced-only like Amazon. Needs a one-time Azure app registration (a client ID) to build.",
  },
  {
    key: "psn",
    name: "PlayStation",
    platform: "PlayStation",
    blurb: "Played titles, with real playtime. Sony has no official API, so this uses the community flow; prices come from PlatPrices when a key is set.",
    cta: "Connect PlayStation",
    steps: [
      "Click Connect and sign in on PlayStation's own page. Sony offers no approval screen — the signed-in session is what earns us the next step.",
      "Still signed in? Open the NPSSO page (link below). It shows one line of JSON, not a website — copy the 64-character npsso value.",
      "Paste it below straight away; it expires fast. We trade it for a long-lived refresh token and never store the NPSSO itself.",
      "Sony exposes only played titles, so these arrive with real hours. Prices come from PlatPrices when a key is configured; without one they still count toward time, only spend stays blank.",
    ],
  },
];


/** Store glyphs as single-path filled SVGs, inlined from simple-icons (CC0).
 *  A stroke icon can't draw a brand mark, so these render filled with
 *  currentColor and inherit whatever colour their context is wearing. */
const BRAND_PATHS = {
  steam: "M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z",
  gog: "M7.15 15.24H4.36a.4.4 0 0 0-.4.4v2c0 .21.18.4.4.4h2.8v1.32h-3.5c-.56 0-1.02-.46-1.02-1.03v-3.39c0-.56.46-1.02 1.03-1.02h3.48v1.32zM8.16 11.54c0 .58-.47 1.05-1.05 1.05H2.63v-1.35h3.78a.4.4 0 0 0 .4-.4V6.39a.4.4 0 0 0-.4-.4H4.39a.4.4 0 0 0-.41.4v2.02c0 .23.18.4.4.4H6v1.35H3.68c-.58 0-1.05-.46-1.05-1.04V5.68c0-.57.47-1.04 1.05-1.04H7.1c.58 0 1.05.47 1.05 1.04v5.86zM21.36 19.36h-1.32v-4.12h-.93a.4.4 0 0 0-.4.4v3.72h-1.33v-4.12h-.93a.4.4 0 0 0-.4.4v3.72h-1.33v-4.42c0-.56.46-1.02 1.03-1.02h5.61v5.44zM21.37 11.54c0 .58-.47 1.05-1.05 1.05h-4.48v-1.35h3.78a.4.4 0 0 0 .4-.4V6.39a.4.4 0 0 0-.4-.4h-2.03a.4.4 0 0 0-.4.4v2.02c0 .23.18.4.4.4h1.62v1.35H16.9c-.58 0-1.05-.46-1.05-1.04V5.68c0-.57.47-1.04 1.05-1.04h3.43c.58 0 1.05.47 1.05 1.04v5.86zM13.72 4.64h-3.44c-.58 0-1.04.47-1.04 1.04v3.44c0 .58.46 1.04 1.04 1.04h3.44c.57 0 1.04-.46 1.04-1.04V5.68c0-.57-.47-1.04-1.04-1.04m-.3 1.75v2.02a.4.4 0 0 1-.4.4h-2.03a.4.4 0 0 1-.4-.4V6.4c0-.22.17-.4.4-.4H13c.23 0 .4.18.4.4zM12.63 13.92H9.24c-.57 0-1.03.46-1.03 1.02v3.39c0 .57.46 1.03 1.03 1.03h3.39c.57 0 1.03-.46 1.03-1.03v-3.39c0-.56-.46-1.02-1.03-1.02m-.3 1.72v2a.4.4 0 0 1-.4.4v-.01H9.94a.4.4 0 0 1-.4-.4v-1.99c0-.22.18-.4.4-.4h2c.22 0 .4.18.4.4zM23.49 1.1a1.74 1.74 0 0 0-1.24-.52H1.75A1.74 1.74 0 0 0 0 2.33v19.34a1.74 1.74 0 0 0 1.75 1.75h20.5A1.74 1.74 0 0 0 24 21.67V2.33c0-.48-.2-.92-.51-1.24m0 20.58a1.23 1.23 0 0 1-1.24 1.24H1.75A1.23 1.23 0 0 1 .5 21.67V2.33a1.23 1.23 0 0 1 1.24-1.24h20.5a1.24 1.24 0 0 1 1.24 1.24v19.34z",
  epic: "M3.537 0C2.165 0 1.66.506 1.66 1.879V18.44a4.262 4.262 0 00.02.433c.031.3.037.59.316.92.027.033.311.245.311.245.153.075.258.13.43.2l8.335 3.491c.433.199.614.276.928.27h.002c.314.006.495-.071.928-.27l8.335-3.492c.172-.07.277-.124.43-.2 0 0 .284-.211.311-.243.28-.33.285-.621.316-.92a4.261 4.261 0 00.02-.434V1.879c0-1.373-.506-1.88-1.878-1.88zm13.366 3.11h.68c1.138 0 1.688.553 1.688 1.696v1.88h-1.374v-1.8c0-.369-.17-.54-.523-.54h-.235c-.367 0-.537.17-.537.539v5.81c0 .369.17.54.537.54h.262c.353 0 .523-.171.523-.54V8.619h1.373v2.143c0 1.144-.562 1.71-1.7 1.71h-.694c-1.138 0-1.7-.566-1.7-1.71V4.82c0-1.144.562-1.709 1.7-1.709zm-12.186.08h3.114v1.274H6.117v2.603h1.648v1.275H6.117v2.774h1.74v1.275h-3.14zm3.816 0h2.198c1.138 0 1.7.564 1.7 1.708v2.445c0 1.144-.562 1.71-1.7 1.71h-.799v3.338h-1.4zm4.53 0h1.4v9.201h-1.4zm-3.13 1.235v3.392h.575c.354 0 .523-.171.523-.54V4.965c0-.368-.17-.54-.523-.54zm-3.74 10.147a1.708 1.708 0 01.591.108 1.745 1.745 0 01.49.299l-.452.546a1.247 1.247 0 00-.308-.195.91.91 0 00-.363-.068.658.658 0 00-.28.06.703.703 0 00-.224.163.783.783 0 00-.151.243.799.799 0 00-.056.299v.008a.852.852 0 00.056.31.7.7 0 00.157.245.736.736 0 00.238.16.774.774 0 00.303.058.79.79 0 00.445-.116v-.339h-.548v-.565H7.37v1.255a2.019 2.019 0 01-.524.307 1.789 1.789 0 01-.683.123 1.642 1.642 0 01-.602-.107 1.46 1.46 0 01-.478-.3 1.371 1.371 0 01-.318-.455 1.438 1.438 0 01-.115-.58v-.008a1.426 1.426 0 01.113-.57 1.449 1.449 0 01.312-.46 1.418 1.418 0 01.474-.309 1.58 1.58 0 01.598-.111 1.708 1.708 0 01.045 0zm11.963.008a2.006 2.006 0 01.612.094 1.61 1.61 0 01.507.277l-.386.546a1.562 1.562 0 00-.39-.205 1.178 1.178 0 00-.388-.07.347.347 0 00-.208.052.154.154 0 00-.07.127v.008a.158.158 0 00.022.084.198.198 0 00.076.066.831.831 0 00.147.06c.062.02.14.04.236.061a3.389 3.389 0 01.43.122 1.292 1.292 0 01.328.17.678.678 0 01.207.24.739.739 0 01.071.337v.008a.865.865 0 01-.081.382.82.82 0 01-.229.285 1.032 1.032 0 01-.353.18 1.606 1.606 0 01-.46.061 2.16 2.16 0 01-.71-.116 1.718 1.718 0 01-.593-.346l.43-.514c.277.223.578.335.9.335a.457.457 0 00.236-.05.157.157 0 00.082-.142v-.008a.15.15 0 00-.02-.077.204.204 0 00-.073-.066.753.753 0 00-.143-.062 2.45 2.45 0 00-.233-.062 5.036 5.036 0 01-.413-.113 1.26 1.26 0 01-.331-.16.72.72 0 01-.222-.243.73.73 0 01-.082-.36v-.008a.863.863 0 01.074-.359.794.794 0 01.214-.283 1.007 1.007 0 01.34-.185 1.423 1.423 0 01.448-.066 2.006 2.006 0 01.025 0zm-9.358.025h.742l1.183 2.81h-.825l-.203-.499H8.623l-.198.498h-.81zm2.197.02h.814l.663 1.08.663-1.08h.814v2.79h-.766v-1.602l-.711 1.091h-.016l-.707-1.083v1.593h-.754zm3.469 0h2.235v.658h-1.473v.422h1.334v.61h-1.334v.442h1.493v.658h-2.255zm-5.3.897l-.315.793h.624zm-1.145 5.19h8.014l-4.09 1.348z",
  amazon: "M21.757 15.4031a4.5796 4.5796 0 0 0-.8157-.3675h-.0038c-.0431-.015-.0863-.0244-.1294-.0375-.5081-.1556-2.4-.8494-3.4782-2.8126v.002l-1.9256-3.334c-.81-1.4212-.6732-3.6844-.585-4.5413a4.519 4.519 0 0 0 .0393-.3244.2659.2659 0 0 0 .0038-.0206h-.0019c.0056-.077.0113-.152.0113-.2307-.002-1.9388-1.5732-3.512-3.512-3.512s-3.512 1.5732-3.512 3.512c0 .0769.0075.1538.0113.2307h-.0038s.0019.0168.0056.045c.0075.09.0188.1762.032.2643.09.8363.2455 3.1876-.6057 4.624h.0018l-2.7582 4.7757v-.0037l-.0318.0581-.2588.45c-.0206.0375-.0356.0769-.0562.1144-.285.4931-.72 1.2057-1.1982 1.8507-.3994.54-1.0238 1.0725-1.637 1.4325l.0076.002c-.0563.028-.1144.0524-.1688.0862a2.3952 2.3952 0 0 0-.8625.8737c-.6694 1.1588-.2719 2.642.8869 3.3114.6056.3506 1.2975.4012 1.9182.2119l-.0038.0056c1.0688-.3732 2.237-.7014 2.8351-.8382 1.0032-.2288 2.4882-.285 3.332-.2963h.96c4.2845.0412 6.4558 1.8582 6.4558 1.8582l.0038-.0038c.1744.1387.3544.27.5531.3844 2.1451 1.2394 4.8902.5043 6.1277-1.6426 1.245-2.145.51-4.8901-1.637-6.1277zm-5.0308 2.267c-.4482.7743-1.0857 1.1568-2.1432 1.2375-1.0575.0806-1.2863.1425-3.2232.1425-1.937 0-2.2295-.06-3.2232-.1425-.992-.0825-1.695-.4632-2.1432-1.2376-.4482-.7744-.4107-1.6594 0-2.475.4106-.8157.6731-1.4457 1.4363-2.7676.7631-1.322 1.0669-1.8226 1.785-2.8145.72-.9919 1.2488-1.2375 2.1432-1.2375.8944 0 1.4644.3319 2.1432 1.2375.6788.9057.8719 1.2563 1.7138 2.7151s1.0556 1.952 1.5075 2.867c.4557.915.45 1.7006.0038 2.475z",
  xbox: "M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z",
  psn: "M8.984 2.596v17.547l3.915 1.261V6.688c0-.69.304-1.151.794-.991.636.18.76.814.76 1.505v5.875c2.441 1.193 4.362-.002 4.362-3.152 0-3.237-1.126-4.675-4.438-5.827-1.307-.448-3.728-1.186-5.39-1.502zm4.656 16.241l6.296-2.275c.715-.258.826-.625.246-.818-.586-.192-1.637-.139-2.357.123l-4.205 1.5V14.98l.24-.085s1.201-.42 2.913-.615c1.696-.18 3.785.03 5.437.661 1.848.601 2.04 1.472 1.576 2.072-.465.6-1.622 1.036-1.622 1.036l-8.544 3.107V18.86zM1.807 18.6c-1.9-.545-2.214-1.668-1.352-2.32.801-.586 2.16-1.052 2.16-1.052l5.615-2.013v2.313L4.205 17c-.705.271-.825.632-.239.826.586.195 1.637.15 2.343-.12L8.247 17v2.074c-.12.03-.256.044-.39.073-1.939.331-3.996.196-6.038-.479z",
};

/** Display name ("Epic", "GOG", "Amazon") → PLATFORMS key, or null. */
const BRAND_KEY = new Map(PLATFORMS.map((p) => [p.platform.toLowerCase(), p.key]));

function brandIcon(platform, size = 14) {
  const key = BRAND_KEY.get(String(platform || "").toLowerCase()) || platform;
  const d = BRAND_PATHS[key];
  if (!d) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

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

  /** Hover/focus/tap explanation for one metric.
   *
   *  A real button rather than a title attribute: it is reachable by keyboard,
   *  announced through aria-describedby, and — crucially — carries its own
   *  data-action so closestAction() stops here. Without that, clicking the chip
   *  inside a ranked row would walk up to data-action="open" and open the drawer.
   *
   *  Returns null when METRIC_TIPS has no copy for the key: a chip with nothing
   *  to say is worse than no chip, and the test asserts every key has copy. */
  infoTip(key, name) {
    const text = METRIC_TIPS[key];
    if (!text) return null;
    const chip = this.el("button", "info");
    chip.type = "button";
    chip.dataset.action = "info";
    chip.setAttribute("aria-label", `About ${name}`);
    const tip = this.el("span", "tip", text);
    tip.id = `tip-${key}`;
    tip.setAttribute("role", "tooltip");
    chip.setAttribute("aria-describedby", tip.id);
    chip.appendChild(this.el("span", "info-mark", "i"));
    chip.appendChild(tip);
    return chip;
  },

  /** Alias kept for callers that used view.view(). */
  view(tag, cls, text) {
    return this.el(tag, cls, text);
  },

  /** Build the static frame once. `root` is #app. */
  shell(root) {
    const main = this.el("main", "app");
    main.id = "main";        // skip-link target and post-drawer focus restorer
    main.tabIndex = -1;

    const topbar = this.el("header", "topbar");

    // Brand: the wordmark doubles as the pitch — a rupee sign stands in for
    // the r of "regret", so the name says what the app does before the
    // tagline has to.
    const brand = this.el("div", "brand");
    const brandText = this.el("div", "brand-text");
    const wordmark = this.el("h1");
    wordmark.appendChild(this.el("span", "brand-mark", "₹"));
    wordmark.appendChild(this.el("span", null, "egret"));
    brandText.appendChild(wordmark);
    brandText.appendChild(this.el("p", "brand-sub", "what your library actually cost"));
    brand.appendChild(brandText);

    // Right cluster: which stores are connected, then the two global
    // controls. API keys used to be reachable from two different buttons
    // with two different names ("Keys" and "keys"); there is now one.
    const right = this.el("div", "topbar-right");
    const sources = this.el("div", "sources");
    const actions = this.el("div", "topbar-actions");

    const scanBtn = this.el("button", "button primary", "Scan library");
    scanBtn.dataset.action = "scan";
    const keysBtn = this.el("button", "button ghost", "API keys");
    keysBtn.type = "button";
    keysBtn.dataset.action = "show-keys";
    const menuBtn = this.el("button", "button ghost icon");
    menuBtn.type = "button";
    menuBtn.dataset.action = "toggle-menu";
    menuBtn.setAttribute("aria-label", "Menu");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.appendChild(icon("dots", 18));
    actions.appendChild(scanBtn);
    actions.appendChild(keysBtn);
    actions.appendChild(menuBtn);

    right.appendChild(sources);
    right.appendChild(actions);
    topbar.appendChild(brand);
    topbar.appendChild(right);

    const phaseEl = this.el("div", "phase");

    const menu = this.el("div", "menu hidden");
    const forget = this.el("button", null, "Forget my data");
    forget.dataset.action = "forget";
    const closeMenu = this.el("button", null, "Close");
    closeMenu.dataset.action = "toggle-menu";
    menu.appendChild(forget);
    menu.appendChild(closeMenu);

    const drawer = this.el("aside", "drawer hidden");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-labelledby", "drawer-title");
    const drawerHeader = this.el("div", "drawer-header");
    const drawerTitle = this.el("h3", null, "Game details");
    drawerTitle.id = "drawer-title";
    drawerHeader.appendChild(drawerTitle);
    const closeDrawerBtn = this.el("button", "button ghost icon");
    closeDrawerBtn.id = "drawer-close";
    closeDrawerBtn.type = "button";
    closeDrawerBtn.dataset.action = "close-drawer";
    closeDrawerBtn.setAttribute("aria-label", "Close");
    closeDrawerBtn.appendChild(icon("close", 16));
    drawerHeader.appendChild(closeDrawerBtn);
    const drawerBody = this.el("div", "drawer-body");
    drawer.appendChild(drawerHeader);
    drawer.appendChild(drawerBody);

    const footer = this.el("footer", "disclaimer");
    footer.appendChild(this.el("p", null, "Prices are today's cheapest price (IsThereAnyDeal) in your selected currency — a replacement-cost estimate, not what you actually paid. Games with unknown playtime are excluded from every ratio, never counted as zero."));
    footer.appendChild(this.el("p", null, "GOG and Epic use the unofficial credentials baked into their own launchers. Tokens stay in this browser's localStorage and are never logged or stored server-side."));
    // PlatPrices' free and Indie plans require a credit wherever its data is
    // shown. Left hidden until the server actually returns one, so a library
    // with no PSN rows carries no dead credit line.
    const attribution = this.el("p", "disclaimer-attribution");
    attribution.hidden = true;
    footer.appendChild(attribution);
    // Why PlayStation pricing is empty, when that is knowable. Without it the
    // four different reasons -- no key saved, region not on the key's plan,
    // upstream down, store has no such title -- all look identical: a blank
    // column, and a user hunting for a bug that is really a setting.
    const psnNote = this.el("p", "disclaimer-psn-note");
    psnNote.hidden = true;
    footer.appendChild(psnNote);

    main.appendChild(topbar);
    main.appendChild(phaseEl);
    main.appendChild(footer);
    main.appendChild(menu);
    main.appendChild(drawer);
    root.appendChild(main);

    Object.assign(this, { main, topbar, sources, scanBtn, keysBtn, menuBtn, menu, phaseEl, drawer, drawerBody, footer, attribution, psnNote });
    this._builtPhase = null;
    return this;
  },


  /** Show the provider credit PlatPrices' free/Indie plans require, or hide
   *  it entirely when no PSN prices came back. */
  setPricingAttribution(text) {
    if (!this.attribution) return;
    this.attribution.textContent = text || "";
    this.attribution.hidden = !text;
  },

  /** Explain why PlayStation prices are missing, or hide the line entirely. */
  setPsnPricingNote(text) {
    if (!this.psnNote) return;
    this.psnNote.textContent = text || "";
    this.psnNote.hidden = !text;
  },

  /** Compact per-platform strip in the topbar (ready/loading phases). */
  renderSources(state) {
    const box = this.sources;
    box.textContent = "";
    for (const p of PLATFORMS) {
      if (p.planned) continue;   // roadmap only — no account to show
      const linked = Boolean(state.accounts[p.key]);
      const chip = this.el("span", `source${linked ? " linked" : ""}`);

      const mark = brandIcon(p.key, 14);
      if (mark) { mark.classList.add("source-mark"); chip.appendChild(mark); }
      else chip.appendChild(this.el("span", "dot"));
      chip.appendChild(this.el("span", "source-name", p.name));

      if (linked) {
        const n = state.counts ? state.counts[p.platform] : null;
        chip.appendChild(this.el("span", "source-count", n == null ? "—" : String(n)));
      }

      // Plain words on the button: it used to read "link"/"unlink", which
      // said nothing about what would actually happen.
      const btn = this.el("button", "source-action", linked ? "Forget" : "Link");
      btn.dataset.action = linked ? "unlink" : "link";
      btn.dataset.platform = p.key;
      btn.setAttribute("aria-label", `${linked ? "Forget" : "Link"} ${p.name}`);
      chip.appendChild(btn);

      box.appendChild(chip);
    }
  },

  /** One bring-your-own-API-key row: visible label + masked input + Save.
   *  The label used to live only in the placeholder, which left the input
   *  unlabelled for screen readers and vanished the moment you typed. */
  keyField(kind, label, hint) {
    const field = this.el("div", "key-field");
    const lab = this.el("label", "key-label", label);
    lab.htmlFor = `${kind}-key`;
    field.appendChild(lab);
    const row = this.el("div", "key-row");
    const input = this.el("input", null);
    input.type = "password";
    input.autocomplete = "off";
    const saved = localStorage.getItem(`${kind}_api_key`);
    input.placeholder = saved ? "Saved — type to replace" : "";
    input.id = `${kind}-key`;
    input.dataset.action = "key-input";
    input.dataset.kind = kind;
    const btn = this.el("button", "button small ghost", "Save");
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

  /** Collapsed paste fallback used by GOG, Epic, Amazon and PlayStation.
   *  `link` is an optional page to visit mid-flow — PlayStation needs one,
   *  because the value to paste lives on a second URL you must be signed in to read. */
  pasteBlock(kind, label, placeholder, link = null) {
    const d = this.el("details", "paste");
    d.id = `${kind}-paste`;
    d.open = true;   // the steps say "paste it below" — below must be visible
    d.appendChild(this.el("summary", null, label));
    if (link) {
      const p = this.el("p", "paste-link");
      const a = this.el("a", null, link.text);
      a.href = link.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      p.appendChild(a);
      d.appendChild(p);
    }
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

    // The pitch, playable before the ask: run the real verdict engine on a
    // sample library so the judgement is felt rather than described. Sits above
    // the store cards because it is the reason to scroll to them.
    wrap.appendChild(renderVerdictToy());

    const cards = this.el("div", "platform-cards");
    for (const p of PLATFORMS) {
      const card = this.el("article", `platform-card${p.key === "steam" ? " featured" : ""}${p.planned ? " planned" : ""}`);
      card.dataset.platform = p.key;

      const head = this.el("div", "pc-head");
      const pmark = this.el("span", `pc-mark ${p.key}`);
      const plogo = brandIcon(p.key, 20);
      if (plogo) pmark.appendChild(plogo);
      else pmark.appendChild(this.el("span", "dot"));
      head.appendChild(pmark);
      head.appendChild(this.el("h2", null, p.name));
      if (p.key === "steam") head.appendChild(this.el("span", "pc-tag", "best data"));
      if (p.planned) head.appendChild(this.el("span", "pc-tag", "coming soon"));
      card.appendChild(head);
      card.appendChild(this.el("p", "pc-blurb", p.blurb));

      if (p.planned) {
        // Say what actually blocks it — not "coming soon". No button: there
        // is nothing behind one to press.
        card.appendChild(this.el("p", "pc-planned", p.why));
        cards.appendChild(card);
        continue;
      }

      // What actually happens, in order. The old cards jumped straight to a
      // button and a collapsed <details> telling you to "paste it below" with
      // nothing below it.
      const steps = this.el("ol", "pc-steps");
      for (const s of p.steps) steps.appendChild(this.el("li", null, s));
      card.appendChild(steps);

      const linked = Boolean(state.accounts && state.accounts[p.key]);
      if (linked) card.appendChild(this.el("p", "pc-status linked", "✓ Linked"));

      const cta = this.el("button", "button primary", linked ? "Relink" : p.cta);
      cta.dataset.action = "link";
      cta.dataset.platform = p.key;
      card.appendChild(cta);

      if (p.key === "gog") {
        card.appendChild(this.pasteBlock("gog", "Paste the URL you landed on",
          "https://embed.gog.com/on_login_success?origin=client&code=…"));
      }
      if (p.key === "epic") {
        card.appendChild(this.pasteBlock("epic", "Paste the JSON page", "authorizationCode or the whole JSON blob"));
      }
      if (p.key === "amazon") {
        card.appendChild(this.pasteBlock("amazon", "Paste the URL you landed on",
          "https://www.amazon.com/?openid.oa2.authorization_code=…"));
      }
      if (p.key === "psn") {
        card.appendChild(this.pasteBlock("psn", "Paste your NPSSO token",
          "the 64-character npsso value from the JSON",
          { href: "https://ca.account.sony.com/api/v1/ssocookie", text: "Open the NPSSO page" }));
      }
      cards.appendChild(card);
    }
    wrap.appendChild(cards);

    // Bring-your-own-API-keys card: each user can supply their own
    // IsThereAnyDeal / Steam keys so they use their own rate-limit quota
    // instead of the shared server key (matters when self-hosted for a group).
    // Deliberately out of the store grid — it is optional, not a fourth store.
    const keysCard = this.el("article", "platform-card api-keys");
    const kh = this.el("div", "pc-head");
    kh.appendChild(this.el("span", "dot keys"));
    kh.appendChild(this.el("h2", null, "Your API keys"));
    kh.appendChild(this.el("span", "pc-tag", "optional"));
    keysCard.appendChild(kh);
    keysCard.appendChild(this.el("p", "pc-blurb",
      "Bring your own keys to use your own rate-limit quota instead of the shared server key. Stored only in this browser and sent only with your own requests."));
    // Three labelled groups, not one flat row of input+button pairs: which
    // key does what is the whole question this card has to answer.
    const fields = this.el("div", "api-keys-fields");

    const pricing = this.el("div", "key-group");
    pricing.appendChild(this.el("h3", "key-group-title", "Pricing"));
    pricing.appendChild(this.keyField("itad", "IsThereAnyDeal API key",
      "the one that matters — every price on the dashboard comes from it"));
    fields.appendChild(pricing);

    const extras = this.el("div", "key-group");
    extras.appendChild(this.el("h3", "key-group-title", "Optional extras"));
    extras.appendChild(this.keyField("steam", "Steam Web API key",
      "only if the shared Steam key is rate-limited"));
    extras.appendChild(this.keyField("sgdb", "SteamGridDB API key",
      "cover art in the grid view"));
    fields.appendChild(extras);

    const display = this.el("div", "key-group");
    display.appendChild(this.el("h3", "key-group-title", "Display"));
    const cwrap = this.el("div", "currency-field");
    const clabel = this.el("label", "key-label", "Currency");
    clabel.htmlFor = "onboarding-currency";
    cwrap.appendChild(clabel);
    const csel = this.buildCurrencySelect(state.currency);
    csel.id = "onboarding-currency";
    cwrap.appendChild(csel);
    display.appendChild(cwrap);
    display.appendChild(this.el("p", "key-hint",
      "prices are re-fetched from IsThereAnyDeal in this currency's store region"));
    fields.appendChild(display);

    keysCard.appendChild(fields);
    wrap.appendChild(keysCard);

    // The back button and the trust note are the screen's footer; stacked
    // bare under the dashed card they read as if they belonged to it.
    const trust = "Tokens stay in this browser's localStorage. Only game IDs are sent to this server for pricing — nothing about you is stored.";
    if (Object.values(state.accounts || {}).some(Boolean)) {
      const foot = this.el("div", "onboarding-footer");
      const back = this.el("button", "button ghost", "← Back to dashboard");
      back.dataset.action = "back";
      foot.appendChild(back);
      foot.appendChild(this.el("p", "trust-note", trust));
      wrap.appendChild(foot);
    } else {
      wrap.appendChild(this.el("p", "trust-note", trust));
    }
    return wrap;
  },

  /** One pager strip: prev, windowed page numbers, range read-out, next.
   *  Built twice — above and below the results — because at 38 pages the
   *  bottom strip is a long way from the top. Only the top copy carries
   *  role="status": two live regions announcing the same move is noise. */
  buildPager(announce) {
    const nav = this.el("nav", "pager hidden");
    nav.setAttribute("aria-label", "Library pages");
    const prev = this.el("button", "button ghost small", "← Prev");
    prev.type = "button";
    prev.dataset.action = "page-prev";
    const numbers = this.el("div", "page-numbers");
    const status = this.el("span", "pager-status");
    if (announce) status.setAttribute("role", "status");
    const next = this.el("button", "button ghost small", "Next →");
    next.type = "button";
    next.dataset.action = "page-next";
    nav.appendChild(prev);
    nav.appendChild(numbers);
    nav.appendChild(status);
    nav.appendChild(next);
    return { nav, prev, next, status, numbers };
  },

  /** Results frame: KPI row, table + sidebar. */
  buildReady() {
    const wrap = this.el("section", "ready");

    // ---- hero: the one loud moment on the page ----
    // The six stats live INSIDE this card: as a separate row below, the card
    // hugged its text and left a dead band between it and the KPIs — and the
    // three chips that used to sit under the figure repeated three of those
    // same stats verbatim.
    const hero = this.el("section", "hero");
    hero.id = "hero";
    const micro = this.el("p", "micro", "Lifetime spend");
    // The chip goes on the label: #hero-spend's textContent is asserted by
    // tests, and a bare figure should stay a bare figure anyway.
    micro.appendChild(this.infoTip("hero-spend", "Lifetime spend"));
    hero.appendChild(micro);
    const figure = this.el("p", "hero-figure", "—");
    figure.id = "hero-spend";
    hero.appendChild(figure);
    const line = this.el("p", "hero-line", "");
    line.id = "hero-line";
    hero.appendChild(line);
    hero.appendChild(this.infoTip("hero-line", "the headline"));

    const kpi = this.el("div", "kpi-grid");
    let ringSvg = null;
    let regretCard = null;
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
      const subEl = this.el("p", "kpi-sub", sub);
      // The chip rides on the sub-line rather than inside the label, because
      // updateKpis rewrites the ₹/hour label with textContent — which destroys
      // every child node. A chip inside the label would vanish after the first
      // render, and the test stub's eager id map would have hidden that: the
      // detached tip stays findable by id while being gone from the page.
      subEl.appendChild(this.infoTip(id, label));
      card.appendChild(subEl);
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
        // Pulled out of the row: regret gets a panel of its own, with the
        // distribution it is read against and the what-if toy beside it.
        regretCard = card;
      } else {
        card.appendChild(v);
        kpi.appendChild(card);
      }
    });
    hero.appendChild(kpi);

    const summary = this.el("div", "dash-grid");
    summary.appendChild(hero);

    const regretPanel = this.el("section", "chart-card regret-card");
    if (regretCard) regretPanel.appendChild(regretCard);
    const dist = this.el("div");
    dist.id = "dist";
    regretPanel.appendChild(dist);
    regretPanel.appendChild(this.buildSim());
    summary.appendChild(regretPanel);

    // `kpi` is the scope renderKpis queries: it must reach #kpi-regret now
    // that the regret card has moved out of the row.
    wrap.appendChild(summary);
    this.heroBits = { figure, line };
    this.distBox = dist;

    // ---- the two ranked lists: worst buys and best value ----
    const insights = this.el("div", "insights");
    const worstCard = this.rankCard("Hall of shame", "worst");
    const bestCard = this.rankCard("Best value", "best");
    insights.appendChild(worstCard.card);
    insights.appendChild(bestCard.card);
    wrap.appendChild(insights);
    this.rankLists = { worst: worstCard.list, best: bestCard.list };
    this.rankCards = { worst: worstCard.card, best: bestCard.card };


    const bodyEl = this.el("div", "dashboard-body");
    const panel = this.el("section", "panel");

    const filterBar = this.el("div", "filter-bar");
    // Two deliberate rows. One wrapped flex row put a lone "Currency" select
    // beside the view switch at mid widths and let the search box swallow all
    // the slack; splitting primary from secondary gives each a stable home.
    const filterMain = this.el("div", "filter-main");
    const filterSub = this.el("div", "filter-sub");
    // Tabs carry their counts and one clearer name: "No data" here means the
    // playtime is unknown, which used to collide head-on with the verdict
    // facet of the same name (that one is now "Unpriced").
    const TAB_LABEL = { All: "All", Unplayed: "Unplayed", Played: "Played", "No data": "Unknown hours" };
    const tabs = [];
    for (const f of ["All", "Unplayed", "Played", "No data"]) {
      const b = this.el("button", `tab${f === "All" ? " active" : ""}`);
      b.type = "button";
      b.dataset.action = "filter";
      b.dataset.filter = f;
      b.setAttribute("aria-pressed", String(f === "All"));
      b.appendChild(this.el("span", "tab-label", TAB_LABEL[f]));
      b.appendChild(this.el("span", "tab-count", "0"));
      tabs.push(b);
      filterMain.appendChild(b);
    }
    const search = this.el("input", "search");
    search.type = "search";
    search.placeholder = "Search games…";
    search.setAttribute("aria-label", "Search games");
    search.dataset.action = "search";
    const sort = this.el("select", "sort");
    sort.dataset.action = "sort";
    [["price-desc", "Price: high → low"], ["price-asc", "Price: low → high"],
      ["name-asc", "Name: A → Z"], ["hours-desc", "Hours: most → least"]]
      .forEach(([value, label]) => {
        const o = this.el("option", null, label);
        o.value = value;
        sort.appendChild(o);
      });
    filterMain.appendChild(search);
    // Every select gets a visible mini-label — bare selects read as random
    // words ("price ↓", "All platforms") rather than as choices.
    const control = (labelText, el) => {
      const c = this.el("label", "control");
      c.appendChild(this.el("span", "control-label", labelText));
      c.appendChild(el);
      return c;
    };
    filterSub.appendChild(control("Sort", sort));
    const platformSelect = this.buildPlatformSelect();
    filterSub.appendChild(control("Store", platformSelect));
    const currencySelect = this.buildCurrencySelect(this.currency);
    filterSub.appendChild(control("Currency", currencySelect));
    const viewToggle = this.el("div", "view-toggle");
    [["list", "List"], ["grid", "Grid"]].forEach(([mode, label]) => {
      const b = this.el("button", `view-btn${mode === "list" ? " active" : ""}`, label);
      b.dataset.action = "view";
      b.dataset.view = mode;
      viewToggle.appendChild(b);
    });
    filterMain.appendChild(viewToggle);

    const count = this.el("span", "result-count", "");
    count.id = "result-count";
    count.setAttribute("role", "status");
    filterSub.appendChild(count);
    filterBar.appendChild(filterMain);
    filterBar.appendChild(filterSub);
    panel.appendChild(filterBar);

    // Verdict facets: one toggle per tier, counts recomputed from the whole
    // library so a filter never shrinks its own options out from under you.
    const facetRow = this.el("div", "facet-row");
    facetRow.appendChild(this.el("span", "facet-label", "Verdict"));
    const tierFacets = this.el("div", "tier-facets");
    for (const t of ["All", "regret", "untouched", "fair", "worth", "nodata", "unknown"]) {
      const b = this.el("button", "tier-facet");
      b.type = "button";
      b.dataset.action = "tier";
      b.dataset.tier = t;
      b.setAttribute("aria-pressed", String(t === "All"));
      b.appendChild(this.el("span", `tier-dot tier-dot-${t}`));
      b.appendChild(this.el("span", "tier-name", t === "All" ? "All verdicts" : (TIER_LABEL[t] || t)));
      b.appendChild(this.el("span", "tier-count", "0"));
      tierFacets.appendChild(b);
    }
    facetRow.appendChild(tierFacets);
    panel.appendChild(facetRow);

    // Scan stepper — filled in only while a scan is running.
    const stepper = this.el("ol", "scan-steps hidden");
    stepper.id = "scan-steps";
    panel.appendChild(stepper);
    this.tierFacets = tierFacets;
    this.stepper = stepper;
    this.resultCount = count;


    // Pagination: one page of rows at a time — 892 <tr>/<article> nodes made
    // every filter keystroke re-render the whole library. A second copy goes
    // at the bottom, so a long list never strands you at either end.
    const topPager = this.buildPager(true);
    panel.appendChild(topPager.nav);

    const tableWrap = this.el("div", "table-wrap");
    const table = this.el("table");
    const thead = this.el("thead");
    const hrow = this.el("tr");
    const headerCells = ["Game", "Platform", "Price", "Hours", `${symbol(this.currency)} / hour`, "Verdict"]
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

    // Pagination, bottom copy (see topPager above the results).
    const bottomPager = this.buildPager(false);
    panel.appendChild(bottomPager.nav);

    const empty = this.el("div", "empty-state");
    const emptyMsg = this.el("p", null,
      "Nothing scanned yet — hit “Scan library” to pull your games and today's prices.");
    const emptyBtn = this.el("button", "button small", "Scan library");
    emptyBtn.type = "button";
    emptyBtn.dataset.action = "scan";
    empty.appendChild(emptyMsg);
    empty.appendChild(emptyBtn);
    panel.appendChild(empty);
    this.emptyMsg = emptyMsg;
    this.emptyBtn = emptyBtn;

    const coverage = this.el("p", "coverage");
    coverage.setAttribute("role", "status");   // scan progress is announced
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

    // `kpi` is the scope renderKpis queries: it must reach #kpi-regret now
    // that the regret card has moved out of the row.
    return { wrap, kpi: wrap, tabs, tbody, tableWrap, gridWrap, viewToggle, empty, coverage, ringSvg, platformList, filterBar, search, sort, currencySelect, platformSelect, headerCells, pagers: [topPager, bottomPager], panel };
  },

  /** Called on every state change. Rebuilds the phase only when it changes. */
  render(state) {
    this.currency = state.currency || "INR";
    this.renderSources(state);
    const showChrome = state.phase !== "onboarding";
    this.sources.hidden = !showChrome;
    this.scanBtn.hidden = !showChrome;
    // On onboarding the keys card is already on screen — a second shortcut
    // to it in the header would just be noise.
    if (this.keysBtn) this.keysBtn.hidden = !showChrome;

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
        pagers: r.pagers, panel: r.panel,
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
    this.updateHero(state);
    if (this.distBox) this.renderDistribution(state);
    this.updateSim(state);
    this.updateInsights(state);
    const gridMode = state.viewMode === "grid";
    // One page at a time. The pager is a rendering-cost decision as much as a
    // layout one: 892 table rows or cards rebuilt on every keystroke is what
    // made filtering a big library feel heavy.
    const page = Math.max(1, state.page || 1);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const cur = Math.min(page, pages);          // clamp after a filter shrinks the set
    const start = (cur - 1) * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);
    if (gridMode) this.renderGrid(this.gridWrap, pageRows, state.prices, scanning, state.verdicts);
    else this.renderTable(this.tbody, pageRows, state.prices, scanning, state.verdicts);
    if (this.pagers) {
      const many = rows.length > PAGE_SIZE;      // one page? no pager clutter
      for (const p of this.pagers) {
        p.nav.classList.toggle("hidden", !many);
        p.prev.disabled = cur <= 1;
        p.next.disabled = cur >= pages;
        p.status.textContent = many
          ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} · page ${cur} of ${pages}`
          : "";
        // Direct jump targets: first, last, and the current page's
        // neighbours — never one button per page (38 of them is a wall).
        p.numbers.textContent = "";
        if (!many) continue;
        for (const item of pageWindow(cur, pages)) {
          if (item === "…") {
            p.numbers.appendChild(this.el("span", "page-gap", "…"));
            continue;
          }
          const b = this.el("button", `page-num${item === cur ? " active" : ""}`, String(item));
          b.type = "button";
          b.dataset.action = "page-go";
          b.dataset.page = String(item);
          if (item === cur) b.setAttribute("aria-current", "page");
          p.numbers.appendChild(b);
        }
      }
    }


    const nothing = !scanning && rows.length === 0;
    this.tableWrap.hidden = gridMode || nothing;
    if (this.gridWrap) this.gridWrap.hidden = !gridMode || nothing;
    if (this.viewToggle) {
      for (const b of this.viewToggle.children) {
        b.classList.toggle("active", b.dataset.view === (state.viewMode || "list"));
      }
    }
    this.emptyState.hidden = scanning || rows.length > 0;
    // Two very different "nothing here" states: an empty library needs a
    // scan, a filtered-out library needs its filters cleared.
    if (this.emptyMsg && this.emptyBtn) {
      const filteredOut = !scanning && rows.length === 0 && (state.games || []).length > 0;
      this.emptyMsg.textContent = filteredOut
        ? "No games match these filters."
        : "Nothing scanned yet — hit “Scan library” to pull your games and today's prices.";
      this.emptyBtn.textContent = filteredOut ? "Clear filters" : "Scan library";
      this.emptyBtn.dataset.action = filteredOut ? "clear-filters" : "scan";
    }
    this.coverage.textContent = state.coverageText;
    this.phaseEl.classList.toggle("is-scanning", Boolean(scanning));
    this.phaseEl.setAttribute("aria-busy", scanning ? "true" : "false");

    if (this.tabs) {
      for (const b of this.tabs) {
        const on = b.dataset.filter === state.filter;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
        const c = b.querySelector(".tab-count");
        if (c) c.textContent = String((state.tabCounts || {})[b.dataset.filter] ?? 0);
      }
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

    this.updateTierFacets(state);
    this.updateCount(state);
    this.renderStepper(state);
  },

  // ---------- hero / distribution / what-if ----------

  updateHero(state) {
    if (!this.heroBits) return;
    const m = state.metrics || {};
    const cur = this.currency;
    this.heroBits.figure.textContent = money(m.libraryValue ?? 0, cur);
    const worst = state.comparators && state.comparators.worst[0];
    this.heroBits.line.textContent = buildHeadline({
      total: (state.games || []).length,
      played: m.knownCount ?? 0,
      worstName: worst ? worst.name : null,
      worstRate: worst ? money(worst.rate, cur) : null,
    });
  },

  /** Box plot of cost-per-hour: p25→p75 box, median tick, p90 whisker and a
   *  dot for the worst buy. Four shapes, so it costs O(1) at any library size
   *  — a scatter would not, and would say nothing the quartiles don't. */
  renderDistribution(state) {
    const box = this.distBox;
    if (!box) return;
    box.textContent = "";
    const b = state.bench;
    if (!b || b.p25 == null) {
      box.appendChild(this.el("p", "dist-note", "Price a few more games to draw a benchmark."));
      return;
    }
    const cur = this.currency;
    const W = 300, H = 40, pad = 14;
    const top = Math.max(b.p90 || b.p75, b.p75) * 1.08 || 1;
    const x = (v) => pad + (Math.min(v, top) / top) * (W - pad * 2);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "dist-plot");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label",
      `Cost per hour across ${b.samples} priced games: p25 ${money(b.p25, cur)}, ` +
      `median ${money(b.p50, cur)}, p75 ${money(b.p75, cur)}.`);
    const mk = (tag, attrs) => {
      const n = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      return n;
    };
    svg.appendChild(mk("line", { class: "dist-axis", x1: pad, y1: 26, x2: W - pad, y2: 26 }));
    svg.appendChild(mk("rect", {
      class: "dist-box", x: x(b.p25), y: 12,
      width: Math.max(2, x(b.p75) - x(b.p25)), height: 14, rx: 3,
    }));
    svg.appendChild(mk("line", { class: "dist-median", x1: x(b.p50), y1: 8, x2: x(b.p50), y2: 30 }));
    svg.appendChild(mk("line", { class: "dist-whisk", x1: x(b.p90), y1: 16, x2: x(b.p90), y2: 22 }));
    const worst = state.comparators && state.comparators.worst[0];
    if (worst && Number.isFinite(worst.rate)) {
      svg.appendChild(mk("circle", { class: "dist-marker", cx: x(worst.rate), cy: 19, r: 4 }));
    }
    box.appendChild(svg);

    const summary = this.el("p", "dist-summary",
      `p25 ${money(b.p25, cur)} · median ${money(b.p50, cur)} · p75 ${money(b.p75, cur)}`);
    // No "worst:" suffix here — the hero headline and the hall of shame both
    // name that game already; this line is about the shape of the spread.
    box.appendChild(summary);
  },

  /** Built once so dragging the slider never rebuilds (and blurs) the input. */
  buildSim() {
    const sim = this.el("div", "sim");
    sim.appendChild(this.el("p", "micro", "What if…"));

    const sel = this.el("select", "sim-select");
    sel.dataset.action = "sim-target";
    sel.setAttribute("aria-label", "Game to replay");

    const range = this.el("input", "sim-range");
    range.type = "range";
    range.min = "1";
    range.max = "60";
    range.step = "1";
    range.value = "10";
    range.dataset.action = "sim";
    range.setAttribute("aria-label", "Hours played");
    range.setAttribute("aria-valuetext", "10 hours");

    const out = this.el("p", "sim-out", "");
    out.id = "sim-out";

    sim.appendChild(sel);
    sim.appendChild(range);
    sim.appendChild(out);
    this.simSelect = sel;
    this.simRange = range;
    this.simOut = out;
    return sim;
  },

  /** Refresh the what-if controls. The <select> keeps its value across
   *  renders (only its options are refreshed) and the range is left alone
   *  while it is being dragged, so focus never moves out of the thumb. */
  updateSim(state) {
    const sel = this.simSelect;
    if (!sel || !this.simRange) return;
    const targets = (state.comparators && state.comparators.worst) || [];
    const sig = targets.map((t) => t.id).join(" ");
    if (sel.dataset.sig !== sig) {
      sel.textContent = "";
      for (const t of targets) {
        const o = this.el("option", null, t.name);
        o.value = t.id;
        sel.appendChild(o);
      }
      sel.dataset.sig = sig;
    }
    if (!targets.length) { this.simOut.textContent = ""; return; }
    const id = targets.some((t) => t.id === state.simTarget) ? state.simTarget : targets[0].id;
    sel.value = id;
    const wanted = String(state.simHours || 10);
    if (this.simRange.value !== wanted) this.simRange.value = wanted;
    this.simRange.setAttribute("aria-valuetext", `${this.simRange.value} hours`);

    const game = (state.games || []).find((g) => g.id === id);
    if (!game) { this.simOut.textContent = ""; return; }
    const r = whatIf(game, state.bench, this.simRange.value);
    const now = r.nowRate == null ? "∞/h" : perHour(r.nowRate, this.currency);
    const then = r.rate == null ? "∞/h" : perHour(r.rate, this.currency);
    this.simOut.textContent = r.rate == null
      ? `${now} today — drag to see a rate.`
      : `${now} today → ${then} at ${this.simRange.value} h · ${TIER_LABEL[r.tier]}` +
        (r.changed ? ` (was ${TIER_LABEL[r.nowTier]})` : " (unchanged)");
  },

  /** Shell for one ranked list; the rows are refilled on every update. */
  rankCard(title, kind) {
    const card = this.el("section", "chart-card rank-card");
    const head = this.el("h3", null, title);
    head.appendChild(this.infoTip(`rank-${kind}`, title));
    card.appendChild(head);
    const list = this.el("ol", `rank rank-${kind}`);
    card.appendChild(list);
    return { card, list };
  },

  updateInsights(state) {
    if (!this.rankLists) return;
    const cur = this.currency;
    for (const kind of ["worst", "best"]) {
      const list = this.rankLists[kind];
      if (!list) continue;
      list.textContent = "";
      const items = (state.comparators && state.comparators[kind]) || [];
      if (!items.length) {
        // The list is empty either because nothing qualifies yet or because the
        // filters hid everything that did — say which, or the reader assumes
        // the product is broken.
        list.appendChild(this.el("li", "rank-empty", filtersActive(state)
          ? "Nothing in this view has both an hour of play and a price."
          : "No game has both an hour of play and a price yet."));
        continue;
      }
      for (const item of items) {
        const li = this.el("li", "rank-item");
        li.dataset.action = "open";
        li.dataset.id = item.id;
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.appendChild(this.el("span", "rank-name", item.name));
        li.appendChild(this.el("span", "rank-rate", perHour(item.rate, cur)));
        li.appendChild(this.el("span", "rank-hours", hours(item.hours)));
        list.appendChild(li);
      }
    }
  },

  updateTierFacets(state) {
    if (!this.tierFacets) return;
    const v = state.verdicts || new Map();
    const counts = new Map();
    for (const g of state.games || []) {
      const t = v.get(g.id) || "nodata";
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const b of this.tierFacets.children) {
      const t = b.dataset.tier;
      const n = t === "All" ? (state.games || []).length : (counts.get(t) || 0);
      const countEl = b.querySelector(".tier-count");
      if (countEl) countEl.textContent = String(n);
      b.hidden = t !== "All" && n === 0;          // no dead facets, no rebuild
      b.setAttribute("aria-pressed", String((state.tier || "All") === t));
    }
  },

  updateCount(state) {
    if (!this.resultCount) return;
    const rows = state.rows || [];
    const priced = rows.reduce((sum, g) => sum + (typeof g.price === "number" ? g.price : 0), 0);
    this.resultCount.textContent =
      `${rows.length} of ${(state.games || []).length} games · ${money(priced, this.currency)}`;
  },

  /** One row per source, filled only while a scan runs. A single progressbar
   *  announces the whole list so a screen reader hears one status, not five. */
  renderStepper(state) {
    const box = this.stepper;
    if (!box) return;
    const steps = state.scanSteps || [];
    box.textContent = "";
    box.classList.toggle("hidden", !steps.length);
    if (!steps.length) return;
    box.setAttribute("role", "progressbar");
    box.setAttribute("aria-valuemin", "0");
    box.setAttribute("aria-valuemax", String(steps.length));
    box.setAttribute("aria-valuenow", String(steps.filter((x) => x.status !== "pending").length));
    box.setAttribute("aria-label", "Scan progress");
    for (const step of steps) {
      const li = this.el("li", `scan-step is-${step.status}`);
      li.appendChild(step.status === "done" ? icon("check", 16)
        : step.status === "failed" ? icon("alert", 16) : icon("clock", 16));
      li.appendChild(this.el("span", "scan-source", step.label));
      li.appendChild(this.el("span", "scan-state", step.status));
      box.appendChild(li);
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

  renderTable(tbody, rows, prices, skeleton = false, verdicts = null) {
    if (!tbody) return;
    tbody.textContent = "";

    if (skeleton) {
      for (let i = 0; i < 6; i += 1) {
        const tr = this.el("tr", "skeleton-row");
        for (let c = 0; c < 6; c += 1) {
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
      tr.tabIndex = 0;   // rows are focusable so Enter can open them too
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
        if (i !== 1) {
          tr.appendChild(this.el("td", i === 0 ? "cell-name" : null, text));
          return;
        }
        // Platform cell: the store's mark, then its name — the eye finds the
        // column by glyph long before it reads the word.
        const td = this.el("td", "cell-platform");
        const pmark = brandIcon(text, 13);
        if (pmark) { pmark.classList.add("platform-mark"); td.appendChild(pmark); }
        td.appendChild(this.el("span", null, text || ""));
        tr.appendChild(td);
      });
      // Verdict is the last column: the money columns keep their positions.
      const vcell = this.el("td", "verdict-cell");
      vcell.appendChild(tierBadge(verdicts ? verdicts.get(game.id) : null));
      tr.appendChild(vcell);
      tbody.appendChild(tr);
    }
  },

  /** Grid of cover cards — the alternative to the table. */
  renderGrid(wrap, rows, prices, skeleton = false, verdicts = null) {
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
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `${game.name}, ${game.platform || "unknown platform"}`);

      const art = this.el("div", "cover");
      // Deterministic per-id hue: the same game always wears the same colour,
      // so the grid stays recognisable while art loads (or forever, without a
      // key) instead of showing an empty grey box.
      const hue = coverHue(game.id);
      art.style.background =
        `linear-gradient(160deg, hsl(${hue} 42% 24%), hsl(${(hue + 45) % 360} 42% 13%))`;
      const init = this.el("span", "cover-fallback", coverInitials(game.name));
      init.setAttribute("aria-hidden", "true");
      art.appendChild(init);

      const img = this.el("img", "cover-img");
      img.alt = "";
      img.decoding = "async";
      img.dataset.coverId = game.id;
      // The card fades the art in on load; without this listener the image
      // downloads fine and then sits at opacity 0 forever.
      img.addEventListener("load", () => img.classList.add("is-loaded"));
      // A 404 from the cover host falls back to the gradient, not a broken icon.
      img.addEventListener("error", () => { img.style.opacity = "0"; });
      art.appendChild(img);

      const badge = tierBadge(verdicts ? verdicts.get(game.id) : null);
      badge.classList.add("card-badge");
      art.appendChild(badge);

      if (game.hours != null && game.hours >= 1) {
        art.appendChild(this.el("span", "card-hours", hours(game.hours)));
      }
      card.appendChild(art);

      const meta = this.el("div", "card-meta");
      meta.appendChild(this.el("p", "card-title", game.name));
      // The band reads today's price against its own history, so it sits
      // directly under the name — above the row it explains.
      const band = this.priceBand(game, price);
      if (band) meta.appendChild(band);
      // Bottom line: amount on the left, store on the right — money first,
      // provenance after.
      const sub = this.el("p", "card-sub");
      sub.appendChild(this.el("span", "card-price",
        typeof price === "number" ? money(price, this.currency) : "—"));
      const store = this.el("span", "card-store");
      const cmark = brandIcon(game.platform, 12);
      if (cmark) { cmark.classList.add("card-mark"); store.appendChild(cmark); }
      store.appendChild(this.el("span", null, game.platform || "—"));
      sub.appendChild(store);
      meta.appendChild(sub);
      card.appendChild(meta);

      if (game.hours != null && game.hours < 1) card.classList.add("unplayed");
      wrap.appendChild(card);
    }
    if (!hasKey) {
      wrap.appendChild(this.el("p", "muted grid-hint",
        "Add a SteamGridDB API key under API keys to load cover art."));
    }
  },

  /** Track showing where today's price sits between the all-time low and high.
   *  Decorative here — the drawer repeats the same fact as text. */
  priceBand(game, price) {
    const high = game.high, low = game.low;
    if (typeof price !== "number" || typeof high !== "number" || typeof low !== "number") return null;
    if (!(high > low)) return null;
    const pct = Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100));
    const band = this.el("div", "price-band");
    band.setAttribute("aria-hidden", "true");
    const track = this.el("span", "band-track");
    const fill = this.el("span", "band-fill");
    fill.style.width = `${pct}%`;
    const marker = this.el("span", "band-marker");
    marker.style.left = `${pct}%`;
    track.appendChild(fill);
    track.appendChild(marker);
    band.appendChild(track);
    return band;
  },

  renderDrawer(drawerBody, game, price, state) {
    if (!drawerBody) return;
    drawerBody.textContent = "";
    const cur = (state && state.currency) || this.currency;
    const verdicts = state && state.verdicts;
    const tier = verdicts ? verdicts.get(game.id) : null;

    // Cover + title together at the top: the same layered fallback the grid
    // cards use (gradient + initials), with the art stamped in when known.
    const head = this.el("div", "drawer-head");
    const art = this.el("div", "cover drawer-cover");
    const hue = coverHue(game.id);
    art.style.background =
      `linear-gradient(160deg, hsl(${hue} 42% 24%), hsl(${(hue + 45) % 360} 42% 13%))`;
    const init = this.el("span", "cover-fallback", coverInitials(game.name));
    init.setAttribute("aria-hidden", "true");
    art.appendChild(init);
    const img = this.el("img", "cover-img");
    img.alt = "";
    img.decoding = "async";
    img.dataset.coverId = game.id;
    img.addEventListener("load", () => img.classList.add("is-loaded"));
    img.addEventListener("error", () => { img.style.opacity = "0"; });
    art.appendChild(img);
    head.appendChild(art);

    const titles = this.el("div", "drawer-titles");
    titles.appendChild(this.el("h3", "drawer-game-title", game.name));
    titles.appendChild(this.el("p", "muted", game.platform));
    head.appendChild(titles);
    drawerBody.appendChild(head);

    // Verdict first: it is the answer to the question the drawer exists for.
    const verdictRow = this.el("div", "drawer-row verdict-row");
    verdictRow.appendChild(this.el("span", null, "Verdict"));
    verdictRow.appendChild(tierBadge(tier));
    drawerBody.appendChild(verdictRow);

    const priceRow = this.el("div", "drawer-row");
    priceRow.appendChild(this.el("span", null, "Current price"));
    priceRow.appendChild(this.el("strong", null, typeof price === "number" ? money(price, cur) : "—"));
    drawerBody.appendChild(priceRow);

    const hoursRow = this.el("div", "drawer-row");
    hoursRow.appendChild(this.el("span", null, "Playtime"));
    hoursRow.appendChild(this.el("strong", null, game.hours == null ? "unknown" : hours(game.hours)));
    drawerBody.appendChild(hoursRow);

    const vphRow = this.el("div", "drawer-row");
    vphRow.appendChild(this.el("span", null, `${symbol(cur)} / hour`));
    vphRow.appendChild(this.el("strong", null,
      perHour(pricePerHour(price, game.hours), cur)));
    drawerBody.appendChild(vphRow);

    // Where today's price sits between the all-time low and high — as words,
    // because a bar you can only see on hover is not information.
    if (typeof price === "number" && typeof game.high === "number" && typeof game.low === "number"
        && game.high > game.low) {
      const band = this.el("div", "drawer-row");
      band.appendChild(this.el("span", null, "All-time range"));
      band.appendChild(this.el("strong", null,
        `${money(game.low, cur)} – ${money(game.high, cur)}`));
      drawerBody.appendChild(band);

      const gap = game.high - price;
      const pos = this.el("div", "drawer-row");
      pos.appendChild(this.el("span", null, "Position"));
      pos.appendChild(this.el("strong", null, gap >= 0
        ? `${money(gap, cur)} below its all-time high`
        : `${money(-gap, cur)} above its all-time high`));
      drawerBody.appendChild(pos);
    }

    drawerBody.appendChild(this.el("p", "muted drawer-note", tierNote(tier)));
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
      const lmark = brandIcon(platform, 13);
      if (lmark) { lmark.classList.add("platform-mark"); row.appendChild(lmark); }
      row.appendChild(this.el("span", "platform-name", platform));
      row.appendChild(this.el("span", "platform-value", money(data.value, this.currency)));
      legend.appendChild(row);
    });
    listEl.appendChild(legend);
  },
};

