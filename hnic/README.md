# Broadcast Booth

Choose your commentators for any NHL game. Mute the TV, open the booth, and get
a 1990s Hockey Night–style crew, two Glasgow football commentators, or Cookie
Monster calling the game from the NHL's live play-by-play feed.

## Run it

You need Python 3.9+ and Chrome, Edge or Safari (for speech).

```bash
cd hnic
python3 server.py
# open http://localhost:8765
```

1. Pick tonight's game (or **Demo game**, a fictional game that works offline).
2. Pick a booth and voices.
3. Press **Start** and mute your TV.

Finished games can be **replayed** at 1–8× game-clock speed.

### Optional: commentary written by Claude

The built-in lines are free and instant but limited. For commentary that
reacts to the actual game (score, momentum, who's hot, call-backs to earlier
plays), let Claude write it:

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...
python3 server.py
```

Then choose **Commentary written by → Claude**. If a request fails, the booth
falls back to the built-in lines for that stretch of play.

- Model: `claude-opus-5-5` at low effort. Override with `BOOTH_MODEL=...`
  (a smaller model such as `claude-haiku-4-5` is cheaper and faster, but it writes worse commentary).
- Cost is a rough estimate, not measured: around 200–300 requests per game,
  which is a few dollars per game on Opus.
- Latency: each batch takes a few seconds. Keep the delay at 15s or more. The
  page warns you if Claude is slower than your delay.

## Syncing with your TV

The NHL feed and your TV picture are almost never in step. Cable, streaming
and the feed itself each add different lag. The booth holds commentary for
**Commentary delay** seconds after the feed reports an event.

- When something happens on your TV (a whistle, a goal), click **sync** next to
  that event in the *On air* log. The delay snaps to match your picture.
- Fine-tune with −5/−1/+1/+5.
- If the commentary runs **behind** your TV even at 0s, the feed is slower than
  your picture. Pause your TV/stream for a few seconds to fall back behind it.

The feed's own lag is outside our control. It is usually a few seconds to
roughly half a minute and varies from game to game.

## How it works

```
NHL play-by-play ──► server.py (relay) ──► app.js: new events every 5s
                                              │
                         engine.js  ◄─────────┤  normalise plays, track score/shots
                         (director + persona   │  decide what is worth calling
                          templates)           │
                         server.py → Claude ◄──┘  (optional) batch of events → lines
                                              │
                         speech queue ────────► browser text-to-speech, two voices,
                         (delay, goal priority,   held for the sync delay
                          backlog thinning)
```

- `engine.js`: pure commentary logic: play parsing, the "director" (which events
  get called, when the colour man talks), persona templates, catchphrase budget.
- `app.js`: UI, live polling, replay clock, Claude batching, speech scheduling.
- `server.py`: serves the page, relays `api-web.nhle.com` (browsers can't call
  it directly because of CORS), and calls Claude.
- `demo-game.json`: fictional game in the NHL feed format (`tools/make_demo.py`).

### Adding a booth

Add an entry to `PERSONAS` in `engine.js`: voices (`langs`, `pitch`, `rate`,
name hints), `pbp` and `colour` line lists keyed by event type, optional
`numberWord`/`leads`/`wins` for score phrasing, and an `llmStyle` paragraph that
tells Claude who the booth is. Run the tests; they check every persona over a
full game for unfilled placeholders.

## Tests

```bash
node --test hnic/test/*.test.js
python3 -m unittest discover -s hnic/test
```

## Limits

- **Voices:** browser speech is serviceable, not broadcast quality. Accents
  depend on what your OS ships (Chrome's "Google UK English Male" is decent for
  the Scottish booth; there is rarely a true Scottish voice). Better voices would
  need a paid TTS service.
- **Data:** the feed reports shots, hits, goals, penalties and faceoffs, not
  passes, rushes or saves-in-detail. The booth can't describe what the feed
  doesn't contain.
- **The NHL API is unofficial and undocumented.** It can change without notice.
  This is for personal use. Don't redistribute broadcasts or the booth's audio.
