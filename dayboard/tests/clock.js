// Suites that build events relative to "now" run on a clock pinned to 10:00
// today (host time), so they pass at any time of day: in the evening their
// later events would otherwise fall on tomorrow. The clock then runs at
// normal speed, so timers and animations behave as usual.
const MORNING = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d.getTime(); })();

async function pinMorning(page) {
  // These suites run on today's date: keep the one-off "Personal from
  // 21 Oct 2026" default (js/store.js) out of them so they pass on any day.
  await page.addInitScript(() => { window.DayBoardTest = { noLineFrom: true }; });
  await page.clock.install({ time: MORNING });
  await page.clock.resume();
}

module.exports = { MORNING, pinMorning };
