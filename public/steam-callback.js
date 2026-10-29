(async () => {
  const statusEl = document.getElementById("status");
  const query = window.location.search;

  try {
    const resp = await fetch(`/api/steam_verify${query}`);
    const data = await resp.json();

    if (data.steamid) {
      localStorage.setItem("steam_id", data.steamid);
      statusEl.textContent = "Steam linked! Redirecting...";
      window.location.href = "index.html";
    } else {
      statusEl.textContent = `Could not verify Steam login: ${data.error || "unknown error"}`;
    }
  } catch (e) {
    statusEl.textContent = `Error verifying Steam login: ${e}`;
  }
})();