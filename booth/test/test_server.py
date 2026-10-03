"""Run: python3 -m unittest discover -s booth/test"""
import gzip
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class FakeMessages:
    def __init__(self, text, stop_reason="end_turn"):
        self.text, self.stop_reason, self.calls = text, stop_reason, []

    def create(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(stop_reason=self.stop_reason,
                               content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=self.text)])


def fake_commentator(text, stop_reason="end_turn"):
    c = server.Commentator.__new__(server.Commentator)
    c.error = None
    c.messages = FakeMessages(text, stop_reason)
    c.client = SimpleNamespace(beta=SimpleNamespace(messages=c.messages))
    return c


PAYLOAD = {
    "sport": "nhl",
    "persona": {"label": "Test booth", "style": "Be brief."},
    "game": {"away": "Canadiens", "home": "Maple Leafs", "venue": "the Gardens"},
    "situation": "Canadiens 1, Maple Leafs 2. Shots 10-12. 2nd period.",
    "recent": ["pbp: Big save!"],
    "events": ["[2nd period 10:00 left] GOAL TOR: Doug McAllister (wrist shot)."],
}


class BuildRequestTest(unittest.TestCase):
    def test_contains_persona_state_and_events(self):
        system, user = server.build_request(PAYLOAD)
        self.assertIn("Test booth", system)
        self.assertIn("Be brief.", system)
        self.assertIn("Situation now: Canadiens 1, Maple Leafs 2", user)
        self.assertIn("live NHL game", system)
        self.assertNotIn("pitch by pitch", system)
        self.assertIn("1. [2nd period 10:00 left] GOAL TOR", user)
        self.assertIn("- pbp: Big save!", user)
        self.assertNotIn("joining", user.lower())

    def test_mlb_rules(self):
        system, _ = server.build_request({**PAYLOAD, "sport": "mlb"})
        self.assertIn("live MLB game", system)
        self.assertIn("strike three", system)
        self.assertNotIn("faceoff", system)

    def test_unknown_sport_defaults_to_hockey(self):
        system, _ = server.build_request({**PAYLOAD, "sport": "curling"})
        self.assertIn("live NHL game", system)

    def test_joining_and_empty(self):
        _, user = server.build_request({"joining": True})
        self.assertIn("joining this game in progress", user)
        self.assertIn("(none)", user)


class ParseLinesTest(unittest.TestCase):
    def test_maps_and_filters(self):
        out = server.parse_lines(json.dumps({"lines": [
            {"speaker": "pbp", "text": " Scores! ", "excitement": "huge"},
            {"speaker": "colour", "text": "", "excitement": "calm"},
            {"speaker": "weird", "text": "Hm.", "excitement": "?"},
        ]}))
        self.assertEqual(out, [
            {"speaker": "pbp", "text": "Scores!", "excitement": 2},
            {"speaker": "pbp", "text": "Hm.", "excitement": 0},
        ])


class CommentatorTest(unittest.TestCase):
    def test_request_shape(self):
        c = fake_commentator(json.dumps({"lines": [{"speaker": "pbp", "text": "Shoots, scores!", "excitement": "huge"}]}))
        self.assertEqual(c.lines(PAYLOAD)[0]["excitement"], 2)
        kw = c.messages.calls[0]
        self.assertEqual(kw["model"], server.MODEL)
        self.assertEqual(kw["output_config"]["effort"], "low")
        self.assertEqual(kw["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(kw["fallbacks"], "default")
        self.assertEqual(kw["betas"], ["server-side-fallback-2026-07-01"])
        self.assertNotIn("thinking", kw)

    def test_refusal_raises(self):
        c = fake_commentator("", stop_reason="refusal")
        with self.assertRaises(RuntimeError):
            c.lines(PAYLOAD)


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.Handler.commentator = fake_commentator(json.dumps({"lines": [{"speaker": "colour", "text": "Nice.", "excitement": "calm"}]}))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=15) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_static(self):
        for p in ["/", "/app.js", "/engine.js", "/demo-game.json", "/mlb-engine.js", "/mlb-demo-game.json"]:
            status, body = self.get(p)
            self.assertEqual(status, 200, p)
            self.assertTrue(body)
        self.assertEqual(self.get("/server.py")[0], 404)
        self.assertEqual(self.get("/../server.py")[0], 404)

    def test_status(self):
        status, body = self.get("/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["llm"])

    def test_nhl_path_validation(self):
        self.assertEqual(self.get("/api/nhl/score/2025-10-10%3Fx")[0], 400)
        self.assertEqual(self.get("/api/nhl/score/2025-10-10?x=1")[0], 400)
        self.assertEqual(self.get("/api/nhl/a/../../etc")[0], 400)

    def test_mlb_path_validation(self):
        self.assertEqual(self.get("/api/mlb/v2/schedule")[0], 400)
        self.assertEqual(self.get("/api/mlb/v1/schedule?date=2026-10-03;rm")[0], 400)
        self.assertEqual(self.get("/api/mlb/v1/../../x")[0], 400)

    def test_mlb_relay_decompresses_gzip(self):
        body = json.dumps({"dates": [{"games": [{"gamePk": 1}]}]}).encode()
        seen = {}

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                seen["path"] = self.path
                seen["enc"] = self.headers.get("Accept-Encoding")
                z = gzip.compress(body)
                self.send_response(200)
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(z)))
                self.end_headers()
                self.wfile.write(z)

        up = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=up.serve_forever, daemon=True).start()
        old = server.MLB_BASE
        server.MLB_BASE = f"http://127.0.0.1:{up.server_address[1]}/api/"
        try:
            status, data = self.get("/api/mlb/v1/schedule?sportId=1&date=2026-10-03&hydrate=team")
        finally:
            server.MLB_BASE = old
            up.shutdown()
            up.server_close()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), json.loads(body))
        self.assertEqual(seen["path"], "/api/v1/schedule?sportId=1&date=2026-10-03&hydrate=team")
        self.assertEqual(seen["enc"], "gzip")

    def test_commentary(self):
        req = urllib.request.Request(self.base + "/api/commentary", data=json.dumps(PAYLOAD).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        self.assertEqual(data["lines"], [{"speaker": "colour", "text": "Nice.", "excitement": 0}])


if __name__ == "__main__":
    unittest.main()
