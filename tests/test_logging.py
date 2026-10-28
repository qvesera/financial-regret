"""Access-log redaction.

server.py's docstring promises tokens never reach the logs. The custom progress
print already trims the query string, but the inherited line writes
self.requestline verbatim, so without the rewrite in log_message the promise
would be false. A leaked query string is exactly the sort of thing only noticed
after it has been in someone's log aggregator for a month.
"""
import http.server
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server


def _logged(path: str, command: str = "GET", requestline: str | None = None) -> str:
    """Run the real log_message against a stub handler; return what the stdlib got."""
    # __new__ skips __init__, so no socket is needed; but it must be a genuine
    # instance, because log_message ends in a zero-argument super() call.
    handler = server.DevRequestHandler.__new__(server.DevRequestHandler)
    handler.path = path
    handler.command = command
    with mock.patch.object(http.server.BaseHTTPRequestHandler, "log_message") as parent:
        server.DevRequestHandler.log_message(
            handler,
            '"%s" %s %s',
            requestline or f"{command} {path} HTTP/1.1",
            "200",
            "10",
        )
    return " ".join(str(a) for a in parent.call_args.args[1:])


class TestRedaction(unittest.TestCase):
    def test_query_string_never_reaches_the_log_line(self):
        logged = _logged("/api/steam_games?steamid=7656119&npsso=SECRET")
        self.assertNotIn("npsso=SECRET", logged)
        self.assertNotIn("steamid=7656119", logged)
        self.assertIn("/api/steam_games", logged, "the path itself must survive")

    def test_a_path_without_a_query_is_passed_through(self):
        logged = _logged("/api/health")
        self.assertIn("/api/health", logged)
        self.assertIn("GET /api/health HTTP/1.1", logged)

    def test_redaction_matches_the_request_line_not_just_self_path(self):
        # log_request passes self.requestline, whose string must be scrubbed too.
        logged = _logged("/api/prices?x=1", requestline="GET /api/prices?x=1 HTTP/1.1")
        self.assertNotIn("x=1", logged)


if __name__ == "__main__":
    unittest.main()
