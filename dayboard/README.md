# Day Board

Your calendar as a subway departure board. Events are trains, calendars are
lines, and the board counts down to what's next. It's a rebuild of
[Day Board by @rillotv](https://day-board.kit.com/waitlist) (an unreleased
iPhone app), with one big addition: **you pick the board style**. Two subway
systems, plus a mechanical split-flap station board.

| | New York City Subway | London Underground | Split-Flap Departures |
|---|---|---|---|
| Type | Helvetica Neue (Inter fallback) | Johnston-style: P22 Underground / Gill Sans if installed, else Cabin | Barlow Condensed on flap cells |
| Line badge | Route bullet: circle, or diamond for all-day | Tube line colour tab (VIC, CEN…), hollow for all-day | Coloured flap tile with a 3-letter code (WRK, PRS…), hollow for all-day |
| Board | Black station-sign header with white rule, cream board, yellow live row | TfL blue header with red rule, white board, blue live row | Dark station board, amber rule, flap rows |
| Time column | Countdowns: `18 MIN`, `1:58 HR`, `NOW ARRIVING` | Countdowns: `18 MINS`, `Due` | Scheduled time plus remarks: `10:30A · ON TIME / BOARDING / FINAL CALL / NOW / DEPARTED` |
| Line status | Good service / Delays | Good service / Minor delays / Severe delays | On time / Delayed |
| Day map | Strip map with white stop circles | Beck-style diagram with ticks and interchange rings | Route map with stop circles |
| Platform display | Day Board widget look: yellow LED type, green LIVE | Amber dot-matrix indicator with "Mind the gap" ticker | Full Solari-style board: flaps cascade when the board advances, optional clatter |
| Clock and dates | 12-hour, `Tuesday, Oct 13` | 24-hour, `Tuesday 13 October` | 12-hour, `10:30A` board times |
| Announcements | "Stand clear of the closing doors, please." | "Please mind the gap between the train and the platform." | "Now boarding… All aboard." |

A line's look is stored per style, so the Work line can be the **A** in New
York, the **Victoria** line in London and **WRK** on the flap board.
Switching styles restyles everything without losing your choices.

### Why the split-flap board shows times, not countdowns

Mainline departure boards list the scheduled time and a remark, not a minute
countdown. Day Board's flap style does the same, so a row only changes at
event boundaries:

| Remark | When |
|---|---|
| ON TIME | more than 15 minutes out |
| BOARDING | 15 minutes or less |
| FINAL CALL | 2 minutes or less |
| NOW (green flaps) | in progress, with minutes left and a progress bar below |
| DEPARTED | finished |

Changed characters flip, cascading left to right. On the platform display the
rows are fixed slots like a real board: when an event departs, every row below
flips up to the next one. Opening the display flips the whole board in from
blank. The flap sound is off by default (Settings → Board → Flap sound).

## Features

- **Board**: live events first with a progress bar and minutes left, then
  departures with countdowns. Swipe or use the arrow keys to change day, and
  tap the date for a month picker. Tap a line bullet to filter to it, and tap
  the ◆ pill for all-day events.
- **Lines**: your categories with today's count and a service status (two
  overlapping events = delays), plus a map of your day.
- **Add**: name, all day, start, duration, line, which calendar to save to,
  and location and notes.
- **Event sheet**: join the video call (Meet, Zoom or any link), open the
  event in Google Calendar, move it to another line, edit or delete.
- **Platform display** (monitor icon): a full-screen arrivals board for a
  spare phone or tablet. It keeps the screen awake where supported.
- **Spoken announcements** (optional): a chime and an announcement five
  minutes before each event and as it starts, while Day Board is open.
- **Sample day**: shown until you add something, timed relative to now like
  Day Board's.
- **Installable and offline**: add it to your home screen; cached events
  still show without a connection.

## Several Google accounts

Connect as many Google accounts as you like (Settings → Google Calendar →
Add account). An event picks its line in this order:

1. a line you picked for that one event (event sheet → Line)
2. the line saved on the event by Day Board (events you created or re-lined)
3. the line assigned to its **calendar** (Settings, per calendar)
4. the **account's** line: the first account gets the first line (Work), the
   second gets Personal, and later accounts get the next free line
5. the first line

So by default your work account is the **A / Victoria** line and your
personal account is the **D / Circle** line. A shared calendar like "Family"
can override that (say, **F / Metropolitan**), and any single event can be
moved.

## Run it

It's static files, with no build step and no server code.

```sh
# from the repository root
python3 -m http.server 8000
# open http://localhost:8000/dayboard/
```

### Host it on GitHub Pages (free; this repo is public)

1. On GitHub: **Settings → Pages → Build and deployment → Deploy from a
   branch**, pick the branch that has `dayboard/` and folder `/ (root)`, then
   **Save**.
2. A minute later it's live at
   `https://braachgs.github.io/silver-enigma/dayboard/`.
3. On your phone, open that URL. On Android, Chrome's ⋮ menu → **Add to home
   screen / Install app**. On iPhone, Safari's Share → **Add to Home Screen**.

## Connect Google Calendar (about five minutes)

Day Board talks to the Google Calendar API straight from your browser, so it
needs an OAuth client ID from **your own** Google Cloud project. It's free,
and no data passes through anyone else's server.

1. Go to <https://console.cloud.google.com/>, create a project (e.g.
   "Day Board").
2. **APIs & Services → Library →** search **Google Calendar API → Enable**.
3. Configure the consent screen (**Google Auth Platform**, formerly "OAuth
   consent screen"):
   - App name: Day Board. Support and developer email: yours.
   - **Audience: External**. Leave it in **Testing**.
   - **Test users: add every Google address you'll connect** (work and
     personal).
4. **Clients → Create client → Web application**:
   - **Authorized JavaScript origins**: `https://braachgs.github.io` (no path),
     plus `http://localhost:8000` if you run it locally.
   - No redirect URI is needed.
5. Copy the **Client ID** (`…apps.googleusercontent.com`) and either:
   - paste it in Day Board → Settings → Google Calendar → Save (stored in that
     browser), or
   - put it in `config.js` (`googleClientId: '…'`) so every device is ready.
     A client ID isn't a secret; Google only honours it from the origins you
     listed.
6. Day Board → Settings → **Add Google account**. Pick the account, then
   click through Google's "hasn't verified this app" notice. That notice is
   expected for your own testing-mode app. Repeat for each account.

Day Board asks for two scopes: `calendar.readonly` (to list your calendars and
read events) and `calendar.events` (to add, edit and delete events and save
line choices). If you untick the second, the account works read-only.

**Things to know:**

- **Hourly reconnects.** Browser-only Google sign-in hands out access tokens
  that last about an hour, with no silent refresh without a server. When one
  lapses you'll see a **Reconnect** banner. One tap fixes it, usually with no
  password prompt. Cached events keep showing in the meantime. Removing this
  would mean adding a small backend to hold refresh tokens.
- **Work accounts.** A Google Workspace admin can block unverified
  third-party apps. If your work account gets "access blocked", the admin
  has to trust your client ID (Workspace Admin console → Security → API
  controls). Not every organisation allows that.
- **Hidden events.** Events you declined and Google "working location" entries
  are hidden.

## Tests

`tests/run.sh` serves the repo on 127.0.0.1:8765 and runs the Playwright suites:
visual tour, local events, a mocked multi-account Google flow, the split-flap
style, and the review regressions. Screenshots land in `tests/out/`.

## More

- `docs/android-widget-decision.md`: native Android widget vs. KWGT vs. a
  Capacitor wrapper, with sources and confidence levels.
- `HANDOFF.md`: state of the project and open decisions, for picking it up in a
  new session or account.

## Privacy

Everything lives in your browser's localStorage: your lines, events you saved
"On this device", your account list, cached Google events, and the
short-lived access tokens. Day Board only talks to Google's servers. Settings
→ Reset Day Board wipes it.

## Add another board style

Each system is one object in `js/systems.js` (`DB.SYSTEMS`) with the same
shape as `nyc` and `london`:

- `style(line)` and `badge(line, opts)`: what a line looks like
- `countdown(mins, live)`, `dateLong`, `time` and the other formatters
- `copy`: board wording and announcements
- `map`: track width, and stop style (`circle` or `tick`)
- `layout: 'flap'` (optional): render rows and the platform display with flap
  cells; such a system also provides `remark(event, now)` and `boardTime(t)`

Then:

1. add a style block for it to each default line in `js/store.js`
   (`DEFAULT_LINES`) and to `nextLineDefaults()`
2. add a picker for it in the line editor (`lineEditorSheet` in `js/app.js`)
3. add a `[data-system="<id>"]` token block in `css/app.css`

Paris (ligne numbers in coloured circles, Parisine-style type) and Tokyo
(letter-number station codes) would both fit this model.

## Files

```
index.html             app shell
config.js              optional Google client ID
css/app.css            layout + per-system design tokens
js/util.js             DOM + date helpers (text-only rendering)
js/systems.js          NYC, London and split-flap board styles
js/flap.js             split-flap cells and flip animation
js/store.js            state, line routing, Google cache (localStorage)
js/google.js           Google Identity Services + Calendar API, multi-account
js/sample.js           the sample day
js/app.js              Board, Lines, Add, sheets, display, announcements, sync
sw.js                  offline app shell
manifest.webmanifest   install metadata
fonts/                 Inter, Cabin, VT323, Doto, Barlow Condensed (SIL OFL 1.1, licences included)
icons/                 app icons
```

## Credits and trademarks

The concept and NYC-style layout follow Day Board by @rillotv. Route bullet
colours follow the MTA's published line colours, and Tube colours follow
TfL's line palette. The MTA's route bullets and TfL's roundel and line
identities are their owners' trademarks. This is a personal, unaffiliated
project; TfL in particular polices the roundel, so get permission before
distributing a London-themed build publicly.
