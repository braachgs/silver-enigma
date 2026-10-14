const { chromium } = require('./pw');
const APP = 'http://127.0.0.1:8765/dayboard/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const page = async (w, h) => { const p = await b.newPage({ viewport: { width: w, height: h } }); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); return p; };
  const now = Date.now(), M = 60000;
  const state = (system) => ({ version: 1, system, settings: { sample: false }, localEvents: [
    { id: 'a', title: 'Встреча с командой', start: now + 30 * M, end: now + 60 * M, allDay: false },
    { id: 'b', title: '🎂🎉', start: now + 90 * M, end: now + 120 * M, allDay: false },
    { id: 'c', title: 'Quarterly business review with the regional leadership team and finance', start: now + 150 * M, end: now + 210 * M, allDay: false },
  ] });
  // 1+2: non-Latin titles readable; screen-reader name carries the full title
  let p = await page(390, 844);
  await p.goto(APP); await p.evaluate((s) => { localStorage.clear(); localStorage.setItem('dayboard.v1', JSON.stringify(s)); }, state('flap')); await p.reload(); await p.waitForTimeout(400);
  const rows = await p.$$eval('.flaprow', (rs) => rs.map((r) => ({ plain: (r.querySelector('.fr-plain') || {}).textContent || null, sr: [...r.querySelectorAll('.sr-only')].map((x) => x.textContent) })));
  assert(rows[0].plain === 'Встреча с командой' && rows[1].plain === '🎂🎉', 'non-Latin and emoji titles shown as text: ' + JSON.stringify(rows.slice(0, 2).map(r => r.plain)));
  assert(rows[2].sr.includes('Quarterly business review with the regional leadership team and finance'), 'screen readers get the full title');
  assert(rows[2].sr.filter((t) => /QUARTERLY|…/.test(t)).length === 0, 'no cut-down uppercase title announced');
  // display shows non-Latin title as text
  await p.click('.icon-btn[aria-label="Platform display"]'); await p.waitForTimeout(300);
  assert(await p.$eval('.fd-plain', (e) => e.textContent) === 'Встреча с командой', 'display shows non-Latin title as text');
  await p.keyboard.press('Escape');
  // 3: line editor preview fits at 320 / 360 / 390 in every style, incl. Hammersmith & City
  for (const sys of ['nyc', 'london', 'flap']) {
    for (const w of [320, 360, 390]) {
      const q = await page(w, 800);
      await q.goto(APP); await q.evaluate((s) => { localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: s })); }, sys); await q.reload(); await q.waitForTimeout(250);
      await q.click('.tab-btn[data-tab="lines"]'); await q.click('button:has-text("Add line")'); await q.waitForTimeout(200);
      const o = await q.$eval('#sheet', (d) => d.scrollWidth - d.clientWidth);
      if (o > 0) assert(false, `line editor overflows ${o}px (${sys} @ ${w})`);
      await q.close();
    }
  }
  assert(true, 'line editor preview fits at 320/360/390 in all three styles');
  // 4: roundel visible in settings card
  const r = await page(390, 844);
  await r.goto(APP); await r.evaluate(() => localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: 'nyc' }))); await r.reload(); await r.waitForTimeout(250);
  await r.click('.icon-btn[aria-label="Settings"]'); await r.waitForTimeout(200);
  const rw = await r.$eval('.sys-preview.sys-london svg.roundel', (e) => e.getBoundingClientRect().width);
  assert(rw >= 25, 'London roundel keeps its width in settings: ' + rw);
  // 6: boot flip happens after the sheet closes
  await r.click('.sys-card:has-text("Split-Flap")'); await r.waitForTimeout(200);
  await r.click('.sheet-head .icon-btn'); await r.waitForTimeout(150);
  const flips = await r.$$eval('.board .cell.flip', (e) => e.length);
  assert(flips > 20, `board flips in after Settings closes (${flips} cells)`);
  // 8: landscape phone display fits vertically
  const l = await page(844, 390);
  await l.goto(APP); await l.evaluate(() => localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: 'flap' }))); await l.reload(); await l.waitForTimeout(250);
  await l.click('.icon-btn[aria-label="Platform display"]'); await l.waitForTimeout(300);
  const fit = await l.evaluate(() => { const p = document.querySelector('.disp-flap').getBoundingClientRect(); return { top: Math.round(p.top), bottom: Math.round(p.bottom), h: innerHeight, slots: document.querySelectorAll('.fd-row').length }; });
  assert(fit.top >= 0 && fit.bottom <= fit.h, 'landscape display fits: ' + JSON.stringify(fit));
  await l.screenshot({ path: process.argv[2] + '/flap-landscape.png' });
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  await b.close();
})();
