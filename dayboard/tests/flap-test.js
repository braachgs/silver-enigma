const { chromium } = require('./pw');
const OUT = process.argv[2];
const APP = 'http://127.0.0.1:8765/dayboard/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('dialog', d => d.accept());
  // Existing NYC user with a saved line that predates the flap style (no `flap` key).
  await p.goto(APP);
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: 'nyc',
      lines: [{ id: 'l1', name: 'Kids', nyc: { letter: 'G', color: 'lime' }, london: { line: 'district' } },
              { id: 'l2', name: 'Work', nyc: { letter: 'A', color: 'blue' }, london: { line: 'victoria' } }] }));
  });
  await p.reload(); await p.waitForTimeout(300);
  // Switch to split-flap in Settings
  await p.click('.icon-btn[aria-label="Settings"]');
  assert((await p.$$('.sys-card')).length === 3, 'three board styles offered');
  await p.click('.sys-card:has-text("Split-Flap")');
  await p.click('.sheet-head .icon-btn'); await p.waitForTimeout(300);
  assert(await p.getAttribute('html', 'data-system') === 'flap', 'switched to split-flap');
  const flipped = await p.$$eval('.board .cell.flip', (els) => els.length);
  assert(flipped > 20, `board flips in from blank after switching (${flipped} cells flipping)`);
  const tiles = await p.$$eval('.hdr-lines .ftile .mark', (els) => els.map((e) => e.textContent));
  assert(tiles.includes('KDS') && tiles.includes('WRK'), 'legacy lines get derived codes: ' + tiles.join(','));
  const kidsColor = await p.$eval('.hdr-lines .ftile', (e) => getComputedStyle(e).backgroundColor);
  console.log('  Kids tile colour (from NYC lime -> green):', kidsColor);
  // Row structure
  const first = await p.$('.flaprow');
  assert(first, 'board renders flap rows');
  const timeText = await p.$eval('.flaprow .fl-time .sr-only', (e) => e.textContent);
  assert(/^\s*\d{1,2}:\d{2}[AP]$/.test(timeText), 'board time like 10:30A: ' + JSON.stringify(timeText));
  const remarks = await p.$$eval('.flaprow .fl-remark .sr-only', (els) => els.map((e) => e.textContent));
  assert(remarks[0] === 'NOW' && remarks[1] === 'NOW' && remarks.slice(2).every((r) => r === 'ON TIME'), 'remarks (live first, next is 18 min out): ' + remarks.join(' | '));
  const overflow = await p.evaluate(() => [...document.querySelectorAll('.flaprow')].some((r) => r.scrollWidth > r.clientWidth + 1));
  assert(!overflow, 'no flap row overflows at 390px');
  // Custom code + colour in the line editor
  await p.click('.tab-btn[data-tab="lines"]');
  await p.click('.line-row:has-text("Kids")');
  await p.fill('#l-code', 'kid!x');
  assert(await p.inputValue('#l-code') === 'KID', 'code input uppercases and strips to 3 chars');
  await p.click('[data-fcolor="purple"]');
  await p.click('button:has-text("Save line")'); await p.waitForTimeout(200);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard.v1')).lines.find((l) => l.name === 'Kids').flap);
  assert(saved.code === 'KID' && saved.color === 'purple', 'flap style saved: ' + JSON.stringify(saved));
  // Clearing the code falls back to the name
  await p.click('.line-row:has-text("Kids")');
  await p.fill('#l-code', '');
  await p.click('button:has-text("Save line")'); await p.waitForTimeout(200);
  const cleared = await p.evaluate(() => JSON.parse(localStorage.getItem('dayboard.v1')).lines.find((l) => l.name === 'Kids').flap);
  assert(!('code' in cleared), 'blank code removed so name-derived code returns');
  // Other day shows times with remarks, no live rows
  await p.click('.tab-btn[data-tab="board"]');
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(150);
  // Display opens and fits on phone
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150);
  await p.click('.icon-btn[aria-label="Platform display"]'); await p.waitForTimeout(400);
  const disp = await p.evaluate(() => ({ rows: document.querySelectorAll('.fd-row').length, overflow: document.querySelector('.disp-flap').scrollWidth - document.querySelector('.disp-flap').clientWidth }));
  assert(disp.rows === 7 && disp.overflow <= 0, 'phone display: 7 slots, no overflow ' + JSON.stringify(disp));
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  assert(await p.$eval('#display', (e) => e.hidden), 'Escape closes display');
  // Reduced motion: no flips
  const rm = await b.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await rm.goto(APP); await rm.evaluate(() => { localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: 'flap' })); });
  await rm.reload(); await rm.waitForTimeout(300);
  await rm.click('.icon-btn[aria-label="Platform display"]'); await rm.waitForTimeout(200);
  assert(await rm.$$eval('#display .cell.flip', (e) => e.length) === 0, 'reduced motion: no flip animations');
  await rm.screenshot({ path: `${OUT}/flap-reduced.png` });
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  await b.close();
})();
