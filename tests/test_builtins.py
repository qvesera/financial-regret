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
import re
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
        self.assertEqual(set(body["keys"]), {"steam", "itad", "platprices", "sgdb"})
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

    def test_reports_the_visitor_country_from_the_edge(self):
        # Vercel's header. The browser defaults the display currency from it.
        h = StubHandler({"x-vercel-ip-country": "DE"})
        config_mod.handler.do_GET(h)
        body = json.loads(h.wfile.getvalue().decode())
        self.assertEqual(body["country"], "DE")

    def test_also_reads_cloudflare_country(self):
        h = StubHandler({"cf-ipcountry": "gb"})
        config_mod.handler.do_GET(h)
        body = json.loads(h.wfile.getvalue().decode())
        self.assertEqual(body["country"], "GB", "normalised to upper case")

    def test_country_is_null_when_no_edge_reported_one(self):
        # A direct self-hosted server.py: the frontend keeps its own default
        # rather than being told a country nobody measured.
        _, _, body = _call(config_mod, {})
        self.assertIsNone(body["country"])


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
        # /api/psn_prices must resolve to backend/psn_prices.py (API_DIR): the
        # single Vercel function and server.py both route on the first path segment.
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

    def test_a_broken_module_is_a_500_not_a_404(self):
        # A file that exists but will not import is a deployment error. It used
        # to fall through to the same 404 as a route that never existed, which
        # named the endpoint as the problem and hid the import failure entirely.
        import index
        index._LOADED.clear()
        with mock.patch.object(index.importlib, "import_module",
                               side_effect=SyntaxError("broken on purpose")):
            status, body = self._dispatch("/api/prices")
        self.assertEqual(status, 500)
        self.assertIn("failed to load", body["error"])

    def test_a_handler_that_raises_returns_500(self):
        # The crash guard server.py already had: production must answer with
        # JSON 500, not let the exception escape into the platform's HTML error.
        class Boom:
            @staticmethod
            def do_GET(_):
                raise RuntimeError("boom")

        import index
        with mock.patch.object(index, "_handler_for",
                               lambda name: Boom if name == "boom" else None):
            status, body = self._dispatch("/api/boom")
        self.assertEqual(status, 500)
        self.assertIn("error", body)


class TestClientRoutes(unittest.TestCase):
    """The browser must only call routes that exist, and public/ must ship no tests.

    Nothing else checks both halves: the endpoint modules are tested on their
    own, and no test ever read the client's URLs, so a renamed or missing
    module would 404 in production while every suite stayed green. The test
    files used to live in public/js/ too, where they were served to visitors."""

    _ROUTE = re.compile(r"""["'`]/api/([a-z][a-z0-9_]*)""")

    def test_every_client_route_has_an_endpoint_module(self):
        # Quote- or backtick-prefixed only: the same substring inside an
        # absolute third-party URL (Epic's /id/api/redirect, Sony's
        # /api/v1/ssocookie) is not one of our routes.
        called = set()
        for src in sorted((ROOT / "public" / "js").glob("*.js")):
            called |= set(self._ROUTE.findall(src.read_text(encoding="utf-8")))
        self.assertGreaterEqual(len(called), 12, sorted(called))
        for name in sorted(called):
            with self.subTest(route=name):
                self.assertTrue((ROOT / "backend" / f"{name}.py").is_file(),
                                f"the client calls /api/{name} but backend/{name}.py does not exist")

    def test_public_ships_no_test_files(self):
        served = [str(p.relative_to(ROOT)) for p in (ROOT / "public").rglob("*.test.mjs")]
        self.assertEqual(served, [], served)


class TestDockerfile(unittest.TestCase):
    """The documented long-scan backend is `docker build` + server.py.

    A Dockerfile that cannot build is a deployment path that rotted silently:
    no suite imported it, and no docker runs in CI. This is the guard."""

    def test_every_requirement_file_the_image_installs_exists(self):
        # The image once ran `pip install -r api/requirements.txt` against a
        # file that had never existed here, so the build died at that layer
        # while every test stayed green.
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        refs = re.findall(r"-r\s+(\S+)", dockerfile)
        self.assertTrue(refs, "no -r references found to check")
        for ref in refs:
            with self.subTest(ref=ref):
                self.assertTrue((ROOT / ref).is_file(),
                                f"Dockerfile installs {ref}, which does not exist")


class TestSecurityHeaderParity(unittest.TestCase):
    """The CSP ships twice: _common.py for server.py, vercel.json at the edge.

    Drift would silently weaken one path while every test kept passing -- this
    repo has been bitten by paired lists that drifted before."""

    def test_the_two_csps_are_one_string(self):
        from _common import CSP
        cfg = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
        seen = [h["value"] for block in cfg.get("headers", [])
                for h in block.get("headers", [])
                if h.get("key") == "Content-Security-Policy"]
        self.assertEqual(len(seen), 1, "vercel.json must carry exactly one CSP")
        self.assertEqual(seen[0], CSP, "vercel.json CSP drifted from _common.CSP")


if __name__ == "__main__":
    unittest.main()
