// Renders the app icon PNGs from icons/flap.svg (needs Playwright; run from
// anywhere: node dayboard/icons/render.js). "any" icons get rounded corners
// for desktop and other launchers; "maskable" ones are full-bleed squares
// that Android crops to its own shape; iOS rounds apple-touch-icon itself.
const fs = require('fs');
const path = require('path');
const { chromium } = require('../tests/pw');

const dir = __dirname;
const font = fs.readFileSync(path.join(dir, '../fonts/barlow-condensed-latin-600-normal.woff2')).toString('base64');
const svg = fs.readFileSync(path.join(dir, 'flap.svg'), 'utf8')
  .replace(/url\(\.\.\/fonts\/[^)]+\)/, `url(data:font/woff2;base64,${font})`);

const OUT = [
  ['app-192.png', 192, true],
  ['app-512.png', 512, true],
  ['app-maskable-192.png', 192, false],
  ['app-maskable-512.png', 512, false],
  ['apple-touch-icon.png', 180, false],
];

(async () => {
  const b = await chromium.launch();
  for (const [name, size, rounded] of OUT) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}
      #i{width:${size}px;height:${size}px;overflow:hidden;border-radius:${rounded ? '22%' : '0'}}
      #i svg{display:block;width:100%;height:100%}</style><div id="i">${svg}</div>`);
    await p.evaluate(() => document.fonts.ready);
    await p.locator('#i').screenshot({ path: path.join(dir, name), omitBackground: true });
    await p.close();
    console.log('wrote', name);
  }
  await b.close();
})();
