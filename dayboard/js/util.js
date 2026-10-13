/* Day Board — DOM and date helpers shared by every module.
 * Everything renders through h()/s(), which only ever create text nodes for
 * strings, so calendar data from Google can never be interpreted as HTML. */
window.DB = window.DB || {};

(function (DB) {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';

  function setAttrs(el, attrs) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) if (val != null) el.style.setProperty(p, val);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v);
      } else if ((k === 'value' || k === 'checked' || k === 'selected') && k in el) {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }

  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    setAttrs(el, attrs);
    append(el, kids);
    return el;
  }

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    setAttrs(el, attrs);
    append(el, kids);
    return el;
  }

  // A filled 8-tooth cog with a hole, generated so it stays crisp at any size.
  function gearPath() {
    const pt = (r, deg) => {
      const a = (deg - 90) * Math.PI / 180;
      return `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`;
    };
    let d = '';
    for (let i = 0; i < 8; i++) {
      const c = i * 45;
      d += `${i ? 'L' : 'M'}${pt(7.4, c - 17)}L${pt(10.4, c - 9)}L${pt(10.4, c + 9)}L${pt(7.4, c + 17)}`;
    }
    return d + 'ZM15.2 12a3.2 3.2 0 1 0-6.4 0 3.2 3.2 0 1 0 6.4 0Z';
  }

  // Small inline icon set on a 24px grid. Strings are stroked paths; arrays are
  // [tag, attrs] parts for icons that need circles or fills.
  const ICONS = {
    gear: [['path', { d: gearPath(), fill: 'currentColor', stroke: 'none', 'fill-rule': 'evenodd' }]],
    chevron: 'm7 10 5 5 5-5',
    left: 'm15 6-6 6 6 6',
    right: 'm9 6 6 6-6 6',
    close: 'M6 6l12 12M18 6 6 18',
    plus: 'M12 5v14M5 12h14',
    reset: 'M5.5 12a6.5 6.5 0 1 0 1.9-4.6M5 4.5v4h4',
    board: [['path', { d: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', fill: 'currentColor', stroke: 'none' }]],
    lines: [
      ['path', { d: 'M6 6h12M6 6l6 12M18 6l-6 12' }],
      ['circle', { cx: 6, cy: 6, r: 2.4, fill: 'currentColor' }],
      ['circle', { cx: 18, cy: 6, r: 2.4, fill: 'currentColor' }],
      ['circle', { cx: 12, cy: 18, r: 2.4, fill: 'currentColor' }],
    ],
    display: 'M3 5h18v12H3zM8 21h8M12 17v4',
    more: [[ 'circle', { cx: 5, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 12, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }],
      ['circle', { cx: 19, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }]],
    sync: 'M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4',
    video: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
    link: 'M10 14 21 3M15 3h6v6M19 14v6H4V5h6',
    speaker: 'M4 9h4l5-4v14l-5-4H4zM17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12',
  };

  function icon(name, size = 20) {
    const def = ICONS[name];
    const parts = typeof def === 'string' ? [['path', { d: def }]] : def;
    return s('svg', {
      viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'icon',
      fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, parts.map(([tag, attrs]) => s(tag, attrs)));
  }

  // ---- Dates. Day keys are local "YYYY-MM-DD" strings; instants are epoch ms.
  const MIN = 60000;
  const pad = (n) => String(n).padStart(2, '0');

  function dateKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function parseKey(k) {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(k, n) {
    const d = parseKey(k);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }
  const dayStart = (k) => parseKey(k).getTime();
  const dayEnd = (k) => dayStart(addDays(k, 1)); // DST-safe: next local midnight
  const todayKey = () => dateKey(Date.now());

  function timeValue(t) {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromInputs(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm).getTime();
  }

  function uid() {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
  }

  function findUrl(text) {
    const m = /https?:\/\/[^\s<>"')]+/i.exec(text || '');
    return m ? m[0] : null;
  }

  // Google descriptions are HTML; reduce to plain text without executing anything.
  function plainText(html) {
    if (!html || !/[<&]/.test(html)) return html || '';
    const doc = new DOMParser().parseFromString(
      html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n'), 'text/html');
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  DB.util = { h, s, icon, MIN, pad, dateKey, parseKey, addDays, dayStart, dayEnd, todayKey, timeValue, fromInputs, uid, findUrl, plainText };
})(window.DB);
