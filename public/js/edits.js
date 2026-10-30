/** Manual edits: what the visitor says they paid, and how long they played.
 *
 *  Pure — no DOM, no I/O — so the pipeline that consumes them is testable
 *  without a browser and the dashboard and the export cannot disagree. An edit
 *  is a number typed over the store's own figure. It is never sent anywhere: it
 *  lives in this browser only, which is also why it is not portable.
 */

/** Typo guards, not business rules: past these a number means the box was
 *  misread, not that someone owns something absurd. */
const MAX_PRICE = 1e9;
const MAX_HOURS = 1e6;

/**
 * Read one field out of an edit box.
 *
 * @returns {{ok: true, value: number|null} | {ok: false, why: string}}
 *   An empty box clears the override (value null); anything that is not a
 *   non-negative figure is refused with a message the caller can show.
 */
export function parseEdit(field, raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (text === "") return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, why: field === "price" ? "Enter a price of 0 or more." : "Enter hours of 0 or more." };
  }
  if (value > (field === "price" ? MAX_PRICE : MAX_HOURS)) {
    return { ok: false, why: field === "price" ? "That price is not believable." : "Those hours are not believable." };
  }
  return { ok: true, value };
}

/**
 * Layer the visitor's edits over a freshly fetched library.
 *
 * Effective rows and the effective price map come back together, because both
 * are read downstream — the metrics take the rows, the table, the pies, the
 * drawer and the verdict carousel take the map — and a half-applied edit is
 * exactly the bug this seam exists to prevent.
 *
 * Two invariants make it safe to call on every render:
 *
 *  - The API price comes from the raw map whenever it carries the id, and from
 *    an already-captured `apiPrice` otherwise — never from `g.price`, which may
 *    already be an effective value. That is what stops clearing an override
 *    from leaving the override behind, and what keeps a currency reprice honest.
 *  - `apiHours` is captured the first time a row is seen and then reused: it is
 *    the only copy of the store's playtime that survives an override, so
 *    clearing one restores the store's number with no network call.
 *
 * @param {Array} rows      library rows (any effective values already on them
 *                          are recomputed, never trusted)
 * @param {Object} prices   the raw price map, as the store priced it
 * @param {Object} edits    {id: {price?, hours?, currency?}}
 * @param {string} currency the display currency, for the stale-currency flag
 */
export function applyEdits(rows, prices, edits, currency) {
  const raw = prices || {};
  const out = { ...raw };
  const games = (rows || []).map((g) => {
    const e = edits && edits[g.id];
    // Untouched rows are returned as they came — no copy, no work. An edited
    // row is always rebuilt from the store's own figures first and the
    // visitor's laid on top, which is what makes clearing an override restore
    // them with no re-fetch rather than leaving the override behind.
    if (!e && !g.edited) return g;
    const apiHours = g.apiHours === undefined ? g.hours : g.apiHours;
    const apiPrice = g.id in raw
      ? raw[g.id]
      : (g.apiPrice === undefined ? g.price : g.apiPrice);
    const next = { ...g, apiHours, apiPrice, price: apiPrice, hours: apiHours };
    delete next.edited;
    delete next.priceCurrency;
    delete next.priceStaleCurrency;
    if (!e) return next;
    if ("price" in e) {
      next.price = e.price;
      next.priceCurrency = e.currency || null;
      // A price entered in another display currency is still the visitor's
      // number — there is no FX in the app to move it — so it is flagged for
      // the drawer to name rather than silently relabelled.
      next.priceStaleCurrency = Boolean(e.currency && currency && e.currency !== currency);
      if (e.price !== null) out[g.id] = e.price;
    }
    if ("hours" in e) next.hours = e.hours;
    next.edited = true;
    return next;
  });
  return { games, prices: out };
}