"""Run: python3 -m unittest discover -s booth/test"""
import gzip
import json
import sys
import threading
import time
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

    def test_colour_mode(self):
        payload = {**PAYLOAD, "sport": "mlb", "mode": "colour", "stats": "Batter: Steven Kwan - season AVG .290"}
        system, user = server.build_request(payload)
        self.assertIn("colour analyst", system)
        self.assertIn("live MLB game", system)
        self.assertIn("at most ONE line", system)
        self.assertNotIn("Introduce each batter", system)  # play-by-play rules don't apply
        self.assertIn("Stats you may use:\nBatter: Steven Kwan", user)
        self.assertIn("Latest events, in order", user)

    def test_load_env(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, ".env")
            with open(p, "w") as fh:
                fh.write("# my key\nexport BOOTH_TEST_KEY='sk-ant-xyz'\nBOOTH_TEST_SET=already\n\nnot a line\n")
            os.environ["BOOTH_TEST_SET"] = "keep"
            try:
                self.assertEqual(server.load_env(p), ["BOOTH_TEST_KEY"])
                self.assertEqual(os.environ["BOOTH_TEST_KEY"], "sk-ant-xyz")
                self.assertEqual(os.environ["BOOTH_TEST_SET"], "keep")
                self.assertEqual(server.load_env(os.path.join(d, "missing")), [])
            finally:
                os.environ.pop("BOOTH_TEST_KEY", None)
                os.environ.pop("BOOTH_TEST_SET", None)

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


class SessionLogTest(unittest.TestCase):
    def test_writes_jsonl_echoes_problems_and_snapshots_feeds(self):
        import io
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = io.StringIO()
            log = server.SessionLog(d, echo=out)
            log.write("line", "browser", text="Ball one.")
            log.write("warn", "relay", message="MLB 503 for /x")
            log.write("flag", "browser", note="count wrong", situation="Top 3rd", recentLines=["Ball. One and one."])
            with open(log.path) as fh:
                rows = [json.loads(x) for x in fh]
            self.assertEqual([r["kind"] for r in rows], ["line", "warn", "flag"])
            self.assertEqual(rows[0]["text"], "Ball one.")
            echoed = out.getvalue()
            self.assertIn("WARN  relay: MLB 503 for /x", echoed)
            self.assertIn('count wrong  |  Top 3rd  |  last line: "Ball. One and one."', echoed)
            self.assertNotIn("Ball one.", echoed)  # routine lines go to the file only

            log.snapshot_feed("/api/mlb/v1.1/game/777/feed/live", b'{"a":1}')
            log.snapshot_feed("/api/mlb/v1.1/game/777/feed/live", b'{"a":2}')  # throttled
            log.snapshot_feed("/api/nhl/gamecenter/2026020001/play-by-play", b'{"b":1}')
            log.snapshot_feed("/api/mlb/v1/schedule", b'{}')  # not a game feed
            self.assertEqual(gzip.decompress((Path(d) / "feed-mlb-777.json.gz").read_bytes()), b'{"a":1}')
            self.assertTrue((Path(d) / "feed-nhl-2026020001.json.gz").exists())
            self.assertEqual(len(list(Path(d).glob("feed-*"))), 2)

    def test_unwritable_directory_does_not_raise(self):
        import io
        log = server.SessionLog("/proc/booth-cannot-write-here", echo=io.StringIO())
        log.write("error", message="still fine")
        log.snapshot_feed("/api/mlb/v1.1/game/1/feed/live", b"{}")
        self.assertIsNone(log.path)


FAKE_SAY = """#!/bin/sh
if [ "$1" = "-v" ] && [ "$2" = "?" ]; then
  printf 'Albert              en_US    # Hello! My name is Albert.\\n'
  printf 'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.\\n'
  printf 'Fiona (Enhanced)    en-scotland # Hello! My name is Fiona.\\n'
  printf 'Amelie              fr_CA    # Bonjour, je m appelle Amelie.\\n'
  exit 0
fi
echo "$@" >> "$SAY_LOG"
case "$*" in *slow*) sleep 5;; esac
"""


class MacVoiceTest(unittest.TestCase):
    def setUp(self):
        import os
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.bin = os.path.join(self.dir.name, "say")
        with open(self.bin, "w") as fh:
            fh.write(FAKE_SAY)
        os.chmod(self.bin, 0o755)
        self.said = os.path.join(self.dir.name, "said.txt")
        os.environ["SAY_LOG"] = self.said
        self.mac = server.MacVoice(self.bin)

    def tearDown(self):
        self.dir.cleanup()

    def test_lists_english_voices_only(self):
        names = [v["name"] for v in self.mac.voices()]
        self.assertEqual(names, ["Albert", "Eddy (English (UK))", "Fiona (Enhanced)"])

    def test_speak_args_system_voice_and_named_voice(self):
        self.mac.speak("Ball one.")
        self.mac.speak("-5 degrees", voice="Albert", rate=1000)
        with open(self.said) as fh:
            lines = fh.read().splitlines()
        self.assertEqual(lines[0], "Ball one.")
        self.assertEqual(lines[1], "-v Albert -r 400  -5 degrees")

    def test_stop_only_kills_the_line_it_targets(self):
        t = threading.Thread(target=self.mac.speak, args=("slow line",), kwargs={"line_id": 7})
        started = time.monotonic()
        t.start()
        time.sleep(0.3)
        self.mac.stop(up_to=6)  # stale stop for an older line: ignored
        time.sleep(0.3)
        self.assertTrue(t.is_alive())
        self.mac.stop(up_to=7)
        t.join(3)
        self.assertFalse(t.is_alive())
        self.assertLess(time.monotonic() - started, 3)

    def test_unavailable_without_say(self):
        self.assertFalse(server.MacVoice("").available)


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
        cls.httpd.server_close()

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

    def test_log_endpoint(self):
        import io
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            old = server.Handler.log
            server.Handler.log = server.SessionLog(d, echo=io.StringIO())
            try:
                body = json.dumps({"entries": [{"kind": "event", "desc": "Ball", "ts": "spoofed"}, "junk", {"kind": "error", "message": "boom"}]}).encode()
                req = urllib.request.Request(self.base + "/api/log", data=body, headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=15) as r:
                    self.assertEqual(r.status, 200)
                with open(server.Handler.log.path) as fh:
                    rows = [json.loads(x) for x in fh]
                self.assertEqual([(r["src"], r["kind"]) for r in rows], [("browser", "event"), ("browser", "error")])
                self.assertNotEqual(rows[0]["ts"], "spoofed")
                self.assertIn("ERROR browser: boom", server.Handler.log.echo.getvalue())
                status = json.loads(self.get("/api/status")[1])
                self.assertTrue(status["logFile"].endswith(".jsonl"))
            finally:
                server.Handler.log = old

    def test_commentary(self):
        req = urllib.request.Request(self.base + "/api/commentary", data=json.dumps(PAYLOAD).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        self.assertEqual(data["lines"], [{"speaker": "colour", "text": "Nice.", "excitement": 0}])


if __name__ == "__main__":
    unittest.main()
