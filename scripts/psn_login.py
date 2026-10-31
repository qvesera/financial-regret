"""
Mint the reader's refresh token. Run this once, on your own machine.

    python3 scripts/psn_login.py
    # paste the printed value into PSN_REFRESH_TOKEN (Vercel/Docker/.env)

Why you and not the website: an NPSSO is your PSN web session, so it belongs
in your terminal -- never in a request to a hosted copy of this app. The
exchange happens here (localhost, no logging, nothing written to disk) and
only the *refresh* token leaves it. That token mints short-lived API access
for reading public profiles; it is not a way to sign in to the PlayStation
website, which is exactly why the server carries one instead of a session.

A throwaway PSN account with no purchases and no payment method is plenty:
this reader only ever asks for public playtime. The token is good for about
two months of use -- when /api/psn_games starts answering "refresh_failed",
run this again and swap the value.

Never prints the NPSSO or the access token.
"""
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from _psn_auth import code_to_tokens, npsso_to_access_code  # noqa: E402


def read_npsso() -> str:
    from_env = os.environ.get("PSN_NPSSO", "").strip()
    if from_env:
        return from_env
    try:
        return getpass.getpass("NPSSO (hidden): ").strip()
    except (EOFError, KeyboardInterrupt):
        return ""


def main() -> None:
    npsso = read_npsso()
    if not npsso:
        sys.exit("no NPSSO given")
    try:
        data = code_to_tokens(npsso_to_access_code(npsso))
    except ValueError as e:
        sys.exit(str(e))
    refresh = data.get("refresh_token")
    if not refresh:
        sys.exit("Sony returned no refresh token -- ask for offline access again")
    print("token minted. Set this on the server as PSN_REFRESH_TOKEN:\n")
    print(f"  {refresh}")
    if data.get("expires_in"):
        print(f"\n  (access token: {data['expires_in']}s; refresh: "
              f"{data.get('refresh_token_expires_in') or 'about two months'})")


if __name__ == "__main__":
    main()