// Which day is "today", for a phone in London (BST until 25 Oct 2026, then
// GMT) with calendars in New York and UTC. Covers the header's relative-day
// label and Back to today action, midnight and resume, the Add form's
// defaults, edits that must keep an event's span, instant and time zone, the
// Google cache merge and the sample day.
const { chromium } = require('./pw');
const APP = 'http://127.0.0.1:8765/dayboard/';
const OUT = process.argv[2];
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const T = (s) => new Date(s).getTime();
const M = 60000;
const FAR = 4102444800000; // token expiry in 2100

(async () => {
  const b = await chromium.launch();
  const errors = [];

  // A page in Europe/London with a fake clock at `time` and the given saved state.
  async function open({ time, state, tokens, cache, w = 390, locale = 'en-GB', touch = false, google = null }) {
    const ctx = await b.newContext({ viewport: { width: w, height: 844 }, timezoneId: 'Europe/London', locale, hasTouch: touch, isMobile: touch });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await p.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    if (google) await p.route('https://www.googleapis.com/calendar/v3/**', google);
    await p.clock.install({ time: T(time) });
    await p.goto(APP);
    await p.evaluate(([s, t, c]) => {
      localStorage.clear();
      localStorage.setItem('dayboard.v1', JSON.stringify(s));
      if (t) localStorage.setItem('dayboard.v1.tokens', JSON.stringify(t));
      if (c) localStorage.setItem('dayboard.v1.cache', JSON.stringify(c));
    }, [state, tokens || null, cache || null]);
    await p.reload();
    await p.clock.runFor(400);
    await p.waitForTimeout(300); // slide/flip animations run on real time
    return { ctx, p };
  }
  const info = (p) => p.evaluate(() => ({
    date: DB.app.ui.date,
    today: DB.util.todayKey(),
    kicker: (document.querySelector('.hdr-kicker') || {}).textContent || null,
    kickerToday: !!document.querySelector('.hdr-kicker.is-today'),
    head: (document.querySelector('.date-text') || {}).textContent || null,
    btn: (document.querySelector('.today-btn') || {}).textContent || null,
    btnAria: document.querySelector('.today-btn') ? document.querySelector('.today-btn').getAttribute('aria-label') : null,
    chip: !!document.querySelector('.chip-btn'),
  }));
  const press = async (p, key, n = 1) => { for (let i = 0; i < n; i++) { await p.keyboard.press(key); await p.clock.runFor(50); } await p.waitForTimeout(350); };
  const local = (id, title, start, end, allDay = false) => ({ id, title, start, end, allDay });
  const base = (system, events = [], extra = {}) => ({ version: 1, system, settings: { sample: false, ...(extra.settings || {}) }, localEvents: events, ...extra.top });
  const hide = (p, hidden) => p.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

  // ---------------------------------------------------------------- header
  const WED = '2026-10-14T15:00:00+01:00';
  const thuEvents = [
    local('a', 'School run', T('2026-10-15T08:30:00+01:00'), T('2026-10-15T09:00:00+01:00')),
    local('b', 'Late call', T('2026-10-14T16:00:00+01:00'), T('2026-10-14T16:30:00+01:00')),
  ];
  for (const sys of ['flap', 'nyc', 'london']) {
    for (const w of [360, 412]) {
      const { ctx, p } = await open({ time: WED, state: base(sys, thuEvents), w });
      let s = await info(p);
      if (w === 360) {
        assert(s.date === '2026-10-14' && s.kicker === 'today' && s.kickerToday && !s.btn && !s.chip, `${sys}: today's board says TODAY above the date, no jump button: ${JSON.stringify(s)}`);
      }
      await press(p, 'ArrowRight');
      s = await info(p);
      const fit = await p.$eval('.date-btn', (d) => d.scrollWidth - d.clientWidth);
      const kickerTop = await p.evaluate(() => { const k = document.querySelector('.hdr-kicker').getBoundingClientRect(); const d = document.querySelector('.date-text').getBoundingClientRect(); const t = document.querySelector('.today-btn').getBoundingClientRect(); return k.bottom <= d.top + 1 && t.top >= d.bottom - 1; });
      assert(s.date === '2026-10-15' && s.kicker === 'tomorrow' && !s.kickerToday && s.btn === 'Back to today' && !s.chip,
        `${sys} @${w}: Thursday says TOMORROW and offers Back to today: ${JSON.stringify(s)}`);
      assert(fit <= 0 && kickerTop, `${sys} @${w}: label above, button below, date fits (overflow ${fit})`);
      if (w === 360) {
        assert(/Back to today, Wednesday/.test(s.btnAria), `${sys}: button names today for screen readers: ${s.btnAria}`);
        await p.screenshot({ path: `${OUT}/dates-${sys}-tomorrow.png` });
        if (sys === 'flap') {
          await p.waitForTimeout(1200);
          const rk = await p.$$eval('.flaprow .fl-remark .sr-only', (e) => e.map((x) => x.textContent));
          assert(rk.length === 1 && rk[0] === 'Scheduled', 'flap: a future day says SCHEDULED, not ON TIME: ' + JSON.stringify(rk));
        }
        await press(p, 'ArrowLeft', 2);
        s = await info(p);
        const chevronLast = await p.$eval('.today-btn', (e) => e.lastElementChild.tagName.toLowerCase() === 'svg');
        assert(s.kicker === 'yesterday' && chevronLast, `${sys}: yesterday, with the chevron pointing forward to today`);
        await press(p, 'ArrowRight', 4);
        s = await info(p);
        assert(s.kicker === 'in 3 days', `${sys}: three days ahead reads "in 3 days": ${s.kicker}`);
        await p.click('.today-btn'); await p.clock.runFor(50); await p.waitForTimeout(350);
        s = await info(p);
        assert(s.date === s.today && s.kicker === 'today' && !s.btn, `${sys}: Back to today goes back`);
        if (sys === 'flap') {
          await p.waitForTimeout(1200);
          const rk = await p.$$eval('.flaprow .fl-remark .sr-only', (e) => e.map((x) => x.textContent));
          assert(rk[0] === 'ON TIME', "flap: today's future departure is still ON TIME: " + JSON.stringify(rk));
        }
        // Lines tab
        await p.click('.tab-btn[data-tab="lines"]'); await p.clock.runFor(50);
        await press(p, 'ArrowRight');
        const lines = await p.evaluate(() => ({ sub: document.querySelector('.hdr-sub').textContent, btn: !!document.querySelector('.lines-view .today-btn') }));
        assert(/tomorrow · /.test(lines.sub) && lines.btn, `${sys}: Lines says tomorrow and offers Back to today: ${JSON.stringify(lines)}`);
        await p.click('.lines-view .today-btn'); await p.clock.runFor(50); await p.waitForTimeout(350);
        assert((await info(p)).date === '2026-10-14', `${sys}: Lines Back to today works`);
        // picker marks today for screen readers
        await p.click('.tab-btn[data-tab="board"]'); await p.clock.runFor(50);
        await press(p, 'ArrowRight');
        await p.click('.date-btn'); await p.clock.runFor(50);
        const pk = await p.evaluate(() => ({ today: document.querySelector('.pk-day.today').getAttribute('aria-label'), sel: document.querySelector('.pk-day.sel').getAttribute('aria-label') }));
        assert(/, today$/.test(pk.today) && !/today/.test(pk.sel), `${sys}: picker labels today: ${JSON.stringify(pk)}`);
      }
      await ctx.close();
    }
  }

  // en-US words too
  {
    const { ctx, p } = await open({ time: WED, state: base('nyc'), locale: 'en-US' });
    await press(p, 'ArrowLeft');
    assert((await info(p)).kicker === 'yesterday', 'en-US: yesterday');
    await ctx.close();
  }

  // -------------------------------------------------------------- midnight
  {
    const { ctx, p } = await open({ time: '2026-10-14T23:59:58+01:00', state: base('flap') });
    await p.clock.runFor(3000); await p.waitForTimeout(300);
    const s = await info(p);
    assert(s.date === '2026-10-15' && s.kicker === 'today' && !s.btn, 'left open across midnight: the board moves on to the new today: ' + JSON.stringify(s));
    await ctx.close();
  }
  for (const sys of ['flap', 'nyc']) {
    // A swipe still in progress at midnight steps from the day on screen.
    const { ctx, p } = await open({ time: '2026-10-14T23:59:58.500+01:00', state: base(sys), touch: true });
    const cdp = await ctx.newCDPSession(p);
    const t = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await t('touchStart', 320, 600);
    for (let i = 1; i <= 10; i++) { await t('touchMove', 320 - i * 25, 600); await p.clock.runFor(250); }
    await t('touchEnd'); await p.clock.runFor(100); await p.waitForTimeout(500); await p.clock.runFor(2000);
    const s = await info(p);
    assert(s.date === '2026-10-15' && s.today === '2026-10-15', `${sys}: swipe across midnight lands on Thursday, not Friday: ${JSON.stringify(s)}`);
    await ctx.close();
  }
  {
    // Phone asleep through midnight: the first frame after waking is today.
    const { ctx, p } = await open({ time: WED, state: base('flap') });
    await hide(p, true);
    await p.clock.setSystemTime(T('2026-10-15T07:30:00+01:00'));
    await hide(p, false);
    const s = await info(p);
    assert(s.date === '2026-10-15' && s.head === 'Thursday, Oct 15' && s.kicker === 'today' && !s.btn, 'woken after midnight: no stale "yesterday" frame: ' + JSON.stringify(s));
    await ctx.close();
  }
  {
    // Back after a while away: today again. A quick app switch keeps your day.
    const { ctx, p } = await open({ time: WED, state: base('flap') });
    await press(p, 'ArrowRight');
    await hide(p, true);
    await p.clock.setSystemTime(T('2026-10-14T15:05:00+01:00'));
    await hide(p, false);
    assert((await info(p)).date === '2026-10-15', 'back after 5 min: still on the day you browsed to');
    await hide(p, true);
    await p.clock.setSystemTime(T('2026-10-14T15:25:00+01:00'));
    await hide(p, false);
    const s = await info(p);
    assert(s.date === '2026-10-14' && s.kicker === 'today', 'back after 20 min: today again: ' + JSON.stringify(s));
    await ctx.close();
  }

  // -------------------------------------------------------------- Add form
  const addForm = (p) => p.evaluate(() => ({ date: document.getElementById('f-date').value, time: document.getElementById('f-time').value, rel: document.querySelector('.rel-cap').textContent }));
  {
    const { ctx, p } = await open({ time: '2026-10-14T23:45:00+01:00', state: base('flap') });
    await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
    const f = await addForm(p);
    assert(f.date === '2026-10-14' && f.time === '23:50' && f.rel === 'today', 'Add at 23:45 stays on today: ' + JSON.stringify(f));
    await ctx.close();
  }
  {
    const { ctx, p } = await open({ time: WED, state: base('flap') });
    await press(p, 'ArrowRight', 11); // Sun 25 Oct: the clocks go back
    await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
    let f = await addForm(p);
    assert(f.date === '2026-10-25' && f.time === '09:00' && f.rel === 'in 11 days', 'Add on the clock-change day defaults to 09:00: ' + JSON.stringify(f));
    await p.fill('#f-date', '2026-10-15');
    f = await addForm(p);
    assert(f.rel === 'tomorrow', 'the caption follows the date field: ' + f.rel);
    await p.fill('#f-title', 'Dentist');
    await p.click('.add-view .btn-primary'); await p.clock.runFor(50); await p.waitForTimeout(350);
    const toast = await p.$eval('#toast', (e) => e.textContent);
    const s = await info(p);
    assert(toast === 'Added to Thursday, Oct 15' && s.kicker === 'tomorrow', `saving says where it went: "${toast}", board on ${s.kicker}`);
    await ctx.close();
  }

  // ----------------------------------------------------------------- edits
  {
    const trip = local('trip', 'Half term', T('2026-10-15T00:00:00+01:00'), T('2026-10-18T00:00:00+01:00'), true);
    // 01:30 GMT on 25 Oct is the second 01:30 that night (the first is 00:30Z).
    const late = local('late', 'Night shift', T('2026-10-25T01:30:00Z'), T('2026-10-25T02:00:00Z'));
    const { ctx, p } = await open({ time: WED, state: base('flap', [trip, late]) });
    const edit = async (key, fn) => {
      await p.evaluate((k) => { DB.app.ui.editKey = k; }, key);
      await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
      await fn();
      await p.click('.add-view .btn-primary'); await p.clock.runFor(50); await p.waitForTimeout(200);
    };
    const saved = (id) => p.evaluate((i) => JSON.parse(localStorage.getItem('dayboard.v1')).localEvents.find((e) => e.id === i), id);
    await edit('l|trip', () => p.fill('#f-title', 'Half term break'));
    let e = await saved('trip');
    assert(e.title === 'Half term break' && e.start === trip.start && e.end === trip.end, 'editing a 3-day all-day event keeps all 3 days');
    await edit('l|trip', () => p.fill('#f-date', '2026-10-22'));
    e = await saved('trip');
    assert(e.start === T('2026-10-22T00:00:00+01:00') && e.end === T('2026-10-25T00:00:00+01:00'), 'moving it keeps its length');
    await edit('l|late', () => p.fill('#f-title', 'Night shift (cover)'));
    e = await saved('late');
    assert(e.start === late.start && e.end === late.end, `an unchanged time in the repeated hour stays put (${new Date(e.start).toISOString()})`);
    await ctx.close();
  }
  {
    // Google: an edit leaves times and the event's own zone alone.
    const patches = [];
    const db = [
      { id: 'ny1', summary: 'Family dinner', status: 'confirmed', start: { dateTime: '2026-10-14T18:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-14T19:00:00-04:00', timeZone: 'America/New_York' } },
      { id: 'trip', summary: 'Visit', status: 'confirmed', start: { date: '2026-10-15' }, end: { date: '2026-10-18' } },
    ];
    const google = async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (req.method() === 'GET') return json({ items: db });
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON();
        patches.push(body);
        const ev = db.find((x) => u.pathname.endsWith('/' + x.id));
        for (const k of ['start', 'end']) if (body[k]) ev[k] = Object.fromEntries(Object.entries({ ...ev[k], ...body[k] }).filter(([, v]) => v !== null));
        if (body.summary) ev.summary = body.summary;
        return json(ev);
      }
      return route.fulfill({ status: 404, body: '{}' });
    };
    const state = base('flap', [], { top: { accounts: [{ email: 'me@gmail.com', defaultLine: null, write: true, calendars: [{ id: 'fam', name: 'Family', color: '#f6bf26', role: 'writer', primary: false, enabled: true, line: null }] }] } });
    const { ctx, p } = await open({ time: WED, state, tokens: { 'me@gmail.com': { token: 'tok', exp: FAR } }, google });
    await p.waitForTimeout(400); await p.clock.runFor(200);
    const edit = async (key, fn) => {
      await p.evaluate((k) => { DB.app.ui.editKey = k; }, key);
      await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
      await fn();
      await p.click('.add-view .btn-primary'); await p.clock.runFor(50); await p.waitForTimeout(400);
    };
    await edit('g|me@gmail.com|fam|ny1', () => p.fill('#f-title', 'Family dinner (call)'));
    let pb = patches.at(-1);
    assert(pb && pb.summary === 'Family dinner (call)' && !('start' in pb) && !('end' in pb), 'Google: renaming sends no times: ' + JSON.stringify(pb && Object.keys(pb)));
    await edit('g|me@gmail.com|fam|ny1', () => p.fill('#f-time', '22:30'));
    pb = patches.at(-1);
    assert(pb && pb.start && pb.start.dateTime === '2026-10-14T21:30:00.000Z' && !('timeZone' in pb.start) && !('timeZone' in pb.end),
      'Google: a new time keeps the event in New York time (no timeZone sent): ' + JSON.stringify(pb && pb.start));
    assert(db[0].start.timeZone === 'America/New_York', 'Google: the event is still a New York event');
    await edit('g|me@gmail.com|fam|trip', () => p.fill('#f-title', 'Visit NYC'));
    pb = patches.at(-1);
    assert(pb && !('start' in pb), 'Google: renaming a 3-day all-day event sends no dates');
    await edit('g|me@gmail.com|fam|trip', () => p.fill('#f-date', '2026-10-16'));
    pb = patches.at(-1);
    assert(pb && pb.start.date === '2026-10-16' && pb.end.date === '2026-10-19', 'Google: moving it keeps 3 days: ' + JSON.stringify(pb && [pb.start, pb.end]));
    await ctx.close();
  }

  // ----------------------------------------------------------------- cache
  {
    const { ctx, p } = await open({ time: WED, state: base('flap') });
    const r = await p.evaluate(() => {
      const U = DB.util;
      // A UTC calendar's all-day 14 Oct ends at 01:00 BST on the 15th, past London midnight.
      const ev = (id, start, end, allDay) => ({ key: 'g|me|u|' + id, source: 'google', id, email: 'me', calId: 'u', title: id, allDay, start, end });
      const ad = ev('ad14', U.dayStart('2026-10-14'), U.dayStart('2026-10-15'), true);
      const w1 = [U.dayStart('2026-10-12'), U.dayStart('2026-10-15')];
      const w2 = [U.dayStart('2026-10-15'), U.dayStart('2026-10-22')];
      DB.store.putWindow(w1[0], w1[1], { 'me|u': [ad] });
      for (let i = 0; i < 5; i++) DB.store.putWindow(w2[0], w2[1], { 'me|u': [ad] }); // Google returns it again each time
      const dup = DB.store.cachedEvents('me', 'u').filter((e) => e.id === 'ad14').length;
      // An event moved on Google from the 22nd to the 15th keeps its id.
      DB.store.putWindow(U.dayStart('2026-10-20'), U.dayStart('2026-10-25'), { 'me|u': [ev('mv', U.fromInputs('2026-10-22', '10:00'), U.fromInputs('2026-10-22', '11:00'), false)] });
      DB.store.putWindow(w2[0], U.dayStart('2026-10-20'), { 'me|u': [ev('mv', U.fromInputs('2026-10-15', '10:00'), U.fromInputs('2026-10-15', '11:00'), false)] });
      const moved = DB.store.cachedEvents('me', 'u').filter((e) => e.id === 'mv').map((e) => U.dateKey(e.start));
      return { dup, moved };
    });
    assert(r.dup === 1, `cache: refetching a window doesn't pile up copies of a UTC all-day event (${r.dup})`);
    assert(r.moved.length === 1 && r.moved[0] === '2026-10-15', 'cache: a moved event leaves no ghost on its old day: ' + JSON.stringify(r.moved));
    await ctx.close();
  }

  // ---------------------------------------------------------------- sample
  {
    const { ctx, p } = await open({ time: '2026-10-14T23:30:00+01:00', state: { version: 1, system: 'flap', settings: { sample: true }, localEvents: [] } });
    const r = await p.evaluate(() => {
      const U = DB.util;
      const evs = DB.sample.build(Date.now(), 'flap');
      return { n: evs.length, outside: evs.filter((e) => e.start < U.dayStart('2026-10-14') || e.end > U.dayEnd('2026-10-14')).map((e) => e.title) };
    });
    assert(r.outside.length === 0 && r.n > 3, 'sample day opened at 23:30 stays on today: ' + JSON.stringify(r));
    await press(p, 'ArrowRight');
    const rows = await p.$$eval('.board .row', (e) => e.length);
    assert(rows === 0, 'tomorrow has no sample departures');
    await ctx.close();
  }

  // ----------------------------------------------- review follow-ups (42b3038)
  {
    // An Add form left open across midnight stops calling its date "today".
    const { ctx, p } = await open({ time: '2026-10-14T23:50:00+01:00', state: base('flap') });
    await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
    await p.clock.runFor(15 * 60000);
    const f = await addForm(p);
    assert(f.date === '2026-10-14' && f.rel === 'yesterday', 'Add form open across midnight now says yesterday: ' + JSON.stringify(f));
    await ctx.close();
  }
  {
    // Opening Add in the instant after midnight, before the next tick, defaults to the new today.
    const { ctx, p } = await open({ time: '2026-10-14T23:59:59.000+01:00', state: base('flap') });
    await p.clock.setSystemTime(T('2026-10-15T00:00:00.400+01:00'));
    await p.click('.tab-btn[data-tab="add"]');
    const f = await addForm(p);
    assert(f.date === '2026-10-15' && f.rel === 'today', 'Add just after midnight opens on the new today: ' + JSON.stringify(f));
    await ctx.close();
  }
  for (const [at, what] of [['2026-10-14T23:55:00+01:00', 'at 23:55'], ['2026-10-15T00:03:00+01:00', 'at 00:03']]) {
    // The sample day is clipped to today, never emptied, and keeps its live rows.
    const { ctx, p } = await open({ time: at, state: { version: 1, system: 'nyc', settings: { sample: true }, localEvents: [] } });
    const r = await p.evaluate(() => ({ rows: document.querySelectorAll('.board .row').length, live: document.querySelectorAll('.board .row.live').length }));
    await press(p, 'ArrowRight');
    const tomorrow = await p.$$eval('.board .row', (e) => e.length);
    assert(r.rows >= 2 && r.live >= 1 && tomorrow === 0, `sample day ${what}: ${r.rows} rows, ${r.live} live today, ${tomorrow} tomorrow`);
    await ctx.close();
  }
  {
    // Saving the untouched default start in the repeated hour keeps the instant shown.
    const { ctx, p } = await open({ time: '2026-10-25T01:15:00Z', state: base('flap') }); // 01:15 GMT, the second 01:15
    await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
    const f = await addForm(p);
    await p.fill('#f-title', 'Night bus');
    await p.click('.add-view .btn-primary'); await p.clock.runFor(50); await p.waitForTimeout(200);
    const e = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard.v1')).localEvents[0]);
    assert(f.time === '01:30' && e.start === T('2026-10-25T01:30:00Z'), `new event at the default 01:30 in the repeated hour is 01:30 GMT (${new Date(e.start).toISOString()})`);
    await ctx.close();
  }
  {
    // A rename keeps a zero-length event's end; a timed multi-day event switched to all day keeps its days.
    const zero = local('zero', 'Reminder', T('2026-10-14T17:00:00+01:00'), T('2026-10-14T17:00:00+01:00'));
    const conf = local('conf', 'Conference', T('2026-10-15T09:00:00+01:00'), T('2026-10-17T17:00:00+01:00'));
    const { ctx, p } = await open({ time: WED, state: base('flap', [zero, conf]) });
    const edit = async (key, fn) => {
      await p.evaluate((k) => { DB.app.ui.editKey = k; }, key);
      await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
      const r = await fn();
      await p.click('.add-view .btn-primary'); await p.clock.runFor(50); await p.waitForTimeout(200);
      return r;
    };
    const saved = (id) => p.evaluate((i) => JSON.parse(localStorage.getItem('dayboard.v1')).localEvents.find((e) => e.id === i), id);
    await edit('l|zero', () => p.fill('#f-title', 'Reminder!'));
    let e = await saved('zero');
    assert(e.start === zero.start && e.end === zero.end, 'renaming a zero-length event keeps it zero-length');
    const cap = await edit('l|conf', async () => { await p.click('#f-allday'); return (await addForm(p)).rel; });
    e = await saved('conf');
    assert(cap === 'tomorrow · 3 days' && e.allDay && e.start === T('2026-10-15T00:00:00+01:00') && e.end === T('2026-10-18T00:00:00+01:00'),
      `a Thu–Sat timed event switched to all day keeps 3 days ("${cap}")`);
    await ctx.close();
  }
  {
    // A background fetch that started before a save can't undo it.
    const { ctx, p } = await open({ time: WED, state: base('flap') });
    const r = await p.evaluate(() => {
      const U = DB.util;
      const ev = (start) => ({ key: 'g|me|c|e1', source: 'google', id: 'e1', email: 'me', calId: 'c', title: 'Dentist', allDay: false, start, end: start + 3600000 });
      const startedAt = Date.now() - 1000; // the fetch went out first...
      DB.store.putEvent(ev(U.fromInputs('2026-10-22', '10:00'))); // ...then the user moved the event to the 22nd
      DB.store.putWindow(U.dayStart('2026-10-12'), U.dayStart('2026-10-20'), { 'me|c': [ev(U.fromInputs('2026-10-15', '10:00'))] }, startedAt);
      return DB.store.cachedEvents('me', 'c').map((e) => U.dateKey(e.start));
    });
    assert(r.length === 1 && r[0] === '2026-10-22', 'a stale sync answer does not undo a just-saved move: ' + JSON.stringify(r));
    await ctx.close();
  }
  for (const sys of ['nyc', 'london']) {
    // Layout and accessibility follow-ups at 320px.
    const { ctx, p } = await open({ time: WED, state: base(sys), w: 320 });
    await press(p, 'ArrowRight');
    const a = await p.evaluate(() => ({ hidden: document.querySelector('.board-view .hdr-kicker').getAttribute('aria-hidden') }));
    await p.click('.today-btn'); await p.clock.runFor(50);
    const focused = await p.evaluate(() => document.activeElement && document.activeElement.className);
    assert(a.hidden === 'true' && focused === 'date-btn', `${sys}: board label hidden from screen readers (the date button says it); focus stays in the header after Back to today (${focused})`);
    await p.click('.tab-btn[data-tab="lines"]'); await p.clock.runFor(50);
    await press(p, 'ArrowRight');
    const l = await p.evaluate(() => ({ lines: document.querySelector('.hdr-sub .sub-date').getClientRects().length, hidden: document.querySelector('.hdr-sub .hdr-kicker').getAttribute('aria-hidden') }));
    assert(l.lines === 1 && l.hidden === null, `${sys}: Lines date never splits at 320px, and its label stays readable`);
    await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
    const fit = await p.evaluate(() => document.querySelector('.field-pair').getBoundingClientRect().right <= innerWidth - 8);
    assert(fit, `${sys}: Add form date and time stay on screen at 320px with the caption`);
    await ctx.close();
  }
  {
    // Landscape: the button joins the label above the date instead of taking a row.
    const { ctx, p } = await open({ time: WED, state: base('nyc'), w: 844 });
    await p.setViewportSize({ width: 844, height: 390 });
    await press(p, 'ArrowRight');
    const g = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { sameRow: Math.abs(r('.today-btn').top + r('.today-btn').height / 2 - (r('.hdr-kicker').top + r('.hdr-kicker').height / 2)) < 6, above: r('.today-btn').bottom <= r('.date-text').top + 2 };
    });
    assert(g.sameRow && g.above, 'landscape: Back to today sits beside the label, above the date');
    await ctx.close();
  }

  // ------------------------------------------- Personal from 21 Oct, Now strip
  {
    const lines = [
      { id: 'w1', name: 'Work', nyc: { letter: 'A', color: 'blue' }, london: { line: 'victoria' }, flap: { color: 'blue' } },
      { id: 'p1', name: 'Personal', nyc: { letter: 'D', color: 'yellow' }, london: { line: 'circle' }, flap: { color: 'yellow' } },
      { id: 's1', name: 'Social', nyc: { letter: 'F', color: 'purple' }, london: { line: 'metropolitan' }, flap: { color: 'magenta' } },
    ];
    const evs = [
      local('tue', 'Dentist', T('2026-10-20T23:00:00+01:00'), T('2026-10-20T23:30:00+01:00')),
      local('wed', 'Lunch', T('2026-10-21T00:30:00+01:00'), T('2026-10-21T01:00:00+01:00')),
      { ...local('own', 'Party', T('2026-10-22T19:00:00+01:00'), T('2026-10-22T22:00:00+01:00')), line: 's1' },
      local('next', 'Standup', T('2026-10-20T10:30:00+01:00'), T('2026-10-20T10:45:00+01:00')),
    ];
    const { ctx, p } = await open({ time: '2026-10-20T10:00:00+01:00', state: { ...base('nyc', evs), lines } });
    const r = await p.evaluate(() => {
      const of = (id) => DB.store.resolveLine({ ...DB.store.state.localEvents.find((e) => e.id === id), key: id, source: 'local' }).name;
      return { tue: of('tue'), wed: of('wed'), own: of('own'), from: DB.store.state.settings.lineFrom, setup: DB.store.widgetSetup() };
    });
    assert(r.tue === 'Work' && r.wed === 'Personal' && r.own === 'Social', `21 Oct on rides Personal (local midnight is the cut); a line picked for an event wins: ${JSON.stringify(r)}`);
    assert(r.from && r.from.date === '2026-10-21' && r.from.line === 'p1', 'the dated default is set once, on Personal');
    assert(/^DB1\nL\tw1\tWork\tWRK\t[0-9A-F]{6}\n/.test(r.setup) && /\nF\t2026-10-21\tp1$/.test(r.setup), 'the widget setup carries the lines and the dated default');
    const strip = await p.evaluate(() => (document.querySelector('.now-strip') || {}).textContent || null);
    assert(/Now\s*10:00/i.test(strip) && /Next train.*in 30 min.*Standup/.test(strip), `today has a Now / Next train strip: ${strip}`);
    await p.clock.runFor(60000 * 5); await p.waitForTimeout(100);
    const strip2 = await p.evaluate(() => document.querySelector('.now-strip').textContent);
    assert(/10:05/.test(strip2) && /in 25 min/.test(strip2), `the strip keeps time: ${strip2}`);
    await p.screenshot({ path: `${OUT}/now-strip-nyc.png` });
    await press(p, 'ArrowRight');
    assert(!(await p.$('.now-strip')), 'another day has no Now strip');
    await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(50);
    const addLine = await p.$eval('#f-line', (s) => s.value);
    assert(addLine === 'p1', `the Add form on 21 Oct defaults to Personal (${addLine})`);
    await p.fill('#f-date', '2026-10-20'); await p.$eval('#f-date', (d) => d.dispatchEvent(new Event('change')));
    assert(await p.$eval('#f-line', (s) => s.value) === 'w1', 'and back to the first line before it');
    // Removing the rule sticks.
    await p.evaluate(() => DB.store.set('lineFrom', null));
    await p.reload(); await p.clock.runFor(400);
    const gone = await p.evaluate(() => DB.store.state.settings.lineFrom);
    assert(gone === null, 'switched off in Settings, it stays off');
    await ctx.close();
  }
  for (const sys of ['flap', 'london']) {
    const evs = [local('n', 'Grab cards at the card shop', T('2026-10-15T16:30:00+01:00'), T('2026-10-15T17:00:00+01:00'))];
    const { ctx, p } = await open({ time: '2026-10-15T14:33:00+01:00', state: base(sys, evs), w: 390 });
    const s = await p.evaluate(() => { const e = document.querySelector('.now-strip'); return { t: e.textContent, over: e.scrollWidth - e.clientWidth }; });
    assert(/in 1 hr 57 min/.test(s.t) && s.over <= 0, `${sys}: Now strip counts down and fits: ${JSON.stringify(s)}`);
    await p.screenshot({ path: `${OUT}/now-strip-${sys}.png` });
    await ctx.close();
  }

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  if (errors.length) process.exitCode = 1;
  await b.close();
})();
