# Android home-screen widget: build native or not?

Research done on 2026-10-13 and 14, from primary sources where they were reachable
(developer.android.com, AOSP source, Google's developer-verification FAQ).
Separate fact-checkers re-checked the widget and calendar findings: 34 of 39
claims were confirmed and none refuted. The other five came back uncertain
and are reflected in the confidence notes below. The distribution and
alternatives findings were **not** independently re-checked, because a usage
limit stopped those fact-checkers. Confidence is marked on each point.

## The one thing to check on your phone first

**Is your work Google account inside an Android "work profile"?** If it is,
you'll see a separate **Work** tab in the app drawer, or apps with a small
briefcase badge.

- **No work profile:** the work account was added like a normal account, and
  its events appear in the regular Google Calendar app. Then any widget, native
  or KWGT, can read both your work and personal calendars from the phone
  itself. That means no Google sign-in, no hourly reconnect, and no IT
  approval. (High confidence)
- **Work profile:** a widget on the personal side can't see work events unless
  your IT admin allowlists the app, and that allowlist is empty by default.
  (Moderate-high) One way around it is to share or subscribe your work calendar
  to your personal Google account, if your employer allows outside sharing.
  (Moderate)

This decides more than any other factor.

## What Android widgets can and can't do (2026)

| Need | Reality | Confidence |
|---|---|---|
| Custom fonts (Helvetica-like, LED, dot-matrix) | Neither Glance nor classic widgets can use a bundled font. Text has to be drawn into images, which caps memory per update. On Android 17, going over the cap crashes the app. | High |
| "18 MIN" countdowns ticking every minute | The built-in refresh runs every 30 minutes at most. Minute updates need exact alarms. A sideloaded app can declare `USE_EXACT_ALARM`; a Play app usually has to ask you for "Alarms & reminders". The battery-free alternative is a system timer that only shows `MM:SS` in a system font. | High |
| Highlighted live event, 4–10 rows, several sizes | Easy. | High |
| Split-flap flip animation | Not feasible in normal widgets. Only Android 17's new Remote Compose (still alpha) might allow it later. Keep the animation in the app's full-screen display. | High / uncertain for Remote Compose |
| Join Meet button | The phone's calendar store has no Meet field. Where Google's sync puts the link has to be tested on a real event. | Low |
| Store an event's "line" on the event | Not possible through the phone's calendar store. The app keeps it in its own database (or uses Google event colours, which is untested). | High / low |

## Getting a self-built app onto your phone

- **Today (US):** sideloading needs nothing beyond "Install unknown apps". (High)
- **2027:** Google's developer verification reaches the US (exact date not
  published). After that, three routes stay free: install over USB with
  **ADB**, a **free "limited distribution" developer account** (up to 20 of
  your own devices, no ID, no fee), or the one-time **advanced flow** on the
  phone. (High, per Google's FAQ updated 2026-09-30)
- **Google Play:** $25 plus an ID check. The internal testing track installs
  your own app without the 12-testers-for-14-days rule. Optional. (Moderate)
- **Building:** a free GitHub Actions workflow can build and sign the APK. It
  must always use the same signing key, or updates fail. This cloud
  environment can't download the Android SDK, so every build would run on
  GitHub. (High)
- **Effort estimate:** roughly 2,500–4,500 lines of Kotlin, about 2–4 weeks for
  an experienced Android developer. With Claude writing the code, the
  bottleneck is your testing loop: change, CI build, download, install, look.
  (Moderate, estimate)

## Options, cheapest first

| Option | Cost / effort | Gets you | Misses |
|---|---|---|---|
| **Todo Agenda** (free, open source) | Minutes | Both accounts, colour per calendar, "time until" | Doesn't look like a departure board |
| **KWGT Pro** widget builder (~$7, actively maintained) | A few hours in its on-phone editor; no ready-made board preset exists | Reads both accounts from the phone, custom fonts, minute countdowns, coloured line bullets | No animation; you build the layout by hand; no app (the web app stays the "full" board) |
| **Wrap the web app with Capacitor + a native widget** | Weeks | Keeps all three designs in the full app, reads phone calendars (no Google sign-in), plus a real widget | Widget fonts drawn as images; minute updates need exact alarms |
| **Fully native app** | Weeks+ | Everything above | Rebuilds the UI that already exists on the web |
| Trusted Web Activity wrapper | Weeks | — | No bridge between the web app and the widget; not worth it |

KWGT and Capacitor details are moderate confidence (third-party sources; not
independently re-checked).

## Recommendation

1. **Check the work-profile question above.** If work events can't reach a
   personal-side widget, no build option fixes that without IT help.
2. **For a home-screen widget this week, use KWGT.** It gets about 80% of the
   Day Board widget look (fonts, bullets, countdowns) at roughly 1% of the
   effort, and it shows whether you actually use a widget before you invest
   weeks in one.
3. **Go native only if** you want both (a) Google sync with no hourly reconnect
   inside the full app and (b) a polished, styled widget you can't build in
   KWGT. Then the efficient route is Capacitor around the existing web app
   (reusing all three designs) plus a native Glance widget that reads the
   phone's calendar. Update every minute only within an hour of the next event,
   and draw each row's text as an image.

## Open questions worth a 10-minute test on your phone

- Does a Google Meet link show up anywhere for a Meet event in the phone's
  calendar data?
- How quickly does an edit made on the web reach the phone's calendar?
- If you try KWGT, does its `ci()` index 0 include an event already in
  progress (needed for the LIVE row)?
