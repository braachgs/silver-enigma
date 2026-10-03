#!/usr/bin/env python3
"""Broadcast Booth local server.

Serves the app, relays NHL and MLB data (the browser can't call the league
APIs directly because of CORS), and optionally writes commentary with Claude.

    python3 server.py                 # http://localhost:8765
    ANTHROPIC_API_KEY=... python3 server.py   # enables "Claude" commentary

Each run writes a session log to logs/ (what the feed sent, what the booth
said, sync clicks, flags, errors) and keeps a copy of the live game feed, so a
game can be replayed and debugged afterwards. Warnings, errors and flags are
also printed here as they happen.

Standard library only, except the optional `anthropic` package.
"""
import argparse
import gzip
import json
import os
import re
import shutil
import subprocess
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
LIVE_FEED = re.compile(r"(?:gamecenter/(\d+)/play-by-play|game/(\d+)/feed/live)$")
FEED_SNAPSHOT_SECONDS = 60
ECHO_KINDS = {"error", "warn", "flag"}


# ---------------------------------------------------------------------------
# Mac voices (macOS `say`)
# ---------------------------------------------------------------------------

SAY_VOICE_LINE = re.compile(r"^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s+#")


class MacVoice:
    """Speaks through the macOS `say` command, one line at a time.

    With no voice name, `say` uses the System Voice from System Settings >
    Accessibility > Spoken Content. That can be a Siri voice, which `say -v`
    can't select by name and browsers can't use at all.
    """

    def __init__(self, binary=None):
        self.binary = binary if binary is not None else shutil.which("say")
        self.lock = threading.Lock()
        self.proc = None
        self.proc_id = None
        self._voices = None

    @property
    def available(self):
        return bool(self.binary)

    def voices(self):
        if self._voices is None and self.available:
            try:
                out = subprocess.run([self.binary, "-v", "?"], capture_output=True, text=True, timeout=10).stdout
            except (OSError, subprocess.SubprocessError):
                out = ""
            found = []
            for line in out.splitlines():
                m = SAY_VOICE_LINE.match(line.strip())
                if m and m.group(2).lower().startswith("en"):
                    found.append({"name": m.group(1).strip(), "lang": m.group(2)})
            self._voices = found
        return self._voices or []

    def speak(self, text, voice="", rate=None, line_id=None):
        """Say one line; returns when it has been spoken (or stopped)."""
        args = [self.binary]
        if voice:
            args += ["-v", voice]
        if rate:
            args += ["-r", str(int(max(90, min(400, rate))))]
        args.append(" " + text if text.startswith("-") else text)
        with self.lock:
            # Own process group, so stop() takes down anything `say` spawned too.
            self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
            self.proc_id = line_id
            try:
                _, err = self.proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                _, err = self.proc.communicate()
            code, self.proc, self.proc_id = self.proc.returncode, None, None
        if code not in (0, -15, -9) and err:
            raise RuntimeError(err.decode("utf-8", "replace").strip()[:300])

    def stop(self, up_to=None):
        """Stop the current line, but only if it's one the page meant to stop."""
        proc, pid = self.proc, self.proc_id
        if proc and (up_to is None or pid is None or pid <= up_to):
            try:
                os.killpg(proc.pid, 15)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Session log
# ---------------------------------------------------------------------------


class SessionLog:
    """Append-only JSONL log of one server run, plus throttled feed snapshots.

    Never raises: logging must not take the booth down mid-game.
    """

    def __init__(self, directory=None, echo=None):
        self.lock = threading.Lock()
        self.dir = Path(directory) if directory else None
        self.path = None
        self.echo = echo
        self._snapped = {}
        if self.dir:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                self.path = self.dir / f"session-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
            except OSError as e:
                self._say(f"[log] can't write to {self.dir}: {e}")
                self.dir = None

    def _say(self, text):
        if self.echo:
            print(text, file=self.echo, flush=True)

    def write(self, kind, src="server", **data):
        entry = {"ts": round(time.time(), 3), "src": src, "kind": kind, **data}
        if self.path:
            try:
                with self.lock, open(self.path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
            except OSError:
                pass
        if kind in ECHO_KINDS:
            self._say(f"[{time.strftime('%H:%M:%S')}] {kind.upper():5} {src}: {self.summary(kind, data)}")

    @staticmethod
    def summary(kind, data):
        if kind == "flag":
            note = data.get("note") or "(no note)"
            said = (data.get("recentLines") or [""])[-1]
            return f'{note}  |  {data.get("situation", "")}  |  last line: "{said}"'
        text = data.get("message") or json.dumps(data, ensure_ascii=False, default=str)
        return str(text)[:300]

    def snapshot_feed(self, path, body):
        """Keep the latest copy of a live game feed (at most once a minute)."""
        m = LIVE_FEED.search(path)
        if not (self.dir and m):
            return
        league, gid = ("nhl", m.group(1)) if m.group(1) else ("mlb", m.group(2))
        now = time.monotonic()
        with self.lock:
            if now - self._snapped.get(gid, -1e9) < FEED_SNAPSHOT_SECONDS:
                return
            self._snapped[gid] = now
        target = self.dir / f"feed-{league}-{gid}.json.gz"
        try:
            tmp = target.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(body))
            os.replace(tmp, target)
        except OSError as e:
            self.write("warn", message=f"couldn't save feed snapshot: {e}")

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


COLOUR_RULES = """You write ONLY the colour analyst's lines. A play-by-play announcer \
already calls every pitch and result, so never restate what just happened.
- Return at most ONE line: one or two sentences, under 30 words, speaker "colour".
- Talk like a real analyst between pitches: the matchup, what the pitcher is \
doing, the hitter's numbers and earlier at-bats today, the game situation, \
strategy. Use the stats given; never invent numbers, history, injuries or records.
- Lines are read aloud by text-to-speech: write batting averages the way \
broadcasters say them ("two-ninety", not ".290") and ERAs as "three-forty-one".
- Don't repeat a stat or idea from the recent commentary.
- Often the right answer is silence: return an empty list when there's \
nothing worth adding."""

SPORT_NAMES = {"nhl": "NHL", "mlb": "MLB"}


def build_request(payload):
    """Turn the browser's payload into (system, user_text). Pure; tested."""
    persona = payload.get("persona") or {}
    sport = payload.get("sport") if payload.get("sport") in SPORT_RULES else "nhl"
    booth = f"THE BOOTH TONIGHT: {persona.get('label', 'Classic broadcast')}\n{persona.get('style', '')}"
    if payload.get("mode") == "colour":
        system = (f"You are the colour analyst in the broadcast booth for a live {SPORT_NAMES[sport]} game.\n\n"
                  f"{COLOUR_RULES}\n\n{booth}\nYou are the COLOUR voice of this booth.")
    else:
        system = f"You are the broadcast booth for a live game.\n\n{COMMON_RULES}\n\n{SPORT_RULES[sport]}\n\n{booth}"
    game = payload.get("game") or {}
    parts = [
        f"Game: {game.get('away', 'Away')} at {game.get('home', 'Home')}" + (f", {game['venue']}" if game.get("venue") else "") + ".",
        f"Situation now: {payload.get('situation') or 'not available'}",
    ]
    if payload.get("stats"):
        parts.append("Stats you may use:\n" + str(payload["stats"]))
    if payload.get("joining"):
        parts.append("We are joining this game in progress: open with a brief welcome and the situation.")
    recent = payload.get("recent") or []
    if recent:
        parts.append("Recent commentary (do not repeat):\n" + "\n".join(f"- {r}" for r in recent[-12:]))
    events = payload.get("events") or []
    label = "Latest events, in order" if payload.get("mode") == "colour" else "New events, in order"
    parts.append(f"{label}:\n" + ("\n".join(f"{i + 1}. {e}" for i, e in enumerate(events)) or "(none)"))
    return system, "\n\n".join(parts)


def load_env(path):
    """Read KEY=VALUE lines (e.g. ANTHROPIC_API_KEY) from booth/.env, without
    overriding variables already set. Keeps the key out of shell history."""
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return []
    loaded = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().removeprefix("export ").strip(), value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


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
            self.error = "no API key (put ANTHROPIC_API_KEY=... in booth/.env)"
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
    log = SessionLog()  # replaced in main(); a no-op log for tests
    mac = MacVoice()
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
            self.send_json(200, {"llm": c.available, "model": MODEL if c.available else None, "llmError": c.error,
                                 "logFile": str(self.log.path) if self.log.path else None,
                                 "macVoices": self.mac.available})
        elif path == "/api/voices":
            self.send_json(200, {"available": self.mac.available, "voices": self.mac.voices()})
        elif path.startswith("/api/nhl/"):
            if query:
                return self.send(*bad_request())
            self.relay("NHL", path, *fetch_nhl(path[len("/api/nhl/"):]))
        elif path.startswith("/api/mlb/"):
            self.relay("MLB", path, *fetch_mlb(path[len("/api/mlb/"):], query))
        else:
            self.send_json(404, {"error": "not found"})

    def relay(self, league, path, status, body):
        if status == 200:
            self.log.snapshot_feed(path, body)
        else:
            self.log.write("warn", "relay", message=f"{league} {status} for {path}: {body[:200].decode('utf-8', 'replace')}")
        self.send(status, body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 200_000:
            raise ValueError("payload too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self):
        if self.path == "/api/log":
            return self.post_log()
        if self.path in ("/api/say", "/api/say/stop"):
            return self.post_say()
        if self.path != "/api/commentary":
            return self.send_json(404, {"error": "not found"})
        if not self.commentator.available:
            return self.send_json(503, {"error": self.commentator.error})
        try:
            payload = self.read_json()
            started = time.monotonic()
            lines = self.commentator.lines(payload)
            seconds = round(time.monotonic() - started, 2)
            self.log.write("claude", "server", seconds=seconds, events=len(payload.get("events") or []), lines=lines)
            self.send_json(200, {"lines": lines, "seconds": seconds})
        except Exception as e:  # report to the page; it falls back to templates
            self.log.write("warn", "claude", message=f"{type(e).__name__}: {e}")
            self.send_json(502, {"error": f"{type(e).__name__}: {e}"})

    def post_say(self):
        if not self.mac.available:
            return self.send_json(503, {"error": "Mac voices need macOS (the `say` command)"})
        try:
            body = self.read_json()
            if self.path == "/api/say/stop":
                self.mac.stop(body.get("upTo"))
                return self.send_json(200, {"ok": True})
            text = str(body.get("text") or "").strip()[:600]
            if text:
                started = time.monotonic()
                self.mac.speak(text, str(body.get("voice") or ""), body.get("rate"), body.get("id"))
                return self.send_json(200, {"ok": True, "seconds": round(time.monotonic() - started, 2)})
            self.send_json(200, {"ok": True})
        except Exception as e:
            self.log.write("warn", "say", message=f"{type(e).__name__}: {e}")
            self.send_json(502, {"error": f"{type(e).__name__}: {e}"})

    def post_log(self):
        try:
            entries = self.read_json().get("entries") or []
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json(400, {"error": str(e)})
        for e in entries[:1000]:
            if isinstance(e, dict):
                data = {k: v for k, v in e.items() if k not in ("kind", "src", "ts")}
                self.log.write(str(e.get("kind", "info"))[:20], "browser", **data)
        self.send_json(200, {"ok": True})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--log-dir", default=os.environ.get("BOOTH_LOG_DIR", str(ROOT / "logs")),
                    help="where session logs and feed snapshots go (default: booth/logs)")
    ap.add_argument("--no-log", action="store_true", help="don't write logs")
    args = ap.parse_args(argv)
    load_env(ROOT / ".env")
    Handler.commentator = Commentator()
    Handler.log = SessionLog(None if args.no_log else args.log_dir, echo=sys.stderr)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    llm = f"Claude commentary ON ({MODEL})" if Handler.commentator.available else f"Claude commentary off: {Handler.commentator.error}"
    print(f"Broadcast Booth on http://localhost:{args.port}  |  {llm}", file=sys.stderr)
    if Handler.log.path:
        print(f"Logging to {Handler.log.path}  (warnings, errors and flags also appear below)", file=sys.stderr)
    if Handler.mac.available:
        print("Mac voices available (the page's 'Voices from' menu); the System Voice can be a Siri voice", file=sys.stderr)
    Handler.log.write("server-start", model=MODEL if Handler.commentator.available else None)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
