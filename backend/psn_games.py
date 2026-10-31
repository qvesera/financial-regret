"""
GET /api/psn_games   query: ?onlineId=<PSN online ID>

Reads a PlayStation profile's played-title list and playtime through the
community gamelist endpoint (m.np.playstation.com/api/gamelist/v2/users/{id}/titles),
the same one psn-api uses.

There is no visitor credential and no route that accepts one. The server holds
PSN_REFRESH_TOKEN -- minted once by scripts/psn_login.py from the *operator's*
own NPSSO, on the operator's machine -- and reads what the profile already
shows publicly:

  1. onlineId -> accountId via profile2 (us-prof...), asked first with **no
     Authorization at all**: it is a public read, and spending no token on it
     is also what keeps a reader account's quota for the gamelist itself. The
     same route with a Bearer is the fallback.
  2. gamelist/v2/users/{accountId}/titles, paged.

Two honest limits, both upstream:
  * Only *played* titles come back. Sony exposes no owned-but-never-opened
    list, so PSN contributes no backlog -- only games with real hours.
  * Only PS4, PS5 and PC titles are in this endpoint at all: `category` is
    ps4_game | ps5_native_game | pspc_game | unknown, so an account whose play
    is all PS3/Vita-era answers with nothing, same as a private profile. Both
    report reason "empty"; the UI names both causes rather than blaming the
    privacy switch alone.
  * A profile whose "Who can see your gaming history" is not Anyone answers
    200 with totalItemCount=0, indistinguishable from an account that has
    played nothing.

Playtime arrives as an ISO-8601 duration ("PT228H56M33S") and is parsed to
hours here; a title with no duration reports null, never 0.

IsThereAnyDeal has no PlayStation Store catalog, so pricing comes from a
different provider -- PlatPrices (see psn_prices.py), which joins on the PSN
title id. That id is passed through below so the client can route each row to
the right source without another gamelist request.
"""
import os
import re
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

from _common import send_json, handle_options
from _psn_auth import refresh_tokens

GAMES_URL = "https://m.np.playstation.com/api/gamelist/v2/users/{}/titles"
PROFILE_URL = ("https://us-prof.np.community.playstation.net/userProfile/v1/users/"
               "{}/profile2")
PROFILE_FIELDS = "accountId,onlineId"
PAGE_SIZE = 100
MAX_PAGES = 50          # safety cap; 50 x 100 = 5000 titles
# Sony's own rule for this endpoint (probe, 2026): limit above 200 -> 400.
MAX_LIMIT = 200
# An Online ID is 2-16 characters of letters, digits, spaces, dot, dash or
# underscore. Checked before it reaches a URL path -- an unvalidated value here
# would let "/../" walk out of the accountId slot, which is upstream path
# traversal, not a bad request.
_ONLINE_ID = re.compile(r"^[A-Za-z0-9._ \-]{2,16}$")

# resolve_account_id's reasons -> (HTTP status, what the visitor is told).
_REASONS = {
    "not_found": (404, "No PlayStation profile with that online ID."),
    "upstream_failed": (502, "PlayStation did not answer."),
}

# In-memory only. The server writes no token to disk (serverless has no disk
# either); a cold start falls back to PSN_REFRESH_TOKEN in env.
# ceiling: Sony rotates the refresh token on use, so the newest one lives here
# and env is only the cold-start copy. If a deployment idles past the refresh
# token's lifetime, the operator re-runs scripts/psn_login.py.
_token_cache = {"access": None, "refresh": None, "expires_at": 0.0}


def _access_token() -> str | None:
    """A live access token, refreshed only when one is missing or expired."""
    now = time.time()
    if _token_cache.get("access") and now < _token_cache.get("expires_at", 0):
        return _token_cache["access"]
    refresh = _token_cache["refresh"] or (os.environ.get("PSN_REFRESH_TOKEN") or "").strip()
    if not refresh:
        return None
    data = refresh_tokens(refresh)
    if not data.get("access_token"):
        return None
    _token_cache["access"] = data["access_token"]
    _token_cache["refresh"] = data.get("refresh_token") or refresh
    _token_cache["expires_at"] = now + max(int(data.get("expires_in") or 3600) - 60, 60)
    return _token_cache["access"]


def resolve_account_id(online_id: str, token: str | None) -> tuple:
    """(accountId, reason). reason is None on success, else why not: the first
    404 wins as "not_found" so a typo never reads as an outage."""
    url = PROFILE_URL.format(online_id)
    variants = [{}, {"Authorization": f"Bearer {token}"}] if token else [{}]
    for headers in variants:
        try:
            resp = requests.get(url, params={"fields": PROFILE_FIELDS},
                                headers=headers, timeout=20)
        except requests.RequestException:
            continue
        if resp.status_code == 200:
            profile = (resp.json() or {}).get("profile") or {}
            account_id = profile.get("accountId")
            # 200 with no id means the profile exists but is not readable --
            # never guess an id out of a partial body.
            return (str(account_id), None) if account_id else (None, "not_found")
        if resp.status_code == 404:
            return None, "not_found"
    return None, "upstream_failed"


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


def fetch_titles(access_token: str, account_id: str) -> tuple:
    """All played titles for one account (paged).

    Returns (titles, total_seen, last_status) -- the status rides along because
    an empty list means two very different things: Sony refusing us, or an
    account that has played nothing / hides its history.
    """
    titles: list[dict] = []
    offset = 0
    total = 0
    status = None
    for _ in range(MAX_PAGES):
        resp = requests.get(
            GAMES_URL.format(account_id),
            params={"limit": min(PAGE_SIZE, MAX_LIMIT), "offset": offset},
            headers={"Authorization": f"Bearer {access_token}",
                     "Content-Type": "application/json"},
            timeout=20,
        )
        status = resp.status_code
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
    return titles, total, status


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        online_id = (query.get("onlineId") or [""])[0].strip()
        if not online_id:
            send_json(self, 400, {"error": "Missing onlineId query parameter"})
            return
        if not _ONLINE_ID.fullmatch(online_id):
            send_json(self, 400, {
                "error": "onlineId must be a PSN online ID: 2-16 characters of "
                         "letters, digits, spaces, dot, dash or underscore",
            })
            return

        token = _access_token()
        if not token:
            if (os.environ.get("PSN_REFRESH_TOKEN") or "").strip():
                error = ("Sony refused this server's PlayStation token -- mint a "
                         "fresh one with scripts/psn_login.py.")
                reason = "refresh_failed"
            else:
                error = "This server has no PlayStation reader (set PSN_REFRESH_TOKEN)."
                reason = "no_token"
            send_json(self, 503, {"error": error, "reason": reason})
            return

        try:
            account_id, reason = resolve_account_id(online_id, token)
        except requests.RequestException:
            account_id, reason = None, "upstream_failed"
        if not account_id:
            status, error = _REASONS.get(reason, (502, "PlayStation did not answer."))
            send_json(self, status, {"error": error, "reason": reason})
            return

        try:
            titles, total, status = fetch_titles(token, account_id)
        except requests.RequestException:
            send_json(self, 502, {"error": "PlayStation did not answer.",
                                  "reason": "upstream_failed"})
            return
        if not titles and status != 200:
            # Refused, not empty: reporting "empty" here would send the visitor
            # hunting for a privacy switch that is not the problem.
            send_json(self, 502, {
                "error": f"PlayStation's gamelist refused this request (HTTP {status}).",
                "reason": "upstream_failed",
            })
            return

        games = [
            {
                "id": f"PSN:{t.get('titleId') or t.get('name') or 'unknown'}",
                "name": t.get("name") or t.get("localizedName") or "PlayStation game",
                "platform": "PlayStation",
                # PlatPrices joins on exactly this id (its `NpTitleId`), so pass
                # it through rather than forcing a second lookup by title.
                "titleId": t.get("titleId") or None,
                "hours": iso8601_to_hours(t.get("playDuration")),
            }
            for t in titles
        ]
        body = {"games": games}
        if not games:
            # 200 with nothing behind it: played nothing, or the profile hides
            # "Who can see your gaming history". The UI names both.
            body["reason"] = "empty" if total == 0 else "no_titles"
        send_json(self, 200, body)
