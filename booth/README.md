# Broadcast Booth

Choose your commentators for any NHL or MLB game. Mute the TV, open the booth,
and get Cookie Monster calling the ballgame pitch by pitch, a golden-age radio
crew, two Glasgow football commentators baffled by both sports, or a
1990s Hockey Night–style crew. Commentary is driven by each league's live
play-by-play feed.

## Run it

You need Python 3.9+ and Chrome, Edge or Safari (for speech).

```bash
cd booth
python3 server.py
# open http://localhost:8765
```

1. Choose **Hockey** or **Baseball** (top right).
2. Pick tonight's game, or **Demo game** (a fictional game that works offline).
3. Pick a booth and voices.
4. Press **Start** and mute your TV.

Finished games can be **replayed** at 1–8× speed; quiet stretches (between
innings, long stoppages) are skipped.

| Sport | Booths | Data |
|---|---|---|
| Baseball | Cookie Monster (parody), Golden-Age Radio, Glasgow Fitba | Every pitch: type, speed, ball/strike/foul, count; every at-bat result with exit velocity and distance; steals, wild pitches, pitching changes |
| Hockey | Saturday Night '93, Glasgow Fitba, Cookie Monster | Faceoffs, shots, hits, blocks, giveaways, goals (scorer, assists), penalties |

### Optional: commentary written by Claude

The built-in lines are free and instant but limited. For commentary that
reacts to the actual game (score, situation, who did what earlier), let Claude
write it:

```bash
pip install anthropic
export ANTHROPIC_API_KEY=sk-ant-...
python3 server.py
```

Then choose **Commentary written by → Claude**. If a request fails, the booth
falls back to the built-in lines for that stretch of play.

- Model: `claude-opus-5-5` at low effort. Override with `BOOTH_MODEL=...`
  (a smaller model such as `claude-haiku-4-5` is cheaper and faster, but it
  writes worse commentary).
- Cost is a rough estimate, not measured. Requests go out every few seconds
  while events are arriving, about 250–400 per game, which is a few dollars
  per game on Opus. Baseball is at the high end because every pitch is an event.
- Latency: each batch takes a few seconds. Keep the delay at 15s or more. The
  page warns you if Claude is slower than your delay.

## Mac voices (including Siri)

On a Mac, set **Voices from → This Mac**. The server speaks each line with
the macOS `say` command, which is immune to background-tab throttling.

- **System Voice** uses whatever is set in System Settings → Accessibility →
  Spoken Content → System Voice. That can be a **Siri voice**, which browsers
  can't use at all. Only one System Voice exists at a time.
- **Auto** puts play-by-play on the System Voice and colour on the first
  downloaded *Premium* or *Enhanced* English voice, if you have one (Manage
  Voices in the same settings pane).
- Speed and excitement work. Pitch doesn't, so Cookie Monster sounds like
  whichever voice you pick.

## Syncing with your TV

The data feed and your TV picture are almost never in step. Cable, streaming
and the feed itself each add different lag. The booth holds commentary for
**Commentary delay** seconds after the feed reports an event.

- When something happens on your TV (a pitch, a whistle), click **sync** next
  to that event in the *On air* log. The delay snaps to match your picture.
  Baseball is easiest: sync on a pitch.
- Fine-tune with −5/−1/+1/+5.
- If the commentary runs **behind** your TV even at 0s, the feed is slower than
  your picture. Pause your TV/stream for a few seconds to fall back behind it.

## Logs and flags

Every run writes a session log to `booth/logs/session-<date>-<time>.jsonl` and
keeps the latest copy of each live game feed (`feed-mlb-<id>.json.gz`, saved
at most once a minute). Together they let a game be replayed and debugged
after the fact.

- **The server's terminal shows problems as they happen:** feed failures,
  Claude failures or slowness, browser errors, and your flags.
- **Flag button (or press F):** type a short note ("count is one pitch behind")
  and press Enter. The log records your note with the game situation, the last
  few spoken lines and the last few feed events.
- The log also records every event, every spoken line (and how late it was
  against the sync target), sync clicks and delay changes.
- Run with `--no-log` to turn logging off, or `--log-dir PATH` to put it elsewhere.

## How it works

```
league feed ──► server.py (relay) ──► app.js: new events every 5s
 NHL / MLB                              │
               engine.js (hockey) ◄─────┤  normalise plays, track game state,
               mlb-engine.js (baseball) │  decide what is worth calling,
               (director + personas)    │  persona templates
               server.py → Claude ◄─────┘  (optional) batch of events → lines
                                        │
               speech queue ────────────► browser text-to-speech, two voices,
               (delay, big-moment         held for the sync delay
                priority, backlog thinning)
```

- `engine.js` / `mlb-engine.js`: pure commentary logic per sport, with the same
  interface: feed parsing, game state (score, count, outs, bases), the
  "director" (which events get called, when the colour voice talks), personas
  and a catchphrase budget.
- `app.js`: UI, sport adapters (schedule + feed URLs), live polling, replay,
  Claude batching, speech scheduling.
- `server.py`: serves the page, relays `api-web.nhle.com` and
  `statsapi.mlb.com` (browsers can't call them directly because of CORS), and
  calls Claude with sport-specific booth rules.
- `demo-game.json`, `mlb-demo-game.json`: fictional games in each league's feed
  format (`tools/make_demo.py`, `tools/make_mlb_demo.py`).

### Adding a booth

Add an entry to `PERSONAS` in the sport's engine: voices (`langs`, `pitch`,
`rate`, name hints), `pbp` and `colour` line lists keyed by moment, optional
score phrasing (`numberWord`, `leads`, `wins`), and an `llmStyle` paragraph that
tells Claude who the booth is. A template that needs a value the event doesn't
have (say `{distance}` on a bunt) is skipped automatically. Run the tests;
they check every persona over a full game for unfilled placeholders and
uncalled moments.

## Tests

```bash
node --test booth/test/*.test.js
python3 -m unittest discover -s booth/test
```

## Limits

- **Voices:** browser speech is serviceable, not broadcast quality. Accents
  depend on what your OS ships. Better voices would need a paid TTS service.
- **Data:** the feeds report events, not the picture. Baseball is close to
  complete (every pitch), but it has no fielder names beyond the result text
  and no pitch location except high/low. Hockey is patchy: no passes, rushes or
  zone entries.
- **The league APIs are unofficial and undocumented.** They can change without
  notice. This is for personal use. Don't redistribute broadcasts or the
  booth's audio.
