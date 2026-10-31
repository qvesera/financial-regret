"""
Phase 0 probe: can ONE PSN account token read *another* account's played-games
list, and does that list carry playtime?

Usage:
    python3 scripts/probe_psn_public.py                        # prompt, probes "me" only
    python3 scripts/probe_psn_public.py <onlineId> [<onlineId> ...]
    PSN_NPSSO=... python3 scripts/probe_psn_public.py <onlineId>

Each <onlineId> is a PSN username (the name on their profile, not an email or
an account id). To answer the question, pass two of them: one from your friends
list, and one you are not friends with -- any public profile will do, a random
player from someone's trophy list is fine.

Answers the three questions the online-ID design depends on:
  1. does universalSearch (or the legacy profile) resolve an online ID to an
     accountId for someone who is not a friend?
  2. does gamelist/v2/users/<accountId>/titles answer for that account?
  3. is playDuration present there, and what does a private profile look like?

Never prints the NPSSO or the tokens, never writes a file.
"""
import getpass
import os
import sys
from urllib.parse import parse_qs, urlparse

import requests

AUTH_BASE = "https://ca.account.sony.com/api/authz/v3/oauth"
CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891"
REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect"
SCOPE = "psn:mobile.v2.core psn:clientapp"
# Same public PlayStation App client as backend/psn_exchange.py.
BASIC = "MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
SEARCH_URL = "https://m.np.playstation.com/api/search/v1/universalSearch"
GAMELIST_URL = "https://m.np.playstation.com/api/gamelist/v2/users/{}/titles"
# Sony rejects anything above 200 ("allowed limit=200"). The shipping handler
# pages at 100, so 200 gives the probe one wide page without diverging in kind.
PAGE_LIMIT = 200
# onlineId -> accountId. Three routes, five attempts (auth variants of each):
# profile2 -- called "the best" as recently as Oct 2024, and usable without a
# token -- the internal profiles route, then universal search, which misses
# some accounts but is the only one carrying a country. Every attempt is
# reported, so a refusal names itself instead of vanishing.
PROFILE2_URL = ("https://us-prof.np.community.playstation.net/userProfile/v1/users/"
                "{}/profile2")
INTERNAL_PROFILE_URL = ("https://m.np.playstation.com/api/userProfile/v1/"
                        "internal/users/{}/profiles")
PROFILE2_FIELDS = "accountId,onlineId,currentOnlineId"


def access_token_from_npsso(npsso: str) -> str:
    """The same two hops as backend/psn_exchange.py, inlined so this probe runs
    standalone. Returns the access token only; nothing is printed."""
    auth = requests.get(
        f"{AUTH_BASE}/authorize",
        params={"access_type": "offline", "client_id": CLIENT_ID,
                "redirect_uri": REDIRECT_URI, "response_type": "code",
                "scope": SCOPE},
        headers={"Cookie": f"npsso={npsso}"},
        allow_redirects=False, timeout=20,
    )
    location = auth.headers.get("Location") or ""
    code = parse_qs(urlparse(location).query).get("code", [""])[0]
    if not code:
        sys.exit("Sony returned no access code -- the NPSSO is expired or mistyped")
    token = requests.post(
        f"{AUTH_BASE}/token",
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Authorization": f"Basic {BASIC}"},
        data={"code": code, "redirect_uri": REDIRECT_URI,
              "grant_type": "authorization_code", "token_format": "jwt"},
        timeout=20,
    )
    if token.status_code != 200 or not token.json().get("access_token"):
        sys.exit(f"Sony rejected the access code (HTTP {token.status_code})")
    return token.json()["access_token"]


def _attempt(token: str, url: str, *, auth: bool = True,
             params: dict | None = None, body: dict | None = None) -> dict:
    """One request, recorded as status + parsed body + raw text. Never raises:
    a probe that dies on the first refusal says nothing about the rest."""
    headers = {"Accept": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        if body is not None:
            resp = requests.post(url, headers=headers, json=body, timeout=20)
        else:
            resp = requests.get(url, headers=headers, params=params, timeout=20)
    except Exception as e:
        return {"status": repr(e), "data": None, "text": ""}
    data = None
    if "json" in (resp.headers.get("Content-Type") or ""):
        try:
            data = resp.json()
        except ValueError:
            data = None
    return {"status": resp.status_code, "data": data, "text": resp.text[:220]}


def _account_id_where(node, online_id: str):
    """The accountId sitting next to the online id we asked for. Each endpoint
    nests it differently -- profile2 under "profile", search under
    socialMetadata -- so recurse and key on the online id we already know,
    never on an arbitrary accountId belonging to somebody else."""
    if isinstance(node, dict):
        if (str(node.get("onlineId", "")).lower() == online_id.lower()
                and node.get("accountId")):
            return str(node["accountId"])
        for value in node.values():
            found = _account_id_where(value, online_id)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _account_id_where(item, online_id)
            if found:
                return found
    return None


def _first_account_id(node):
    if isinstance(node, dict):
        if isinstance(node.get("accountId"), (str, int)):
            return str(node["accountId"])
        for value in node.values():
            found = _first_account_id(value)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _first_account_id(item)
            if found:
                return found
    return None


def resolve_account_id(token: str, online_id: str) -> tuple:
    """Every route to onlineId -> accountId, tried in order of what the
    community reports as working. Returns (accountId, one report line each)."""
    search_body = {
        "searchTerm": online_id,
        "domainRequests": [{
            "domain": "SocialAllAccounts",
            "socialSearchParams": {"strictGrouping": True},
            "pagination": {"cursor": "", "pageSize": 20},
            "featureFlags": {"isSpartacusEnabled": True},
        }],
        "countryCode": "us",
        "languageCode": "en",
        "age": 99,
    }
    minimal_body = {"searchTerm": online_id,
                    "domainRequests": [{"domain": "SocialAllAccounts"}]}
    attempts = [
        ("profile2 no-auth",
         PROFILE2_URL.format(online_id), {"fields": PROFILE2_FIELDS}, None),
        ("profile2 bearer",
         PROFILE2_URL.format(online_id), {"fields": PROFILE2_FIELDS}, None),
        ("internal profiles bearer",
         INTERNAL_PROFILE_URL.format(online_id),
         {"fields": "accountId,onlineId"}, None),
        ("search minimal body", SEARCH_URL, None, minimal_body),
        ("search full body", SEARCH_URL, None, search_body),
    ]
    found, lines = None, []
    for label, url, params, body in attempts:
        result = _attempt(token, url, params=params, body=body)
        account = None
        if result["status"] == 200 and result["data"] is not None:
            account = _account_id_where(result["data"], online_id)
            if not account and online_id.lower() in result["text"].lower():
                # The id is present but split across sibling objects: take the
                # first accountId rather than declare a working route dead.
                account = _first_account_id(result["data"])
        line = f"{label}: {result['status']} account={account}"
        if result["status"] != 200:
            line += f" {result['text']!r}"        # the refusal, quoted verbatim
        lines.append(line)
        if account and not found:
            found = account
    return found, lines


def show_gamelist(label: str, token: str, account_id: str) -> None:
    print(f"   gamelist [{label}] status=", end="")
    resp = requests.get(GAMELIST_URL.format(account_id),
                        params={"limit": PAGE_LIMIT, "offset": 0},
                        headers={"Authorization": f"Bearer {token}"}, timeout=20)
    print(resp.status_code)
    if resp.status_code != 200:
        print(f"   body={resp.text[:300]!r}")     # the permission/privacy answer lives here
        return
    data = resp.json()
    titles = data.get("titles") or []
    print(f"   totalItemCount={data.get('totalItemCount')} on page={len(titles)}")
    for t in titles[:5]:
        print(f"     {t.get('titleId')}  {t.get('name')!r}  "
              f"playDuration={t.get('playDuration')}")
    if titles and all(t.get("playDuration") is None for t in titles):
        print("   WARNING: playDuration absent -- playtime is not exposed here")


def _read_npsso() -> str:
    from_env = os.environ.get("PSN_NPSSO", "").strip()
    if from_env:
        return from_env
    try:
        return getpass.getpass("NPSSO (hidden): ").strip()
    except (EOFError, KeyboardInterrupt):
        return ""                                # piped stdin has no console to ask


def main() -> None:
    npsso = _read_npsso()
    if not npsso:
        sys.exit("no NPSSO given")
    token = access_token_from_npsso(npsso)
    print("token acquired")

    print("\n== me (baseline: proves the token works)")
    show_gamelist("me", token, "me")

    for online_id in sys.argv[1:]:
        account_id, lines = resolve_account_id(token, online_id)
        print(f"\n== other: {online_id}")
        for line in lines:
            print(f"   {line}")
        if account_id:
            show_gamelist(online_id, token, account_id)
        else:
            print("   VERDICT: no route resolved this online ID -- the /me flow "
                  "is the only option")


if __name__ == "__main__":
    main()