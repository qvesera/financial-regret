"""
Renew the PlayStation reader token -- the scheduled half of PSN_REFRESH_TOKEN.

    python3 scripts/renew_psn_token.py               # mint, write .env, update Vercel, redeploy, verify
    python3 scripts/renew_psn_token.py --local       # mint + write .env only (no Vercel)
    python3 scripts/renew_psn_token.py --dry-run     # report what would happen; change nothing
    python3 scripts/renew_psn_token.py --save-npsso  # store an NPSSO first (prompted, hidden)

The NPSSO comes from $PSN_NPSSO or ~/.config/financial-regret/npsso (mode 0600).
Sony issues those for about two months and they cannot be fetched without a
browser sign-in -- psn-api says it outright: "after two months you will need to
remember to manually retrieve another NPSSO token". So this automates everything
that *can* be automated: a fresh refresh token, on schedule, pushed everywhere it
is needed. When the NPSSO itself has expired it fails loudly, and the fix is
thirty seconds of browser work (sign in at playstation.com, open
https://ca.account.sony.com/api/v1/ssocookie, run --save-npsso).

Each run also reports whether Sony re-issued the NPSSO on the authorize hop. If
it ever does, the fresh cookie is saved back to the same file and the chain never
needs a human again -- the log line says which of the two worlds you are in.

Token hygiene: no secret is printed, logged or put on argv. The Vercel CLI is
given the token and the value on stdin only, so neither appears in `ps`.

Requires the vercel CLI for the Vercel half (authed by `vercel login`, or by
VERCEL_TOKEN in the environment -- which is also what a CI scheduler passes).
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from _psn_auth import authorize, code_from_location, code_to_tokens  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
NPSSO_FILE = Path.home() / ".config" / "financial-regret" / "npsso"
KEY = "PSN_REFRESH_TOKEN"
VERCEL_PROJECT = os.environ.get("VERCEL_PROJECT", "")
PROD_URL = os.environ.get("VERCEL_PROD_URL", "")
# Fails the run rather than letting a dead upstream read as success anywhere.
VERIFY_ID = "renewtest99"


def fail(message: str) -> "SystemExit":
    print(f"renew: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_npsso(path: Path = NPSSO_FILE) -> str:
    """NPSSO from the environment (CI) or the stored file (everything else)."""
    from_env = os.environ.get("PSN_NPSSO", "").strip()
    if from_env:
        return from_env
    if path.is_file():
        value = path.read_text().strip()
        if value:
            return value
    fail(
        f"no NPSSO. Store one with --save-npsso (prompted, hidden), or set "
        f"PSN_NPSSO. File: {path}"
    )


def save_npsso(value: str, path: Path = NPSSO_FILE) -> None:
    """0600 in a private dir: this is a PSN web session and stays one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(value.strip() + "\n")


def reissued_npsso(resp) -> str | None:
    """A fresh NPSSO off the authorize response, when Sony sets one."""
    cookies = getattr(resp, "cookies", None)
    try:
        value = cookies.get("npsso")
    except AttributeError:
        return None
    return value if isinstance(value, str) and len(value) >= 32 else None


def upsert_env(path: Path, key: str, value: str) -> None:
    """Set KEY=value in a dotenv file, replacing one line and never touching
    the rest (ordering, comments, unrelated keys). Atomic: a crash mid-write
    must not truncate the operator's .env."""
    lines = path.read_text().splitlines() if path.is_file() else []
    out, replaced = [], False
    for line in lines:
        if line.startswith(f"{key}="):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{key}={value}")
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(out) + "\n")
    tmp.replace(path)


def mint(npsso: str) -> tuple:
    """NPSSO in, (token payload, raw authorize response) out."""
    resp = authorize(npsso)
    return code_to_tokens(code_from_location(resp)), resp


def vercel_binary() -> str:
    found = shutil.which("vercel")
    if found:
        return found
    # Cron and CI often run with a minimal PATH; nvm installs vercel outside it.
    candidates = sorted(Path.home().glob(".nvm/versions/node/*/bin/vercel"))
    if candidates:
        return str(candidates[-1])
    fail("vercel CLI not found (npm i -g vercel), or use --local")


def vercel(args: list, token: str | None = None, stdin: str | None = None):
    """Run the CLI with secrets on stdin only; returns CompletedProcess."""
    cmd = [vercel_binary(), *args]
    if token:
        cmd += ["--token", token]        # argv: an API token, not a session
    return subprocess.run(
        cmd, cwd=ROOT, input=stdin, capture_output=True, text=True, timeout=600,
    )


def push_to_vercel(refresh: str, token: str | None) -> str:
    """Set the production env var, link the directory if needed, deploy.

    Env and deploy are one step on purpose: a new env var only reaches a live
    deployment when a new deployment exists, so either half alone is a no-op
    that still exits green.

    Returns the production URL to verify against.
    """
    rm = vercel(["env", "rm", KEY, "production", "--yes"], token=token)
    if rm.returncode and "not found" not in (rm.stderr + rm.stdout).lower():
        # "not found" is the normal first run; anything else is a real refusal.
        fail(f"vercel env rm failed: {(rm.stderr or rm.stdout).strip()[:300]}")
    add = vercel(["env", "add", KEY, "production"], token=token, stdin=refresh + "\n")
    if add.returncode:
        fail(f"vercel env add failed: {(add.stderr or add.stdout).strip()[:300]}")

    if not (ROOT / ".vercel" / "project.json").is_file():
        if not VERCEL_PROJECT:
            fail("directory is not linked and VERCEL_PROJECT is unset -- link "
                 "once with `vercel link --project <name>`, or set VERCEL_PROJECT")
        link = vercel(["link", "--yes", "--project", VERCEL_PROJECT], token=token)
        if link.returncode:
            fail(f"vercel link failed: {(link.stderr or link.stdout).strip()[:300]}")

    dep = vercel(["deploy", "--prod", "--yes"], token=token)
    if dep.returncode:
        fail(f"vercel deploy failed: {(dep.stderr or dep.stdout).strip()[:300]}")
    urls = re.findall(r"https://[a-z0-9.-]+vercel\.app", dep.stdout or "")
    if urls:
        return urls[-1]
    if PROD_URL:
        return PROD_URL
    if VERCEL_PROJECT:
        return f"https://{VERCEL_PROJECT}.vercel.app"
    fail("deploy succeeded but no URL to verify -- set VERCEL_PROD_URL")


def verify(url: str, tries: int = 18, delay: float = 10.0) -> None:
    """Wait for the deployment swap, then prove the new build is serving with
    the new token: an unknown online ID answers 404 `not_found`, which only
    happens when a live reader token exists (no token -> 503 `no_token`)."""
    import requests

    target = f"{url.rstrip('/')}/api/psn_games?onlineId={VERIFY_ID}"
    last = "no attempt made"
    for _ in range(tries):
        try:
            resp = requests.get(target, timeout=20)
            last = f"HTTP {resp.status_code}: {resp.text[:200]}"
            if resp.status_code == 404 and "not_found" in resp.text:
                print(f"renew: verified live at {url} -- reader token accepted")
                return
        except requests.RequestException as e:
            last = repr(e)
        time.sleep(delay)
    fail(f"deployment did not verify within {int(tries * delay)}s -- {last}")


def npsso_age_days(path: Path = NPSSO_FILE) -> int | None:
    if os.environ.get("PSN_NPSSO", "").strip() or not path.is_file():
        return None
    return int((time.time() - path.stat().st_mtime) / 86400)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Mint a fresh PSN reader token and push it everywhere it lives.")
    parser.add_argument("--local", action="store_true",
                        help="mint and write .env only; leave Vercel alone")
    parser.add_argument("--dry-run", action="store_true",
                        help="report every step, change nothing (still exchanges "
                             "with Sony: that is the only way to know whether the "
                             "stored NPSSO still works)")
    parser.add_argument("--save-npsso", action="store_true",
                        help="prompt for an NPSSO (hidden), store it 0600, then renew")
    args = parser.parse_args()

    if args.save_npsso:
        import getpass
        try:
            given = getpass.getpass("NPSSO (hidden): ").strip()
        except (EOFError, KeyboardInterrupt):
            given = ""
        given = given or os.environ.get("PSN_NPSSO", "").strip()
        if not given:
            fail("no NPSSO given")
        if not args.dry_run:
            save_npsso(given)
            print(f"renew: NPSSO stored at {NPSSO_FILE} (mode 0600)")
        os.environ["PSN_NPSSO"] = given

    npsso = load_npsso()
    age = npsso_age_days()
    if age is not None and age > 50:
        print(f"renew: WARNING -- stored NPSSO is {age} days old; Sony issues "
              f"them for about two months. Re-grab it soon (--save-npsso) or the "
              f"next run is the loud failure.")

    try:
        payload, resp = mint(npsso)
    except SystemExit:
        raise
    except Exception as e:                   # a refusal must name itself, never traceback
        fail(f"exchange failed: {e}")
    refresh = payload.get("refresh_token")
    if not refresh:
        fail("Sony returned no refresh token")

    fresh = reissued_npsso(resp)
    print("renew: NPSSO re-issued by Sony: "
          + ("yes (chain continues without a human)" if fresh else
             "no (re-grab needed when it expires)")
          + (f"; {age} days old" if age is not None else ""))
    ttl = payload.get("refresh_token_expires_in")
    if ttl:
        print(f"renew: refresh token minted, valid {int(ttl)}s ({int(ttl) // 86400} days)")

    if args.dry_run:
        print("renew: DRY RUN -- would write .env"
              + ("" if args.local else ", push the Vercel env, deploy, verify")
              + (f"; would save the re-issued NPSSO to {NPSSO_FILE}" if fresh else ""))
        return

    if fresh:
        save_npsso(fresh)
    upsert_env(ENV_FILE, KEY, refresh)
    print(f"renew: {ENV_FILE} updated")

    if args.local:
        print("renew: --local, Vercel untouched")
        return

    token = os.environ.get("VERCEL_TOKEN") or None
    url = push_to_vercel(refresh, token)
    print(f"renew: Vercel env updated, deployment queued ({url})")
    verify(url)


if __name__ == "__main__":
    main()
