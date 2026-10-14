const { chromium } = require('./pw');
const { MORNING, pinMorning } = require('./clock');
const OUT = process.argv[2];
const APP = 'http://127.0.0.1:8765/dayboard/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await pinMorning(p);
  const errors = [];
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('dialog', d => d.accept());

  // Fake Google Identity Services: each sign-in hands out the next account's token.
  await p.addInitScript(() => {
    window.__tokenRequests = [];
    let n = 0;
    window.google = { accounts: { oauth2: {
      initTokenClient(cfg) {
        return { requestAccessToken() {
          window.__tokenRequests.push({ prompt: cfg.prompt, login_hint: cfg.login_hint, scope: cfg.scope, client_id: cfg.client_id });
          const who = cfg.login_hint || (n++ % 2 === 0 ? 'work@company.com' : 'me@gmail.com');
          setTimeout(() => cfg.callback({ access_token: 'tok:' + who, expires_in: 3599, scope: cfg.scope }), 10);
        } };
      },
      hasGrantedAllScopes: () => true,
    } } };
  });

  // Fake Calendar API.
  const now = MORNING;
  const iso = (m) => new Date(Math.floor(now / 60000) * 60000 + m * 60000).toISOString();
  const today = new Date(MORNING); const pad = (x) => String(x).padStart(2, '0');
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const db = {
    'work@company.com|work@company.com': [
      { id: 'w1', summary: 'Sprint planning', location: 'Room 12', start: { dateTime: iso(-15) }, end: { dateTime: iso(30) }, htmlLink: 'https://calendar.google.com/x', hangoutLink: 'https://meet.google.com/abc-defg-hij', status: 'confirmed' },
      { id: 'w2', summary: 'Design crit', start: { dateTime: iso(70) }, end: { dateTime: iso(100) }, status: 'confirmed' },
      { id: 'w3', summary: 'Declined sync', start: { dateTime: iso(80) }, end: { dateTime: iso(90) }, attendees: [{ self: true, responseStatus: 'declined' }], status: 'confirmed' },
      { id: 'w4', summary: 'Office', start: { date: todayKey }, end: { date: todayKey }, eventType: 'workingLocation', status: 'confirmed' },
    ],
    'work@company.com|team@group.calendar.google.com': [
      { id: 't1', summary: 'Team offsite planning', start: { date: todayKey }, end: { date: todayKey }, status: 'confirmed' },
    ],
    'me@gmail.com|me@gmail.com': [
      { id: 'p1', summary: 'Pick up kids', location: 'Lincoln Elementary', start: { dateTime: iso(150) }, end: { dateTime: iso(180) }, status: 'confirmed' },
      { id: 'p2', summary: '<b>Gym</b>', description: '<p>Leg day<br>bring <i>water</i></p>', start: { dateTime: iso(240) }, end: { dateTime: iso(300) }, status: 'confirmed' },
    ],
    'me@gmail.com|family@group.calendar.google.com': [
      { id: 'f1', summary: 'Family dinner', start: { dateTime: iso(320) }, end: { dateTime: iso(400) }, status: 'confirmed' },
    ],
  };
  const calendars = {
    'work@company.com': [
      { id: 'work@company.com', summary: 'work@company.com', primary: true, accessRole: 'owner', backgroundColor: '#4285f4', selected: true },
      { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader', backgroundColor: '#0b8043', selected: true },
    ],
    'me@gmail.com': [
      { id: 'me@gmail.com', summary: 'me@gmail.com', primary: true, accessRole: 'owner', backgroundColor: '#e67c73', selected: true },
      { id: 'family@group.calendar.google.com', summary: 'Family', accessRole: 'writer', backgroundColor: '#f6bf26', selected: true },
    ],
  };
  const calls = [];
  let expired = new Set();
  await p.route('https://www.googleapis.com/calendar/v3/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const who = (req.headers()['authorization'] || '').replace('Bearer tok:', '');
    calls.push(`${req.method()} ${u.pathname} as ${who}`);
    if (expired.has(who)) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Invalid Credentials' } }) });
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: calendars[who] });
    const m = u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (m) {
      const calId = decodeURIComponent(m[1]); const evId = m[2] && decodeURIComponent(m[2]);
      const key = `${who}|${calId}`;
      db[key] = db[key] || [];
      if (req.method() === 'GET') return json({ items: db[key] });
      if (req.method() === 'POST') { const body = req.postDataJSON(); const ev = { id: 'new' + db[key].length, status: 'confirmed', htmlLink: 'https://calendar.google.com/new', ...body }; db[key].push(ev); return json(ev); }
      if (req.method() === 'PATCH') { const body = req.postDataJSON(); const ev = db[key].find(e => e.id === evId); Object.assign(ev, body, { extendedProperties: { private: { ...((ev.extendedProperties||{}).private||{}), ...((body.extendedProperties||{}).private||{}) } } }); return json(ev); }
      if (req.method() === 'DELETE') { db[key] = db[key].filter(e => e.id !== evId); return route.fulfill({ status: 204 }); }
    }
    return json({ error: { message: 'unexpected ' + u.pathname } }, 404);
  });

  await p.goto(APP);
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: 'nyc', settings: { clientId: 'test-client.apps.googleusercontent.com' } })); });
  await p.reload(); await p.waitForTimeout(400);

  // Connect two accounts.
  await p.click('.icon-btn[aria-label="Settings"]');
  await p.click('text=Add Google account'); await p.waitForTimeout(500);
  await p.click('text=Add account'); await p.waitForTimeout(700);
  const st = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard.v1')));
  assert(st.accounts.length === 2, 'two accounts connected');
  const lineName = (id) => st.lines.find(l => l.id === id).name;
  assert(lineName(st.accounts[0].defaultLine) === 'Work', 'work account defaults to the Work line');
  assert(lineName(st.accounts[1].defaultLine) === 'Personal', 'personal account defaults to the Personal line');
  const tr = await p.evaluate(() => window.__tokenRequests);
  assert(tr[0].prompt === 'select_account' && tr[0].client_id === 'test-client.apps.googleusercontent.com', 'sign-in uses account chooser and configured client id');
  assert(/calendar\.readonly/.test(tr[0].scope) && /calendar\.events/.test(tr[0].scope), 'requests read + events scopes');
  await p.screenshot({ path: `${OUT}/g1-settings-accounts.png` });
  // Route the Family calendar to the Social line.
  const social = st.lines.find(l => l.name === 'Social').id;
  await p.selectOption('select[aria-label="Line for Family"]', social);
  await p.click('.sheet-head .icon-btn');
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/g2-board.png` });

  const rows = await p.$$eval('.row', rs => rs.map(r => ({ t: r.querySelector('.row-title').textContent, b: r.querySelector('.badge').getAttribute('aria-label') })));
  console.log(JSON.stringify(rows));
  const find = (t) => rows.find(r => r.t === t);
  assert(find('Sprint planning') && /Work/.test(find('Sprint planning').b), 'work event on Work line');
  assert(find('Pick up kids') && /Personal/.test(find('Pick up kids').b), 'personal event on Personal line');
  assert(find('Family dinner') && /Social/.test(find('Family dinner').b), 'Family calendar routed to Social line');
  assert(!find('Declined sync'), 'declined event hidden');
  assert(find('<b>Gym</b>'), 'HTML in titles rendered as text (not markup)');
  const pill = await p.textContent('.pill');
  assert(/1 all-day/i.test(pill), 'working-location hidden, team all-day shown: ' + pill);
  assert(!(await p.$('.banner')), 'no sample banner once accounts are connected');

  // Detail sheet: Meet link + notes stripped of HTML.
  await p.click('.row:has-text("Sprint planning")');
  const join = await p.getAttribute('a:has-text("Join video call")', 'href');
  assert(join === 'https://meet.google.com/abc-defg-hij', 'Join video call uses Meet link');
  await p.screenshot({ path: `${OUT}/g3-detail.png` });
  // Move it to the Focus line -> local override + PATCH extendedProperties.
  await p.click('.line-choice:has-text("Focus")'); await p.waitForTimeout(300);
  assert(calls.some(c => c.startsWith('PATCH') && c.includes('/events/w1')), 'line change saved to Google (PATCH)');
  await p.click('.sheet-head .icon-btn');
  await p.click('.row:has-text("Gym")');
  const notes = await p.textContent('.notes');
  assert(notes.includes('Leg day') && !notes.includes('<'), 'HTML description converted to plain text: ' + JSON.stringify(notes));
  await p.click('.sheet-head .icon-btn');

  // Create an event in the personal Family calendar.
  await p.click('.tab-btn[data-tab="add"]');
  const opts = await p.$$eval('#f-dest option', os => os.map(o => o.textContent));
  assert(opts.includes('Family · me@gmail.com') && !opts.some(o => o.startsWith('Team')), 'save-to lists writable calendars only: ' + opts.join(' | '));
  await p.fill('#f-title', 'Dentist');
  await p.selectOption('#f-dest', 'g|me@gmail.com|family@group.calendar.google.com');
  const autoLine = await p.$eval('#f-line', s => s.options[s.selectedIndex].textContent);
  assert(/Social/.test(autoLine), 'line follows destination calendar: ' + autoLine);
  await p.screenshot({ path: `${OUT}/g4-add.png` });
  await p.click('button:has-text("Add to board")'); await p.waitForTimeout(500);
  const post = db['me@gmail.com|family@group.calendar.google.com'].find(e => e.summary === 'Dentist');
  assert(post && post.extendedProperties.private.dayboardLineName === 'Social' && post.start.timeZone, 'POST body has line + timezone');
  assert(await p.$('.row:has-text("Dentist")'), 'new Google event shows on the board');

  // Expire the work token -> reconnect banner -> reconnect with login hint.
  expired.add('work@company.com');
  await p.evaluate(() => { const t = JSON.parse(localStorage.getItem('dayboard.v1.tokens')); t['work@company.com'].exp = Date.now() - 1000; localStorage.setItem('dayboard.v1.tokens', JSON.stringify(t)); });
  await p.reload(); await p.waitForTimeout(500);
  const banner = await p.textContent('.banner.warn');
  assert(/Reconnect work@company.com/.test(banner), 'reconnect banner shown: ' + banner);
  assert(await p.$('.row:has-text("Sprint planning")'), 'cached work events still shown while expired');
  await p.screenshot({ path: `${OUT}/g5-reconnect.png` });
  expired.delete('work@company.com');
  await p.click('.banner.warn'); await p.waitForTimeout(600);
  const last = (await p.evaluate(() => window.__tokenRequests)).pop();
  assert(last.login_hint === 'work@company.com' && last.prompt === '', 'reconnect uses login_hint, no account chooser');
  assert(!(await p.$('.banner.warn')), 'banner cleared after reconnect');

  // Delete the Dentist event.
  await p.click('.row:has-text("Dentist")');
  await p.click('.detail-actions button:has-text("Delete")'); await p.click('.armed'); await p.waitForTimeout(400);
  assert(!db['me@gmail.com|family@group.calendar.google.com'].some(e => e.summary === 'Dentist'), 'DELETE reached Google');
  assert(!(await p.$('.row:has-text("Dentist")')), 'deleted event gone from board');

  // London rendering of the same data.
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('dayboard.v1')); s.system = 'london'; localStorage.setItem('dayboard.v1', JSON.stringify(s)); });
  await p.reload(); await p.waitForTimeout(500);
  await p.screenshot({ path: `${OUT}/g6-london-board.png` });

  console.log('API calls:', calls.length);
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  await b.close();
})();
