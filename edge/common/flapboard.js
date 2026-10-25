/* Day Board / Match Board split-flap boards on a <canvas>: a line-for-line
 * port of the Android widgets' renderer (dayboard-android/core: Render.kt,
 * Flap.kt, match/MatchRender.kt), so the Xeneon Edge boards look like the
 * phone ones. Sizes are in "dp" scaled by `d` pixels per dp, as on Android.
 * Works in iCUE's Chromium and in Node (for tests, without a canvas).
 */
(function (root) {
  const Palette = {
    BACKGROUND: '#161616',
    RULE: '#F2B705',
    INK: '#F4F1E6',
    DIM: '#A39E8F',
    DIVIDER: '#262626',
    CELL_TOP: '#2A2A2A',
    CELL_BOTTOM: '#1B1B1B',
    LIVE_TOP: '#31904A',
    LIVE_BOTTOM: '#22683A',
    SPLIT: 'rgba(0,0,0,0.55)',
    TILE_SPLIT: 'rgba(0,0,0,0.35)',
    PIN_BG: '#222016',
    AMBER_DIM: '#6E5A1C',
    SCORE_INK: '#111111',
    SCORE_INK_DIM: '#2A2412',
    ink(tone) {
      return { ON_TIME: '#93DD73', BOARDING: '#FFC233', FINAL: '#FF7A45', LIVE: '#FFFFFF', INFO: '#D6D1C3', PAST: '#8A8578' }[tone] || '#F4F1E6';
    },
    /** Dark ink on light tile colours (yellow, white), white on the rest. */
    tileInk(hex) {
      const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16);
      const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
      return l > 0.45 ? '#111111' : '#FFFFFF';
    },
  };

  // ------------------------------------------------------------ flap text
  const ALLOWED = /[A-Z0-9 .,:;'&\-/()!?#+@%…]/;
  const Flap = {
    clean(s) {
      const t = String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .replace(/[‘’`]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ');
      let out = '';
      for (const c of t) out += ALLOWED.test(c) ? c : ' ';
      return out;
    },
    fit(s, width) {
      const t = Flap.clean(s).trim();
      return t.length <= width ? t : `${t.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
    },
    /** False when flaps would lose most of the text (non-Latin scripts, emoji). */
    legible(s) {
      const visible = String(s || '').replace(/\s+/g, '');
      if (!visible) return true;
      return Flap.clean(s).replace(/[\s…]/g, '').length >= Math.ceil(visible.length / 2);
    },
    /** Three-letter line code from a name, as js/systems.js flapCode: Work -> WRK, Family -> FML. */
    code(name) {
      const letters = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!letters) return 'LN';
      const picked = [0];
      for (let i = 1; i < letters.length && picked.length < 3; i++) if (!'AEIOU'.includes(letters[i])) picked.push(i);
      for (let i = 1; i < letters.length && picked.length < 3; i++) if (!picked.includes(i)) picked.push(i);
      return picked.sort((a, b) => a - b).map((i) => letters[i]).join('');
    },
  };

  function ellipsize(p, s, size, maxW, tracking = 0) {
    if (p.measure(s, size, tracking) <= maxW) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (p.measure(`${s.slice(0, mid).trimEnd()}…`, size, tracking) <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo === 0 ? '' : `${s.slice(0, lo).trimEnd()}…`;
  }

  function wrap(s, width) {
    if (width <= 0) return [];
    const out = [];
    let cur = '';
    for (let w of s.split(' ').filter(Boolean)) {
      while (w.length > width) { if (cur) { out.push(cur); cur = ''; } out.push(w.slice(0, width)); w = w.slice(width); }
      if (!w) continue;
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur = `${cur} ${w}`;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ------------------------------------------------------------- painter
  /** Draws on a 2D context in the flap typeface. Sizes in CSS pixels. */
  function CanvasPainter(ctx, family) {
    const font = (size) => `${size}px ${family}`;
    return {
      rect(x, y, w, h, color, radius = 0) {
        ctx.fillStyle = color;
        if (radius > 0 && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2)); ctx.fill(); }
        else ctx.fillRect(x, y, w, h);
      },
      text(s, x, baseline, size, color, align = 'left', tracking = 0) {
        ctx.font = font(size);
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.textBaseline = 'alphabetic';
        if ('letterSpacing' in ctx) {
          ctx.letterSpacing = `${tracking * size}px`;
          // Canvas adds the spacing after the last letter too: shift right- and centre-aligned text back.
          const fix = align === 'right' ? tracking * size : align === 'center' ? tracking * size / 2 : 0;
          ctx.fillText(s, x + fix, baseline);
          ctx.letterSpacing = '0px';
        } else {
          ctx.fillText(s, x, baseline);
        }
      },
      measure(s, size, tracking = 0) {
        ctx.font = font(size);
        return ctx.measureText(s).width + Math.max(0, s.length - 1) * tracking * size;
      },
      capHeight(size) {
        ctx.font = font(size);
        const m = ctx.measureText('H');
        return m.actualBoundingBoxAscent || size * 0.7;
      },
    };
  }

  // ------------------------------------------------------- shared pieces
  const ASPECT = 1.9; // flap height : width
  const TILE = 3.3; // Day Board line tile width, in flaps

  function frame(w, h, d) {
    const compact = h < 190 * d;
    const pad = (compact ? 8 : 10) * d;
    const headerH = (compact ? 20 : 24) * d;
    const ruleY = pad + headerH;
    const ruleH = 2 * d;
    const footerH = (compact ? 14 : 16) * d;
    return {
      w, h, d, compact, pad, headerH, ruleY, ruleH,
      radius: 12, // dp; iCUE draws its own slot corners around this
      gap: Math.max(1, d),
      sectionGap: 6 * d,
      contentW: w - 2 * pad,
      lineGap: 3 * d,
      rowGap: (compact ? 6 : 8) * d,
      rowsTop: ruleY + ruleH + (compact ? 5 : 7) * d,
      footerH,
      rowsBottom: h - pad - footerH,
    };
  }

  function cells(p, text, x, y, n, l, ink, { live = false, bold = false } = {}) {
    const d = l.d;
    const top = live ? Palette.LIVE_TOP : Palette.CELL_TOP;
    const bottom = live ? Palette.LIVE_BOTTOM : Palette.CELL_BOTTOM;
    const r = 1.5 * d;
    const baseline = y + l.ch / 2 + p.capHeight(l.fontSize) / 2;
    for (let i = 0; i < n; i++) {
      const cx = x + i * (l.cw + l.gap);
      p.rect(cx, y, l.cw, l.ch, top, r);
      p.rect(cx, y + l.ch / 2, l.cw, l.ch / 2, bottom, r);
      p.rect(cx, y + l.ch / 2, l.cw, r, bottom);
      const c = text[i];
      if (c != null && c !== ' ') {
        p.text(c, cx + l.cw / 2, baseline, l.fontSize, ink, 'center');
        if (bold) p.text(c, cx + l.cw / 2 + 0.55 * d, baseline, l.fontSize, ink, 'center');
      }
      p.rect(cx, y + l.ch / 2 - d * 0.3, l.cw, Math.max(1, d * 0.6), Palette.SPLIT);
    }
  }

  function header(p, l, title, label, clock) {
    const d = l.d;
    p.rect(0, 0, l.w, l.h, Palette.BACKGROUND, l.radius * d);
    const hs = 12 * d;
    const hb = l.pad + l.headerH / 2 + p.capHeight(hs) / 2;
    p.text(title, l.pad + 2 * d, hb, hs, Palette.DIM, 'left', 0.14);
    p.text(label, l.pad + 2 * d + p.measure(title, hs, 0.14) + 10 * d, hb, hs, Palette.INK, 'left', 0.1);
    if (clock) p.text(clock, l.w - l.pad - 2 * d, hb + d, 15 * d, Palette.RULE, 'right', 0.04);
    p.rect(0, l.ruleY, l.w, l.ruleH, Palette.RULE);
  }

  function message(p, msg, l) {
    const n = Math.floor((l.contentW + l.gap) / (l.cw + l.gap));
    const lines = wrap(Flap.clean(msg).trim(), n).slice(0, 2);
    const blockH = lines.length * l.ch + (lines.length - 1) * l.lineGap;
    const mid = (l.rowsTop + l.rowsBottom) / 2;
    lines.forEach((line, i) => {
      const w = line.length * (l.cw + l.gap) - l.gap;
      cells(p, line, (l.w - w) / 2, mid - blockH / 2 + i * (l.ch + l.lineGap), line.length, l, Palette.INK);
    });
  }

  function footer(p, l, left, right, leftInk) {
    const d = l.d;
    const size = 10.5 * d;
    const baseline = l.h - l.pad - (l.footerH - p.capHeight(size)) / 2;
    const rightW = right ? p.measure(right, size, 0.08) : 0;
    if (right) p.text(right, l.w - l.pad, baseline, size, Palette.DIM, 'right', 0.08);
    if (left) {
      const maxW = l.contentW - rightW - (right ? 12 * d : 0);
      p.text(ellipsize(p, left, size, maxW, 0.08), l.pad, baseline, size, leftInk || Palette.DIM, 'left', 0.08);
    }
  }

  function divider(p, l, y) {
    p.rect(l.pad, y - l.rowGap / 2 - l.d / 2, l.contentW, Math.max(1, l.d * 0.75), Palette.DIVIDER);
  }

  // ---------------------------------------------------------- Day Board
  /** dayboard.core.BoardLayout */
  function dayLayout(w, h, d, hour12) {
    const l = frame(w, h, d);
    l.timeCells = hour12 ? 6 : 5;
    l.remarkCells = 10;
    const rowCount = (c, lines, area) => Math.floor((area + l.rowGap) / (c * ASPECT * lines + (lines - 1) * l.lineGap + l.rowGap));
    const wide = 11 * d;
    const wideTitle = Math.floor((l.contentW - wide * TILE - 3 * l.sectionGap - (l.timeCells + l.remarkCells) * (wide + l.gap)) / (wide + l.gap));
    l.oneLine = wideTitle >= 14;
    let c = l.oneLine ? wide : Math.min(12 * d, Math.max(7 * d, (l.contentW - 2 * l.sectionGap - (l.timeCells + l.remarkCells) * l.gap) / (TILE + l.timeCells + l.remarkCells)));
    const lines = l.oneLine ? 1 : 2;
    const area = l.rowsBottom - l.rowsTop;
    if (rowCount(c, lines, area) < 2) {
      const c2 = (area - l.rowGap - 2 * (lines - 1) * l.lineGap) / (2 * lines) / ASPECT;
      if (c2 >= 8.5 * d) c = Math.min(c, c2);
    }
    l.cw = c;
    l.ch = c * ASPECT;
    l.tileW = c * TILE;
    l.titleCells = l.oneLine
      ? Math.floor((l.contentW - l.tileW - 3 * l.sectionGap - (l.timeCells + l.remarkCells) * (c + l.gap)) / (c + l.gap))
      : Math.floor((l.contentW - l.tileW - l.sectionGap + l.gap) / (c + l.gap));
    l.fontSize = l.ch * 0.82;
    l.rowH = l.oneLine ? l.ch : l.ch * 2 + l.lineGap;
    l.capacity = Math.max(1, Math.floor((l.rowsBottom - l.rowsTop + l.rowGap) / (l.rowH + l.rowGap)));
    l.timeX = l.pad + l.tileW + l.sectionGap;
    l.remarkX = l.w - l.pad - l.remarkCells * (c + l.gap) + l.gap;
    l.titleX = l.oneLine ? l.timeX + l.timeCells * (c + l.gap) + l.sectionGap : l.timeX;
    return l;
  }

  /**
   * model: { dayLabel, rows: [{ line: {code, color}, time, remark: {text, tone}, title, tomorrow }],
   *          message, footer, footerInk, more }
   */
  function drawDayBoard(p, model, l, clock) {
    const d = l.d;
    header(p, l, 'DEPARTURES', model.dayLabel, clock);
    if (!model.rows.length) message(p, model.message || 'NO DEPARTURES TODAY', l);
    model.rows.forEach((row, i) => {
      const y = l.rowsTop + i * (l.rowH + l.rowGap);
      if (i > 0) divider(p, l, y);
      p.rect(l.pad, y, l.tileW, l.ch, row.line.color, 2.5 * d);
      p.text(row.line.code.slice(0, 3).toUpperCase(), l.pad + l.tileW / 2, y + l.ch / 2 + p.capHeight(l.fontSize * 0.86) / 2,
        l.fontSize * 0.86, Palette.tileInk(row.line.color), 'center', 0.06);
      p.rect(l.pad, y + l.ch / 2 - d / 2, l.tileW, Math.max(1, d * 0.75), Palette.TILE_SPLIT);
      const timeInk = row.tomorrow ? Palette.ink('INFO') : Palette.INK;
      cells(p, row.time, l.timeX, y, l.timeCells, l, timeInk);
      cells(p, row.remark.text.padEnd(l.remarkCells), l.remarkX, y, l.remarkCells, l, Palette.ink(row.remark.tone), { live: row.remark.tone === 'LIVE' });
      const ty = l.oneLine ? y : y + l.ch + l.lineGap;
      const n = l.titleCells;
      if (Flap.legible(row.title)) {
        cells(p, Flap.fit(row.title, n), l.titleX, ty, n, l, row.tomorrow ? Palette.ink('INFO') : Palette.INK);
      } else {
        const size = l.fontSize;
        p.text(ellipsize(p, row.title, size, n * (l.cw + l.gap)), l.titleX, ty + l.ch / 2 + p.capHeight(size) / 2, size, Palette.INK);
      }
    });
    footer(p, l, model.footer, model.more > 0 ? `+${model.more} MORE TODAY` : '', model.footerInk);
  }

  // -------------------------------------------------------- Match Board
  const NAME_TARGET = 10;

  /** dayboard.match.MatchLayout */
  function matchLayout(w, h, d) {
    const l = frame(w, h, d);
    l.timeCells = 6;
    l.statusCells = 10;
    const names = (c, one) => {
      const scores = 2 * c * 1.5 + 2 * l.gap + 2 * l.sectionGap;
      const avail = one ? l.contentW - scores - 2 * l.sectionGap - (l.timeCells + l.statusCells) * (c + l.gap) : l.contentW - scores;
      return Math.floor((avail / 2 + l.gap) / (c + l.gap));
    };
    const wide = 11 * d;
    l.oneLine = names(wide, true) >= NAME_TARGET;
    let c = l.oneLine ? wide : (() => {
      const top = (l.contentW - l.sectionGap - (l.timeCells + l.statusCells) * l.gap) / (l.timeCells + l.statusCells);
      const scoreline = (l.contentW - 2 * NAME_TARGET * l.gap - 2 * l.sectionGap) / (2 * NAME_TARGET + 3);
      return Math.min(12 * d, Math.max(7 * d, Math.min(top, scoreline)));
    })();
    const lines = l.oneLine ? 1 : 2;
    const area = l.rowsBottom - l.rowsTop;
    const rowH0 = c * ASPECT * lines + (lines - 1) * l.lineGap;
    if (Math.floor((area + l.rowGap) / (rowH0 + l.rowGap)) < 2) {
      const c2 = (area - l.rowGap - 2 * (lines - 1) * l.lineGap) / (2 * lines) / ASPECT;
      if (c2 >= 8.5 * d) c = Math.min(c, c2);
    }
    l.cw = c;
    l.ch = c * ASPECT;
    l.nameCells = names(c, l.oneLine);
    l.scoreW = c * 1.5;
    l.fontSize = l.ch * 0.82;
    l.rowH = l.oneLine ? l.ch : l.ch * 2 + l.lineGap;
    l.capacity = Math.max(1, Math.floor((l.rowsBottom - l.rowsTop + l.rowGap) / (l.rowH + l.rowGap)));
    l.statusX = l.w - l.pad - l.statusCells * (c + l.gap) + l.gap;
    l.homeX = l.oneLine ? l.pad + l.timeCells * (c + l.gap) + l.sectionGap : l.pad;
    l.scoreX = l.homeX + l.nameCells * (c + l.gap) - l.gap + l.sectionGap;
    l.awayScoreX = l.scoreX + l.scoreW + 2 * l.gap;
    l.awayX = l.awayScoreX + l.scoreW + l.sectionGap;
    return l;
  }

  function score(p, value, x, y, l, dim) {
    const d = l.d;
    const r = 2 * d;
    if (value == null) {
      p.rect(x, y, l.scoreW, l.ch, Palette.CELL_TOP, r);
      p.rect(x, y + l.ch / 2, l.scoreW, l.ch / 2, Palette.CELL_BOTTOM, r);
    } else {
      p.rect(x, y, l.scoreW, l.ch, dim ? Palette.AMBER_DIM : Palette.RULE, r);
      const s = String(value);
      const size = s.length > 1 ? l.fontSize * 0.8 : l.fontSize;
      p.text(s, x + l.scoreW / 2, y + l.ch / 2 + p.capHeight(size) / 2, size, dim ? Palette.SCORE_INK_DIM : Palette.SCORE_INK, 'center');
    }
    p.rect(x, y + l.ch / 2 - d * 0.3, l.scoreW, Math.max(1, d * 0.6), Palette.TILE_SPLIT);
  }

  /**
   * model: { dayLabel, rows: [{ time, status: {text, tone}, section, pinned, home, away,
   *          homeScore, awayScore, winner: 'HOME'|'AWAY'|'DRAW'|null, done }], message, footer, stale, more }
   * Returns each row's band [top, bottom] in canvas units, for taps.
   */
  function drawMatchBoard(p, model, l, clock) {
    const d = l.d;
    header(p, l, 'MATCHES', model.dayLabel, clock);
    const bands = [];
    if (!model.rows.length) message(p, model.message || 'NO MATCHES', l);
    model.rows.forEach((row, i) => {
      const y = l.rowsTop + i * (l.rowH + l.rowGap);
      if (i > 0) divider(p, l, y);
      if (row.pinned) {
        p.rect(l.pad - 4 * d, y - 3 * d, l.contentW + 8 * d, l.rowH + 6 * d, Palette.PIN_BG, 3 * d);
        p.rect(l.pad - 7 * d, y - 3 * d, 3 * d, l.rowH + 6 * d, Palette.RULE, 1.5 * d);
      }
      const upcomingInk = row.section === 'UPCOMING' ? Palette.ink('INFO') : Palette.INK;
      cells(p, row.time, l.pad, y, l.timeCells, l, row.section === 'RECENT' ? Palette.DIM : upcomingInk);
      cells(p, row.status.text.padEnd(l.statusCells), l.statusX, y, l.statusCells, l, Palette.ink(row.status.tone), { live: row.status.tone === 'LIVE' });
      const sy = l.oneLine ? y : y + l.ch + l.lineGap;
      const homeWon = row.done && row.winner === 'HOME';
      const awayWon = row.done && row.winner === 'AWAY';
      const n = l.nameCells;
      cells(p, Flap.clean(row.homeName(n)).padStart(n), l.homeX, sy, n, l, awayWon ? Palette.DIM : Palette.INK, { bold: homeWon });
      score(p, row.homeScore, l.scoreX, sy, l, awayWon);
      score(p, row.awayScore, l.awayScoreX, sy, l, homeWon);
      cells(p, Flap.clean(row.awayName(n)).padEnd(n), l.awayX, sy, n, l, homeWon ? Palette.DIM : Palette.INK, { bold: awayWon });
      bands.push([y - l.rowGap / 2, y + l.rowH + l.rowGap / 2]);
    });
    footer(p, l, model.footer, model.more > 0 ? `+${model.more} MORE` : '', model.stale ? Palette.ink('BOARDING') : Palette.DIM);
    return bands;
  }

  // ------------------------------------------------------------ helpers
  /** dp scale for a board [w] css px wide: about a 360dp phone widget across a portrait Edge slot. */
  function scaleFor(w, h) {
    const base = Math.min(w, h * 2.4);
    return Math.max(1, Math.min(4, base / 360));
  }

  /** Sizes [canvas] to its box at the screen's pixel ratio and returns a painter plus CSS size. */
  function prepare(canvas, family) {
    const dpr = (root.devicePixelRatio || 1);
    const w = canvas.clientWidth || root.innerWidth;
    const h = canvas.clientHeight || root.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { p: CanvasPainter(ctx, family), w, h };
  }

  const api = { Palette, Flap, ellipsize, wrap, CanvasPainter, dayLayout, drawDayBoard, matchLayout, drawMatchBoard, scaleFor, prepare };
  root.FlapBoard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
