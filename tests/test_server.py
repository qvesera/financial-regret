"""Server behavior tests: traversal, 405, 413, rate limit, /api/config, /api/health."""
import json
import threading
import time
import urllib.error
import urllib.request
import unittest
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


def start_server():
    srv = server.ThreadingHTTPServer(("127.0.0.1", 0), server.DevRequestHandler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, port


def req(method, port, path, body=None, headers=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv, cls.port = start_server()
        time.sleep(0.3)

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def test_health(self):
        st, hd, bd = req("GET", self.port, "/api/health")
        data = json.loads(bd)
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertNotEqual(hd.get("Access-Control-Allow-Origin"), "*")

    def test_api_route_strips_query_string(self):
        # Regression: /api/steam_verify?<openid params> must resolve the module
        # by path only, not by path+query.
        st, hd, bd = req("GET", self.port, "/api/health?openid.ns=x&openid.mode=id_res")
        self.assertEqual(st, 200)
        self.assertTrue(json.loads(bd)["ok"])

    def test_unknown_api_with_query_string_names_bare_module(self):
        st, hd, bd = req("GET", self.port, "/api/nope?x=1")
        self.assertEqual(st, 404)
        self.assertIn("'nope'", json.loads(bd)["error"])

    def test_handler_crash_returns_500_not_empty_response(self):
        # Regression: an unhandled handler exception must produce a JSON 500,
        # never a silently dropped socket (browser sees ERR_EMPTY_RESPONSE).
        class Boom:
            def do_GET(self):
                raise RuntimeError("boom")

        with mock.patch.object(server, "_load_api_handler",
                               lambda name: Boom if name == "boom" else None):
            st, hd, bd = req("GET", self.port, "/api/boom")
        self.assertEqual(st, 500)
        self.assertIn("error", json.loads(bd))

    def test_prices_rejects_row_without_id(self):
        # Regression: rows missing 'id' used to raise KeyError mid-request.
        st, hd, bd = req("POST", self.port, "/api/prices",
                         body={"games": [{"title": "X", "appid": 1}]})
        self.assertEqual(st, 400)
        self.assertIn("id", json.loads(bd)["error"])

    def test_config(self):
        st, hd, bd = req("GET", self.port, "/api/config")
        data = json.loads(bd)
        self.assertEqual(st, 200)
        self.assertIn("publicBaseUrl", data)

    def test_traversal_dotdot(self):
        st, _, _ = req("GET", self.port, "/../.env")
        self.assertEqual(st, 404)

    def test_traversal_encoded(self):
        st, _, _ = req("GET", self.port, "/%2e%2e/.env")
        self.assertEqual(st, 404)

    def test_traversal_dot_segment(self):
        st, _, _ = req("GET", self.port, "/./.env")
        self.assertEqual(st, 404)

    def test_static_index(self):
        st, hd, _ = req("GET", self.port, "/index.html")
        self.assertEqual(st, 200)
        self.assertEqual(hd.get("Cache-Control"), "no-cache",
                         "static files must never be cached heuristically")

    def test_method_not_allowed(self):
        st, hd, _ = req("PUT", self.port, "/api/prices")
        self.assertEqual(st, 405)
        self.assertIn("GET", hd.get("Allow", ""))

    def test_large_body(self):
        big = {"games": [{"title": "x" * 2_000_000, "appid": 1}]}
        try:
            st, _, _ = req("POST", self.port, "/api/prices", body=big)
        except (ConnectionError, OSError):
            # The server rejects without draining the upload, so the client can
            # see a reset mid-send instead of the clean 413 -- still a rejection.
            return
        self.assertEqual(st, 413)

    def test_unknown_api(self):
        st, _, _ = req("GET", self.port, "/api/nope")
        self.assertEqual(st, 404)

    def test_security_headers(self):
        st, hd, _ = req("GET", self.port, "/api/health")
        self.assertIn("Content-Security-Policy", hd)
        self.assertIn("nosniff", hd.get("X-Content-Type-Options", ""))


if __name__ == "__main__":
    unittest.main()
