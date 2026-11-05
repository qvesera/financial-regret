/** PlayStation Plus spend arithmetic. Pure: no DOM, no fetch, no network.
 *
 *  What it produces is an UPPER BOUND, and it is labelled as one wherever it
 *  is shown: whole months since the account's first played title, billed
 *  monthly at today's Essential price for every one of them. Annual plans cost
 *  less, Sony's prices were lower for most of that period, and PS3/Vita-era
 *  play is invisible to the scan -- so the true figure sits below this number,
 *  never above it. That is the whole reason the card says "at most".
 *
 *  Nothing here is ever stored as a visitor's own figure. Their total, if they
 *  entered one, always wins over this; the estimate exists only for the card. */

/** Whole calendar months from `fromIso` to `toIso`.
 *  Returns null for anything unparseable, and 0 when the end is not after the
 *  start -- a same-month start has no elapsed months to price yet. */
export function monthsBetween(fromIso, toIso = new Date().toISOString()) {
  // Type-checked before parsing: `new Date(null)` is a perfectly valid epoch
  // date, so a null start would otherwise price 56 years of subscription.
  if (typeof fromIso !== "string" || typeof toIso !== "string") return null;
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (to <= from) return 0;
  let months = (to.getFullYear() - from.getFullYear()) * 12
    + (to.getMonth() - from.getMonth());
  // A start on the 25th has not completed its month until the 25th of the
  // later one; without this a 25th-to-10th span counts a month never paid.
  if (to.getDate() < from.getDate()) months -= 1;
  return Math.max(months, 0);
}

/** {months, total} for the "at most" figure, or null when any input is
 *  missing or unusable -- a null here must read as "show nothing", never as
 *  a zero, because a zero would be a claim too. */
export function estimatePlusSpend({ firstPlayed, monthlyPrice, now } = {}) {
  if (typeof firstPlayed !== "string" || !firstPlayed.trim()) return null;
  if (typeof monthlyPrice !== "number" || !Number.isFinite(monthlyPrice)
      || monthlyPrice <= 0) return null;
  const months = monthsBetween(firstPlayed, now);
  if (months == null || months < 1) return null;
  return { months, total: Math.round(months * monthlyPrice * 100) / 100 };
}
