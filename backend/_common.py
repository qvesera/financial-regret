"""Small shared helpers for the API handler modules (JSON responses + security headers).

No CORS wildcard: the frontend is normally same-origin with this server, and a
split deploy must name its origins explicitly through CORS_ALLOWED_ORIGINS (see
_cors.py). A wildcard is neither needed nor safe for a public host.
"""
import hmac
import json
import os

from _cors import send_cors

# connect-src names exactly one outbound host beyond 'self': is.gd, used only
# when a visitor clicks Copy link to fetch a short URL. SECURITY.md records
# what that host can see and how to remove it again.
CSP = (
    "default-src 'self'; "
    "connect-src 'self' https://is.gd; "
    "img-src 'self' data: https://cdn2.steamgriddb.com https://cdn.steamgriddb.com; "
    "style-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'"
)


def _security_headers(handler) -> None:
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("X-Frame-Options", "DENY")
    handler.send_header("Content-Security-Policy", CSP)
    handler.send_header("Cache-Control", "no-store")


def send_json(handler, status: int, data: dict) -> None:
    handler._response_sent = True   # lets the server return 500 instead of double-sending
    body = json.dumps(data).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    _security_headers(handler)
    send_cors(handler)
    handler.end_headers()
    handler.wfile.write(body)


def handle_options(handler) -> None:
    handler._response_sent = True
    handler.send_response(204)
    _security_headers(handler)
    send_cors(handler)
    handler.end_headers()


def require_user_keys() -> bool:
    return os.environ.get("REQUIRE_USER_KEYS", "0").lower() in ("1", "true", "yes")


def user_key(handler, header: str, env_var: str) -> str | None:
    """The API key to spend on this request: the caller's, or the server's.

    The caller's header key always wins, so a visitor who brought their own
    spends their own quota first. Falling back to the server key is what makes
    an instance usable without any setup -- but that quota is a shared pool
    (PlatPrices' free tier is 1,000 requests a month), so one busy visitor
    could drain it for everybody, and reselling another provider's data on your
    own account is exactly what their paid tiers are for.

    Public deployments set REQUIRE_USER_KEYS=1 to remove the fallback: the
    server key is then never spent on a stranger's request, and a visitor
    without a key is refused rather than billed against the operator's quota.

    Self-hosted installs leave the flag unset and keep the convenience of a
    server-side key, which is what the existing contract tests pin.
    """
    key = (handler.headers.get(header) or "").strip()
    # SUPERUSER_KEY (env): an operator-set term that spends the server's own
    # key even in BYO mode. Unset — the default — the term below behaves as
    # "no key supplied" instead of reaching a provider.
    secret = os.environ.get("SUPERUSER_KEY") or ""
    if key and secret and hmac.compare_digest(key.lower().encode("utf-8"), secret.lower().encode("utf-8")):
        return (os.environ.get(env_var) or "").strip() or None
    if key.lower() == "superuser":
        key = ""
    if key:
        return key
    if require_user_keys():
        return None
    return (os.environ.get(env_var) or "").strip() or None
