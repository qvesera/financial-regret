"""
Phase 0 probe: Epic playtime via library-service playtime endpoint.

Usage:
    python scripts/probe_epic_playtime.py <ACCESS_TOKEN> <ACCOUNT_ID>

Calls https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account/{accountId}/all
and prints the response shape so we can map artifactId -> hours.
"""
import sys
import requests

LIBRARY_HOST = "library-service.live.use1a.on.epicgames.com"


def main() -> None:
    token = sys.argv[1] if len(sys.argv) > 1 else input("Epic access token: ").strip()
    account_id = sys.argv[2] if len(sys.argv) > 2 else input("Epic account id: ").strip()
    headers = {"Authorization": f"bearer {token}"}
    url = f"https://{LIBRARY_HOST}/library/api/public/playtime/account/{account_id}/all"
    resp = requests.get(url, headers=headers, timeout=15)
    print(f"status={resp.status_code}")
    print(resp.text[:1500])


if __name__ == "__main__":
    main()
