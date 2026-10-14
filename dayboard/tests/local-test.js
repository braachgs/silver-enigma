const { chromium } = require('./pw');
const { MORNING, pinMorning } = require('./clock');
const OUT = process.argv[2];
const APP = 'http://127.0.0.1:8765/dayboard/';
const assert = (c, m) => { if (!c) { console.log('FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); };
(async () => {
  const b = await chromium.launch();
  const errors = [];
  // narrow phone
  for (const [w, h, name] of [[320, 640, 'narrow'], [1280, 800, 'desktop']]) {
    const p = await b.newPage({ viewport: { width: w, height: h } }); await pinMorning(p);
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(APP); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(400);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `${name}: no horizontal scroll (overflow ${overflow}px)`);
    await p.screenshot({ path: `${OUT}/${name}.png` });
    await p.close();
  }
  const p = await b.newPage({ viewport: { width: 390, height: 844 } }); await pinMorning(p);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('dialog', d => d.accept());
  await p.goto(APP); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(300);
  assert(await p.$('.banner'), 'sample banner on first run');
  // Empty title is rejected
  await p.click('.tab-btn[data-tab="add"]');
  await p.click('button:has-text("Add to board")');
  assert(await p.$('.add-view'), 'empty title keeps you on the form');
  // Add a local event 2 hours from now on the Health line
  const d = new Date(MORNING + 2 * 3600e3); const pad = n => String(n).padStart(2, '0');
  await p.fill('#f-title', 'Physio');
  await p.fill('#f-date', `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  await p.fill('#f-time', `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  await p.selectOption('#f-dur', '45');
  const health = await p.$eval('#f-line', s => [...s.options].find(o => /Health/.test(o.textContent)).value);
  await p.selectOption('#f-line', health);
  await p.click('summary'); await p.fill('#f-loc', 'https://zoom.us/j/123');
  await p.click('button:has-text("Add to board")'); await p.waitForTimeout(300);
  assert(!(await p.$('.banner')), 'sample day replaced by real events');
  const row = await p.$('.row:has-text("Physio")');
  assert(row, 'local event on the board');
  assert(/Health/.test(await p.getAttribute('.row:has-text("Physio") .badge', 'aria-label')), 'local event on chosen line');
  // Detail -> video link from location -> edit title
  await p.click('.row:has-text("Physio")');
  assert(await p.getAttribute('a:has-text("Join video call")', 'href') === 'https://zoom.us/j/123', 'Zoom link offered as video call');
  await p.click('.detail-actions button:has-text("Edit")');
  assert(await p.inputValue('#f-title') === 'Physio', 'edit form prefilled');
  await p.fill('#f-title', 'Physio (knee)');
  await p.click('button:has-text("Save changes")'); await p.waitForTimeout(300);
  assert(await p.$('.row:has-text("Physio (knee)")'), 'edit saved');
  // Persisted across reload, line editor rename, system switch
  await p.reload(); await p.waitForTimeout(300);
  assert(await p.$('.row:has-text("Physio (knee)")'), 'event persisted after reload');
  await p.click('.tab-btn[data-tab="lines"]');
  await p.click('.line-row:has-text("Health")');
  await p.fill('#l-name', 'Body');
  await p.click('.letter:has-text("G")');
  await p.click('button:has-text("Save line")'); await p.waitForTimeout(200);
  assert(await p.$('.line-row:has-text("Body")'), 'line renamed');
  const bullet = await p.textContent('.line-row:has-text("Body") .mark');
  assert(bullet === 'G', 'bullet letter changed to G');
  await p.click('.tab-btn[data-tab="board"]');
  await p.click('.icon-btn[aria-label="Settings"]');
  await p.click('.sys-card:has-text("London")'); await p.click('.sheet-head .icon-btn'); await p.waitForTimeout(200);
  assert(await p.getAttribute('html', 'data-system') === 'london', 'switched to London');
  const tab = await p.textContent('.row:has-text("Physio") .mark');
  assert(tab === 'DIS', 'same line shows its London identity (District): ' + tab);
  await p.screenshot({ path: `${OUT}/local-london.png` });
  // Delete
  await p.click('.row:has-text("Physio")');
  await p.click('.detail-actions button:has-text("Delete")'); await p.click('.armed'); await p.waitForTimeout(300);
  assert(!(await p.$('.row:has-text("Physio")')), 'local event deleted');
  // Day navigation via keyboard
  const before = await p.textContent('.date-text');
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(150);
  assert(await p.textContent('.date-text') !== before, 'arrow key moves to next day');
  assert(await p.$('.today-btn:has-text("Back to today")'), 'Back to today appears off-today');
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO CONSOLE ERRORS');
  await b.close();
})();
