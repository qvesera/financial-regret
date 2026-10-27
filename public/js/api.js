/** API clients. All tokens travel in headers or JSON bodies — never in URLs. */

export async function fetchConfig() {
  const resp = await fetch("/api/config");
  if (!resp.ok) throw new Error(`config ${resp.status}`);
  return resp.json();
}

export async function fetchSteamGames(steamId) {
  const steamKey = localStorage.getItem("steam_api_key");
  const resp = await fetch(`/api/steam_games?steamid=${encodeURIComponent(steamId)}`,
    steamKey ? { headers: { "X-Steam-Key": steamKey } } : {});
  if (!resp.ok) throw new Error(`steam_games ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.games || [];
}

export async function fetchGogGames() {
  const accessToken = localStorage.getItem("gog_access_token");
  const refreshToken = localStorage.getItem("gog_refresh_token");
  const userId = localStorage.getItem("gog_user_id");
  if (!accessToken) return [];

  const resp = await fetch("/api/gog_games", {
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

  const url = cursor
    ? `/api/epic_games?cursor=${encodeURIComponent(cursor)}`
    : "/api/epic_games";
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

export async function fetchPrices(games, currency = "INR") {
  const BATCH_SIZE = 200;
  const prices = {};
  let actual = currency;

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
    const resp = await fetch("/api/prices", {
      method: "POST",
      headers,
      body: JSON.stringify({ games: batch, currency }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    Object.assign(prices, data.prices || {});
    // The server reports the currency the amounts are actually in (ITAD's own
    // label) so the UI symbol always matches the numbers.
    if (data.currency) actual = data.currency;
  }

  return { prices, currency: actual };
}

export async function exchangeGog(code, redirectUri) {
  const resp = await fetch("/api/gog_exchange", {
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
  const resp = await fetch("/api/epic_exchange", {
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
      return u.searchParams.get("code") || u.searchParams.get("authorizationCode") || "";
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
  const resp = await fetch(`/api/steam_verify${queryString}`);
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
