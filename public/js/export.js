/** Card exports — pure spec builders, a share-link codec, and a canvas painter.
 *
 *  The Wrapped-style share deck. Everything that decides *what* a card says
 *  is pure and testable without a DOM; only the painter touches a 2D context,
 *  and it takes one as an argument. No dependencies: the arcade skin is drawn
 *  by hand so the repo keeps its zero-frontend-dep footing.
 */
import { money, perHour, pricePerHour } from "./format.js";
import { TIER_LABEL, TIERS, comparators as rankGames } from "./verdict.js";
import { computeRegret } from "./regret.js";

export const CARD_W = 1080;
export const CARD_H = 1350;      // 4:5 — feed-native, and room for eight rows
const MAX_ROWS = 8;
const MAX_STATS = 4;

/** Fallback tokens match style.css's :root; themeTokens() prefers the live
 *  values so a re-skin cannot leave the exports behind. */
export const CARD_TOKENS = {
  bg: "#14161a",
  text: "#e8e9eb",
  muted: "#8b909a",
  accent: "#6ee7b7",
  border: "#2a2e35",
  tiers: {
    worth: "#6ee7b7",
    fair: "#e0b263",
    regret: "#f0776c",
    untouched: "#9aa1ac",
    nodata: "#7aa2f7",
    free: "#38bdf8",
  },
};

export function themeTokens() {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return CARD_TOKENS;
  }
  const cs = getComputedStyle(document.documentElement);
  const read = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  const tiers = {};
  for (const [k, v] of Object.entries(CARD_TOKENS.tiers)) tiers[k] = read(`--tier-${k}`, v);
  return {
    bg: read("--bg", CARD_TOKENS.bg),
    text: read("--text", CARD_TOKENS.text),
    muted: read("--muted", CARD_TOKENS.muted),
    accent: read("--accent", CARD_TOKENS.accent),
    border: read("--border", CARD_TOKENS.border),
    tiers,
  };
}

function currentHost() {
  if (typeof location !== "undefined" && location.hostname) return location.hostname;
  if (typeof window !== "undefined" && window.location && window.location.hostname) {
    return window.location.hostname;
  }
  return "";
}

/** Kinds the current library can actually fill — the chips the UI offers.
 *  The two ranked lists come from the comparators the dashboard already
 *  computes; a verdict kind only appears when that verdict has members. */
export function exportKinds(state) {
  const out = ["wrapped"];
  const c = state.comparators || {};
  if ((c.worst || []).length) out.push("worst");
  if ((c.best || []).length) out.push("best");
  // No view-scoped untouched twin: the verdict card below is library-wide
  // and carries the stats, and the table's filters already show whatever
  // slice of it the user is looking at.
  const v = state.verdicts || new Map();
  const seen = new Set();
  for (const g of state.games || []) seen.add(v.get(g.id) || "nodata");
  // "unknown" is not in TIERS — it is the no-benchmark verdict, and a library
  // small enough to earn it still deserves a card saying so.
  for (const t of [...TIERS, "unknown"]) {
    if (seen.has(t)) out.push(`verdict:${t}`);
  }
  if ((state.rows || []).length) out.push("view");
  return out;
}

export function kindLabel(kind) {
  if (kind === "wrapped") return "Wrapped";
  if (kind === "worst") return "Hall of shame";
  if (kind === "best") return "Best value";
  if (kind === "view") return "This view";
  if (kind && kind.startsWith("verdict:")) return TIER_LABEL[kind.slice(8)] || kind.slice(8);
  return String(kind || "");
}

const iso = (ms) => new Date(ms || Date.now()).toISOString().slice(0, 10);

/** Best value / Hall of shame rows: rate where a rate exists, hours where a
 *  free game's only value is play. Untouched games never enter — they have no
 *  rate to rank on, and price ranking is the untouched list's own job. */
function rankRows(games, kind, cur) {
  const played = games
    .map((g) => ({ g, rate: pricePerHour(g.price, g.hours) }))
    .filter((x) => x.g.price > 0 && x.g.hours >= 1 && Number.isFinite(x.rate));
  const list = (kind === "best" && !played.length)
    ? games.filter((g) => g.price === 0 && g.hours >= 1)
      .map((g) => ({ g, rate: 0 }))
      .sort((a, b) => b.g.hours - a.g.hours)
    : (kind === "best"
      ? [...played].sort((a, b) => a.rate - b.rate)
      : [...played].sort((a, b) => b.rate - a.rate));
  return list.slice(0, MAX_ROWS).map((x) => ({
    name: x.g.name,
    value: perHour(x.rate, cur),
    meta: x.g.hours == null ? "" : `${x.g.hours} h`,
  }));
}

function untouchedRows(games, cur) {
  return games
    .filter((g) => g.price > 0 && (g.hours == null || g.hours < 1))
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_ROWS)
    .map((g) => ({ name: g.name, value: money(g.price, cur), meta: "unopened" }));
}

/** Everything one card says, as plain data. Returns null when the library
 *  cannot fill the kind — the UI then says so instead of exporting a lie. */
export function cardSpec(state, kind = "wrapped") {
  const cur = state.currency || "INR";
  const games = state.games || [];
  const rows = state.rows || [];
  const base = {
    v: 1,
    kind,
    eyebrow: "YOUR LIBRARY, JUDGED",
    currency: cur,
    at: Date.now(),
    // Who made it: the Steam display name where one is known — a card is
    // signed by a person, not by whichever hostname served the page.
    who: state.steamPersona || null,
    src: currentHost(),
  };

  if (kind === "wrapped") {
    if (!games.length) return null;
    // Wrapped is the whole library, whatever the filters say. state.metrics
    // and state.comparators are built from the *filtered* rows (the dashboard
    // KPIs follow the table), and the summary card is the one someone
    // screenshots — it has to be the full story, so both are recomputed here
    // from the library itself.
    const m = computeRegret(games);
    const c = rankGames(games);
    const worst = (c.worst || [])[0];
    const best = (c.best || [])[0];
    const idle = (c.untouched || [])[0];
    const playedCount = games.filter((g) => g.hours != null && g.hours >= 1).length;
    const pct = games.length ? Math.round((playedCount / games.length) * 100) : 0;
    return {
      ...base,
      tier: null,
      title: "WRAPPED",
      badge: `${games.length} GAMES`,
      stats: [
        { label: "LIBRARY VALUE", value: money(m.libraryValue || 0, cur) },
        { label: "TOTAL HOURS", value: `${Math.round(m.totalHours || 0)} h` },
        { label: "REGRET SCORE", value: m.regretScore == null ? "—" : `${Math.round(m.regretScore * 100)}%` },
        { label: "PLAYED", value: `${pct}%` },
      ],
      rows: [
        worst && { name: `Worst buy · ${worst.name}`, value: perHour(worst.rate, cur), meta: "per hour" },
        best && { name: `Best value · ${best.name}`, value: perHour(best.rate, cur), meta: "per hour" },
        idle && { name: `Biggest idle buy · ${idle.name}`, value: money(idle.price, cur), meta: "never opened" },
      ].filter(Boolean),
      footnote: `Judged against your own quartiles · ${iso(Date.now())}`,
    };
  }

  // The two ranked lists. Untouched has no view-scoped twin — the verdict
  // card below is library-wide, carries the stats, and the table's filters
  // already show whatever slice of it the user is looking at.
  if (kind === "worst" || kind === "best") {
    const list = (state.comparators || {})[kind] || [];
    if (!list.length) return null;
    const tier = kind === "worst" ? "regret" : "worth";
    return {
      ...base,
      tier,
      title: kind === "worst" ? "HALL OF SHAME" : "BEST VALUE",
      badge: TIER_LABEL[tier],
      stats: [
        { label: "ON THE LIST", value: `${list.length}` },
        { label: "PER HOUR", value: perHour(list[0].rate, cur) },
      ],
      rows: list.slice(0, MAX_ROWS).map((x) => ({
        name: x.name,
        value: perHour(x.rate, cur),
        meta: x.hours == null ? "" : `${x.hours} h`,
      })),
      footnote: `Ranked from your current view · ${iso(Date.now())}`,
    };
  }

  if (kind && kind.startsWith("verdict:")) {
    const tier = kind.slice(8);
    const v = state.verdicts || new Map();
    const members = games.filter((g) => (v.get(g.id) || "nodata") === tier);
    if (!members.length) return null;
    const spend = members.reduce((s, g) => s + (g.price || 0), 0);
    const totalHours = members.reduce((s, g) => s + (g.hours || 0), 0);
    let list;
    if (tier === "untouched" || tier === "nodata") {
      list = untouchedRows(members, cur);
    } else if (tier === "free") {
      list = members.filter((g) => g.hours >= 1)
        .sort((a, b) => (b.hours || 0) - (a.hours || 0))
        .slice(0, MAX_ROWS)
        .map((g) => ({ name: g.name, value: perHour(0, cur), meta: `${g.hours} h` }));
    } else {
      // Worth and Fair read cheapest-first, Regret dearest-first: each card
      // leads with the row its verdict is *about*.
      list = rankRows(members, tier === "regret" ? "worst" : "best", cur);
    }
    const stats = [
      { label: "GAMES", value: `${members.length}` },
      { label: "SPEND", value: money(spend, cur) },
    ];
    if (tier === "free") {
      stats.push({ label: "HOURS ON RECORD", value: `${Math.round(totalHours)} h` });
    }
    if (tier === "untouched") {
      // Not "hours on record": the verdict counts a sub-hour opening as
      // untouched, so a summed playtime only contradicts the rows below it
      // ("unopened" over a card claiming hours). What an idle library burned
      // is money, and that is the number worth saying.
      stats.push({
        label: "AVG IDLE COST",
        value: members.length ? money(spend / members.length, cur) : "—",
      });
    }
    return {
      ...base,
      tier,
      title: `VERDICT: ${(TIER_LABEL[tier] || tier).toUpperCase()}`,
      badge: TIER_LABEL[tier] || tier,
      stats: stats.slice(0, MAX_STATS),
      rows: list,
      footnote: `${members.length} games carry this verdict · ${iso(Date.now())}`,
    };
  }

  if (kind === "view") {
    if (!rows.length) return null;
    const filters = [
      state.tier && state.tier !== "All" ? (TIER_LABEL[state.tier] || state.tier) : null,
      state.platform && state.platform !== "All" ? state.platform : null,
      state.filter && state.filter !== "All" ? state.filter : null,
      state.search ? `"${state.search}"` : null,
    ].filter(Boolean);
    const spend = rows.reduce((s, g) => s + (g.price || 0), 0);
    return {
      ...base,
      tier: null,
      title: "YOUR VIEW",
      badge: filters.join(" · ") || "ALL GAMES",
      stats: [
        { label: "GAMES", value: `${rows.length}` },
        { label: "SPEND", value: money(spend, cur) },
      ],
      rows: rows.slice(0, MAX_ROWS).map((g) => {
        const rate = pricePerHour(g.price, g.hours);
        const valued = g.price > 0 && g.hours >= 1 && Number.isFinite(rate);
        return {
          name: g.name,
          value: valued ? perHour(rate, cur) : money(g.price, cur),
          meta: g.hours == null ? "" : `${g.hours} h`,
        };
      }),
      footnote: `${filters.length ? filters.join(" · ") : "Whole library"} · ${iso(Date.now())}`,
    };
  }

  return null;
}

/* ---------- share link: recipe + frozen snapshot of its numbers ---------- */

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCard(spec) {
  return b64urlEncode(JSON.stringify(spec));
}

/** Accepts a full hash ("#card=…") or just the payload. Anything that is not
 *  one of our own cards comes back null — a link must never crash a boot. */
export function decodeCard(hash) {
  const m = /[#&?]card=([A-Za-z0-9_-]+)/.exec(String(hash || ""));
  if (!m) return null;
  try {
    const spec = JSON.parse(b64urlDecode(m[1]));
    return spec && spec.v === 1 && typeof spec.title === "string" ? spec : null;
  } catch { return null; }
}

export function shareUrl(spec, origin) {
  const o = origin
    || (typeof location !== "undefined" && location.origin)
    || (typeof window !== "undefined" && window.location && window.location.origin)
    || "";
  return `${o}/#card=${encodeCard(spec)}`;
}

/* ---------- the painter ---------- */

let fontReady = null;
function loadArcadeFont() {
  if (typeof FontFace === "undefined") return Promise.resolve(false);
  if (!fontReady) {
    // Same file and family style.css ships; the page's @font-face covers the
    // DOM, and this makes the canvas wait for it instead of falling back.
    fontReady = new FontFace("Press Start 2P", "url(fonts/press-start-2p-latin.woff2)")
      .load()
      .then((f) => { if (typeof document !== "undefined" && document.fonts) document.fonts.add(f); return true; })
      .catch(() => false);
  }
  return fontReady;
}

const DISP = '"Press Start 2P", monospace';
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** The rupee sign, hand-drawn. Press Start 2P ships no ₹ (latin subset
 *  only), and a mono fallback mid-pixel-word reads as a glitch — so the
 *  glyph is pixel art. 5×5, one block per Press Start 2P design pixel
 *  (the font is an 8px-grid face; caps are five), so at the same em size
 *  the ₹ sits exactly level with the letters beside it: top bar, stem,
 *  middle bar, and a leg stepping down to the right. */
export const RUPEE = [
  "11111",
  "10000",
  "11111",
  "10010",
  "10001",
];

/** Block size in px for a glyph drawn `size` px tall — integer, so the
 *  pixel art never renders as blurry fractions. */
function rupeeBlock(size) {
  return Math.max(1, Math.round((size * 0.7) / RUPEE.length));
}

export function rupeeWidth(size) {
  return rupeeBlock(size) * RUPEE[0].length;
}

/** Draw the glyph with its baseline at `y` and its height near `size`. */
export function drawRupee(ctx, x, y, size, color) {
  const s = rupeeBlock(size);
  const top = y - s * RUPEE.length;
  if (color) ctx.fillStyle = color;
  for (let r = 0; r < RUPEE.length; r += 1) {
    for (let c = 0; c < RUPEE[r].length; c += 1) {
      if (RUPEE[r][c] === "1") ctx.fillRect(x + c * s, top + r * s, s, s);
    }
  }
}

/** The same grid as inline SVG, for the DOM wordmark — one glyph, two
 *  surfaces, so the heading and the exported cards cannot drift apart. */
export function rupeeSvg() {
  const cells = [];
  RUPEE.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] === "1") cells.push(`<rect x="${c}" y="${r}" width="1" height="1"/>`);
    }
  });
  return `<svg class="rupee-glyph" viewBox="0 0 5 5" fill="currentColor"`
    + ` preserveAspectRatio="none" aria-hidden="true">${cells.join("")}</svg>`;
}

/** Cap height of the pixel face as a fraction of em — measured from the
 *  loaded font, not guessed, so the ₹ matches the letters beside it at
 *  every size. Falls back to five of eight design pixels. */
export async function pixelCapRatio() {
  const FALLBACK = 0.625;
  if (typeof document === "undefined" || !document.createElement) return FALLBACK;
  try {
    await loadArcadeFont();
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return FALLBACK;
    ctx.font = `100px ${DISP}`;
    const m = ctx.measureText("E");
    const cap = m && m.actualBoundingBoxAscent;
    return cap > 0 ? cap / 100 : FALLBACK;
  } catch { return FALLBACK; }
}

/** Where the project lives — the watermark names the home, not whatever
 *  hostname happened to serve this copy (localhost tells a stranger nothing). */
const SITE = "financial-regret.vercel.app";

/** Shrink-to-fit display text: titles are short by design, but a verdict
 *  label like "VERDICT: UNTOUCHED" is wider than the frame at full size. */
function fitFont(ctx, text, size, maxW, family) {
  let s = size;
  ctx.font = `${s}px ${family}`;
  while (s > 14 && ctx.measureText && ctx.measureText(text).width > maxW) {
    s -= 4;
    ctx.font = `${s}px ${family}`;
  }
}

function truncate(ctx, text, maxW) {
  if (!ctx.measureText) return text;
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Press Start 2P ships no ₹ (the latin subset is the only one vendored), so
 *  a leading ₹ is drawn as the hand-drawn pixel glyph and the rest of the
 *  figure stays in pixels — no font fallback anywhere. */
function fillDisplay(ctx, text, x, y, maxW, size) {
  const s = String(text);
  if (!s.startsWith("₹")) {
    fitFont(ctx, s, size, maxW, DISP);
    ctx.fillText(s, x, y);
    return;
  }
  const rw = rupeeWidth(size);
  drawRupee(ctx, x, y, size, ctx.fillStyle);
  fitFont(ctx, s.slice(1), size, maxW - rw, DISP);
  ctx.fillText(s.slice(1), x + rw, y);
}

/** Draw one spec. Synchronous: renderCardTo() awaits the font first; a
 *  missing measureText skips fitting, which is what keeps this painter
 *  testable against a recording stub. */
export function drawCard(ctx, spec, tokens = CARD_TOKENS, w = CARD_W, h = CARD_H) {
  const ink = spec.tier && tokens.tiers[spec.tier] ? tokens.tiers[spec.tier] : tokens.accent;
  const PAD = 72;
  const MAXW = w - PAD * 2;

  ctx.fillStyle = tokens.bg;
  ctx.fillRect(0, 0, w, h);
  // Scanlines: the toy-screen skin, one transparent pixel every three.
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

  ctx.strokeStyle = ink;
  ctx.lineWidth = 4;
  ctx.strokeRect(28, 28, w - 56, h - 56);

  ctx.textAlign = "left";
  ctx.fillStyle = tokens.muted;
  ctx.font = `22px ${MONO}`;
  ctx.fillText(spec.eyebrow || "YOUR LIBRARY, JUDGED", PAD, 116);

  ctx.fillStyle = ink;
  fitFont(ctx, spec.title, 52, MAXW, DISP);
  ctx.fillText(spec.title, PAD, 196);

  if (spec.badge) {
    ctx.font = `24px ${DISP}`;
    const tw = ctx.measureText ? ctx.measureText(spec.badge).width : spec.badge.length * 24;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, 232, tw + 40, 56);
    ctx.fillStyle = ink;
    ctx.fillText(spec.badge, PAD + 20, 270);
  }

  (spec.stats || []).slice(0, MAX_STATS).forEach((s, i) => {
    const x = PAD + (i % 2) * (MAXW / 2);
    const y = 380 + Math.floor(i / 2) * 130;
    ctx.fillStyle = tokens.muted;
    ctx.font = `20px ${MONO}`;
    ctx.fillText(s.label, x, y);
    ctx.fillStyle = tokens.text;
    fillDisplay(ctx, s.value, x, y + 52, MAXW / 2 - 24, 34);
  });

  const list = (spec.rows || []).slice(0, MAX_ROWS);
  let y = 690;
  if (list.length) {
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y - 44);
    ctx.lineTo(w - PAD, y - 44);
    ctx.stroke();
  }
  list.forEach((r, i) => {
    ctx.fillStyle = ink;
    ctx.font = `20px ${DISP}`;
    ctx.fillText(String(i + 1).padStart(2, "0"), PAD, y);
    ctx.fillStyle = tokens.text;
    ctx.font = `26px ${MONO}`;
    ctx.fillText(truncate(ctx, r.name, MAXW - 240), PAD + 64, y);
    ctx.fillStyle = ink;
    ctx.textAlign = "right";
    ctx.fillText(r.value, w - PAD, y);
    ctx.textAlign = "left";
    if (r.meta) {
      ctx.fillStyle = tokens.muted;
      ctx.font = `18px ${MONO}`;
      ctx.fillText(r.meta, PAD + 64, y + 26);
    }
    y += 66;
  });

  ctx.fillStyle = tokens.muted;
  ctx.font = `18px ${MONO}`;
  ctx.fillText(spec.footnote || "", PAD, h - 84);

  // Watermark: the wordmark in the pixel font plus where to get it, one
  // quiet muted line — brand without shouting over the stats. The ₹ is the
  // hand-drawn glyph again: the pixel face has no rupee.
  ctx.textAlign = "right";
  ctx.fillStyle = tokens.muted;
  ctx.font = `18px ${MONO}`;
  const site = SITE;
  const siteW = ctx.measureText ? ctx.measureText(site).width : site.length * 11;
  ctx.fillText(site, w - PAD, h - 84);
  ctx.font = `16px ${DISP}`;
  const markW = ctx.measureText ? ctx.measureText("egret").width : 5 * 16;
  ctx.fillText("egret", w - PAD - siteW - 20, h - 84);
  drawRupee(ctx, w - PAD - siteW - 20 - markW - 10, h - 84, 16, tokens.muted);
  ctx.textAlign = "left";
}

/** Paint into a live canvas. False when the environment cannot draw (the
 *  test DOM has no contexts) so callers degrade instead of crashing. */
export async function renderCardTo(canvas, spec) {
  await loadArcadeFont();
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  if (!ctx) return false;
  drawCard(ctx, spec, themeTokens());
  return true;
}

export async function cardBlob(spec) {
  await loadArcadeFont();
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  drawCard(canvas.getContext("2d"), spec, themeTokens());
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob(resolve, "image/png");
    else resolve(null);
  });
}
