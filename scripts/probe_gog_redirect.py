"""
Phase 0 probe -- RESULT RECORDED: GOG only honours allowlisted redirect URIs.
A custom origin (<HOST>/gog-callback.html) fails with "redirect_uri_mismatch";
the public Galaxy client's registered URI is
https://embed.gog.com/on_login_success?origin=client (what Lutris uses).

Usage:
    python scripts/probe_gog_redirect.py

Prints the /auth URL with the registered redirect. Open it, log in (captcha
possible), and you land on embed.gog.com/on_login_success?...&code=... --
that full URL is exactly what the app's paste box expects.
"""
from urllib.parse import urlencode

GOG_CLIENT_ID = "46899977096215655"
GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client"


def main() -> None:
    params = {
        "client_id": GOG_CLIENT_ID,
        "redirect_uri": GOG_REDIRECT_URI,
        "response_type": "code",
        "layout": "client2",
    }
    url = f"https://auth.gog.com/auth?{urlencode(params)}"
    print("\n=== GOG redirect probe (registered URI) ===")
    print(f"redirect_uri: {GOG_REDIRECT_URI}")
    print("Open this URL in a browser and log in:")
    print(url)
    print("\nAfter login you should be on embed.gog.com/on_login_success?...&code=...")


if __name__ == "__main__":
    main()
