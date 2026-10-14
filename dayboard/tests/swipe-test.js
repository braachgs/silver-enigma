// Day swipes, driven through Chrome's real touch pipeline (CDP), so
// touch-action, scrolling and tap-vs-drag behave as they do on a phone.
const { chromium } = require('./pw');
const APP = 'http://127.0.0.1:8765/dayboard/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const now = Date.now(), M = 60000;
  const events = (n) => Array.from({ length: n }, (_, i) => ({
    id: 'e' + i, title: 'Event ' + i, start: now + (30 + i * 45) * M, end: now + (60 + i * 45) * M, allDay: false,
  }));

  async function open(system, { n = 1, reduced = false, w = 390, hgt = 844 } = {}) {
    const ctx = await b.newContext({ viewport: { width: w, height: hgt }, hasTouch: true, isMobile: true, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.goto(APP);
    await p.evaluate((s) => { localStorage.clear(); localStorage.setItem('dayboard.v1', JSON.stringify(s)); },
      { version: 1, system, settings: { sample: false }, localEvents: events(n) });
    await p.reload();
    await p.waitForTimeout(400);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    async function swipe(x0, y0, x1, y1, { ms = 220, steps = 12, end = true } = {}) {
      await touch('touchStart', x0, y0);
      for (let i = 1; i <= steps; i++) {
        await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
        await p.waitForTimeout(ms / steps);
      }
      if (end) { await touch('touchEnd'); await p.waitForTimeout(500); }
    }
    const date = () => p.evaluate(() => DB.app.ui.date);
    return { ctx, p, swipe, touch, date };
  }
  const plus = (k, n) => { const [y, m, d] = k.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

  // NYC board
  let t = await open('nyc');
  const today = await t.date();
  await t.swipe(320, 760, 70, 760); // empty space below a one-event board
  assert(await t.date() === plus(today, 1), 'swipe left on empty space -> next day');
  const head = await t.p.$eval('.date-text', (e) => e.textContent);
  await t.swipe(70, 300, 320, 300);
  assert(await t.date() === today, 'swipe right -> previous day');
  assert(head !== await t.p.$eval('.date-text', (e) => e.textContent), 'header date follows the swipe');
  const row = await t.p.$eval('.board .row', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await t.swipe(row.x + 120, row.y, row.x - 130, row.y);
  assert(await t.date() === plus(today, 1), 'swipe starting on an event row changes day');
  assert(!(await t.p.evaluate(() => document.getElementById('sheet').open)), '...and does not open that event');
  await t.swipe(70, 500, 320, 500);
  // mid-drag: the day follows the finger
  await t.swipe(300, 600, 200, 600, { end: false });
  const mid = await t.p.$eval('.board.swipe-pane', (e) => e.style.transform);
  assert(/translateX\(-\d/.test(mid), 'board follows the finger mid-drag: ' + mid);
  await t.p.screenshot({ path: process.argv[2] + '/swipe-mid-nyc.png' });
  await t.touch('touchEnd'); await t.p.waitForTimeout(500);
  assert(await t.date() === plus(today, 1), '100px drag commits');
  await t.swipe(70, 500, 320, 500);
  // short, slow drag springs back
  await t.swipe(250, 600, 215, 600, { ms: 500 });
  assert(await t.date() === today, 'short slow drag springs back');
  assert(await t.p.$eval('.board.swipe-pane', (e) => e.style.transform === '' && e.style.opacity === ''), 'panes reset after spring-back');
  // quick flick
  await t.swipe(250, 600, 195, 600, { ms: 40, steps: 4 });
  assert(await t.date() === plus(today, 1), 'quick 55px flick changes day');
  await t.swipe(70, 500, 320, 500);
  // vertical and edge swipes do nothing
  await t.swipe(200, 700, 220, 300);
  assert(await t.date() === today, 'vertical swipe leaves the day alone');
  await t.swipe(8, 500, 260, 500);
  assert(await t.date() === today, 'swipe from the screen edge is left to Android back');
  // tap still opens an event
  await t.p.touchscreen.tap(row.x, row.y); await t.p.waitForTimeout(300);
  assert(await t.p.evaluate(() => document.getElementById('sheet').open), 'a tap on a row still opens the event');
  await t.p.keyboard.press('Escape'); await t.p.waitForTimeout(200);
  // keyboard
  await t.p.keyboard.press('ArrowRight'); await t.p.waitForTimeout(300);
  assert(await t.date() === plus(today, 1), 'ArrowRight still moves a day');
  await t.p.keyboard.press('t'); await t.p.waitForTimeout(200);
  // Lines tab
  await t.p.click('.tab-btn[data-tab="lines"]'); await t.p.waitForTimeout(250);
  const linesDate = await t.p.$eval('.hdr-sub span', (e) => e.textContent);
  await t.swipe(320, 400, 70, 400);
  assert(await t.date() === plus(today, 1), 'swipe works on the Lines tab');
  assert(linesDate !== await t.p.$eval('.hdr-sub span', (e) => e.textContent), 'Lines header date updates');
  // Add tab ignores swipes
  await t.p.click('.tab-btn[data-tab="add"]'); await t.p.waitForTimeout(250);
  const before = await t.date();
  await t.swipe(320, 600, 70, 600);
  assert(await t.date() === before, 'Add tab ignores swipes');
  await t.ctx.close();

  // Long board still scrolls vertically (touch-action keeps pan-y)
  t = await open('london', { n: 14 });
  await t.swipe(200, 700, 205, 250, { ms: 300 });
  const sy = await t.p.evaluate(() => window.scrollY);
  assert(sy > 100, 'long board still scrolls vertically: scrollY ' + sy);
  await t.swipe(320, 500, 70, 500);
  assert(await t.date() === plus(await t.p.evaluate(() => DB.util.todayKey()), 1), 'swipe works after scrolling (London)');
  const hscroll = await t.p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(hscroll <= 0, 'no horizontal page scroll after swipes: ' + hscroll);
  await t.ctx.close();

  // Split-flap: the next day flips in rather than sliding
  t = await open('flap', { n: 3 });
  await t.swipe(320, 700, 70, 700);
  await t.swipe(70, 700, 320, 700, { end: false });
  await t.touch('touchEnd'); await t.p.waitForTimeout(120);
  const flips = await t.p.$$eval('.board .cell.flip', (e) => e.length);
  assert(flips > 20, `flap board flips in on swipe back (${flips} cells)`);
  await t.p.screenshot({ path: process.argv[2] + '/swipe-flap-flip.png' });
  await t.ctx.close();

  // Reduced motion: no follow or slide, but the swipe still works
  t = await open('nyc', { reduced: true });
  const d0 = await t.date();
  await t.swipe(320, 600, 70, 600, { end: false });
  assert(await t.p.$eval('.board.swipe-pane', (e) => e.style.transform === ''), 'reduced motion: board does not follow the finger');
  await t.touch('touchEnd'); await t.p.waitForTimeout(300);
  assert(await t.date() === plus(d0, 1), 'reduced motion: swipe still changes day');
  await t.ctx.close();

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  if (errors.length) process.exitCode = 1;
  await b.close();
})();
