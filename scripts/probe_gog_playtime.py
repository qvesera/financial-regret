"""
Phase 0 probe: GOG playtime via gameplay.gog.com sessions endpoint.

Usage:
    python scripts/probe_gog_playtime.py <ACCESS_TOKEN> <USER_ID>

Calls https://gameplay.gog.com/games/{game_id}/users/{user_id}/sessions
for a handful of known games and prints the response shape / units.
"""
import sys
import requests

GAMEPLAY_BASE = "https://gameplay.gog.com"


def main() -> None:
    token = sys.argv[1] if len(sys.argv) > 1 else input("GOG access token: ").strip()
    user_id = sys.argv[2] if len(sys.argv) > 2 else input("GOG user id: ").strip()
    headers = {"Authorization": f"Bearer {token}"}
    # A few commonly-owned GOG game ids to probe
    for game_id in ("1207658691", "1390622812", "1490380055"):
        url = f"{GAMEPLAY_BASE}/games/{game_id}/users/{user_id}/sessions"
        resp = requests.get(url, headers=headers, timeout=15)
        print(f"game {game_id}: status={resp.status_code}", end="")
        if resp.status_code == 200:
            print(f" body={resp.text[:300]!r}")
        else:
            print(f" body={resp.text[:200]!r}")


if __name__ == "__main__":
    main()
