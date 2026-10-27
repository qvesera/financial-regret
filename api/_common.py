"""Small shared helpers for the API handler modules (JSON responses + security headers).

No CORS wildcard: the frontend is same-origin with this server, so
Access-Control-Allow-Origin: * is neither needed nor safe for a public host.
"""
import json

CSP = (
    "default-src 'self'; "
    "connect-src 'self'; "
    "img-src 'self' data:; "
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
    handler.end_headers()
    handler.wfile.write(body)


def handle_options(handler) -> None:
    handler.send_response(204)
    _security_headers(handler)
    handler.end_headers()
