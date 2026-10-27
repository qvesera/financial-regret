/** Client-side persistence: credentials (localStorage), paid overrides, scan snapshot. */

const CRED_KEYS = ["steam_id", "gog_access_token", "gog_refresh_token", "gog_user_id", "epic_access_token", "epic_refresh_token", "epic_account_id", "itad_api_key", "steam_api_key"];

export const store = {
  /** Credentials */
  get(key) { return localStorage.getItem(key); },
  set(key, value) { localStorage.setItem(key, value); },
  remove(key) { localStorage.removeItem(key); },
  clearCredentials() { CRED_KEYS.forEach((k) => localStorage.removeItem(k)); },

  /** Paid overrides: {gameId: amount} */
  getPaidOverrides() {
    try { return JSON.parse(localStorage.getItem("paid_overrides") || "{}"); }
    catch { return {}; }
  },
  setPaidOverride(gameId, amount) {
    const o = this.getPaidOverrides();
    if (amount == null || amount === "") delete o[gameId];
    else o[gameId] = Number(amount);
    localStorage.setItem("paid_overrides", JSON.stringify(o));
  },
  getPaid(gameId) {
    return this.getPaidOverrides()[gameId] ?? null;
  },

  /** Scan snapshot for instant render on refresh (v1 = canonical game shape) */
  setSnapshot(data) {
    localStorage.setItem("last_scan", JSON.stringify({ ...data, at: Date.now(), v: 1 }));
  },
  getSnapshot() {
    try {
      const snap = JSON.parse(localStorage.getItem("last_scan") || "null");
      // v1 rows carry {id, name, platform, hours}; older/failed snapshots are dropped
      return snap && snap.v === 1 ? snap : null;
    } catch { return null; }
  },
  clearSnapshot() { localStorage.removeItem("last_scan"); },

  /** Forget everything (privacy affordance for public hosting) */
  forget() {
    this.clearCredentials();
    localStorage.removeItem("paid_overrides");
    this.clearSnapshot();
  },
};

export function applyPaidOverrides(games) {
  const overrides = store.getPaidOverrides();
  return games.map((g) => ({ ...g, paid: overrides[g.id] ?? null }));
}
