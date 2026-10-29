"""Origin allowlist for split-origin hosting.

Self-hosted deploys serve the frontend from this process, so same-origin
requests carry no Origin header on GETs and CORS simply never applies --
behaviour is unchanged from before this module existed.

A public split deploy (static frontend on a CDN, this API on its own host)
crosses origins, so the browser demands an Access-Control-Allow-Origin it can
match. We only ever echo back an origin that was explicitly allowlisted: no
wildcard, because every client here carries credentials in request headers and
a wildcard would let any website in the world drive them.
"""
import os

# Every header the browser client sends. A request carrying a header outside
# this list fails preflight outright, so it must track public/js/api.js and
# public/js/app.js exactly. Covered by tests/test_cors.py.
ALLOW_HEADERS = (
    "Accept, Content-Type, X-Amazon-Serial, X-Amazon-Token, X-Epic-Account-Id, "
    "X-Epic-Refresh, X-Epic-Token, X-GOG-Refresh, X-GOG-Token, X-GOG-User-Id, "
    "X-ITAD-Key, X-Platprices-Key, X-PSN-Refresh, X-PSN-Token, X-SGDB-Key, "
    "X-Steam-Key"
)

ALLOW_METHODS = "GET, POST, OPTIONS"

# Cross-origin requests that carry a header are preflighted; caching the
# preflight keeps that extra round trip off every single call.
MAX_AGE = "600"


# A stray '*' or 'null' in the allowlist must never become an emitted origin:
# either one would let any site in, which is the exact failure this module
# exists to prevent. Rejecting them here means a copy-paste mistake is inert.
UNSAFE = frozenset({"*", "null"})


def allowed_origins() -> list[str]:
    raw = os.environ.get("CORS_ALLOWED_ORIGINS", "")
    cleaned = [o.strip().rstrip("/") for o in raw.split(",")]
    return [o for o in cleaned if o and o not in UNSAFE]


def acknowledged_origin(handler) -> str | None:
    """The origin we are willing to vouch for, or None."""
    origin = (handler.headers.get("Origin") or "").strip()
    if not origin or origin.rstrip("/") not in allowed_origins():
        return None
    return origin


def send_cors(handler) -> None:
    """Attach CORS headers to an in-progress response. Call before end_headers().

    Empty for same-origin and for disallowed origins alike: withholding the
    header is how a browser is told "not yours", and that needs no cooperation
    from us beyond silence.
    """
    allowed = acknowledged_origin(handler)
    if allowed is None:
        return
    handler.send_header("Access-Control-Allow-Origin", allowed)
    handler.send_header("Access-Control-Max-Age", MAX_AGE)
    handler.send_header("Access-Control-Allow-Methods", ALLOW_METHODS)
    handler.send_header("Access-Control-Allow-Headers", ALLOW_HEADERS)
    handler.send_header("Vary", "Origin")
