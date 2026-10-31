/** Client-side persistence: credentials (localStorage) and scan snapshot. */

const CRED_KEYS = ["steam_id", "gog_access_token", "gog_refresh_token", "gog_user_id", "epic_access_token", "epic_refresh_token", "epic_account_id", "amazon_access_token", "amazon_refresh_token", "amazon_serial", "psn_online_id", "psn_access_token", "psn_refresh_token", "platprices_api_key", "itad_api_key", "steam_api_key", "sgdb_api_key"];

export const store = {
  /** Credentials */
  get(key) { return localStorage.getItem(key); },
  set(key, value) { localStorage.setItem(key, value); },
  remove(key) { localStorage.removeItem(key); },
  clearCredentials() { CRED_KEYS.forEach((k) => localStorage.removeItem(k)); },

  /** Manual edits the visitor typed over a store's own figures:
   *  {gameId: {price?, hours?, currency?}}. Their own key, so a snapshot
   *  refresh never disturbs them and "forget" can take them with it. */
  getEdits() {
    try { return JSON.parse(localStorage.getItem("game_edits") || "{}"); }
    catch { return {}; }
  },
  /** Patch one field of one edit. A null value deletes that field, and an edit
   *  with nothing left in it disappears rather than lingering as a husk. */
  setEdit(id, patch) {
    const edits = this.getEdits();
    const next = { ...(edits[id] || {}), ...patch };
    for (const key of Object.keys(next)) if (next[key] == null) delete next[key];
    if (Object.keys(next).length) edits[id] = next;
    else delete edits[id];
    localStorage.setItem("game_edits", JSON.stringify(edits));
    return edits;
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
    localStorage.removeItem("paid_overrides");   // legacy "what I paid" entries
    localStorage.removeItem("game_edits");       // the visitor's own figures
    localStorage.removeItem("covers_cache");     // derived cover-art urls
    this.clearSnapshot();
  },
};
