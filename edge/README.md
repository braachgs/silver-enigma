# Day Board and Match Board for the Xeneon Edge

The two split-flap boards as CORSAIR iCUE widgets for the Xeneon Edge
(and any iCUE `dashboard_lcd` screen). They draw exactly like the Android
widgets: the renderer, colours, flap font and board logic are ports of
`dayboard-android/core`.

| Widget | Data | Settings (in iCUE) |
|---|---|---|
| **Day Board** | Google Calendar's *secret address in iCal format*, up to four calendars, read every 10 minutes. No sign-in, no reconnecting. | Clock (12/24 h); per calendar: the address, a 3-letter line code, a line colour |
| **Match Board** | football-data.org v4, competition PL, with your own API key. Every 15 minutes; every minute while your club is live. | API key; your club (name, short name or code: Brentford, Spurs, BRE); board colour (pitch green by default, so it stands apart from Day Board's charcoal) |

Both fit every Edge slot size, portrait or landscape: a VL (696x1688) slot
shows about ten matches or departures. Match Board rows are tappable:
finished matches open YouTube highlights, live and upcoming ones Peacock,
in your default browser (iCUE's Link plugin). Tap its header to update now.

## Install

1. Download `day-board.icuewidget` and/or `match-board.icuewidget` from the
   [`edge` release](https://github.com/braachgs/silver-enigma/releases/tag/edge)
   (or the download page, https://braachgs.github.io/silver-enigma/get/).
2. Double-click the file (or iCUE > your Xeneon Edge > Widgets > **+**).
   iCUE lists the permissions to approve: Day Board reaches
   `calendar.google.com`, Match Board `api.football-data.org`, and both
   `localhost:8577` (the helper below).
3. Place the widget on an Edge page and open its settings.

**Day Board's iCal address:** Google Calendar on the web > Settings >
your calendar > *Integrate calendar* > **Secret address in iCal format**.
Anyone with it can read that calendar; it stays in iCUE on your PC (reset
it in Google Calendar if it ever leaks).

## If a widget says NO CONNECTION

iCUE's browser may refuse requests to football-data.org or Google that a
normal app would make (the browser's cross-origin rules). Then the widgets
go through **DayBoardHelper.ps1**: a small relay on `http://localhost:8577`
that only fetches those two services, passes your key through without
storing it, and needs no install or admin rights (Windows PowerShell is
built in).

In PowerShell, from wherever the file was downloaded, this moves it to a
permanent folder and starts it now and at every sign-in:

```powershell
$d = "$env:LOCALAPPDATA\DayBoard"; New-Item -ItemType Directory -Force $d | Out-Null
Move-Item "$env:USERPROFILE\Downloads\DayBoardHelper.ps1" $d -Force
powershell -ExecutionPolicy Bypass -File "$d\DayBoardHelper.ps1" -Install
```

Check it at http://localhost:8577/ping ("Day Board Helper"). To stop and
remove it: `powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\DayBoard\DayBoardHelper.ps1" -Uninstall`.

The widgets try the direct route first and switch to the helper by
themselves, retrying direct every hour. After a failed update they try
again every two minutes, so a newly started helper shows up quickly.

## Rules carried over from the phone

- Never a guessed score: failed or stale updates keep the last score as
  sent, with "AS OF 2:39 PM · OFFLINE OR BLOCKED" in the footer.
- Before kickoff the status counts down from the fixture time (IN 20 MIN);
  only the feed can say LIVE, HALF TIME or FULL TIME (KICK OFF until it does).
- A calendar that fails keeps its last events, and the footer names it.

## Build and test

```sh
npm install -g icuewidget-cli          # Corsair's CLI, 0.5+
edge/build.sh                          # validate + package into edge/dist/
TZ=Europe/London node edge/tests/ics-test.js
TZ=Europe/London node edge/tests/matches-test.js
TZ=Europe/London node edge/tests/widgets-test.js   # Playwright, after build.sh
```

`tests/widgets-test.js` renders both widgets at every Edge slot size with
mocked data, including the direct route being refused (helper fallback),
nothing getting through, and taps. CI also runs `helper/test-helper.ps1`
on Windows. Not yet tested on a real Xeneon Edge.

| Path | What |
|---|---|
| `common/flapboard.js` | Canvas renderer: flaps, header, footer, Day Board and Match Board layouts |
| `common/matches.js` | football-data.org parsing, statuses, order, pinning |
| `common/ics.js` | iCalendar reading and repeat expansion |
| `common/departures.js` | Day Board's departures and remarks |
| `common/net.js` | Direct fetch with helper fallback |
| `dayboard/`, `matchboard/` | Each widget's `index.html`, manifest, translations, icons |
| `helper/` | DayBoardHelper.ps1 and its Windows test |
