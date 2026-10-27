"""
Phase 0 probe: GOG paginated library via getFilteredProducts.

Usage:
    python scripts/probe_gog_library.py <ACCESS_TOKEN>

Calls https://embed.gog.com/account/getFilteredProducts?mediaType=1&page=N
and prints product count, totalPages, and the shape of the first product.
"""
import sys
import requests

GOG_EMBED_BASE = "https://embed.gog.com"


def main() -> None:
    token = sys.argv[1] if len(sys.argv) > 1 else input("GOG access token: ").strip()
    headers = {"Authorization": f"Bearer {token}"}
    page = 1
    seen = 0
    while page <= 5:
        resp = requests.get(
            f"{GOG_EMBED_BASE}/account/getFilteredProducts",
            params={"mediaType": 1, "page": page},
            headers=headers, timeout=15,
        )
        print(f"page {page}: status={resp.status_code}", end="")
        if resp.status_code != 200:
            print(f" body={resp.text[:200]!r}")
            break
        data = resp.json()
        products = data.get("products", [])
        print(f" products={len(products)} total_pages={data.get('totalPages')}")
        seen += len(products)
        if products:
            print("  sample:", {k: products[0].get(k) for k in ("id", "title", "image", "price")})
        if page >= data.get("totalPages", 1):
            break
        page += 1
    print(f"\nTotal products across pages: {seen}")


if __name__ == "__main__":
    main()
