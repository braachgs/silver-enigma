# Day Board: handoff notes

Everything needed to continue this project from any Claude account or
session. The conversation that built it isn't needed.

## Where things are

- **Repo:** `braachgs/silver-enigma` (public). The app is in `dayboard/`. The
  repo root `index.html` is a separate, older app (Story Narrator); leave it
  alone.
- **Branch:** `ccr-ffb78b8c-d0w0m7`. Day Board is not on the default branch
  (`claude/work-in-progress-u8Bwg`) yet, so the repo's front page doesn't show
  it.
- **Phone preview (no Google sync):** a private claude.ai artifact owned by the
  Claude account that created it:
  https://claude.ai/artifact/3KQVfAWr3CknFvRueaEnKY. Another Claude account
  can't update that link; it would publish its own.
- **Live app:** GitHub Pages serves this branch at
  `https://braachgs.github.io/silver-enigma/dayboard/`, and the owner runs it
  on an Android phone. Real Google sync works (confirmed by the owner on
  2026-10-15) through the OAuth client in Cloud project 278695224344, with the
  Calendar API enabled there. The owner's personal account is connected; the
  work account hasn't been tried (a Workspace admin may block it).

## What exists

A static PWA (vanilla JS, no build step):
- **Board styles:** three, under Settings → Board style: NYC Subway, London
  Underground and Split-Flap Departures.
- **Board:** live/next/departed rows, countdowns (NYC, London) or time plus
  remarks (split-flap), an all-day pill, line filters and a month picker.
- **Lines:** categories with a per-style look, service status, and a strip-map
  or line diagram of the day.
- **Add:** add, edit and delete local or Google events. Destructive buttons use
  a two-tap confirm (`confirmTap`), because some hosts block
  `window.confirm`.
- **Google Calendar:** several accounts through Google Identity Services. Each
  account defaults to its own line, and per-calendar and per-event overrides
  exist. Tokens last about an hour, then a Reconnect banner appears.
- **Platform display:** full-screen board in each style. Split-flap animates
  with fixed slots; NYC uses an LED look; London uses dot-matrix.
- **Other:** spoken announcements, offline service worker, sample day.

Code map: see README.md → Files. Key modules: `js/systems.js` (the board
styles), `js/flap.js` (flap engine), `js/store.js` (state, line routing),
`js/google.js` (multi-account Google), `js/app.js` (UI).

## How to test

`dayboard/tests/run.sh` serves the repo on 127.0.0.1:8765 and runs seven
Playwright suites (visual tour, local events, mocked multi-account Google,
split-flap, review fixes, day swipes, dates). Screenshots go to `tests/out/`.
Google is mocked in the suites. `dates-test.js` emulates the owner's setup: a
Europe/London phone (BST until 25 Oct 2026) with calendars in New York and UTC.
It uses Playwright's fake clock. Slide and flip animations run on real time, so
wait in real time before measuring layout after a day change. The suites that
build events relative to now (every suite but dates, which sets its own times) pin the clock to 10:00 today
with `tests/clock.js`, so they pass at any time of day.

`config.js` has `preview: false` by default. The claude.ai preview build sets
`preview: true`, hides Google sign-in, and gets its fonts inlined as data
URIs, because the artifact viewer blocks the Google sign-in script and may block
loading font files. To rebuild that preview, copy `dayboard/`, set
`preview: true`, inline the fonts in `css/app.css`, and publish `index.html`
without its `<html>/<head>/<body>` wrapper.

## Open decisions (owner: Shawn)

1. **Android widget:** native, built and installed (no work profile). It
   matches the web app's lines after Settings → Android widget → Send lines
   to widget. Unverified on a real phone: whether Android syncs Day Board's
   private extended properties (the widget falls back to the lines the web
   app sends, so it works either way until a newer event is re-lined).
2. **Merge to the default branch?** Do this so the repo front page shows Day
   Board and Pages can deploy from the default branch.
3. **Google sync:** working for the personal account. Next: assign that
   account and its shared calendars to lines (Settings), and try adding the
   work account.

## Known limitations

- Fonts are approximations: Inter stands in for Helvetica on Android, Cabin
  for Johnston.
- **Line colours:** MTA values are high confidence. TfL values are moderate
  (the Metropolitan line's value differs between sources).
- **Trademarks:** MTA bullets and the TfL roundel are trademarks. Fine for
  personal use; get permission before distributing a London-themed build.
- **Google Workspace:** an admin may block the unverified OAuth app for the
  work account.

## Working notes for the next session

- The "Personal from 21 Oct 2026" default is a one-off set in `js/store.js`
  (`lineFromSet`). Suites on today's clock opt out through `tests/clock.js`
  (`window.DayBoardTest.noLineFrom`); `dates-test.js` covers it on a fixed
  clock.
- `tests/run.sh` starts its own server if none is running, and that server
  keeps the output pipe open: run it with output to a file, not `| tail`.

- This cloud environment can't reach `dl.google.com`, so Android builds have to
  run on GitHub Actions.
- Multi-agent workflows ("ultracode") used about 2.5M subagent tokens across
  the research and review runs. Use them deliberately on a capped plan.
