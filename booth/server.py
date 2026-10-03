#!/usr/bin/env python3
"""Broadcast Booth local server.

Serves the app, relays NHL and MLB data (the browser can't call the league
APIs directly because of CORS), and optionally writes commentary with Claude.

    python3 server.py                 # http://localhost:8765
    ANTHROPIC_API_KEY=... python3 server.py   # enables "Claude" commentary

Standard library only, except the optional `anthropic` package.
"""
import argparse
import gzip
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NHL_BASE = "https://api-web.nhle.com/v1/"
MLB_BASE = "https://statsapi.mlb.com/api/"
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/engine.js": ("engine.js", "text/javascript; charset=utf-8"),
    "/demo-game.json": ("demo-game.json", "application/json"),
    "/mlb-engine.js": ("mlb-engine.js", "text/javascript; charset=utf-8"),
    "/mlb-demo-game.json": ("mlb-demo-game.json", "application/json"),
}
NHL_PATH = re.compile(r"^[A-Za-z0-9/_\-]{1,200}$")
MLB_PATH = re.compile(r"^v1(\.1)?/[A-Za-z0-9/_\-]{1,200}$")
MLB_QUERY = re.compile(r"^[A-Za-z0-9=&,_\-.]{0,300}$")
MODEL = os.environ.get("BOOTH_MODEL", "claude-opus-5-5")

# ---------------------------------------------------------------------------
# League relays, with a tiny cache so several tabs don't hammer the APIs
# ---------------------------------------------------------------------------

_cache = {}
_cache_lock = threading.Lock()
CACHE_SECONDS = 2.0


def _fetch(url, league):
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1], hit[2]
    req = urllib.request.Request(url, headers={
        "User-Agent": "BroadcastBooth/1.0 (personal use)",
        "Accept": "application/json",
        # MLB's live feed is a few MB raw; compressed it's a fraction of that.
        "Accept-Encoding": "gzip",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status, body = resp.status, resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
    except urllib.error.HTTPError as e:
        status, body = e.code, json.dumps({"error": f"{league} API returned {e.code}"}).encode()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        status, body = 502, json.dumps({"error": f"could not reach {league} API: {e}"}).encode()
    with _cache_lock:
        _cache[url] = (now, status, body)
    return status, body


def bad_request():
    return 400, json.dumps({"error": "bad path"}).encode()


def fetch_nhl(path):
    """Return (status, body_bytes) for api-web.nhle.com/v1/<path>."""
    if not NHL_PATH.match(path) or ".." in path:
        return bad_request()
    return _fetch(NHL_BASE + path, "NHL")


def fetch_mlb(path, query=""):
    """Return (status, body_bytes) for statsapi.mlb.com/api/<path>?<query>."""
    if not MLB_PATH.match(path) or ".." in path or not MLB_QUERY.match(query):
        return bad_request()
    return _fetch(MLB_BASE + path + (f"?{query}" if query else ""), "MLB")


# ---------------------------------------------------------------------------
# Claude commentary
# ---------------------------------------------------------------------------

COMMON_RULES = """You receive the newest events from the league's official data \
feed and write what the booth says, as two voices: "pbp" (play-by-play) and \
"colour" (analyst).

Rules:
- Facts come ONLY from the events and game state given. Never invent players, \
injuries, stats, history or anything not in the data. Colour may offer opinions, \
character and general talk about the sport, but no made-up facts.
- Lines are spoken aloud by text-to-speech: short sentences, no stage directions, \
no emoji, no markdown, no sound effects in asterisks.
- Do not repeat lines or catchphrases from the recent commentary.
- If nothing in the batch is worth saying, return an empty list."""

SPORT_RULES = {
    "nhl": """This is a live NHL game.
- Play-by-play lines are brief (usually under 15 words) and in event order. Not \
every faceoff, giveaway or missed shot needs a call; skip the mundane when a \
batch is busy. Always call goals and penalties, and give the score after a goal.
- Colour speaks after goals, penalties, period ends, and some whistles. Keep it \
to one or two sentences, and do not let colour talk over a run of action.
- Excitement: "calm" for routine, "up" for big saves/hits/penalties, "huge" only \
for goals in close games, late drama, or overtime.""",
    "mlb": """This is a live MLB game, delivered pitch by pitch.
- Introduce each batter. Call pitches briefly and give the count often; you may \
skip some routine balls and fouls. Never call strike three or ball four as an \
ordinary pitch: the at-bat RESULT line covers it.
- Always call every RESULT, using its description for what happened (who \
fielded it, who scored). After runs score, give the score. Mention exit \
velocity or distance on big hits when given.
- Baseball has room for colour between pitches and between innings: use it, \
one or two sentences at a time, but stop for the action.
- Excitement: "calm" for routine, "up" for extra-base hits, runs, big \
strikeouts and steals, "huge" for home runs in close or late games and walk-offs.""",
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": {"type": "string", "enum": ["pbp", "colour"]},
                    "text": {"type": "string"},
                    "excitement": {"type": "string", "enum": ["calm", "up", "huge"]},
                },
                "required": ["speaker", "text", "excitement"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["lines"],
    "additionalProperties": False,
}

EXCITEMENT = {"calm": 0, "up": 1, "huge": 2}


def build_request(payload):
    """Turn the browser's payload into (system, user_text). Pure; tested."""
    persona = payload.get("persona") or {}
    sport = payload.get("sport") if payload.get("sport") in SPORT_RULES else "nhl"
    system = (f"You are the broadcast booth for a live game.\n\n{COMMON_RULES}\n\n{SPORT_RULES[sport]}\n\n"
              f"THE BOOTH TONIGHT: {persona.get('label', 'Classic broadcast')}\n{persona.get('style', '')}")
    game = payload.get("game") or {}
    parts = [
        f"Game: {game.get('away', 'Away')} at {game.get('home', 'Home')}" + (f", {game['venue']}" if game.get("venue") else "") + ".",
        f"Situation now: {payload.get('situation') or 'not available'}",
    ]
    if payload.get("joining"):
        parts.append("We are joining this game in progress: open with a brief welcome and the situation.")
    recent = payload.get("recent") or []
    if recent:
        parts.append("Recent commentary (do not repeat):\n" + "\n".join(f"- {r}" for r in recent[-12:]))
    events = payload.get("events") or []
    parts.append("New events, in order:\n" + ("\n".join(f"{i + 1}. {e}" for i, e in enumerate(events)) or "(none)"))
    return system, "\n\n".join(parts)


def parse_lines(text):
    data = json.loads(text)
    out = []
    for line in data.get("lines", []):
        t = str(line.get("text", "")).strip()
        if not t:
            continue
        out.append({
            "speaker": "colour" if line.get("speaker") == "colour" else "pbp",
            "text": t,
            "excitement": EXCITEMENT.get(line.get("excitement"), 0),
        })
    return out


class Commentator:
    def __init__(self):
        self.client = None
        self.error = None
        try:
            import anthropic  # noqa: F401
        except ImportError:
            self.error = "anthropic package not installed (pip install anthropic)"
            return
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            self.error = "no ANTHROPIC_API_KEY set"
            return
        import anthropic
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(timeout=30.0, max_retries=1)

    @property
    def available(self):
        return self.client is not None

    def lines(self, payload):
        system, user = build_request(payload)
        resp = self.client.beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=system,
            messages=[{"role": "user", "content": user}],
            cache_control={"type": "ephemeral"},
            # Low effort: this is short creative writing on a clock.
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            raise RuntimeError("model declined this batch")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if text is None:
            raise RuntimeError(f"no text in response (stop_reason={resp.stop_reason})")
        return parse_lines(text)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    commentator = None
    server_version = "BroadcastBooth/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("BOOTH_LOG"):
            super().log_message(fmt, *args)

    def send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj):
        self.send(status, json.dumps(obj).encode())

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in STATIC:
            name, ctype = STATIC[path]
            self.send(200, (ROOT / name).read_bytes(), ctype)
        elif path == "/api/status":
            c = self.commentator
            self.send_json(200, {"llm": c.available, "model": MODEL if c.available else None, "llmError": c.error})
        elif path.startswith("/api/nhl/"):
            if query:
                return self.send(*bad_request())
            self.send(*fetch_nhl(path[len("/api/nhl/"):]))
        elif path.startswith("/api/mlb/"):
            self.send(*fetch_mlb(path[len("/api/mlb/"):], query))
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/api/commentary":
            return self.send_json(404, {"error": "not found"})
        if not self.commentator.available:
            return self.send_json(503, {"error": self.commentator.error})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 200_000:
                return self.send_json(413, {"error": "payload too large"})
            payload = json.loads(self.rfile.read(length) or b"{}")
            started = time.monotonic()
            lines = self.commentator.lines(payload)
            self.send_json(200, {"lines": lines, "seconds": round(time.monotonic() - started, 2)})
        except Exception as e:  # report to the page; it falls back to templates
            self.send_json(502, {"error": f"{type(e).__name__}: {e}"})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args(argv)
    Handler.commentator = Commentator()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    llm = f"Claude commentary ON ({MODEL})" if Handler.commentator.available else f"Claude commentary off: {Handler.commentator.error}"
    print(f"Broadcast Booth on http://localhost:{args.port}  |  {llm}", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
