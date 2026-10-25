// Renders each widget's icon.png (256px) and preview.png (128x56) from its SVG on the board colours.
const { chromium } = require('../../dayboard/tests/pw');
const fs = require('fs');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  for (const w of ['matchboard', 'dayboard']) {
    const svg = fs.readFileSync(path.join(__dirname, `../${w}/resources/${w}.svg`), 'utf8');
    const p = await b.newPage({ viewport: { width: 256, height: 256 } });
    // Colour the white picker icon amber on the dark board for the larger images.
    const amber = svg.replace(/#fff/g, '#F2B705');
    await p.setContent(`<body style="margin:0;background:#161616"><div style="width:256px;height:256px;display:grid;place-items:center">${amber.replace('<svg ', '<svg width="200" height="200" ')}</div></body>`);
    await p.screenshot({ path: path.join(__dirname, `../${w}/resources/icon.png`) });
    await p.setViewportSize({ width: 128, height: 56 });
    await p.setContent(`<body style="margin:0;background:#161616"><div style="width:128px;height:56px;display:grid;place-items:center">${amber.replace('<svg ', '<svg width="52" height="52" ')}</div></body>`);
    await p.screenshot({ path: path.join(__dirname, `../${w}/resources/preview.png`) });
    await p.close();
  }
  await b.close();
})();
