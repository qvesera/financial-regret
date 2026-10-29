"""The built-in endpoints, and the contract that lets the whole API deploy to Vercel.

Vercel's file-based Python functions load each api/<name>.py and look for a
top-level `handler` that subclasses BaseHTTPRequestHandler, then serve it at
/api/<name>. This repo already matched that shape by accident of how server.py
loads modules -- so it is now asserted deliberately, because the day someone
renames a handler class the API would silently vanish from a Vercel deploy while
every self-hosted test kept passing.
"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
API_DIR = ROOT / "backend"
sys.path.insert(0, str(API_DIR))
# api/index.py is the single serverless entry point, so it must be importable
# alongside the modules it dispatches to.
sys.path.insert(0, str(ROOT / "api"))

import config as config_mod
import health as health_mod


class StubHandler:
    def __init__(self, headers=None):
        self.headers = dict(headers or {})
        self.sent = []
        self._response_sent = False
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, name, value):
        self.sent.append((name, value))

    def end_headers(self):
        pass


def _call(mod, env=None):
    with mock.patch.dict(os.environ, env or {}):
        h = StubHandler()
        mod.handler.do_GET(h)
    body = json.loads(h.wfile.getvalue().decode())
    return h.status, dict(h.sent), body


class TestHealth(unittest.TestCase):
    def test_reports_liveness_and_mode(self):
        status, _, body = _call(health_mod, {"REQUIRE_USER_KEYS": "1", "STEAM_API_KEY": "k"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIsInstance(body["uptime_s"], float)
        self.assertTrue(body["require_user_keys"])
        self.assertEqual(set(body["keys"]), {"steam", "itad", "platprices"})
        self.assertTrue(body["keys"]["steam"])

    def test_answers_a_cors_preflight(self):
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_ORIGINS": "https://a.example"}):
            h = StubHandler({"Origin": "https://a.example"})
            health_mod.handler.do_OPTIONS(h)
            headers = dict(h.sent)
        self.assertEqual(h.status, 204)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "https://a.example")


class TestConfig(unittest.TestCase):
    def test_carries_the_fields_the_browser_needs(self):
        status, _, body = _call(config_mod, {"PUBLIC_BASE_URL": "https://app.example"})
        self.assertEqual(status, 200)
        self.assertEqual(body["publicBaseUrl"], "https://app.example")
        self.assertIn("gogClientId", body)
        self.assertIn("epicClientId", body)
        self.assertIn("gogRedirectMode", body)

    def test_falls_back_to_the_bind_address(self):
        status, _, body = _call(config_mod, {"PORT": "8123"})
        self.assertEqual(body["publicBaseUrl"], "http://localhost:8123")


class TestVercelContract(unittest.TestCase):
    """Every api module must be loadable by Vercel's /api runtime."""

    def test_every_module_exposes_a_handler_class(self):
        from http.server import BaseHTTPRequestHandler
        modules = sorted(p.stem for p in API_DIR.glob("*.py")
                         if not p.stem.startswith("_"))
        self.assertGreaterEqual(len(modules), 13, modules)
        for name in modules:
            with self.subTest(module=name):
                mod = __import__(name)
                cls = getattr(mod, "handler", None)
                self.assertIsNotNone(cls, f"{name}.py must define `handler`")
                self.assertTrue(issubclass(cls, BaseHTTPRequestHandler), name)
                methods = {m for m in ("do_GET", "do_POST", "do_OPTIONS")
                           if callable(getattr(cls, m, None))}
                self.assertTrue({"do_GET", "do_POST"} & methods,
                                f"{name}.py handles neither GET nor POST")
                self.assertIn("do_OPTIONS", methods, f"{name}.py cannot answer a preflight")

    def test_route_names_match_module_names(self):
        # /api/psn_prices must resolve to api/psn_prices.py: Vercel routes on
        # file path, and server.py routes on the first path segment.
        for name in ("health", "config", "prices", "psn_prices", "steam_games"):
            self.assertTrue((API_DIR / f"{name}.py").is_file(), name)


class TestIndexDispatch(unittest.TestCase):
    """api/index.py stands in for the local server's routing on a Hobby plan."""

    @staticmethod
    def _dispatch(path, method="do_GET", body=b""):
        # Call _dispatch unbound against the stub rather than instantiating the
        # handler: BaseHTTPRequestHandler.__init__ wants a socket, and its
        # send_response() needs the buffers __init__ builds. The stub satisfies
        # everything _dispatch and the endpoint modules actually touch.
        import index
        h = StubHandler()
        h.path = path
        h.command = method[3:]
        h.requestline = f"{h.command} {path} HTTP/1.1"
        h.rfile = io.BytesIO(body)
        index.handler._dispatch(h, method)
        return h.status, json.loads(h.wfile.getvalue().decode() or "{}")

    def test_routes_by_first_path_segment(self):
        status, body = self._dispatch("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_query_string_is_not_part_of_the_route_name(self):
        status, _ = self._dispatch("/api/health?openid.mode=id_res")
        self.assertEqual(status, 200)

    def test_unknown_route_is_a_json_404(self):
        status, body = self._dispatch("/api/nope")
        self.assertEqual(status, 404)
        self.assertIn("'nope'", body["error"])

    def test_wrong_method_is_405(self):
        status, body = self._dispatch("/api/health", method="do_POST")
        self.assertEqual(status, 405)
        self.assertEqual(body["error"], "Method not allowed")

    def test_a_module_is_loaded_once_and_reused(self):
        # Warm instances must share module state, which is the main benefit of
        # collapsing to one function.
        import index
        index._LOADED.clear()
        self._dispatch("/api/config")
        self._dispatch("/api/config")
        self.assertEqual(len(index._LOADED), 1)


if __name__ == "__main__":
    unittest.main()
