#!/usr/bin/env python3
"""Broadcast Booth local server.

Serves the app, relays NHL data (the browser can't call api-web.nhle.com
directly because of CORS), and optionally writes commentary with Claude.

    python3 server.py                 # http://localhost:8765
    ANTHROPIC_API_KEY=... python3 server.py   # enables "Claude" commentary

Standard library only, except the optional `anthropic` package.
"""
import argparse
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
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/engine.js": ("engine.js", "text/javascript; charset=utf-8"),
    "/demo-game.json": ("demo-game.json", "application/json"),
}
NHL_PATH = re.compile(r"^[A-Za-z0-9/_\-]{1,200}$")
MODEL = os.environ.get("BOOTH_MODEL", "claude-opus-5-5")

# ---------------------------------------------------------------------------
# NHL relay with a tiny cache so several tabs don't hammer the API
# ---------------------------------------------------------------------------

_cache = {}
_cache_lock = threading.Lock()
CACHE_SECONDS = 2.0


def fetch_nhl(path):
    """Return (status, body_bytes) for api-web.nhle.com/v1/<path>."""
    if not NHL_PATH.match(path) or ".." in path:
        return 400, json.dumps({"error": "bad path"}).encode()
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(path)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1], hit[2]
    req = urllib.request.Request(NHL_BASE + path, headers={
        "User-Agent": "BroadcastBooth/1.0 (personal use)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status, body = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, json.dumps({"error": f"NHL API returned {e.code}"}).encode()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        status, body = 502, json.dumps({"error": f"could not reach NHL API: {e}"}).encode()
    with _cache_lock:
        _cache[path] = (now, status, body)
    return status, body


# ---------------------------------------------------------------------------
# Claude commentary
# ---------------------------------------------------------------------------

BOOTH_RULES = """You are the broadcast booth for a live NHL game. You receive the newest \
play-by-play events from the official data feed and write what the booth says, \
as two voices: "pbp" (play-by-play) and "colour" (analyst).

Rules:
- Facts come ONLY from the events and game state given. Never invent players, \
goals, injuries, fights, stats, or anything not in the data. Colour may offer \
opinions, character, and general hockey talk, but no made-up facts.
- Lines are spoken aloud by text-to-speech: short sentences, no stage directions, \
no emoji, no markdown, no sound effects in asterisks.
- Play-by-play lines are brief (usually under 15 words) and in event order. Not \
every faceoff, giveaway or missed shot needs a call; skip the mundane when a \
batch is busy. Always call goals and penalties, and give the score after a goal.
- Colour speaks after goals, penalties, period ends, and some whistles. Keep it \
to one or two sentences, and do not let colour talk over a run of action.
- Do not repeat lines or catchphrases from the recent commentary.
- Excitement: "calm" for routine, "up" for big saves/hits/penalties, "huge" only \
for goals in close games, late drama, or overtime.
- If nothing in the batch is worth saying, return an empty list."""

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
    system = f"{BOOTH_RULES}\n\nTHE BOOTH TONIGHT: {persona.get('label', 'Classic broadcast')}\n{persona.get('style', '')}"
    game = payload.get("game") or {}
    st = payload.get("state") or {}
    parts = [
        f"Game: {game.get('away', 'Away')} at {game.get('home', 'Home')}" + (f", {game['venue']}" if game.get("venue") else "") + ".",
        f"Current score: {game.get('away', 'Away')} {st.get('awayScore', 0)}, {game.get('home', 'Home')} {st.get('homeScore', 0)}. "
        f"Shots: {st.get('awaySog', 0)}-{st.get('homeSog', 0)}. {st.get('period', '')}".strip(),
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
            status, body = fetch_nhl(path[len("/api/nhl/"):])
            self.send(status, body)
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
