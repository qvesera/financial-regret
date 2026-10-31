/** API clients. All tokens travel in headers or JSON bodies — never in URLs.
 *  The only values that ride a query string are public account identifiers
 *  (steamid, onlineId): a PSN online ID is profile data anybody can look up,
 *  not a credential, which is why PlayStation sends nothing secret at all. */

import { API_BASE } from "./env.js";

/**
 * Resolve an API path against the configured backend.
 *
 * Empty API_BASE keeps every URL relative, which is the dev-server default:
 * server.py serves public/ and /api from one process, so there is nothing to
 * configure. A split deploy prefixes the API host instead. Routing every call
 * through here is what makes that a one-line change rather than thirteen.
 */
export const apiUrl = (path) => `${API_BASE}${path}`;

export async function fetchConfig() {
  const resp = await fetch(apiUrl("/api/config"));
  if (!resp.ok) throw new Error(`config ${resp.status}`);
  return resp.json();
}

export async function fetchSteamGames(steamId) {
  const steamKey = localStorage.getItem("steam_api_key");
  const resp = await fetch(apiUrl(`/api/steam_games?steamid=${encodeURIComponent(steamId)}`),
    steamKey ? { headers: { "X-Steam-Key": steamKey } } : {});
  if (!resp.ok) throw new Error(`steam_games ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  // persona: the account's display name, for signing shared cards.
  return { games: data.games || [], persona: data.persona || null };
}

export async function fetchGogGames() {
  const accessToken = localStorage.getItem("gog_access_token");
  const refreshToken = localStorage.getItem("gog_refresh_token");
  const userId = localStorage.getItem("gog_user_id");
  if (!accessToken) return [];

  const resp = await fetch(apiUrl("/api/gog_games"), {
    headers: {
      "X-GOG-Token": accessToken,
      "X-GOG-Refresh": refreshToken || "",
      "X-GOG-User-Id": userId || "",
    },
  });
  if (resp.status === 401) return []; // relink needed
  if (!resp.ok) throw new Error(`gog_games ${resp.status}`);
  const data = await resp.json();
  if (data.new_tokens) {
    localStorage.setItem("gog_access_token", data.new_tokens.access_token);
    localStorage.setItem("gog_refresh_token", data.new_tokens.refresh_token);
  }
  return data.games || [];
}

/** One page of the Epic library; follow `nextCursor` until it comes back null. */
export async function fetchEpicGames(cursor = null) {
  const accessToken = localStorage.getItem("epic_access_token");
  const refreshToken = localStorage.getItem("epic_refresh_token");
  const accountId = localStorage.getItem("epic_account_id");
  if (!accessToken) return { games: [], nextCursor: null, filtered: 0 };

  const url = apiUrl(cursor
    ? `/api/epic_games?cursor=${encodeURIComponent(cursor)}`
    : "/api/epic_games");
  const resp = await fetch(url, {
    headers: {
      "X-Epic-Token": accessToken,
      "X-Epic-Refresh": refreshToken || "",
      "X-Epic-Account-Id": accountId || "",
    },
  });
  if (resp.status === 401) return { games: [], nextCursor: null, filtered: 0 }; // relink needed
  if (resp.status === 429) throw new Error("Epic: rate limited — wait a minute, then rescan");
  if (!resp.ok) throw new Error(`epic_games ${resp.status}`);
  const data = await resp.json();
  if (data.new_tokens) {
    localStorage.setItem("epic_access_token", data.new_tokens.access_token);
    localStorage.setItem("epic_refresh_token", data.new_tokens.refresh_token);
  }
  return { games: data.games || [], nextCursor: data.next_cursor || null, filtered: data.filtered_count || 0 };
}

/**
 * Prices for a mixed batch, from whichever source can actually answer it.
 *
 * Every store except PlayStation is priced by IsThereAnyDeal, whose catalog has
 * no PlayStation Store at all -- so PSN rows sent there always come back empty.
 * PlatPrices covers PSN instead, and it keys on the PSN title id, so the batch
 * is split by platform rather than quietly pricing nothing.
 */
export async function fetchPrices(games, currency = "INR") {
  const psn = games.filter((g) => g.platform === "PlayStation" && g.titleId);
  const rest = psn.length ? games.filter((g) => !psn.includes(g)) : games;

  const out = { prices: {}, highs: {}, lows: {}, currency, attribution: null, psnReason: null, limited: {} };
  const merge = (part) => {
    if (!part) return;
    Object.assign(out.prices, part.prices || {});
    Object.assign(out.highs, part.highs || {});
    Object.assign(out.lows, part.lows || {});
    if (part.currency) out.currency = part.currency;
    // Only PlatPrices sets one; it must survive the merge or the UI can never
    // show the credit the free plans require.
    if (part.attribution) out.attribution = part.attribution;
    // Why PlayStation pricing came back empty, if it did -- the difference
    // between "no key saved here" and "the store has no price for this".
    if (part.psnReason) out.psnReason = part.psnReason;
    // Which shared key refused this batch, kept per provider: one call can
    // report a spent ITAD key while its PlayStation half answered fine.
    if (part.limited) Object.assign(out.limited, part.limited);
  };

  if (rest.length) merge(await fetchItadPrices(rest, currency));
  if (psn.length) {
    try {
      merge(await fetchPsnPrices(psn, currency));
    } catch {
      /* pricing is optional: PSN rows just stay "Unpriced" */
    }
  }
  return out;
}

/**
 * PlayStation Store prices from PlatPrices, batched by PSN title id. Returns
 * nulls for titles the store does not carry, so they still render as "Unpriced"
 * rather than being dropped from the batch.
 */
export async function fetchPsnPrices(games, currency = "INR") {
  const BATCH_SIZE = 200;
  const prices = {};
  const highs = {};
  const lows = {};
  let actual = currency;
  let attribution = null;
  let reason = null;
  const limited = {};

  const headers = { "Content-Type": "application/json" };
  // Same pattern as the ITAD key: a user-supplied key carries their own quota.
  const platpricesKey = localStorage.getItem("platprices_api_key");
  if (platpricesKey) headers["X-Platprices-Key"] = platpricesKey;

  for (let i = 0; i < games.length; i += BATCH_SIZE) {
    const batch = games.slice(i, i + BATCH_SIZE).map((g) => ({
      id: g.id,
      titleId: g.titleId,
    }));
    const resp = await fetch(apiUrl("/api/psn_prices"), {
      method: "POST",
      headers,
      body: JSON.stringify({ games: batch, currency }),
    });
    if (resp.status === 429) { limited.platprices = true; continue; }
    if (!resp.ok) continue;
    const data = await resp.json();
    Object.assign(prices, data.prices || {});
    Object.assign(highs, data.highs || {});
    Object.assign(lows, data.lows || {});
    if (data.currency) actual = data.currency;
    if (data.attribution) attribution = data.attribution;
    if (data.reason) reason = data.reason;
    if (data.limited) Object.assign(limited, data.limited);
  }

  return { prices, highs, lows, currency: actual, attribution, psnReason: reason, limited };
}

/** IsThereAnyDeal prices for the non-PlayStation stores. */
async function fetchItadPrices(games, currency = "INR") {
  const BATCH_SIZE = 200;
  const prices = {};
  const highs = {};
  const lows = {};
  let actual = currency;
  const limited = {};

  for (let i = 0; i < games.length; i += BATCH_SIZE) {
    const batch = games.slice(i, i + BATCH_SIZE).map((g) => ({
      id: g.id,
      title: g.name,
      appid: g.platform === "Steam" ? g.appid : null,
      platform: g.platform,
    }));
    const headers = { "Content-Type": "application/json" };
    const itadKey = localStorage.getItem("itad_api_key");
    if (itadKey) headers["X-ITAD-Key"] = itadKey;
    const resp = await fetch(apiUrl("/api/prices"), {
      method: "POST",
      headers,
      body: JSON.stringify({ games: batch, currency }),
    });
    // Our own per-IP limiter answers 429: that is a limit too, and silently
    // dropping it would leave prices blank with no explanation at all.
    if (resp.status === 429) { limited.itad = true; continue; }
    if (!resp.ok) continue;
    const data = await resp.json();
    Object.assign(prices, data.prices || {});
    Object.assign(highs, data.highs || {});
    Object.assign(lows, data.lows || {});
    // The server reports the currency the amounts are actually in (ITAD's own
    // label) so the UI symbol always matches the numbers.
    if (data.currency) actual = data.currency;
    if (data.limited) Object.assign(limited, data.limited);
  }

  return { prices, highs, lows, currency: actual, limited };
}

export async function exchangeGog(code, redirectUri) {
  const resp = await fetch(apiUrl("/api/gog_exchange"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "GOG exchange failed");
  }
  return resp.json();
}

export async function exchangeEpic(code) {
  const resp = await fetch(apiUrl("/api/epic_exchange"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "Epic exchange failed");
  }
  return resp.json();
}

/** Accept a bare auth code, or a pasted JSON blob containing one. */
export function parseAuthCode(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return u.searchParams.get("code") || u.searchParams.get("authorizationCode")
        || u.searchParams.get("openid.oa2.authorization_code") || "";
    } catch {
      return "";
    }
  }
  if (/^[A-Za-z0-9._~-]{16,}$/.test(t)) return t;
  try {
    const obj = JSON.parse(t);
    return obj.authorizationCode || obj.code || "";
  } catch {
    const m = t.match(/"authorizationCode"\s*:\s*"([^"]+)"/) || t.match(/"code"\s*:\s*"([^"]+)"/);
    return m ? m[1] : "";
  }
}

export async function verifySteam(queryString) {
  const resp = await fetch(apiUrl(`/api/steam_verify${queryString}`));
  if (!resp.ok) throw new Error(`steam_verify ${resp.status}`);
  return resp.json();
}

/**
 * The one redirect URI registered for GOG's public Galaxy client.
 * GOG rejects any other origin at /auth time with "redirect_uri_mismatch",
 * so the login lands the user on embed.gog.com with ?code=... and the app
 * collects that URL via paste (same pattern as Epic).
 */
export const GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";

export async function loginGog() {
  const state = crypto.randomUUID();
  sessionStorage.setItem("gog_oauth_state", state);
  const params = new URLSearchParams({
    client_id: "46899977096215655",
    redirect_uri: GOG_REDIRECT_URI,
    response_type: "code",
    layout: "client2",
    state,
  });
  return `https://auth.gog.com/auth?${params.toString()}`;
}

/**
 * The redirect URL registered for Epic's launcher client — the same public
 * client credentials legendary ships. Epic rejects anything else with
 * "Redirect URL is not known to the client". It lands the user on
 * epicgames.com's own JSON page carrying ?authorizationCode=..., so — like
 * GOG — the code is collected via paste instead of a server callback.
 */
export const EPIC_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
export const EPIC_REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${EPIC_CLIENT_ID}&responseType=code`;

/** Epic login URL; redirectUrl must match the client's allowlist exactly. */
export function loginEpic() {
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(EPIC_REDIRECT_URL)}`;
}

/** Steam OpenID 2.0 checkid_setup URL. Steam redirects back to returnTo. */
export function loginSteam(returnTo) {
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": new URL(returnTo).origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `https://steamcommunity.com/openid/login?${params.toString()}`;
}

/** PKCE helpers for Amazon's device sign-in (base64url, unpadded). */
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function asciiHex(str) {
  return [...new TextEncoder().encode(str)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Amazon device (PKCE) login URL — the same undocumented flow the Amazon Games
 * launcher and Nile use: an OpenID signin whose code_challenge is SHA-256 of a
 * random verifier and whose client_id is hex(serial + "#A2UMVHOX7UP4V7").
 * There is no public Amazon library API, so this registers a virtual launcher
 * device. The verifier/serial are stashed for the exchange; Amazon redirects to
 * its own domain carrying openid.oa2.authorization_code, collected via paste.
 */
export async function loginAmazon() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = b64url(new Uint8Array(digest));
  const serial = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  const clientId = asciiHex(`${serial}#A2UMVHOX7UP4V7`);
  sessionStorage.setItem("amazon_pkce", JSON.stringify({ clientId, verifier, serial }));
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.mode": "checkid_setup",
    "openid.oa2.scope": "device_auth_access",
    "openid.ns.oa2": "http://www.amazon.com/ap/ext/oauth/2",
    "openid.oa2.response_type": "code",
    "openid.oa2.code_challenge_method": "S256",
    "openid.oa2.client_id": `device:${clientId}`,
    language: "en_US",
    marketPlaceId: "ATVPDKIKX0DER",
    "openid.return_to": "https://www.amazon.com",
    "openid.pape.max_auth_age": 0,
    "openid.assoc_handle": "amzn_sonic_games_launcher",
    pageId: "amzn_sonic_games_launcher",
    "openid.oa2.code_challenge": challenge,
  });
  return { url: `https://amazon.com/ap/signin?${params.toString()}` };
}

/** Exchange the pasted Amazon code for a device bearer token (server-side). */
export async function exchangeAmazon(payload) {
  const resp = await fetch(apiUrl("/api/amazon_exchange"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || "Amazon exchange failed");
  }
  return resp.json();
}

/** Owned Amazon Games titles. Playtime is unavailable, so `hours` is null. */
export async function fetchAmazonGames() {
  const token = localStorage.getItem("amazon_access_token");
  const serial = localStorage.getItem("amazon_serial");
  if (!token) return [];
  const resp = await fetch(apiUrl("/api/amazon_games"), {
    headers: { "X-Amazon-Token": token, "X-Amazon-Serial": serial || "" },
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `amazon_games ${resp.status}`);
  }
  return (await resp.json()).games || [];
}

/**
 * Played PSN titles, with real playtime.
 *
 * PlayStation takes no approval screen and this app accepts no PlayStation
 * credential — the visitor's public online ID is the whole request, and the
 * server reads the profile's playtime with the operator's own reader account
 * (PSN_REFRESH_TOKEN). Nothing to paste, nothing handed over.
 *
 * Sony exposes no owned-but-unplayed list, so this is played-only. Prices are
 * fetched separately by title id, in fetchPsnPrices.
 */
export async function fetchPsnGames() {
  const onlineId = localStorage.getItem("psn_online_id");
  if (!onlineId) return [];
  const resp = await fetch(apiUrl(`/api/psn_games?onlineId=${encodeURIComponent(onlineId)}`));
  // A 404 (typo, or a deleted profile) must not read as "no games": the scan
  // step shows the server's sentence instead.
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `psn_games ${resp.status}`);
  }
  const data = await resp.json();
  if (data.reason === "empty" || data.reason === "no_titles") {
    // 200 with nothing behind it. Failing the scan step with the reason beats
    // a silent blank library: either nothing was ever played, or the profile
    // hides its gaming history and the visitor can go and open it.
    throw new Error("That PlayStation profile returned no played titles. Either "
      + "your account has played nothing this endpoint covers — it lists PS4, "
      + "PS5 and PC titles only, so PS3/Vita-era play never appears — or “Who "
      + "can see your gaming history” is set to No one (PS5: Settings → Users "
      + "and Accounts → Privacy → Gaming | Media): set it to Anyone and scan again.");
  }
  return data.games || [];
}
