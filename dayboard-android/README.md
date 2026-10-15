# Day Board widget (Android)

A home-screen widget that shows your next calendar events as a split-flap
departure board, in the style of the Day Board web app's Split-Flap
Departures board. Tap it to open Day Board.

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

## Layout

| Path | What |
|---|---|
| `core/` | Plain Kotlin, no Android: text rules (`Flap`), remarks (`Remarks`), which departures to show (`BoardBuilder`), layout and drawing (`BoardLayout`, `BoardRenderer`). |
| `app/` | The Android app: `WidgetUpdater` (render and push), `CalendarSource`, `Receivers` (widget, alarms, boot/time-zone, calendar-change job), `MainActivity`. |
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
