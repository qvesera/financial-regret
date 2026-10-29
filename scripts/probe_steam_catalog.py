"""
Phase 0 probe: Steam app catalog type field via IStoreService/GetAppList/v1.

Usage:
    python scripts/probe_steam_catalog.py

Checks whether the app list response carries a usable "type" field so we can
filter out soundtracks, tools, videos, and DLC from Steam-owned games.
"""
import requests

BASE = "https://api.steampowered.com"


def main() -> None:
    params = {"include_games": "true", "max_results": 50, "format": "json"}
    resp = requests.get(f"{BASE}/IStoreService/GetAppList/v1/", params=params, timeout=20)
    print(f"status={resp.status_code}")
    print(f"body (first 500 chars): {resp.text[:500]!r}")
    if resp.status_code != 200:
        print("\nNote: GetAppList/v1 may require a Steam Web API key or IP allowlist.")
        return
    data = resp.json()
    apps = data.get("response", {}).get("apps", [])
    print(f"apps returned: {len(apps)}")
    if apps:
        print("first app keys:", sorted(apps[0].keys()))
        print("first app:", apps[0])
    # also try a second page to see paging shape
    params["last_appid"] = apps[-1]["appid"] if apps else 0
    resp2 = requests.get(f"{BASE}/IStoreService/GetAppList/v1/", params=params, timeout=20)
    print(f"second page status={resp2.status_code} apps={len(resp2.json().get('response', {}).get('apps', []))}")


if __name__ == "__main__":
    main()
