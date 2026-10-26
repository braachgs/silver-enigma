// Renders the built widgets (edge/build) at Xeneon Edge slot sizes with mocked
// data: football-data.org and a Google iCal feed, direct and via the helper.
// TZ=Europe/London node edge/tests/widgets-test.js <outdir>
const { chromium } = require('../../dayboard/tests/pw');
const fs = require('fs');
const path = require('path');
const http = require('http');
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'}: ${m}`); if (!c) fails++; };
const NOW = Date.parse('2026-10-25T14:40:00Z');
const PL = fs.readFileSync(path.join(__dirname, '../../dayboard-android/core/src/test/resources/pl-matches.json'), 'utf8');
const SLOTS = { VS: [697, 417], VM: [697, 841], VL: [697, 1689], VXL: [697, 2537], HM: [841, 697], HS: [841, 345] };

const ICAL = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:me@gmail.com', 'X-WR-TIMEZONE:Europe/London',
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Grab cards at the card shop', 'DTSTART:20261025T163000Z', 'DTEND:20261025T170000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Tesco run - flowers, cards, breakfast for tomorrow', 'DTSTART:20261025T183000Z', 'DTEND:20261025T191500Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Rehearse panel', 'DTSTART:20261025T144500Z', 'DTEND:20261025T151500Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Coffee with Sam', 'DTSTART:20261025T140000Z', 'DTEND:20261025T150000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e', 'SUMMARY:Meet Jeni, Emma & Noah - Heathrow T3', 'DTSTART:20261026T051500Z', 'DTEND:20261026T083000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:f', 'SUMMARY:Emma birthday', 'DTSTART;VALUE=DATE:20091025', 'RRULE:FREQ=YEARLY', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const WORK = [
  'BEGIN:VCALENDAR', 'X-WR-CALNAME:me@work.com',
  'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Weekly planning', 'DTSTART;TZID=Europe/London:20261019T151500', 'DTEND;TZID=Europe/London:20261019T160000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,SU', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const URL1 = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics';
const URL2 = 'https://calendar.google.com/calendar/ical/me%40work.com/private-def/basic.ics';

const server = http.createServer((req, res) => {
  const f = path.join(__dirname, '../build', decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(path.join(__dirname, '../build')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
  res.end(fs.readFileSync(f));
}).listen(0, '127.0.0.1');

(async () => {
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch();
  const errors = [];

  async function open(widget, size, settings, { direct = true, helper = true } = {}) {
    const ctx = await b.newContext({ viewport: { width: size[0], height: size[1] }, timezoneId: 'Europe/London' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${widget}: ${e.message}`));
    await p.addInitScript((s) => { Object.assign(window, s); window.__opened = []; window.open = (u) => window.__opened.push(u); }, settings);
    const calls = { direct: 0, helper: 0, keys: [] };
    const answer = (url) => (url.includes('football-data.org') ? { body: PL, type: 'application/json' }
      : url.includes('me%40work.com') ? { body: WORK, type: 'text/calendar' } : { body: ICAL, type: 'text/calendar' });
    await p.route(/api\.football-data\.org|calendar\.google\.com/, (r) => {
      calls.direct++;
      calls.keys.push(r.request().headers()['x-auth-token']);
      if (!direct) return r.abort('failed'); // as a CORS refusal looks to the page
      const a = answer(r.request().url());
      return r.fulfill({ status: 200, contentType: a.type, body: a.body, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await p.route(/localhost:8577/, (r) => {
      calls.helper++;
      if (!helper) return r.abort('connectionrefused');
      const target = new URL(r.request().url()).searchParams.get('url');
      const a = answer(target);
      return r.fulfill({ status: 200, contentType: a.type, body: a.body, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await p.clock.install({ time: NOW });
    await p.goto(`${base}/${widget}/index.html`);
    await p.clock.runFor(2000);
    await p.waitForTimeout(500);
    return { ctx, p, calls };
  }

  // ---------------------------------------------------------------- Match Board
  const MB = { apiKey: 'test-key-0123456789abcdef', club: 'Brentford' };
  for (const [name, size] of Object.entries(SLOTS)) {
    const { ctx, p, calls } = await open('matchboard', size, MB);
    await p.screenshot({ path: `${OUT}/match-${name}.png` });
    if (name === 'VL') {
      ok(calls.direct >= 2 && calls.keys.every((k) => k === MB.apiKey), `Match Board fetches football-data.org with the key in X-Auth-Token (${calls.direct} requests)`);
      const store = await p.evaluate(() => JSON.parse(localStorage.getItem('matchboard-standalone')));
      ok(store && store.sources.next && store.sources.past && !store.error, 'keeps the past and coming weeks with their times');
      // Tap the pinned (live) row, then a finished one.
      const bandsY = await p.evaluate(() => bands.map((b) => (b[0] + b[1]) / 2));
      const rows = await p.evaluate(() => shownRows.map((r) => r.match.id));
      ok(rows[0] === 1005 && rows.length >= 8, `VL shows ${rows.length} matches, your club first`);
      await p.mouse.click(300, bandsY[0]);
      const fin = rows.indexOf(1004);
      if (fin >= 0) await p.mouse.click(300, bandsY[fin]);
      const opened = await p.evaluate(() => window.__opened);
      ok(opened[0] === 'https://www.peacocktv.com/sports/premier-league' && (fin < 0 || /youtube\.com\/results\?search_query=Fulham\+vs\+Bournemouth/.test(opened[1])), `taps open Peacock (live) and YouTube highlights (finished): ${opened.join(' | ')}`);
    }
    await ctx.close();
  }
  {
    // A day without matches (Tuesday): the weekend's results lead, under day lines.
    const ctx = await b.newContext({ viewport: { width: SLOTS.VM[0], height: SLOTS.VM[1] }, timezoneId: 'Europe/London' });
    const p = await ctx.newPage();
    await p.addInitScript((s) => Object.assign(window, s), MB);
    await p.route(/api\.football-data\.org/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: PL }));
    await p.clock.install({ time: Date.parse('2026-10-27T09:00:00Z') });
    await p.goto(`${base}/matchboard/index.html`);
    await p.clock.runFor(2000); await p.waitForTimeout(500);
    const ids = await p.evaluate(() => shownRows.slice(0, bands.length).map((r) => r.match.id));
    ok(ids[0] === 1010 && ids[1] === 1008, `Tuesday: your club's next match, then yesterday's result first (${ids})`);
    await p.screenshot({ path: `${OUT}/match-VM-tuesday.png` });
    await ctx.close();
  }
  {
    // CORS refused: the helper relays it.
    const { ctx, p, calls } = await open('matchboard', SLOTS.VM, MB, { direct: false });
    const store = await p.evaluate(() => JSON.parse(localStorage.getItem('matchboard-standalone')));
    ok(calls.helper >= 2 && store.sources.next && !store.error, `direct refused: falls back to the helper (${calls.helper} relayed)`);
    await ctx.close();
  }
  {
    // Neither: says so, and keeps nothing invented.
    const { ctx, p } = await open('matchboard', SLOTS.VM, MB, { direct: false, helper: false });
    const s = await p.evaluate(() => ({ store: JSON.parse(localStorage.getItem('matchboard-standalone')), rows: shownRows.length }));
    ok(s.store.error === 'OFFLINE OR BLOCKED' && s.rows === 0, 'nothing gets through: no rows, and the board points at the helper');
    // Then it waits two minutes between tries: never a tight retry loop.
    const before = await p.evaluate(() => JSON.parse(localStorage.getItem('matchboard-standalone')).attemptAt);
    await p.clock.runFor(60000); await p.waitForTimeout(200);
    const at1 = await p.evaluate(() => JSON.parse(localStorage.getItem('matchboard-standalone')).attemptAt);
    await p.clock.runFor(70000); await p.waitForTimeout(300);
    const at2 = await p.evaluate(() => JSON.parse(localStorage.getItem('matchboard-standalone')).attemptAt);
    ok(at1 === before && at2 > before && at2 - before >= 120000, `after a failure it retries in two minutes, not at once (${(at2 - before) / 1000}s)`);
    await p.screenshot({ path: `${OUT}/match-blocked.png` });
    await ctx.close();
  }
  {
    const { ctx, p } = await open('matchboard', SLOTS.VM, { apiKey: '', club: '' });
    await p.screenshot({ path: `${OUT}/match-no-key.png` });
    ok(await p.evaluate(() => shownRows.length === 0), 'no key: asks for one');
    await ctx.close();
  }

  // ------------------------------------------------------------------ Day Board
  const DB = { cal1Url: URL1, cal1Code: 'PRS', cal1Color: '#F2C500', cal2Url: URL2, cal2Code: 'WRK', cal2Color: '#1F5AA6', hourFormat: '12' };
  for (const [name, size] of Object.entries(SLOTS)) {
    const { ctx, p, calls } = await open('dayboard', size, DB);
    await p.screenshot({ path: `${OUT}/day-${name}.png` });
    if (name === 'VL') {
      const s = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard-standalone')));
      const personal = s.cals[DB.cal1Url];
      const work = s.cals[DB.cal2Url];
      ok(calls.direct === 2 && personal && work && !personal.error, 'reads both iCal addresses');
      ok(personal.events.some((e) => e.title === 'Emma birthday' && e.allDay) && work.events.some((e) => e.title === 'Weekly planning'), 'repeating and all-day events expanded');
    }
    await ctx.close();
  }
  {
    const { ctx, p, calls } = await open('dayboard', SLOTS.VM, DB, { direct: false });
    const s = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard-standalone')));
    ok(calls.helper === 2 && !s.cals[DB.cal1Url].error, 'Day Board falls back to the helper too');
    await ctx.close();
  }
  {
    const { ctx, p } = await open('dayboard', SLOTS.VM, { ...DB, cal2Url: 'https://example.com/cal.ics' });
    const s = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard-standalone')));
    ok(s.cals['https://example.com/cal.ics'].error === 'NOT A GOOGLE ICAL ADDRESS', 'only Google iCal addresses are fetched');
    await p.screenshot({ path: `${OUT}/day-bad-address.png` });
    await ctx.close();
  }

  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'NO PAGE ERRORS');
  if (errors.length) fails++;
  await b.close();
  server.close();
  if (fails) { console.log(`${fails} FAILED`); process.exitCode = 1; } else console.log('ALL OK');
})();
