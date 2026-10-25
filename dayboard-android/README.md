# Day Board (Android)

Day Board's board, plus a home-screen widget that shows your next calendar
events as a split-flap departure board.

- **The board** (`BoardActivity`, the launcher icon) is the web app in a
  WebView, loaded from GitHub Pages and kept offline by its service worker,
  so board changes arrive without a new APK. `PhoneBridge` gives the page
  `window.DayBoardPhone`: the phone's calendars and event instances, and
  insert/update/delete through `CalendarContract` (READ_CALENDAR and
  WRITE_CALENDAR). Every account synced to the phone is there, work
  included, with no Google sign-in. A content observer tells the page when
  the calendar store changes. Only Day Board's own pages load in the
  WebView; every other link opens in its own app, so the bridge never
  serves another site.
- **Lines**: the board saves its line setup for the widget whenever it
  changes. "Send to Android app" in the browser version also carries the
  whole setup (`s=`), which the app's board adopts on its first run.
- **Widget settings** (`MainActivity`) open from the board's Settings →
  Android widget.

- **Reads the phone's own calendars** (CalendarContract): every Google account
  synced to the phone, work included, with no sign-in and no hourly reconnect.
- **Wakes only when the board changes**: at each remark boundary (15 and 2
  minutes before an event, its start and end) and at midnight, plus whenever
  a calendar changes. The clock in the corner is a TextClock, so it ticks
  without waking the app.
- **Resizable**: 4x2 shows two departures, taller widgets more. Wide widgets
  put each departure on one line.
- The app's own screen grants calendar access, previews the board, adds the
  widget, and lets you hide calendars or change a line's three-letter code.
- **Same lines as the web app**: Day Board → Settings → Android widget →
  Send lines to widget opens this app with `dayboard://lines?d=…` (the setup
  as base64url text, format in `core/.../LineConfig.kt`). Events then get the
  web app's line codes and colours, resolved in its order: a line picked for
  the event (matched by Google event id, or the instance id
  `<series>_<UTC start>` for repeats), the line Day Board saved on it, the
  dated default, the calendar's line, the account's line. Calendars from
  accounts Day Board doesn't have keep their own colour and code.

## Match Board

A second app in this project (`matchboard/`, `com.braachgs.matchboard`):
Premier League matches on the same split-flap board, as a resizable 4x2
widget. It shares Day Board's renderer pieces, palette, flap font and
signing key; its logic lives in core's `dayboard.match` package and is
tested on the JVM (`MatchTest`, with previews in `core/build/previews/match-*.png`).

- **Rows**: kickoff (12-hour, local; a past day's result shows its day),
  home and away short names with each score on its own amber flap, and a
  status flap: ON TIME, IN 20 MIN (5-minute steps from an hour out), LIVE,
  HALF TIME, FULL TIME, POSTPONED (also SUSPENDED, CANCELLED, TOMORROW,
  SAT 31 OCT). Past kickoff with no word from the feed it says KICK OFF,
  never LIVE. At full time the winner is bold and the loser dimmed.
- **Order**: today's matches, then upcoming, then recent results (newest
  first). Your club's current or next match is pinned on top with an
  amber bar (Brentford unless you pick another in the app).
- **Data**: football-data.org v4, competition PL, with your own API key,
  typed into the app and kept in its private storage (never in the code
  or the APK). A full update is two requests (the past week, the coming
  week); a live update fetches today only.
- **Refresh**: WorkManager every 15 minutes; two minutes after your club
  kicks off; every minute while your club is live, only while the screen
  is on, Battery Saver is off, the phone isn't dozing and the app isn't
  battery-restricted.
- **Never a guessed score**: a failed or stale update keeps the last
  scores exactly as sent, and the footer says when they're from
  ("AS OF 2:39 PM · OFFLINE").
- **Taps**: each row is its own band of the board with its own link:
  finished matches search YouTube for "<Home> vs <Away> highlights
  Premier League NBC Sports"; live and upcoming ones open Peacock's
  Premier League page. The header and footer open the app.

## Layout

| Path | What |
|---|---|
| `core/` | Plain Kotlin, no Android: text rules (`Flap`), remarks (`Remarks`), which departures to show (`BoardBuilder`), the web app's lines (`LineConfig`), layout and drawing (`BoardLayout`, `BoardRenderer`). |
| `matchboard/` | Match Board: `Feed`/`Api` (football-data.org), `Store` (key, club, responses), `Refresh` (WorkManager), `Widgets` (render, cut into tappable bands), `SettingsActivity`. |
| `app/` | The Day Board app: `BoardActivity` and `PhoneBridge` (the board), `WidgetUpdater` (render and push), `CalendarSource`, `Receivers` (widget, alarms, boot/time-zone, calendar-change job), `MainActivity` (widget settings). |
| `app/release.p12` | Signing key, created and committed by the workflow on its first signed build, encrypted with the `DAYBOARD_KEYSTORE_PASSWORD` repository secret (the only place the password exists). |
| `OFL-BarlowCondensed.txt` | Licence for the bundled Barlow Condensed font (SIL OFL 1.1). |

## Build

- **Core tests and previews** (no Android SDK needed):
  `gradle -p dayboard-android/core test`. This draws the board at common
  widget sizes into `core/build/previews/`.
- **APK**: GitHub Actions (`.github/workflows/dayboard-android.yml`) builds on
  every push that touches this folder. With the secret set, it publishes the
  signed APK to the `widget` release:
  `https://github.com/braachgs/silver-enigma/releases/download/widget/DayBoard-widget.apk`
- Locally: needs the Android SDK (`platforms;android-35`) and Gradle 8.14:
  `gradle -p dayboard-android :app:assembleRelease`.
