/**
 * Checked-in API origin — no generator and no build step stand behind it.
 *
 * Empty means "same origin", which is how this app ships: Vercel serves
 * public/ and /api from one deployment (vercel.json rewrites /api/* to the
 * single Python function), so there is never a cross-origin hop to name.
 *
 * Edit only if you deliberately split the halves onto different hosts; then
 * this becomes the API origin with no trailing slash.
 *
 * This file holds a URL only. Never put a key here: the bundle ships to
 * everyone, and it is not a secret store.
 */
export const API_BASE = "";
