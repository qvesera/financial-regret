/**
 * Attract-mode verdict toy: a playable demo of the verdict engine that needs
 * no linked store and no key.
 *
 * The pitch of the whole landing page is "see what your library is actually
 * worth" — but until now that promise only began after a signup. This runs the
 * real engine (verdict.js) on a fixed sample library so a visitor can feel the
 * judgement flip under their own thumb before granting anything.
 *
 * Styling note: the DOM is addressed by id rather than element.closest(),
 * because the test DOM stub implements no selector methods at all — that is
 * why the rest of this app walks parentNode by hand too.
 */
import { benchmark, whatIf, TIER_LABEL } from "./verdict.js";

/** A small fake library. At least three priced, played rows are required or
 *  benchmark() withholds quartiles and every verdict would read "No benchmark",
 *  which would make the toy worse than useless. */
export const TOY_SAMPLE = [
  { id: "toy-1", name: "Pocket Rally", price: 499, hours: 120 },
  { id: "toy-2", name: "Kaiju Kitchen", price: 799, hours: 30 },
  { id: "toy-3", name: "Neon Drifter", price: 1499, hours: 62 },
  { id: "toy-4", name: "Spectral Ops", price: 1299, hours: 15 },
  { id: "toy-5", name: "Tile Witch", price: 299, hours: 3 },
  { id: "toy-6", name: "Void Cathedral", price: 1999, hours: 8 },
];

/** The card under the slider, owned and never opened. Starting at 0h matters:
 *  whatIf() falls back to the game's own hours whenever the proposed playtime
 *  is under one, so a demo game with hours already logged would read "Regret"
 *  at 0h instead of "Untouched" — and the honest first frame here is the one
 *  the hero copy promises: a game you never opened.
 *
 *  A real game, not an invented one: Hollow Knight, at its actual Indian list
 *  price. ₹690 also sits inside the window where one drag still spans all
 *  four verdicts against the sample quartiles (above roughly ₹571 an hour is
 *  still Regret, and at or under roughly ₹1,301 it reaches Worth it by 53h),
 *  so the arc stays arithmetic instead of being tuned around a fiction. */
export const TOY_GAME = {
  id: "toy-hero",
  name: "Hollow Knight",
  appid: 367520,
  price: 690,
  hours: 0,
  // Cached beside the page, not looked up: img-src 'self' forbids the Steam
  // CDN at runtime, and the toy's pitch is "no sign-up, no key" — a cover or
  // price fetch would break both. The art is Hollow Knight's official Steam
  // library cover (Team Cherry's, via Valve's CDN), fetched once and shipped;
  // the price is the real ₹690 India list price, to be updated only when the
  // publisher changes it.
  cover: "covers/hollow-knight.jpg",
};

export const TOY_MIN = 0;
export const TOY_MAX = 60;
export const TOY_DEFAULT = 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const bench = benchmark(TOY_SAMPLE);

/** Everything the paint step needs for a given playtime. Pure and cheap, so
 *  the tests can assert the verdict arc without touching the DOM. */
export function toyState(hours) {
  const w = whatIf(TOY_GAME, bench, Number(hours));
  return {
    tier: w.tier,
    label: TIER_LABEL[w.tier] || w.tier,
    rate: w.rate,
    changed: w.changed,
    nowTier: w.nowTier,
    nowLabel: TIER_LABEL[w.nowTier] || w.nowTier,
  };
}

/** The widget. Returns one section; the caller decides where it goes. */
export function renderVerdictToy() {
  const section = el("section", "toy");
  section.setAttribute("aria-label", "Verdict demo");

  const screen = el("div", "toy-screen");
  screen.appendChild(el("p", "toy-kicker", "ATTRACT MODE"));

  const head = el("div", "toy-head");
  // The cover is decorative: the heading beside it already carries the name.
  const cover = el("img", "toy-cover");
  cover.src = TOY_GAME.cover;
  cover.alt = "";
  head.appendChild(cover);
  const titles = el("div", "toy-titles");
  titles.appendChild(el("h2", "toy-title", TOY_GAME.name));
  // The price is part of the demo's arithmetic — it is what makes 0h read
  // "Untouched" and 53h "Worth it" — so it is shown, not left implicit.
  titles.appendChild(el("p", "toy-price", `₹${TOY_GAME.price.toLocaleString("en-IN")}`));
  head.appendChild(titles);
  // Existing `badge badge-<tier>` convention: the tier colours are already
  // contrast-audited and re-themed by the light-theme block, so the toy gets
  // both for free instead of inventing a parallel palette.
  const badge = el("span", "badge");
  badge.id = "toy-badge";
  badge.setAttribute("role", "status");
  head.appendChild(badge);
  screen.appendChild(head);

  const stats = el("div", "toy-stats");
  const rate = el("p", "toy-rate");
  rate.id = "toy-rate";
  stats.appendChild(rate);
  const note = el("p", "toy-note");
  note.id = "toy-note";
  stats.appendChild(note);
  screen.appendChild(stats);

  const control = el("div", "toy-control");
  const label = el("label", "toy-label", "HOURS PLAYED");
  label.id = "toy-label";
  label.htmlFor = "toy-hours";
  const out = el("output", "toy-out");
  out.id = "toy-out";
  out.htmlFor = "toy-hours";
  label.appendChild(out);
  control.appendChild(label);

  const range = el("input", "toy-range");
  range.id = "toy-hours";
  range.type = "range";
  range.min = String(TOY_MIN);
  range.max = String(TOY_MAX);
  range.step = "1";
  range.value = String(TOY_DEFAULT);
  range.dataset.action = "toy";
  range.setAttribute("aria-label", "Hours played in the demo game");
  control.appendChild(range);

  const scale = el("div", "toy-scale");
  scale.appendChild(el("span", null, "0 · never opened"));
  scale.appendChild(el("span", null, "60 hours"));
  control.appendChild(scale);
  screen.appendChild(control);

  screen.appendChild(el("p", "toy-hint",
    "Drag it. Same engine that judges your library — no sign-up, no key."));

  section.appendChild(screen);
  // Paint from references, not getElementById: the section is not in the
  // document yet, so an id lookup would find nothing and the badge would ship
  // blank until the first drag.
  paintVerdictToy(TOY_DEFAULT, { badge, rate, note, out });
  return section;
}

/** Repaint in place from a playtime. Deliberately does not re-render the page:
 *  rebuilding mid-drag would pull the thumb out from under the pointer.
 *  `refs` is how the builder paints before attachment; after that the delegated
 *  input handler resolves the nodes by id. */
export function paintVerdictToy(hours, refs = {}) {
  const s = toyState(hours);
  const badge = refs.badge || document.getElementById("toy-badge");
  if (badge) {
    badge.className = `badge badge-${s.tier}`;
    badge.dataset.tier = s.tier;
    badge.textContent = s.label;
  }
  const rate = refs.rate || document.getElementById("toy-rate");
  if (rate) rate.textContent = s.rate == null ? "—" : `₹${s.rate.toFixed(2)} / hour`;

  const note = refs.note || document.getElementById("toy-note");
  if (note) {
    // Three frames, in order of how much they explain: the default state says
    // what is wrong with the game, a flip says what the drag just changed, and
    // an unchanged tier still reports the rate rather than going blank.
    note.textContent = s.tier === "untouched"
      ? `${TOY_GAME.name} · bought, never opened`
      : s.changed
        ? `${s.nowLabel} at ${TOY_GAME.hours}h → ${s.label} at ${hours}h`
        : `still ${s.label}, ${s.rate == null ? "—" : `₹${s.rate.toFixed(2)}/hour`}`;
  }
  const out = refs.out || document.getElementById("toy-out");
  if (out) out.textContent = `${hours}h`;
}
