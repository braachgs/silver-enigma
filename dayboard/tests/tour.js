const { chromium } = require('./pw');
const { pinMorning } = require('./clock');
const OUT = process.argv[2];
const URL = 'http://127.0.0.1:8765/dayboard/';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await pinMorning(p);
  const errors = [];
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const shot = async (name, full = false) => { await p.waitForTimeout(350); await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: full }); };

  for (const sysId of ['nyc', 'london', 'flap']) {
    await p.goto(URL);
    await p.evaluate((s) => { localStorage.clear(); localStorage.setItem('dayboard.v1', JSON.stringify({ version: 1, system: s })); }, sysId);
    await p.goto(URL); await p.waitForTimeout(600);
    await shot(`${sysId}-1-board`);
    await shot(`${sysId}-1b-board-full`, true);
    // all-day pill
    await p.click('.pill'); await shot(`${sysId}-2-allday`);
    await p.click('.pill');
    // date picker
    await p.click('.date-btn'); await shot(`${sysId}-3-picker`);
    await p.click('.date-btn');
    // detail sheet of first row
    await p.click('.row >> nth=0'); await shot(`${sysId}-4-detail`);
    await p.click('.sheet-head .icon-btn');
    // lines
    await p.click('.tab-btn[data-tab="lines"]'); await shot(`${sysId}-5-lines`); await shot(`${sysId}-5b-lines-full`, true);
    // line editor
    await p.click('.line-row >> nth=0'); await shot(`${sysId}-6-line-editor`);
    await p.click('.sheet-head .icon-btn');
    // add
    await p.click('.tab-btn[data-tab="add"]'); await shot(`${sysId}-7-add`);
    // settings
    await p.click('.tab-btn[data-tab="board"]');
    await p.click('.hdr-actions .icon-btn[aria-label="Settings"]'); await shot(`${sysId}-8-settings`);
    await p.evaluate(() => { const d = document.getElementById('sheet'); d.scrollTop = 99999; }); await shot(`${sysId}-8b-settings-bottom`);
    await p.click('.sheet-head .icon-btn');
    // display (landscape-ish view too)
    await p.click('.icon-btn[aria-label="Platform display"]'); await p.waitForTimeout(800); await shot(`${sysId}-9-display`);
    await p.mouse.click(10, 10);
  }
  console.log(errors.length ? errors.join('\n') : 'NO CONSOLE ERRORS');
  await b.close();
})();
