"""Single entry point that serves every /api route.

Endpoint modules live in backend/ so that api/ holds exactly one file. Vercel
turns every .py under /api into its own serverless function, and the Hobby plan
allows at most 12 per deployment -- with 15 endpoints, one file per route could
not deploy. The local server already dispatches /api/<name> to a module by
name, so this does the same inside one function and vercel.json rewrites
/api/* here.

Modules keep their own `class handler(BaseHTTPRequestHandler)`, so dispatching
is just handing them the live request object, exactly as the local server does.
"""
import importlib
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from _common import send_json   # noqa: E402

_LOADED: dict[str, object] = {}
_ALLOWED = ("GET", "POST", "OPTIONS")
_BROKEN = object()             # the file exists but will not load: a 500, not a 404


def _handler_for(name: str):
    """The handler class, _BROKEN when the module fails to load, or None when
    the route does not exist at all."""
    if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
        return None
    if name in _LOADED:
        return _LOADED[name]
    if not (_BACKEND / f"{name}.py").is_file():
        return None
    try:
        module = importlib.import_module(name)
    except Exception:
        # One broken module must not take every route down -- but its own route
        # has to report the import failure, not answer 404 as though nobody had
        # ever written it. That 404 is what the local server used to give too.
        traceback.print_exc()
        return _BROKEN
    cls = getattr(module, "handler", None)
    if cls is None:
        return _BROKEN
    _LOADED[name] = cls        # cached, so warm instances share module state
    return cls


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._dispatch("do_GET")

    def do_POST(self):
        self._dispatch("do_POST")

    def do_OPTIONS(self):
        self._dispatch("do_OPTIONS")

    def _dispatch(self, method: str) -> None:
        # /api/psn_prices?x=1 -> psn_prices, matching the local server.
        parts = self.path.split("?", 1)[0].split("/")
        name = parts[2] if len(parts) > 2 else ""
        cls = _handler_for(name)
        if cls is _BROKEN:
            send_json(self, 500, {"error": f"API function '{name}' failed to load"})
            return
        if cls is None:
            send_json(self, 404, {"error": f"No API function named '{name}'"})
            return
        fn = getattr(cls, method, None)
        if fn is None:
            allow = ", ".join(m for m in _ALLOWED if getattr(cls, m, None))
            send_json(self, 405, {"error": "Method not allowed", "allow": allow})
            return
        # The same contract server.py keeps: a handler bug answers with JSON 500
        # instead of escaping to the platform's own HTML error page, and never
        # after a response was already sent.
        try:
            fn(self)
        except Exception:
            traceback.print_exc()
            if not getattr(self, "_response_sent", False):
                try:
                    send_json(self, 500, {"error": "Internal server error"})
                except Exception:
                    pass
