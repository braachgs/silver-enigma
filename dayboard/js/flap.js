/* Day Board — split-flap rendering.
 *
 * Text becomes a row of flap cells. Each render remembers what every cell
 * showed; on the next render, cells whose character changed play a flip (the
 * old top half falls, the new bottom half drops in), staggered left to right
 * like a mechanical board. Memory is kept per namespace ("board", "display")
 * so each surface animates independently. Screen readers get the plain text. */
(function (DB) {
  'use strict';
  const { h } = DB.util;

  // Characters a flap drum can show; anything else renders as a blank flap.
  const ALLOWED = /[A-Z0-9 .,:;'&\-/()!?#+@%…]/;
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const prev = {}; // ns -> Map(cellKey -> char) from the last render
  const next = {}; // ns -> Map being filled by the current render
  const primed = new Set(); // namespaces that should flip in from blank flaps
  const flips = {}; // ns -> cells flipped since the last takeFlips(ns)

  function clean(str) {
    return String(str == null ? '' : str)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[‘’`]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ')
      .split('').map((c) => (ALLOWED.test(c) ? c : ' ')).join('');
  }

  // Word-wrap into at most `max` lines of `width` cells; overflow ends in "…".
  function wrap(str, width, max) {
    const words = clean(str).trim().split(' ').filter(Boolean);
    const lines = [];
    let cur = '';
    for (let w of words) {
      while (w.length > width) {
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!w) continue;
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (!lines.length) lines.push('');
    if (lines.length > max) {
      lines.length = max;
      const last = lines[max - 1];
      lines[max - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
    }
    return lines;
  }

  // False when flap cells would lose most of the text (non-Latin scripts,
  // emoji): callers then show the title as ordinary text instead.
  function legible(str) {
    const visible = String(str || '').replace(/\s+/g, '');
    if (!visible) return true;
    const kept = clean(str).replace(/[\s…]/g, '').length;
    return kept >= Math.ceil(visible.length / 2);
  }

  // One line that fits `width` cells, ending in "…" when cut.
  function fit(str, width) {
    const t = clean(str).trim();
    return t.length <= width ? t : `${t.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  }

  function begin(ns) {
    next[ns] = new Map();
  }
  function end(ns) {
    if (next[ns]) prev[ns] = next[ns];
    delete next[ns];
    primed.delete(ns);
  }
  // The next render of `ns` flips every cell in from blank (a board "booting").
  function prime(ns) {
    primed.add(ns);
    prev[ns] = new Map();
  }
  function takeFlips(ns) {
    const n = flips[ns] || 0;
    flips[ns] = 0;
    return n;
  }

  const glyph = (c) => (c === ' ' ? ' ' : c);

  function cell(ch, old, delay) {
    if (old === undefined || old === ch) {
      return h('span', { class: 'cell' }, h('span', { class: 'f' }, glyph(ch)));
    }
    return h('span', { class: 'cell flip', style: { '--d': `${delay}ms` } },
      h('span', { class: 'f t' }, glyph(ch)), // new top half, revealed as the flap falls
      h('span', { class: 'f b' }, glyph(old)), // old bottom half, covered as the new flap lands
      h('span', { class: 'f t fall' }, glyph(old)),
      h('span', { class: 'f b rise' }, glyph(ch)));
  }

  /* Render `str` into exactly `len` cells.
   * key: stable id for this run of cells within the namespace (e.g. event key + field)
   * opts.align: 'left' (default) or 'right'; opts.cls: extra class; opts.delay: base stagger in ms
   * opts.label: text for screen readers (defaults to str; '' reads nothing) */
  function text(str, len, key, ns, opts = {}) {
    const raw = clean(str).slice(0, len);
    const t = opts.align === 'right' ? raw.padStart(len, ' ') : raw.padEnd(len, ' ');
    const mem = prev[ns] || new Map();
    const out = next[ns];
    const animate = !reduceMotion();
    const boot = primed.has(ns);
    const base = opts.delay || 0;
    const cells = [];
    for (let i = 0; i < len; i++) {
      const k = `${key}#${i}`;
      const ch = t[i];
      let old = mem.has(k) ? mem.get(k) : (boot ? ' ' : undefined);
      if (!animate) old = undefined;
      if (out) out.set(k, ch);
      if (old !== undefined && old !== ch) flips[ns] = (flips[ns] || 0) + 1;
      cells.push(cell(ch, old, base + i * 26));
    }
    const label = String(opts.label !== undefined ? opts.label : (str == null ? '' : str)).trim();
    return h('span', { class: `flapline${opts.cls ? ` ${opts.cls}` : ''}` },
      label ? h('span', { class: 'sr-only' }, label) : null,
      h('span', { class: 'flaps', 'aria-hidden': 'true' }, cells));
  }

  DB.flap = { clean, legible, wrap, fit, text, begin, end, prime, takeFlips };
})(window.DB);
