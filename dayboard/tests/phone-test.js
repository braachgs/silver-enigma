// The board inside the Day Board Android app, against a fake phone bridge
// (window.DayBoardPhone, as dayboard-android's PhoneBridge provides): two
// Google accounts read from the phone with no sign-in, a repeating event
// keyed like Google's, lines carried over from the browser setup, writes,
// and the widget setup sent automatically.
const { chromium } = require('./pw');
const APP = 'http://127.0.0.1:8765/dayboard/';
const OUT = process.argv[2];
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
const T = (s) => new Date(s).getTime();

(async () => {
  const b = await chromium.launch();
  const errors = [];

  const lines = [
    { id: 'w1', name: 'Work', nyc: { letter: 'A', color: 'blue' }, london: { line: 'victoria' }, flap: { color: 'blue' } },
    { id: 'p1', name: 'Personal', nyc: { letter: 'D', color: 'yellow' }, london: { line: 'circle' }, flap: { color: 'yellow' } },
    { id: 's1', name: 'Social', nyc: { letter: 'F', color: 'purple' }, london: { line: 'metropolitan' }, flap: { color: 'magenta' } },
  ];
  // What the browser version sends over: the personal account, its family
  // calendar on Social, and one repeating instance picked onto Social.
  const browserState = {
    version: 1, system: 'flap', lines,
    accounts: [{ email: 'me@gmail.com', defaultLine: 'p1', write: true, calendars: [
      { id: 'me@gmail.com', name: 'Events', color: '#039be5', role: 'owner', primary: true, enabled: true, line: null },
      { id: 'fam@group.calendar.google.com', name: 'Family', color: '#8e24aa', role: 'writer', primary: false, enabled: true, line: 's1' },
    ] }],
    localEvents: [],
    overrides: { 'g|me@gmail.com|me@gmail.com|gym9_20261022T170000Z': 's1' },
    settings: { sample: false },
  };

  const phone = {
    imported: JSON.stringify(browserState),
    calendars: [
      // Android keeps the Google id in NAME for some calendars, OWNER_ACCOUNT for others.
      { id: 1, account: 'me@gmail.com', name: 'me@gmail.com', displayName: 'Events', owner: 'me@gmail.com', syncId: null, color: -16537100, access: 700, visible: true, primary: true },
      { id: 2, account: 'me@gmail.com', name: 'Family', displayName: 'Family', owner: 'fam@group.calendar.google.com', syncId: null, color: -7461718, access: 600, visible: true, primary: false },
      { id: 3, account: 'me@work.com', name: 'me@work.com', displayName: 'me@work.com', owner: 'me@work.com', syncId: null, color: -15108398, access: 700, visible: true, primary: true },
      { id: 4, account: 'me@work.com', name: 'UK Holidays', displayName: 'UK Holidays', owner: 'en.uk#holiday@group.v.calendar.google.com', syncId: null, color: -1, access: 200, visible: true, primary: false },
    ],
    events: [
      { eventId: 10, calendarId: 1, title: 'Dentist', begin: T('2026-10-22T14:00:00+01:00'), end: T('2026-10-22T14:30:00+01:00'), allDay: false, syncId: 'dent1', repeats: false },
      { eventId: 11, calendarId: 1, title: 'Gym', begin: T('2026-10-22T18:00:00+01:00'), end: T('2026-10-22T19:00:00+01:00'), allDay: false, syncId: 'gym9', repeats: true },
      { eventId: 12, calendarId: 2, title: 'School run', begin: T('2026-10-22T15:00:00+01:00'), end: T('2026-10-22T15:30:00+01:00'), allDay: false, syncId: 'sch1', repeats: false },
      { eventId: 20, calendarId: 3, title: 'Board prep', begin: T('2026-10-22T11:00:00+01:00'), end: T('2026-10-22T12:00:00+01:00'), allDay: false, syncId: 'wk1', repeats: false },
      { eventId: 21, calendarId: 3, title: 'Declined sync', begin: T('2026-10-22T12:30:00+01:00'), end: T('2026-10-22T13:00:00+01:00'), allDay: false, syncId: 'wk2', repeats: false, selfStatus: 2 },
      { eventId: 30, calendarId: 4, title: 'Bank holiday', begin: T('2026-10-22T00:00:00Z'), end: T('2026-10-23T00:00:00Z'), allDay: true, syncId: 'hol1', repeats: false },
    ],
  };

  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London', locale: 'en-GB' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.addInitScript((ph) => {
    const log = (window.__phone = { lines: [], opened: [], inserted: [], updated: [], deleted: [] });
    let next = 100;
    const ok = (x) => JSON.stringify(x == null ? {} : x);
    window.DayBoardPhone = {
      importedState: () => ph.imported,
      calendars: () => JSON.stringify(ph.calendars),
      events: (from, to) => JSON.stringify(ph.events.filter((e) => e.begin < to && e.end > from)),
      insertEvent: (json) => {
        const d = JSON.parse(json); log.inserted.push(d);
        const id = next++;
        ph.events.push({ eventId: id, calendarId: d.calendar, title: d.title, location: d.location, begin: d.start, end: d.end, allDay: d.allDay, syncId: null, repeats: false });
        return ok({ id });
      },
      updateEvent: (id, json) => {
        const d = JSON.parse(json); log.updated.push([id, d]);
        const e = ph.events.find((x) => String(x.eventId) === id);
        if (d.title != null) e.title = d.title;
        if (d.start != null) { e.begin = d.start; e.end = d.end; }
        return ok();
      },
      deleteEvent: (id) => { log.deleted.push(id); ph.events = ph.events.filter((x) => String(x.eventId) !== id); return ok(); },
      openEvent: (id, at) => log.opened.push([id, at]),
      saveLines: (text) => log.lines.push(text),
      openWidgetSettings: () => log.opened.push(['widget']),
    };
  }, phone);
  await p.clock.install({ time: T('2026-10-22T10:00:00+01:00') });
  await p.goto(APP);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.clock.runFor(1500);
  await p.waitForTimeout(400);

  const st = await p.evaluate(() => ({
    accounts: DB.store.state.accounts.map((a) => ({ email: a.email, line: a.defaultLine, cals: a.calendars.map((c) => [c.id, c.enabled, c.line, c.role]) })),
    rows: [...document.querySelectorAll('.board .row')].map((r) => (r.querySelector('.fl-dest .sr-only') || r.querySelector('.row-title') || {}).textContent),
    banner: !!document.querySelector('.banner.warn'),
    system: DB.store.state.system,
  }));
  assert(st.system === 'flap' && st.accounts.length === 2, `first run in the app starts from the browser setup, plus the work account from the phone: ${JSON.stringify(st.accounts)}`);
  const fam = st.accounts[0].cals.find((c) => c[0] === 'fam@group.calendar.google.com');
  assert(fam && fam[2] === 's1', 'the family calendar keeps its line (matched by its Google id in OWNER_ACCOUNT)');
  const hol = st.accounts[1].cals.find((c) => c[0] === 'en.uk#holiday@group.v.calendar.google.com');
  assert(hol && hol[3] === 'reader', 'a read-only phone calendar stays read-only');
  assert(!st.banner, 'no Reconnect banner: phone accounts never expire');
  assert(st.rows.includes('Board prep') && st.rows.includes('Dentist') && st.rows.includes('School run') && st.rows.includes('Gym'),
    `both accounts on one board: ${JSON.stringify(st.rows)}`);
  assert(!st.rows.includes('Declined sync'), 'invitations you declined stay off');

  const ev = await p.evaluate(() => {
    const all = Object.values(DB.store.state.accounts).flatMap((a) => a.calendars.flatMap((c) => DB.store.cachedEvents(a.email, c.id)));
    const one = (t) => { const e = all.find((x) => x.title === t); return e && { key: e.key, line: DB.store.resolveLine(e).name, recurring: e.recurring, allDay: e.allDay, start: e.start }; };
    return { gym: one('Gym'), school: one('School run'), work: one('Board prep'), hol: one('Bank holiday'), dent: one('Dentist') };
  });
  assert(ev.gym.key === 'g|me@gmail.com|me@gmail.com|gym9_20261022T170000Z' && ev.gym.line === 'Social' && ev.gym.recurring,
    `a repeating instance gets Google's instance id, so the line picked in the browser carries over: ${JSON.stringify(ev.gym)}`);
  assert(ev.school.line === 'Social' && ev.dent.line === 'Personal', 'calendar and account lines carry over');
  assert(ev.hol.allDay && ev.hol.start === T('2026-10-22T00:00:00+01:00'), 'all-day events land on local midnight');
  await p.screenshot({ path: `${OUT}/phone-board.png` });

  const sent = await p.evaluate(() => window.__phone.lines.at(-1) || '');
  assert(/^DB1\n/.test(sent) && /\nA\tme@work\.com\t/.test(sent) && /\nE\tgym9_20261022T170000Z\ts1/.test(sent), 'the widget gets the lines by itself, both accounts included');

  // Settings: phone accounts, no sign-in.
  await p.click('[aria-label="Settings"]'); await p.clock.runFor(400);
  const set = await p.evaluate(() => ({
    phoneSection: [...document.querySelectorAll('.set-section h3')].map((x) => x.textContent),
    status: [...document.querySelectorAll('.acct-id small')].map((x) => x.textContent),
    remove: !!document.querySelector('.acct-head .btn-small.ghost'),
  }));
  assert(set.phoneSection.includes('Calendars on this phone') && !set.phoneSection.includes('Google Calendar'), `Settings lists the phone's calendars instead of Google sign-in: ${set.phoneSection}`);
  assert(set.status.every((s) => s === 'On this phone') && !set.remove, 'accounts read "On this phone", with no Reconnect or Remove');
  await p.click('button:has-text("Widget settings")');
  assert((await p.evaluate(() => window.__phone.opened.some((o) => o[0] === 'widget'))), 'Widget settings opens the Android screen');
  await p.keyboard.press('Escape'); await p.clock.runFor(300);

  // A repeating event is edited in the Calendar app.
  await p.evaluate((k) => document.querySelectorAll('.board .row').forEach((r) => { if (r.textContent.includes('GYM')) r.click(); }), ev.gym.key);
  await p.clock.runFor(300);
  const rep = await p.evaluate(() => ({ help: (document.querySelector('dialog .help') || {}).textContent || '', edit: !!document.querySelector('dialog button.btn-outline:not([class*=x])') }));
  assert(/Calendar app/.test(rep.help), `a repeating phone event points to the Calendar app: ${rep.help}`);
  await p.click('dialog button:has-text("Open in Calendar")');
  assert((await p.evaluate(() => window.__phone.opened.some((o) => o[0] === '11'))), 'Open in Calendar opens that event on the phone');
  await p.keyboard.press('Escape'); await p.clock.runFor(300);

  // Add an event to the work calendar on the Social line.
  await p.click('.tab-btn[data-tab="add"]'); await p.clock.runFor(100);
  await p.fill('#f-title', 'Panel rehearsal');
  await p.fill('#f-date', '2026-10-22');
  await p.fill('#f-time', '16:45');
  await p.selectOption('#f-dest', 'g|me@work.com|me@work.com');
  await p.selectOption('#f-line', 's1');
  await p.click('button:has-text("Add to board")'); await p.clock.runFor(800); await p.waitForTimeout(200);
  const add = await p.evaluate(() => {
    const ins = window.__phone.inserted[0];
    const e = DB.store.cachedEvents('me@work.com', 'me@work.com').find((x) => x.title === 'Panel rehearsal');
    return { ins, key: e && e.key, line: e && DB.store.resolveLine(e).name };
  });
  assert(add.ins && add.ins.calendar === 3 && add.ins.start === T('2026-10-22T16:45:00+01:00') && add.ins.timeZone === 'Europe/London',
    `Add writes to the work calendar on the phone: ${JSON.stringify(add.ins)}`);
  assert(add.key === 'g|me@work.com|me@work.com|p100' && add.line === 'Social', `the new event rides the line picked for it: ${JSON.stringify(add)}`);

  // Once the phone has synced it, Google's id replaces the temporary one and the line follows.
  await p.evaluate(() => { /* the sync adapter assigns the Google id */ });
  await p.evaluate(() => {
    const raw = JSON.parse(window.DayBoardPhone.events(0, 9e15)).find((e) => e.eventId === 100);
    const orig = window.DayBoardPhone.events;
    window.DayBoardPhone.events = (f, t) => JSON.stringify(JSON.parse(orig(f, t)).map((e) => (e.eventId === 100 ? { ...e, syncId: 'g777' } : e)));
    window.DayBoardPhoneChanged();
    return raw;
  });
  await p.clock.runFor(800); await p.waitForTimeout(200);
  const moved = await p.evaluate(() => {
    const e = DB.store.cachedEvents('me@work.com', 'me@work.com').find((x) => x.title === 'Panel rehearsal');
    return { key: e.key, line: DB.store.resolveLine(e).name, old: DB.store.state.overrides['g|me@work.com|me@work.com|p100'] || null };
  });
  assert(moved.key === 'g|me@work.com|me@work.com|g777' && moved.line === 'Social' && !moved.old, `the line follows the event to its Google id: ${JSON.stringify(moved)}`);

  // Delete a single event.
  const dent = await p.evaluate(() => DB.store.cachedEvents('me@gmail.com', 'me@gmail.com').find((x) => x.title === 'Dentist'));
  await p.evaluate((k) => { DB.app.ui.tab = 'board'; DB.app.render(); }, null);
  await p.clock.runFor(200);
  await p.evaluate(() => document.querySelectorAll('.board .row').forEach((r) => { if (r.textContent.includes('DENTIST')) r.click(); }));
  await p.clock.runFor(300);
  await p.click('dialog button:has-text("Delete")'); await p.click('dialog button:has-text("Tap again")');
  await p.clock.runFor(500);
  const del = await p.evaluate(() => ({ deleted: window.__phone.deleted, still: !!DB.store.cachedEvents('me@gmail.com', 'me@gmail.com').find((x) => x.title === 'Dentist') }));
  assert(del.deleted.includes(String(dent.phoneId)) && !del.still, `Delete removes it from the phone: ${JSON.stringify(del)}`);

  await ctx.close();

  // The browser version: Send to Android app carries the lines and the whole setup.
  const bctx = await b.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile' });
  const bp = await bctx.newPage();
  bp.on('pageerror', (e) => errors.push(e.message));
  await bp.goto(APP);
  await bp.evaluate((s) => { localStorage.clear(); localStorage.setItem('dayboard.v1', JSON.stringify(s)); }, browserState);
  await bp.reload(); await bp.waitForTimeout(400);
  const url = await bp.evaluate(() => DB.app.widgetLink());
  const dec = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const m = url && url.match(/^intent:\/\/lines\?d=([\w-]+)&s=([\w-]+)#Intent;scheme=dayboard;package=com\.braachgs\.dayboard;end$/);
  const carried = m && JSON.parse(dec(m[2]));
  assert(m && /^DB1\n/.test(dec(m[1])) && carried.lines.length === 3 && carried.overrides['g|me@gmail.com|me@gmail.com|gym9_20261022T170000Z'] === 's1' && carried.settings.clientId === '',
    'Send to Android app carries the widget lines and the whole setup (no client ID or tokens)');
  await bctx.close();

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  if (errors.length) process.exitCode = 1;
  await b.close();
})();
