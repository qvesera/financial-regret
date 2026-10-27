"""
GET /api/epic_games[?cursor=...]   headers: X-Epic-Token, X-Epic-Refresh

Fetches ONE page of the Epic library per HTTP request and hands the
continuation cursor back to the client, which asks for the next page.
Big libraries previously hung inside a single request (serial cursor
pagination with a 15s upstream timeout per page); now every request stays
short and the client shows live progress between pages.

Non-game assets (Unreal Engine / Marketplace content) are filtered out and
playtime is attached from the playtime endpoint. Unknown playtime is
reported as null (never 0) so the regret metric can exclude it.
"""
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

from _common import send_json, handle_options

EPIC_OAUTH_HOST = "account-public-service-prod03.ol.epicgames.com"
EPIC_LIBRARY_HOST = "library-service.live.use1a.on.epicgames.com"
EPIC_CATALOG_HOST = "catalog-public-service-prod06.ol.epicgames.com"
EPIC_CLIENT_ID = os.environ.get("EPIC_CLIENT_ID", "34a02cf8f4414e29b15921876da36f9a")
EPIC_CLIENT_SECRET = os.environ.get("EPIC_CLIENT_SECRET", "daafbccc737745039dffe53d94fc76cf")

IGNORE_PREFIXES = ("UE_", "UnrealEngine", "Unreal_", "UE5_", "UE4_")
IGNORE_NAMES = {
    "unreal engine", "unreal editor", "unreal tournament",
}

# Creator-tool product lines Epic ships to developers (Adobe Substance 3D,
# Twinmotion, Quixel/Fab content). Matched against the alnum-folded name so
# separators don't matter ("Substance_4.17", "Substance 3D Painter" both go).
NON_GAME_NAME_PREFIXES = (
    "substance", "adobe", "twinmotion", "quixel", "megascans", "pixologic",
    "realitycapture",
)
# "Substance_4.17"-style trailing versions on app names / titles.
_TRAILING_VERSION_RE = re.compile(r"[\s_]\d+(?:\.\d+)+$")
# Fab/UE marketplace asset ids: truncated name + hex run + "V<nn>"
# (e.g. "Substanc8f08b879e842V26"). Real titles never end in 8+ hex chars.
_FAB_ASSET_RE = re.compile(r"[0-9a-f]{8,}v\d+$")


def _fold(name: str) -> str:
    """Alphanumeric-only lowercase form for name-shape matching."""
    return re.sub(r"[^0-9a-z]", "", name.lower())

# Catalog namespaces that are never standalone games: Unreal Engine itself
# and Quixel (Megascans packages arrive as appName "ue/<hex>").
NON_GAME_NAMESPACES = ("ue", "quixel")
# Marketplace/Fab listings use this entitlement type; playable games use
# EXECUTABLE/DEMO-style types instead.
NON_GAME_ENTITLEMENT_TYPES = ("AUDIENCE",)
# Catalog category paths that mark an offer as engine content (plugins,
# Megascans, projects, demos, DLC) rather than a game. Matched as an exact
# path or a path prefix ("plugins/engine" is covered by "plugins").
NON_GAME_CATEGORY_PREFIXES = (
    "plugins", "plugin", "projects", "project", "projectfeature",
    "asset-format", "type", "engine", "demo", "demos", "addons",
)
# Epic's Fab / UE live-listing catalog namespace: every Fab asset, UnrealSt*
# starter pack, Quixel-style pack and Maya/Mobu LiveLink plugin lands here
# (sandboxName "fab-listing-live"). Real games carry their own namespace.
FAB_NAMESPACE = "89efe5924d3d467c839449ab6ab52e7f"
# sandboxName substrings (alnum-folded) that mark a NON-game product: Fab
# listings, the UE marketplace, dev kits. Real game sandboxNames are clean
# commercial titles (e.g. "Rocket League") and never contain these.
NON_GAME_SANDBOX_MARKERS = ("fablisting", "marketplace", "devkit", "megascans", "unrealengine")
# "<codename> Production" UE project sandboxes; suffix-matched so a game like
# "Production Line" (which merely contains the word) is not caught.
NON_GAME_SANDBOX_SUFFIXES = ("production",)
# Exact sandboxNames that are service/infrastructure buckets, never games.
JUNK_SANDBOX_NAMES = frozenset({"live"})

# The playtime endpoint covers the whole account in one upstream call, so it
# is fetched once per account and reused for every page (handlers run on
# threads under ThreadingHTTPServer -- hence the lock).
_playtime_cache: dict[str, dict[str, float]] = {}
_playtime_lock = threading.Lock()


def refresh_access_token(refresh_token: str) -> dict | None:
    resp = requests.post(
        f"https://{EPIC_OAUTH_HOST}/account/api/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": refresh_token, "token_type": "eg1"},
        auth=requests.auth.HTTPBasicAuth(EPIC_CLIENT_ID, EPIC_CLIENT_SECRET),
        timeout=15,
    )
    if resp.status_code != 200:
        return None
    return resp.json()


# Raw responseMetadata of the last library page (diagnostic: exposes whether
# the endpoint reports totalCount/hasMore vs where our cursor walk stopped).
_last_lib_meta: dict = {}


def fetch_library_page(access_token: str, cursor: str | None = None) -> tuple[list[dict], str | None]:
    """Return (records, next_cursor) for exactly one page of the library."""
    global _last_lib_meta
    headers = {"Authorization": f"bearer {access_token}"}
    params = {"includeMetadata": "true"}
    if cursor:
        params["cursor"] = cursor
    resp = requests.get(
        f"https://{EPIC_LIBRARY_HOST}/library/api/public/items",
        headers=headers, params=params, timeout=15,
    )
    if resp.status_code != 200:
        _last_lib_meta = {"error": resp.status_code}
        return [], None
    data = resp.json()
    if not isinstance(data, dict):
        _last_lib_meta = {"error": "non-dict"}
        return [], None
    records = data.get("records")
    records = records if isinstance(records, list) else []
    meta = data.get("responseMetadata")
    _last_lib_meta = meta if isinstance(meta, dict) else {}
    next_cursor = meta.get("nextCursor") if isinstance(meta, dict) else None
    return records, (next_cursor or None)


def fetch_playtime(access_token: str, account_id: str) -> dict:
    """Return {appName: hours} from the playtime endpoint, or {} on failure.

    Epic returns either {"artifacts": [...]} or, for some accounts, a bare
    top-level list of artifacts -- both must parse (a shape mismatch here
    used to raise AttributeError and 500 the whole scan).
    """
    headers = {"Authorization": f"bearer {access_token}"}
    try:
        resp = requests.get(
            f"https://{EPIC_LIBRARY_HOST}/library/api/public/playtime/account/{account_id}/all",
            headers=headers, timeout=15,
        )
        if resp.status_code != 200:
            return {}
        data = resp.json()
    except (requests.RequestException, ValueError):
        return {}

    artifacts = data if isinstance(data, list) else (
        data.get("artifacts") if isinstance(data, dict) else None
    )
    result = {}
    if isinstance(artifacts, list):
        for a in artifacts:
            if not isinstance(a, dict):
                continue
            aid = a.get("artifactId")
            ms = a.get("totalTime")
            if aid and isinstance(ms, (int, float)):
                result[aid] = round(ms / 3_600_000, 1)
    elif isinstance(data, dict):
        # Fallback shape: {appName: totalMs} directly on the object.
        for aid, ms in data.items():
            if isinstance(ms, (int, float)):
                result[aid] = round(ms / 3_600_000, 1)
    return result



def classify(record: dict) -> str | None:
    """Return a short reason string if this library record is NOT a game, else None.

    Excludes Unreal Engine builds and store-bought UE content (Fab/UE
    marketplace plugins, Megascans packages, projects), DLC/addons, and
    demos. Signals verified against real library records: namespace,
    app-name prefixes, the DLC base-game pointer, catalog category paths,
    UE-only release compatibility, and the AUDIENCE entitlement type used
    by marketplace listings (see legendary-gl/legendary#696 and
    Heroic-Games-Launcher/HeroicGamesLauncher#4200). Creator tools
    (Adobe Substance 3D etc.) and Fab asset ids ship WITHOUT those markers
    and are dropped by name shape instead. Real games are identified by a
    clean commercial `sandboxName`; Fab/UE content shows a technical one
    ("fab-listing-live", "UT Marketplace") or lives in the FAB_NAMESPACE.

    The returned reason is surfaced by ?debug=1 so the filter can be tuned
    against a real library instead of guesses.
    """
    metadata = record.get("metadata") or {}
    namespace = record.get("namespace", "")
    app_name = record.get("appName", "")
    sandbox_type = record.get("sandboxType", "")
    sandbox_name = record.get("sandboxName") or ""

    if namespace in NON_GAME_NAMESPACES or namespace == FAB_NAMESPACE:
        return f"namespace:{namespace}"
    folded_sb = _fold(sandbox_name)
    if folded_sb in JUNK_SANDBOX_NAMES:
        return "sandbox:junk-name"
    if any(m in folded_sb for m in NON_GAME_SANDBOX_MARKERS):
        # sandboxName exposes Fab listings / UE marketplace / dev kits even
        # when the namespace and catalog categories are unhelpful.
        return "sandbox-marker"
    if folded_sb.endswith(NON_GAME_SANDBOX_SUFFIXES):
        return "sandbox:suffix"
    if not app_name:
        return "no-app-name"
    if app_name.startswith("ue/"):  # Quixel Megascans package ids
        return "ue-slash-prefix"
    if sandbox_type == "PRIVATE":
        return "sandbox:PRIVATE"
    if any(app_name.startswith(p) for p in IGNORE_PREFIXES):
        return "app-prefix"
    if app_name.lower() in IGNORE_NAMES:
        return "name-blacklist"
    if record.get("mainGameAppName"):  # DLC / addon pointing at its base game
        return "dlc"
    ent = metadata.get("entitlementType")
    if ent in NON_GAME_ENTITLEMENT_TYPES:
        return f"entitlement:{ent}"
    for cat in metadata.get("categories") or []:
        path = cat.get("path", "") if isinstance(cat, dict) else ""
        if any(path == p or path.startswith(f"{p}/") for p in NON_GAME_CATEGORY_PREFIXES):
            return f"category:{path}"
    for rel in metadata.get("releaseInfo") or []:
        apps = (rel or {}).get("compatibleApps") or []
        if apps and all(str(a).startswith("UE_") for a in apps):
            return "ue-only-release"
    title = metadata.get("title") or ""
    # Check appName, title AND sandboxName for creator-tool / dev-kit shapes:
    # many tools ship a hex appName with the real tool name in sandboxName.
    for name in (app_name, title, sandbox_name):
        folded = _fold(name)
        if any(folded.startswith(p) for p in NON_GAME_NAME_PREFIXES):
            return "name-shape:tool-prefix"
        if "devkit" in folded or "marketplace" in folded:
            return "name-shape:devkit"
        if _TRAILING_VERSION_RE.search(name.lower()):
            return "name-shape:trailing-version"
        if _FAB_ASSET_RE.search(folded):
            return "name-shape:fab-id"
    return None


def is_non_game(record: dict) -> bool:
    """True unless this library record is an actual playable game."""
    return classify(record) is not None


def _catalog_bulk(access_token: str, namespace: str, extra: dict) -> dict:
    headers = {"Authorization": f"bearer {access_token}"}
    params = {"includeDLCDetails": "true", "includeMainGameDetails": "true",
              "country": "US", "locale": "en"}
    params.update(extra)
    resp = requests.get(
        f"https://{EPIC_CATALOG_HOST}/catalog/api/shared/namespace/{namespace}/bulk/items",
        headers=headers, params=params, timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else {}


# Catalog title/category cache keyed (namespace, catalogItemId). Titles are
# stable enough to cache for the process lifetime; the lock guards concurrent
# page handlers (handlers run on threads under ThreadingHTTPServer).
_cat_cache: dict[tuple[str, str], dict] = {}   # resolved items (positive)
_cat_miss: dict[tuple[str, str], float] = {}   # id -> epoch the catalog lacked it
_cat_cache_lock = threading.Lock()
# Ids the catalog doesn't return (removed offers, UE marketplace records that
# never resolve) are re-fetched only after this window, so a transient 429 or
# miss can't blank a title forever -- yet warm scans still skip them instead of
# re-hitting upstream (which kept warm scans at ~21s instead of ~8s).
_CAT_MISS_TTL = 3600.0


def resolve_catalog_titles(access_token: str, records: list[dict]) -> dict:
    """Return {(namespace, catalogItemId): catalog_item} for the given records.

    Uncached ids are fetched in parallel (batched up to 25 ids per namespace
    request) and memoised, so a re-scan or overlapping pages don't re-hit the
    catalog. Recently-missed ids are skipped for _CAT_MISS_TTL seconds to keep
    warm scans fast. Namespace junk (Unreal Engine / Fab) is skipped -- it never
    resolves to a playable game and would only waste upstream calls.
    """
    by_ns: dict[str, set] = {}
    for r in records:
        if not isinstance(r, dict):
            continue
        ns, cid = r.get("namespace"), r.get("catalogItemId")
        if ns and cid and ns not in NON_GAME_NAMESPACES and ns != FAB_NAMESPACE:
            by_ns.setdefault(ns, set()).add(cid)
    keys = {(ns, cid) for ns, ids in by_ns.items() for cid in ids}
    if not keys:
        return {}
    now = time.time()
    need_by_ns: dict[str, list[str]] = {}
    with _cat_cache_lock:
        for ns, cid in (keys - _cat_cache.keys()):
            missed_at = _cat_miss.get((ns, cid))
            if missed_at is not None and (now - missed_at) < _CAT_MISS_TTL:
                continue  # recently missed -- skip for now, keep the scan fast
            need_by_ns.setdefault(ns, []).append(cid)
    jobs = []
    for ns, ids in need_by_ns.items():
        ids = sorted(ids)
        for i in range(0, len(ids), 25):
            jobs.append((ns, ids[i:i + 25]))
    if jobs:
        def _job(job):
            ns, chunk = job
            try:
                cat = _catalog_bulk(access_token, ns, {"id": ",".join(chunk)})
            except Exception:  # noqa: BLE001 -- a catalog miss must not 500 the page
                return {}
            return {(ns, iid): v for iid, v in cat.items() if isinstance(v, dict)}
        fetched: dict = {}
        with ThreadPoolExecutor(max_workers=8) as pool:
            for d in pool.map(_job, jobs):
                fetched.update(d)
        with _cat_cache_lock:
            _cat_cache.update(fetched)
            stamped = time.time()
            for k in fetched:
                _cat_miss.pop(k, None)  # a resolved id clears any stale miss
            for ns, ids in need_by_ns.items():
                for cid in ids:
                    if (ns, cid) not in fetched:
                        _cat_miss[(ns, cid)] = stamped  # remember the miss
    with _cat_cache_lock:
        return {k: _cat_cache[k] for k in keys if k in _cat_cache}


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        handle_options(self)

    def do_GET(self):
        access_token = self.headers.get("X-Epic-Token")
        refresh_token = self.headers.get("X-Epic-Refresh")
        account_id = self.headers.get("X-Epic-Account-Id", "")

        if not access_token:
            send_json(self, 400, {"error": "Missing X-Epic-Token header"})
            return

        cursor = (parse_qs(urlparse(self.path).query).get("cursor") or [""])[0] or None
        q = parse_qs(urlparse(self.path).query)
        debug = (q.get("debug") or [""])[0] not in ("", "0", "false")
        debug_full = (q.get("debug") or [""])[0] == "full"
        new_tokens = None

        try:
            records, next_cursor = fetch_library_page(access_token, cursor)
        except requests.RequestException:
            records, next_cursor = [], None

        # Expired-token fallback is only worth trying on the first page.
        if not records and not cursor and refresh_token:
            refreshed = refresh_access_token(refresh_token)
            if refreshed:
                access_token = refreshed["access_token"]
                new_tokens = {
                    "access_token": refreshed["access_token"],
                    "refresh_token": refreshed["refresh_token"],
                }
                try:
                    records, next_cursor = fetch_library_page(access_token, cursor)
                except requests.RequestException:
                    records, next_cursor = [], None

        playtime: dict = {}
        if account_id:
            with _playtime_lock:
                playtime = _playtime_cache.get(account_id, {})
            if not playtime:
                playtime = fetch_playtime(access_token, account_id)
                if playtime:
                    with _playtime_lock:
                        _playtime_cache[account_id] = playtime

        # Catalog-resolve this page's records first: the catalog's `title` (the
        # real commercial name) and `categories` (`games` membership) are
        # authoritative over sandboxName heuristics, which both mislabel
        # codenames ("MtWilliamson" -> "A Plague Tale: Innocence") and drop real
        # games whose sandboxName is the generic "Live".
        cat_titles = resolve_catalog_titles(access_token, records)
        seen = set()
        games = []
        filtered_count = 0
        debug_records = [] if debug else None
        for r in records:
            if not isinstance(r, dict):
                continue
            app_name = r.get("appName")
            if not app_name or app_name in seen:
                if app_name:
                    filtered_count += 1
                    if debug:
                        debug_records.append(_debug_entry(r, "duplicate", full=debug_full))
                continue
            reason = classify(r)
            cat = cat_titles.get((r.get("namespace"), r.get("catalogItemId")))
            cat_title = ""
            if isinstance(cat, dict):
                cat_title = (cat.get("title") or "").strip()
                cat_cats = [c.get("path", "") for c in (cat.get("categories") or [])]
                if cat_cats:
                    if "games" in cat_cats:
                        # Catalog says game: keep even if the sandbox/appName
                        # heuristics (e.g. the "Live" junk bucket) dropped it.
                        reason = None
                    elif reason is None:
                        # Catalog says non-game (DLC/plugins/demos) though the
                        # heuristics let it through.
                        reason = "catalog:non-game"
            if reason:
                filtered_count += 1
                if debug:
                    debug_records.append(_debug_entry(r, reason, full=debug_full))
                continue
            seen.add(app_name)
            if debug:
                debug_records.append(_debug_entry(r, None, full=debug_full))
            metadata = r.get("metadata") or {}
            # The catalog's title is the real commercial name; sandboxName is a
            # fallback (it is a codename like "MtWilliamson" when the catalog
            # misses), then metadata.title, then appName.
            sandbox_name = (r.get("sandboxName") or "").strip()
            title = cat_title or sandbox_name or metadata.get("title") or app_name
            gid = app_name
            games.append({
                "id": f"Epic:{gid}",
                "name": title,
                "appid": gid,
                "platform": "Epic",
                "hours": playtime.get(gid),
            })

        result = {"games": games, "filtered_count": filtered_count, "next_cursor": next_cursor}
        if debug:
            result["debug"] = debug_records
            result["lib_meta"] = _last_lib_meta
        if new_tokens:
            result["new_tokens"] = new_tokens

        send_json(self, 200, result)


def _debug_entry(r: dict, reason: str | None, full: bool = False) -> dict:
    """One classification row for ?debug=1: kept (reason None) or dropped.

    With ?debug=full the entire upstream record is attached under `raw` so
    hidden distinguishing fields can be inspected empirically.
    """
    md = r.get("metadata") or {}
    cats = [c.get("path", "") if isinstance(c, dict) else str(c)
            for c in (md.get("categories") or [])]
    entry = {
        "name": md.get("title") or r.get("appName"),
        "appName": r.get("appName"),
        "sandboxName": r.get("sandboxName"),
        "namespace": r.get("namespace"),
        "entitlementType": md.get("entitlementType"),
        "categories": cats,
        "mainGameAppName": r.get("mainGameAppName"),
        "sandboxType": r.get("sandboxType"),
        "kept": reason is None,
        "reason": reason,
    }
    if full:
        entry["raw"] = r
    return entry
