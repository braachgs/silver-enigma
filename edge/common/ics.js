/* iCalendar (RFC 5545) reading for the Day Board Edge widget: enough of it
 * for Google Calendar's "secret address in iCal format" feeds. Handles line
 * folding, escapes, TZID / UTC / floating times, all-day dates, DURATION,
 * RRULE (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY
 * incl. 2MO / -1FR, BYMONTHDAY, BYMONTH, BYSETPOS, WKST), RDATE, EXDATE,
 * moved or cancelled single instances (RECURRENCE-ID), cancelled events and
 * invitations the calendar's owner declined. Repeats are expanded in the
 * event's own time zone, so a 9:00 weekly meeting stays at 9:00 across a
 * clock change.
 */
(function (root) {
  const DAY = 864e5;

  // ------------------------------------------------------------- lines
  function unfold(text) {
    return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  }

  /** NAME;PARAM=V;P2="a:b":VALUE -> { name, params, value } */
  function parseLine(line) {
    let i = 0;
    let quoted = false;
    let nameEnd = -1;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === ';' || c === ':') && nameEnd < 0) nameEnd = i;
      if (!quoted && c === ':') break;
    }
    if (i >= line.length) return null;
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const parts = [];
    let cur = '';
    quoted = false;
    for (const c of head) {
      if (c === '"') { quoted = !quoted; continue; }
      if (c === ';' && !quoted) { parts.push(cur); cur = ''; } else cur += c;
    }
    parts.push(cur);
    const params = {};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    return { name: parts[0].toUpperCase(), params, value };
  }

  const unescape = (s) => String(s).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

  // -------------------------------------------------------------- times
  const fmtCache = new Map();
  function zoneFormat(tz) {
    if (!fmtCache.has(tz)) {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }));
    }
    return fmtCache.get(tz);
  }
  function validZone(tz) {
    if (!tz) return false;
    try { zoneFormat(tz); return true; } catch (_) { return false; }
  }
  /** Offset of [tz] from UTC at instant [t], in ms. */
  function offset(t, tz) {
    const p = {};
    for (const x of zoneFormat(tz).formatToParts(new Date(t))) p[x.type] = x.value;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - Math.floor(t / 1000) * 1000;
  }
  /** Wall-clock [w] in zone [tz] (null = this PC's zone) -> epoch ms. */
  function wallToEpoch(w, tz) {
    if (!tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    const o1 = offset(guess - offset(guess, tz), tz);
    let t = guess - o1;
    const o2 = offset(t, tz);
    if (o2 !== o1) t = guess - o2; // in a clock change's gap or overlap
    return t;
  }

  /** "20261026T090000Z" / "20261026T090000" / "20261026" with its TZID, against the calendar's default zone. */
  function parseTime(prop, calZone) {
    const v = (prop.value || '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
    if (!m) return null;
    const w = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
    if (!m[4] || (prop.params.VALUE || '').toUpperCase() === 'DATE') return { wall: w, date: true, zone: null };
    if (m[7]) return { wall: w, date: false, zone: 'UTC' };
    const tz = validZone(prop.params.TZID) ? prop.params.TZID : validZone(calZone) ? calZone : null;
    return { wall: w, date: false, zone: tz };
  }
  const epochOf = (pt) => (pt.date ? new Date(pt.wall.y, pt.wall.mo - 1, pt.wall.d).getTime() : wallToEpoch(pt.wall, pt.zone));

  /** "PT1H30M", "P1D", "-PT15M" -> ms */
  function parseDuration(s) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(s || '').trim());
    if (!m) return null;
    const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 * 3600 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
    return m[1] === '-' ? -ms : ms;
  }

  // ------------------------------------------------------------ calendar
  /** -> { name, zone, events: [vevent] } */
  function parse(text) {
    const cal = { name: '', zone: null, events: [] };
    let ev = null;
    let depth = 0; // skip VALARM / VTIMEZONE contents
    for (const line of unfold(text)) {
      if (!line) continue;
      const p = parseLine(line);
      if (!p) continue;
      if (p.name === 'BEGIN') {
        if (p.value.toUpperCase() === 'VEVENT' && depth === 0) ev = { props: {}, exdates: [], rdates: [], attendees: [] };
        else if (ev || p.value.toUpperCase() !== 'VCALENDAR') depth++;
        continue;
      }
      if (p.name === 'END') {
        if (p.value.toUpperCase() === 'VEVENT' && depth === 0 && ev) { cal.events.push(ev); ev = null; }
        else if (depth > 0) depth--;
        continue;
      }
      if (depth > 0) continue;
      if (!ev) {
        if (p.name === 'X-WR-CALNAME') cal.name = unescape(p.value);
        else if (p.name === 'X-WR-TIMEZONE') cal.zone = p.value.trim();
        continue;
      }
      if (p.name === 'EXDATE') ev.exdates.push(p);
      else if (p.name === 'RDATE') ev.rdates.push(p);
      else if (p.name === 'ATTENDEE') ev.attendees.push(p);
      else ev.props[p.name] = p;
    }
    return cal;
  }

  // --------------------------------------------------------------- rules
  const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  function parseRule(s) {
    const r = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [], bysetpos: [], wkst: 1 };
    for (const part of String(s).split(';')) {
      const [k, v] = part.split('=');
      if (!v) continue;
      const K = k.toUpperCase();
      if (K === 'FREQ') r.freq = v.toUpperCase();
      else if (K === 'INTERVAL') r.interval = Math.max(1, parseInt(v, 10) || 1);
      else if (K === 'COUNT') r.count = parseInt(v, 10);
      else if (K === 'UNTIL') r.until = v;
      else if (K === 'BYDAY') r.byday = v.split(',').map((x) => { const m = /^([+-]?\d+)?([A-Z]{2})$/i.exec(x.trim()); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WD.indexOf(m[2].toUpperCase()) } : null; }).filter((x) => x && x.wd >= 0);
      else if (K === 'BYMONTHDAY') r.bymonthday = v.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite);
      else if (K === 'BYMONTH') r.bymonth = v.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite);
      else if (K === 'BYSETPOS') r.bysetpos = v.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite);
      else if (K === 'WKST') r.wkst = Math.max(0, WD.indexOf(v.toUpperCase()));
    }
    return r;
  }

  // Calendar arithmetic on wall dates, in UTC to stay clear of this PC's zone.
  const ymd = (y, mo, d) => Date.UTC(y, mo - 1, d);
  const fromUtc = (t) => { const x = new Date(t); return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
  const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const weekday = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

  /** Days of month [y]-[mo] that the rule's BYMONTHDAY / BYDAY pick (null: none given). */
  function monthDays(r, y, mo) {
    const n = daysIn(y, mo);
    let out = null;
    if (r.bymonthday.length) {
      out = r.bymonthday.map((x) => (x > 0 ? x : n + x + 1)).filter((x) => x >= 1 && x <= n);
    }
    if (r.byday.length) {
      const set = [];
      for (const { n: k, wd } of r.byday) {
        const all = [];
        for (let d = 1; d <= n; d++) if (weekday(y, mo, d) === wd) all.push(d);
        if (k === 0) set.push(...all);
        else { const pick = k > 0 ? all[k - 1] : all[all.length + k]; if (pick) set.push(pick); }
      }
      out = out ? out.filter((d) => set.includes(d)) : set;
    }
    if (!out) return null;
    out = [...new Set(out)].sort((a, b) => a - b);
    if (r.bysetpos.length) out = r.bysetpos.map((p) => (p > 0 ? out[p - 1] : out[out.length + p])).filter(Boolean).sort((a, b) => a - b);
    return out;
  }

  /**
   * Wall dates of a rule's occurrences from [start] (a wall date) until
   * [limit] (UTC ms of a wall date), in order. COUNT counts from the start.
   */
  function* dates(r, start, untilMs, limitMs) {
    const s0 = ymd(start.y, start.mo, start.d);
    let emitted = 0;
    const take = function* (list) {
      for (const t of list) {
        if (t < s0) continue;
        if (untilMs != null && t > untilMs) return 'stop';
        if (t > limitMs) return 'stop';
        if (r.count != null && emitted >= r.count) return 'stop';
        emitted++;
        yield t;
      }
      return null;
    };
    for (let period = 0; period < 5000; period++) {
      let list;
      if (r.freq === 'DAILY') {
        const t = s0 + period * r.interval * DAY;
        const x = fromUtc(t);
        const ok = (!r.bymonth.length || r.bymonth.includes(x.mo))
          && (!r.byday.length || r.byday.some((b) => b.wd === new Date(t).getUTCDay()))
          && (!r.bymonthday.length || (monthDays({ ...r, byday: [] }, x.y, x.mo) || []).includes(x.d));
        list = ok ? [t] : [];
        if (t > limitMs) return;
      } else if (r.freq === 'WEEKLY') {
        const sw = new Date(s0).getUTCDay();
        const weekStart = s0 - ((sw - r.wkst + 7) % 7) * DAY + period * r.interval * 7 * DAY;
        if (weekStart > limitMs) return;
        const wds = r.byday.length ? r.byday.map((b) => b.wd) : [sw];
        list = wds.map((wd) => weekStart + ((wd - r.wkst + 7) % 7) * DAY).sort((a, b) => a - b)
          .filter((t) => !r.bymonth.length || r.bymonth.includes(fromUtc(t).mo));
      } else if (r.freq === 'MONTHLY') {
        const mIndex = start.y * 12 + (start.mo - 1) + period * r.interval;
        const y = Math.floor(mIndex / 12);
        const mo = (mIndex % 12) + 1;
        if (ymd(y, mo, 1) > limitMs) return;
        if (r.bymonth.length && !r.bymonth.includes(mo)) { list = []; } else {
          const days = monthDays(r, y, mo) || (start.d <= daysIn(y, mo) ? [start.d] : []);
          list = days.map((d) => ymd(y, mo, d));
        }
      } else if (r.freq === 'YEARLY') {
        const y = start.y + period * r.interval;
        if (ymd(y, 1, 1) > limitMs) return;
        const months = r.bymonth.length ? r.bymonth : [start.mo];
        list = [];
        for (const mo of months) {
          const days = (r.byday.length || r.bymonthday.length) ? monthDays(r, y, mo) || [] : (start.d <= daysIn(y, mo) ? [start.d] : []);
          list.push(...days.map((d) => ymd(y, mo, d)));
        }
        list.sort((a, b) => a - b);
      } else {
        return;
      }
      const res = yield* take(list);
      if (res === 'stop') return;
    }
  }

  // --------------------------------------------------------------- events
  /**
   * Event instances overlapping [from, to) from a parsed calendar:
   * [{ uid, title, location, start, end, allDay }] sorted by start.
   */
  function expand(cal, from, to) {
    const owner = /@/.test(cal.name) ? cal.name.trim().toLowerCase() : null;
    const declined = (ev) => owner && ev.attendees.some((a) =>
      String(a.value).toLowerCase().replace(/^mailto:/, '') === owner && String(a.params.PARTSTAT || '').toUpperCase() === 'DECLINED');
    const text = (ev, k) => (ev.props[k] ? unescape(ev.props[k].value) : '');

    // Moved or cancelled single instances, by series and original start.
    const overrides = new Map();
    for (const ev of cal.events) {
      const rid = ev.props['RECURRENCE-ID'];
      const uid = text(ev, 'UID');
      if (!rid || !uid) continue;
      const pt = parseTime(rid, cal.zone);
      if (pt) overrides.set(`${uid}|${epochOf(pt)}`, ev);
    }

    const out = [];
    const push = (ev, start, end, allDay) => {
      if ((text(ev, 'STATUS') || '').toUpperCase() === 'CANCELLED' || declined(ev)) return;
      if (start < to && (end > from || (end === start && start >= from))) {
        out.push({ uid: text(ev, 'UID'), title: text(ev, 'SUMMARY') || '(No title)', location: text(ev, 'LOCATION'), start, end, allDay });
      }
    };
    const timesOf = (ev) => {
      const s = ev.props.DTSTART && parseTime(ev.props.DTSTART, cal.zone);
      if (!s) return null;
      const startMs = epochOf(s);
      let span;
      if (ev.props.DTEND) {
        const e = parseTime(ev.props.DTEND, cal.zone);
        span = e ? (s.date ? Math.round((ymd(e.wall.y, e.wall.mo, e.wall.d) - ymd(s.wall.y, s.wall.mo, s.wall.d)) / DAY) : epochOf(e) - startMs) : null;
      } else if (ev.props.DURATION) {
        const dur = parseDuration(ev.props.DURATION.value);
        span = s.date ? Math.max(1, Math.round((dur || DAY) / DAY)) : dur;
      }
      if (span == null) span = s.date ? 1 : 0;
      return { s, startMs, span };
    };
    // An instance's end: all-day spans are whole local days; timed ones a fixed length.
    const endOf = (s, startWall, span) => (s.date
      ? new Date(startWall.y, startWall.mo - 1, startWall.d + Math.max(1, span)).getTime()
      : null);

    for (const ev of cal.events) {
      if (ev.props['RECURRENCE-ID']) continue;
      const t = timesOf(ev);
      if (!t) continue;
      const { s, startMs, span } = t;
      const uid = text(ev, 'UID');
      if (!ev.props.RRULE && !ev.rdates.length) {
        push(ev, startMs, s.date ? endOf(s, s.wall, span) : startMs + Math.max(0, span), s.date);
        continue;
      }
      const ex = new Set();
      for (const p of ev.exdates) {
        for (const v of p.value.split(',')) {
          const pt = parseTime({ value: v, params: p.params }, cal.zone);
          if (pt) ex.add(s.date ? ymd(pt.wall.y, pt.wall.mo, pt.wall.d) : epochOf(pt));
        }
      }
      const instance = (wallDate) => {
        const w = { ...s.wall, y: wallDate.y, mo: wallDate.mo, d: wallDate.d };
        const st = s.date ? new Date(w.y, w.mo - 1, w.d).getTime() : wallToEpoch(w, s.zone);
        const keyEx = s.date ? ymd(w.y, w.mo, w.d) : st;
        if (ex.has(keyEx)) return;
        const o = overrides.get(`${uid}|${st}`);
        if (o) {
          const ot = timesOf(o);
          if (ot) push(o, ot.startMs, ot.s.date ? endOf(ot.s, ot.s.wall, ot.span) : ot.startMs + Math.max(0, ot.span), ot.s.date);
          return;
        }
        push(ev, st, s.date ? endOf(s, w, span) : st + Math.max(0, span), s.date);
      };
      if (ev.props.RRULE) {
        const r = parseRule(ev.props.RRULE.value);
        let untilMs = null;
        if (r.until) {
          const u = parseTime({ value: r.until, params: {} }, cal.zone);
          if (u) {
            // UNTIL is inclusive; compare on the start's own wall date.
            const ue = epochOf(u.date ? { ...u } : u);
            const local = u.date ? u.wall : (() => {
              const z = s.zone || null;
              if (!z) { const x = new Date(ue); return { y: x.getFullYear(), mo: x.getMonth() + 1, d: x.getDate() }; }
              const p = {};
              for (const x of zoneFormat(z).formatToParts(new Date(ue))) p[x.type] = x.value;
              return { y: +p.year, mo: +p.month, d: +p.day };
            })();
            untilMs = ymd(local.y, local.mo, local.d);
          }
        }
        // Expand past the window's end: a day for zone differences, and a month so an
        // instance moved into the window from a later date is still found.
        const lim = new Date(to + 31 * DAY);
        const limitMs = ymd(lim.getUTCFullYear(), lim.getUTCMonth() + 1, lim.getUTCDate());
        for (const t of dates(r, s.wall, untilMs, limitMs)) instance(fromUtc(t));
      } else {
        instance(s.wall);
      }
      for (const p of ev.rdates) {
        for (const v of p.value.split(',')) {
          const pt = parseTime({ value: v, params: p.params }, cal.zone);
          if (pt) instance(pt.wall);
        }
      }
    }
    // Overrides whose series isn't in the feed (or moved into the window from outside it).
    for (const [k, o] of overrides) {
      const uid = k.split('|')[0];
      if (cal.events.some((e) => !e.props['RECURRENCE-ID'] && text(e, 'UID') === uid)) continue;
      const ot = timesOf(o);
      if (ot) push(o, ot.startMs, ot.s.date ? endOf(ot.s, ot.s.wall, ot.span) : ot.startMs + Math.max(0, ot.span), ot.s.date);
    }
    const seen = new Set();
    return out.filter((e) => { const k = `${e.uid}|${e.start}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title));
  }

  const api = { parse, expand, parseLine, parseTime, parseDuration, parseRule, wallToEpoch, unfold };
  root.ICS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
