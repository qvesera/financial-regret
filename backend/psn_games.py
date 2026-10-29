"""
GET /api/psn_games   headers: X-PSN-Token, X-PSN-Refresh

Fetches the played-title list for a PSN account via the community gamelist
endpoint (m.np.playstation.com/api/gamelist/v2/users/me/titles), the same one
psn-api uses. Auto-refreshes the access token if it has expired.

Two honest limits, both upstream:
  * Only *played* titles come back. Sony's API exposes no owned-but-never-
    opened list, so PSN contributes no backlog -- only games with real hours.
  * Playtime arrives as an ISO-8601 duration ("PT228H56M33S"). It is parsed
    to hours here; a title with no duration reports null, never 0.

IsThereAnyDeal has no PlayStation Store catalog, so pricing comes from a
different provider -- PlatPrices (see psn_prices.py), which joins on the PSN
title id. That id is passed through below so the client can route each row to
the right source without another gamelist request.
"""
import json
import re
from http.server import BaseHTTPRequestHandler

import requests

from _common import send_json, handle_options

GAMES_URL = "https://m.np.playstation.com/api/gamelist/v2/users/me/titles"
AUTH_BASE = "https://ca.account.sony.com/api/authz/v3/oauth"
# Same public PlayStation App client as psn_exchange.py.
BASIC = "MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
SCOPE = "psn:mobile.v2.core psn:clientapp"
PAGE_SIZE = 100
MAX_PAGES = 50          # safety cap; 50 x 100 = 5000 titles

# PT228H56M33S / PT1H2M / PT45M / P1DT2H -- all legal ISO-8601 durations.
_DUR = re.compile(
    r"^P(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?(?:(?P<s>\d+(?:\.\d+)?)S)?)?$"
)


def iso8601_to_hours(raw) -> float | None:
    """ISO-8601 duration string -> hours. Returns None for anything unparseable
    (never 0 -- an unknown playtime must stay out of every ratio)."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    m = _DUR.match(raw.strip())
    if not m:
        return None
    days = float(m.group("d") or 0)
    hours = float(m.group("h") or 0)
    mins = float(m.group("m") or 0)
    secs = float(m.group("s") or 0)
    total = days * 24 + hours + mins / 60 + secs / 3600
    if total <= 0:
        return None
    # Round for display, but never let a real (tiny) playtime collapse to 0.0:
    # the app reads a bare 0 as "definitely never played" and would compute
    # price / 0 = Infinity for the per-hour rate. A 5-minute game floors at 0.1
    # -- still "unplayed" (<1h) for every verdict, never a division by zero.
    return max(round(total, 1), 0.1)


def refresh_access_token(refresh_token: str) -> dict | None:
    resp = requests.post(
        f"{AUTH_BASE}/token",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {BASIC}",
        },
        data={
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
            "token_format": "jwt",
            "scope": SCOPE,
        },
        timeout=20,
    )
    if resp.status_code != 200:
        return None
    return resp.json()


def fetch_titles(access_token: str) -> tuple[list[dict], int]:
    """All played titles (paginated). Returns (titles, total_seen)."""
    titles: list[dict] = []
    offset = 0
    total = 0
    for _ in range(MAX_PAGES):
        resp = requests.get(
            GAMES_URL,
            params={"limit": PAGE_SIZE, "offset": offset},
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            timeout=20,
        )
        if resp.status_code != 200:
            break
        data = resp.json()
        page = data.get("titles") or []
        titles.extend(page)
        total = data.get("totalItemCount") or total
        nxt = data.get("nextOffset")
        if not page or nxt is None or nxt == offset or len(titles) >= total:
            break
        offset = nxt
    return titles, total


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        access_token = self.headers.get("X-PSN-Token")
        refresh_token = self.headers.get("X-PSN-Refresh")
        if not access_token:
            send_json(self, 400, {"error": "Missing X-PSN-Token header"})
            return

        new_tokens = None
        try:
            titles, _total = fetch_titles(access_token)
        except requests.RequestException:
            titles = []

        # An expired access token comes back as a non-200 (usually 401/403) and
        # an empty page -- refresh once, then retry.
        if not titles and refresh_token:
            refreshed = refresh_access_token(refresh_token)
            if refreshed and refreshed.get("access_token"):
                access_token = refreshed["access_token"]
                new_tokens = {
                    "access_token": refreshed["access_token"],
                    "refresh_token": refreshed.get("refresh_token") or refresh_token,
                }
                try:
                    titles, _total = fetch_titles(access_token)
                except requests.RequestException:
                    titles = []

        games = []
        for t in titles:
            name = t.get("name") or t.get("localizedName") or "PlayStation game"
            title_id = t.get("titleId") or ""
            games.append({
                "id": f"PSN:{title_id or name}",
                "name": name,
                "platform": "PlayStation",
                # PlatPrices joins on exactly this id (its `NpTitleId`), so pass it
                # through rather than forcing a second lookup by title.
                "titleId": title_id or None,
                "hours": iso8601_to_hours(t.get("playDuration")),
            })

        result = {"games": games}
        if new_tokens:
            result["new_tokens"] = new_tokens
        send_json(self, 200, result)
