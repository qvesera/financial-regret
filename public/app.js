const GOG_CLIENT_ID = "46899977096215655";
const GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";
const EPIC_CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";

// ---------- Steam linking ----------

function steamLoginUrl() {
  const returnTo = `${window.location.origin}/steam-callback.html`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": window.location.origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `https://steamcommunity.com/openid/login?${params.toString()}`;
}

function refreshSteamUI() {
  const steamId = localStorage.getItem("steam_id");
  const statusEl = document.getElementById("steam-status");
  const linkBtn = document.getElementById("steam-link-btn");
  const unlinkBtn = document.getElementById("steam-unlink-btn");

  if (steamId) {
    statusEl.textContent = "linked";
    statusEl.className = "status linked";
    linkBtn.hidden = true;
    unlinkBtn.hidden = false;
  } else {
    statusEl.textContent = "not linked";
    statusEl.className = "status pending";
    linkBtn.hidden = false;
    unlinkBtn.hidden = true;
  }
}

document.getElementById("steam-link-btn").addEventListener("click", (e) => {
  e.preventDefault();
  window.location.href = steamLoginUrl();
});

document.getElementById("steam-unlink-btn").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("steam_id");
  refreshSteamUI();
});

// ---------- GOG linking ----------

function gogLoginUrl() {
  const params = new URLSearchParams({
    client_id: GOG_CLIENT_ID,
    redirect_uri: GOG_REDIRECT_URI,
    response_type: "code",
    layout: "client2",
  });
  return `https://auth.gog.com/auth?${params.toString()}`;
}

function refreshGogUI() {
  const token = localStorage.getItem("gog_access_token");
  const statusEl = document.getElementById("gog-status");
  const linkBtn = document.getElementById("gog-link-btn");
  const unlinkBtn = document.getElementById("gog-unlink-btn");

  if (token) {
    statusEl.textContent = "linked";
    statusEl.className = "status linked";
    linkBtn.hidden = true;
    unlinkBtn.hidden = false;
  } else {
    statusEl.textContent = "not linked";
    statusEl.className = "status pending";
    linkBtn.hidden = false;
    unlinkBtn.hidden = true;
  }
}

document.getElementById("gog-link-btn").addEventListener("click", (e) => {
  e.preventDefault();
  window.open(gogLoginUrl(), "_blank");
  document.getElementById("gog-code-form").hidden = false;
});

document.getElementById("gog-unlink-btn").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("gog_access_token");
  localStorage.removeItem("gog_refresh_token");
  refreshGogUI();
});

document.getElementById("gog-code-submit").addEventListener("click", async () => {
  const code = document.getElementById("gog-code-input").value.trim();
  const errorEl = document.getElementById("gog-code-error");
  errorEl.hidden = true;

  if (!code) return;

  try {
    const resp = await fetch("/api/gog_exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await resp.json();

    if (data.access_token) {
      localStorage.setItem("gog_access_token", data.access_token);
      localStorage.setItem("gog_refresh_token", data.refresh_token);
      document.getElementById("gog-code-form").hidden = true;
      document.getElementById("gog-code-input").value = "";
      refreshGogUI();
    } else {
      errorEl.textContent = data.error || "Could not link GOG account";
      errorEl.hidden = false;
    }
  } catch (e) {
    errorEl.textContent = `Error: ${e}`;
    errorEl.hidden = false;
  }
});

// ---------- Epic linking ----------

function epicLoginUrl() {
  const redirectUrl = `https://www.epicgames.com/id/api/redirect?clientId=${EPIC_CLIENT_ID}&responseType=code`;
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(redirectUrl)}`;
}

function refreshEpicUI() {
  const token = localStorage.getItem("epic_access_token");
  const statusEl = document.getElementById("epic-status");
  const linkBtn = document.getElementById("epic-link-btn");
  const unlinkBtn = document.getElementById("epic-unlink-btn");

  if (token) {
    statusEl.textContent = "linked";
    statusEl.className = "status linked";
    linkBtn.hidden = true;
    unlinkBtn.hidden = false;
  } else {
    statusEl.textContent = "not linked";
    statusEl.className = "status pending";
    linkBtn.hidden = false;
    unlinkBtn.hidden = true;
  }
}

document.getElementById("epic-link-btn").addEventListener("click", (e) => {
  e.preventDefault();
  window.open(epicLoginUrl(), "_blank");
  document.getElementById("epic-code-form").hidden = false;
});

document.getElementById("epic-unlink-btn").addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("epic_access_token");
  localStorage.removeItem("epic_refresh_token");
  refreshEpicUI();
});

document.getElementById("epic-code-submit").addEventListener("click", async () => {
  const code = document.getElementById("epic-code-input").value.trim();
  const errorEl = document.getElementById("epic-code-error");
  errorEl.hidden = true;

  if (!code) return;

  try {
    const resp = await fetch("/api/epic_exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await resp.json();

    if (data.access_token) {
      localStorage.setItem("epic_access_token", data.access_token);
      localStorage.setItem("epic_refresh_token", data.refresh_token);
      document.getElementById("epic-code-form").hidden = true;
      document.getElementById("epic-code-input").value = "";
      refreshEpicUI();
    } else {
      errorEl.textContent = data.error || "Could not link Epic account";
      errorEl.hidden = false;
    }
  } catch (e) {
    errorEl.textContent = `Error: ${e}`;
    errorEl.hidden = false;
  }
});

// ---------- Scanning ----------

async function fetchSteamGames() {
  const steamId = localStorage.getItem("steam_id");
  if (!steamId) return [];

  const resp = await fetch(`/api/steam_games?steamid=${encodeURIComponent(steamId)}`);
  const data = await resp.json();
  return data.games || [];
}

async function fetchGogGames() {
  const accessToken = localStorage.getItem("gog_access_token");
  const refreshToken = localStorage.getItem("gog_refresh_token");
  if (!accessToken) return [];

  const params = new URLSearchParams({ access_token: accessToken });
  if (refreshToken) params.set("refresh_token", refreshToken);

  const resp = await fetch(`/api/gog_games?${params.toString()}`);
  const data = await resp.json();

  if (data.new_tokens) {
    localStorage.setItem("gog_access_token", data.new_tokens.access_token);
    localStorage.setItem("gog_refresh_token", data.new_tokens.refresh_token);
  }

  return data.games || [];
}

async function fetchEpicGames() {
  const accessToken = localStorage.getItem("epic_access_token");
  const refreshToken = localStorage.getItem("epic_refresh_token");
  if (!accessToken) return [];

  const params = new URLSearchParams({ access_token: accessToken });
  if (refreshToken) params.set("refresh_token", refreshToken);

  const resp = await fetch(`/api/epic_games?${params.toString()}`);
  const data = await resp.json();

  if (data.new_tokens) {
    localStorage.setItem("epic_access_token", data.new_tokens.access_token);
    localStorage.setItem("epic_refresh_token", data.new_tokens.refresh_token);
  }

  return data.games || [];
}

async function fetchPrices(titles) {
  const BATCH_SIZE = 25;
  const prices = {};

  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const resp = await fetch("/api/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titles: batch }),
    });
    const data = await resp.json();
    Object.assign(prices, data.prices || {});
  }

  return prices;
}

function renderResults(games, prices) {
  const tbody = document.getElementById("games-tbody");
  tbody.innerHTML = "";

  let total = 0;
  let pricedCount = 0;

  games.sort((a, b) => a.platform.localeCompare(b.platform));

  for (const game of games) {
    const price = prices[game.name];
    if (typeof price === "number") {
      total += price;
      pricedCount += 1;
    }

    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${game.name}</td>
      <td>${game.platform}</td>
      <td>${typeof price === "number" ? "₹" + price.toFixed(2) : "N/A"}</td>
    `;
    tbody.appendChild(row);
  }

  document.getElementById("total-count").textContent = games.length;
  document.getElementById("total-value").textContent = "₹" + total.toFixed(2);
  document.getElementById("priced-count").textContent = pricedCount;
  document.getElementById("results").hidden = false;
}

document.getElementById("scan-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("scan-status");
  statusEl.hidden = false;
  statusEl.textContent = "Fetching your library...";

  try {
    const [steamGames, gogGames, epicGames] = await Promise.all([
      fetchSteamGames(),
      fetchGogGames(),
      fetchEpicGames(),
    ]);
    const allGames = [...steamGames, ...gogGames, ...epicGames];

    if (allGames.length === 0) {
      statusEl.textContent = "No games found -- link an account above first.";
      return;
    }

    statusEl.textContent = `Found ${allGames.length} games. Looking up prices...`;
    const prices = await fetchPrices(allGames.map((g) => g.name));

    statusEl.hidden = true;
    renderResults(allGames, prices);
  } catch (e) {
    statusEl.textContent = `Error during scan: ${e}`;
  }
});

// ---------- Init ----------

refreshSteamUI();
refreshGogUI();
refreshEpicUI();
