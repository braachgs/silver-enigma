/* Day Board — subway systems.
 *
 * A system is the whole design language for the board: how a line's badge is
 * drawn, its palette, the wording ("Stand clear of the closing doors" vs
 * "Mind the gap"), and date/time conventions. Visual tokens (fonts, colours of
 * the chrome) live in css/app.css under [data-system="<id>"].
 *
 * To add a system: add an entry to SYSTEMS below with the same shape, add a
 * per-line style key to DEFAULT_LINES in store.js, and a CSS token block.
 * A system with `layout: 'flap'` renders board rows and the platform display
 * with split-flap cells (js/flap.js) instead of countdown numerals. */
(function (DB) {
  'use strict';
  const { h, s } = DB.util;

  // MTA trunk-line colours as published in the MTA's developer "colors" data.
  const MTA_COLORS = [
    { id: 'blue', hex: '#0039A6', ink: '#FFFFFF', label: 'Blue · A C E' },
    { id: 'orange', hex: '#FF6319', ink: '#FFFFFF', label: 'Orange · B D F M' },
    { id: 'lime', hex: '#6CBE45', ink: '#FFFFFF', label: 'Lime · G' },
    { id: 'brown', hex: '#996633', ink: '#FFFFFF', label: 'Brown · J Z' },
    { id: 'gray', hex: '#A7A9AC', ink: '#FFFFFF', label: 'Gray · L' },
    { id: 'yellow', hex: '#FCCC0A', ink: '#000000', label: 'Yellow · N Q R W' },
    { id: 'red', hex: '#EE352E', ink: '#FFFFFF', label: 'Red · 1 2 3' },
    { id: 'green', hex: '#00933C', ink: '#FFFFFF', label: 'Green · 4 5 6' },
    { id: 'purple', hex: '#B933AD', ink: '#FFFFFF', label: 'Purple · 7' },
    { id: 'shuttle', hex: '#808183', ink: '#FFFFFF', label: 'Dark gray · S' },
    { id: 'teal', hex: '#00ADD0', ink: '#FFFFFF', label: 'Teal · T' },
  ];
  const MTA_LETTERS = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'T'];
  const MTA_LETTER_COLOR = {
    1: 'red', 2: 'red', 3: 'red', 4: 'green', 5: 'green', 6: 'green', 7: 'purple',
    A: 'blue', C: 'blue', E: 'blue', B: 'orange', D: 'orange', F: 'orange', M: 'orange',
    G: 'lime', J: 'brown', Z: 'brown', L: 'gray', N: 'yellow', Q: 'yellow', R: 'yellow', W: 'yellow',
    S: 'shuttle', T: 'teal',
  };

  // TfL line colours (Tube map palette). `ink` is the text colour TfL-style
  // signage puts on light line colours.
  const TFL_BLUE = '#0019A8';
  const TFL_RED = '#DC241F';
  const TFL_LINES = [
    { id: 'bakerloo', name: 'Bakerloo', code: 'BAK', hex: '#B36305', ink: '#FFFFFF' },
    { id: 'central', name: 'Central', code: 'CEN', hex: '#E32017', ink: '#FFFFFF' },
    { id: 'circle', name: 'Circle', code: 'CIR', hex: '#FFD300', ink: TFL_BLUE },
    { id: 'district', name: 'District', code: 'DIS', hex: '#00782A', ink: '#FFFFFF' },
    { id: 'hammersmith-city', name: 'Hammersmith & City', code: 'H&C', hex: '#F3A9BB', ink: TFL_BLUE },
    { id: 'jubilee', name: 'Jubilee', code: 'JUB', hex: '#A0A5A9', ink: TFL_BLUE },
    { id: 'metropolitan', name: 'Metropolitan', code: 'MET', hex: '#9B0056', ink: '#FFFFFF' },
    { id: 'northern', name: 'Northern', code: 'NOR', hex: '#000000', ink: '#FFFFFF' },
    { id: 'piccadilly', name: 'Piccadilly', code: 'PIC', hex: '#003688', ink: '#FFFFFF' },
    { id: 'victoria', name: 'Victoria', code: 'VIC', hex: '#0098D4', ink: '#FFFFFF' },
    { id: 'waterloo-city', name: 'Waterloo & City', code: 'W&C', hex: '#95CDBA', ink: TFL_BLUE },
    { id: 'elizabeth', name: 'Elizabeth line', code: 'ELZ', hex: '#6950A1', ink: '#FFFFFF' },
    { id: 'dlr', name: 'DLR', code: 'DLR', hex: '#00A4A7', ink: '#FFFFFF' },
  ];

  const fmt = (locale, opts) => new Intl.DateTimeFormat(locale, opts);

  // Shared countdown maths: whole minutes, rounded up so "18 min" never
  // shows while 18m30s remain.
  function minutesBetween(a, b) {
    return Math.max(0, Math.ceil((b - a) / 60000));
  }

  function hhmm(mins) {
    return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
  }

  function makeClock(locale, defaultHour12) {
    return {
      // hour12: true | false | 'auto'
      time(t, hour12) {
        const h12 = hour12 === 'auto' || hour12 == null ? defaultHour12 : hour12;
        return fmt(locale, { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 }).format(t);
      },
      timeParts(t, hour12) {
        const h12 = hour12 === 'auto' || hour12 == null ? defaultHour12 : hour12;
        const parts = fmt(locale, { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 }).formatToParts(t);
        const main = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
        const ap = parts.find((p) => p.type === 'dayPeriod');
        return { main, ap: ap ? ap.value.toUpperCase() : '' };
      },
      clock(t, hour12, seconds) {
        const h12 = hour12 === 'auto' || hour12 == null ? defaultHour12 : hour12;
        const o = { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 };
        if (seconds) o.second = '2-digit';
        return fmt(locale, o).format(t);
      },
    };
  }

  // ---------------------------------------------------------------- NYC
  const nycClock = makeClock('en-US', true);
  const nyc = {
    id: 'nyc',
    name: 'New York City Subway',
    tagline: 'Helvetica, route bullets, countdown clocks',
    themeColor: '#0D0D0F',
    locale: 'en-US',
    voiceLang: 'en-US',
    chimeNotes: [659.25, 523.25],
    ...nycClock,

    style(line) {
      const cfg = line.nyc || {};
      const c = MTA_COLORS.find((x) => x.id === cfg.color) || MTA_COLORS[0];
      const letter = cfg.letter || line.name.charAt(0).toUpperCase();
      return { hex: c.hex, ink: c.ink, mark: letter, title: `${letter} line` };
    },

    // Route bullet: circle for timed events, diamond for all-day (the MTA uses
    // diamonds for express service; Day Board borrows them for all-day items).
    badge(line, { allDay = false, outline = false, wide = false, size } = {}) {
      const st = this.style(line);
      return h('span', {
        class: `badge bullet${allDay ? ' diamond' : ''}${outline ? ' outline' : ''}`,
        style: { '--c': st.hex, '--i': st.ink, '--bs': size ? `${size}px` : null },
        role: 'img',
        'aria-label': `${st.mark} line, ${line.name}${allDay ? ', all day' : ''}`,
      }, h('span', { class: 'mark', 'aria-hidden': 'true' }, st.mark));
    },

    dateLong: (t) => fmt('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(t),
    dateShort: (t) => fmt('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(t).replace(',', '').toUpperCase(),
    monthTitle: (t) => fmt('en-US', { month: 'long', year: 'numeric' }).format(t),
    weekStart: 0,

    // { big, unit } for the TIME column.
    countdown(mins, live) {
      if (mins < 1) return live ? { big: '<1', unit: 'MIN LEFT' } : { big: 'NOW', unit: 'ARRIVING' };
      if (mins < 60) return { big: String(mins), unit: live ? 'MIN LEFT' : 'MIN' };
      return { big: hhmm(mins), unit: live ? 'HR LEFT' : 'HR' };
    },

    copy: {
      departures: 'Departures',
      timeCol: 'Time',
      timeColOther: 'Time',
      arriving: 'Arriving now',
      liveTag: 'Live',
      allDay: (n) => `${n} all-day`,
      allDayTitle: 'All-day',
      empty: 'No scheduled service',
      emptySub: 'Nothing on the board for this day.',
      ended: 'Last train has left the station',
      endedSub: 'That was the last departure today.',
      departed: 'Departed',
      linesTitle: 'Lines',
      addLine: 'Add line',
      mapTitle: 'Service map',
      mapEmpty: 'No service to map for this day.',
      now: 'Now',
      status: { none: 'No scheduled service', good: 'Good service', minor: 'Delays', severe: 'Delays' },
      display: { ln: 'LN', event: 'EVENT', min: 'MIN', allDay: 'ALL DAY', live: 'LIVE' },
      sample: 'Sample day',
      announceSoon: (title, mins, where) =>
        `The next stop is ${title}, in ${mins} ${mins === 1 ? 'minute' : 'minutes'}${where ? `, at ${where}` : ''}. Stand clear of the closing doors, please.`,
      announceNow: (title, where) =>
        `This is ${title}.${where ? ` ${where}.` : ''} Stand clear of the closing doors, please.`,
    },

    // Strip-map styling (NYC: white stop circles with black outlines).
    map: { track: 6, stop: 'circle' },

    lineOptions: {
      letters: MTA_LETTERS,
      colors: MTA_COLORS,
      colorForLetter: (l) => MTA_LETTER_COLOR[l] || 'blue',
    },
  };

  // ------------------------------------------------------------- London
  const londonClock = makeClock('en-GB', false);
  const london = {
    id: 'london',
    name: 'London Underground',
    tagline: 'Johnston-style type, line colours, dot-matrix indicators',
    themeColor: TFL_BLUE,
    locale: 'en-GB',
    voiceLang: 'en-GB',
    chimeNotes: [523.25, 659.25],
    ...londonClock,

    style(line) {
      const cfg = line.london || {};
      const l = TFL_LINES.find((x) => x.id === cfg.line) || TFL_LINES[9];
      return { hex: l.hex, ink: l.ink, mark: l.code, title: l.name };
    },

    // Line "tab": a block of line colour, as on TfL status boards. All-day
    // events get a hollow tab.
    badge(line, { allDay = false, outline = false, wide = false } = {}) {
      const st = this.style(line);
      return h('span', {
        class: `badge tab${allDay ? ' hollow' : ''}${outline ? ' outline' : ''}${wide ? ' wide' : ''}`,
        style: { '--c': st.hex, '--i': st.ink },
        role: 'img',
        'aria-label': `${st.title}, ${line.name}${allDay ? ', all day' : ''}`,
      }, h('span', { class: 'mark', 'aria-hidden': 'true' }, wide ? st.title : st.mark));
    },

    // Ring-and-bar mark for the header.
    logo(size = 34) {
      return s('svg', { viewBox: '0 0 100 80', width: size, height: size * 0.8, 'aria-hidden': 'true', class: 'roundel' },
        s('circle', { cx: 50, cy: 40, r: 30, fill: 'none', stroke: TFL_RED, 'stroke-width': 14 }),
        s('rect', { x: 4, y: 31, width: 92, height: 18, fill: TFL_BLUE, stroke: '#FFFFFF', 'stroke-width': 3 }));
    },

    dateLong: (t) => fmt('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(t),
    dateShort: (t) => fmt('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(t).replace(',', '').toUpperCase(),
    monthTitle: (t) => fmt('en-GB', { month: 'long', year: 'numeric' }).format(t),
    weekStart: 1,

    countdown(mins, live) {
      if (mins < 1) return live ? { big: '<1', unit: 'MIN LEFT' } : { big: 'Due', unit: '' };
      if (mins < 60) return { big: String(mins), unit: `${mins === 1 ? 'MIN' : 'MINS'}${live ? ' LEFT' : ''}` };
      return { big: hhmm(mins), unit: live ? 'HRS LEFT' : 'HRS' };
    },

    copy: {
      departures: 'Departures',
      timeCol: 'Due',
      timeColOther: 'Time',
      arriving: 'Due',
      liveTag: 'Now',
      allDay: (n) => `${n} all day`,
      allDayTitle: 'All day',
      empty: 'No trains scheduled',
      emptySub: 'Nothing on the board for this day.',
      ended: 'Service has ended for today',
      endedSub: 'That was the last departure.',
      departed: 'Earlier',
      linesTitle: 'Lines',
      addLine: 'Add line',
      mapTitle: 'Line diagram',
      mapEmpty: 'No service to map for this day.',
      now: 'Now',
      status: { none: 'No service', good: 'Good service', minor: 'Minor delays', severe: 'Severe delays' },
      display: { ln: '', event: '', min: '', allDay: 'ALL DAY', live: 'Now' },
      sample: 'Sample day',
      announceSoon: (title, mins, where) =>
        `The next station is ${title}, in ${mins} ${mins === 1 ? 'minute' : 'minutes'}${where ? `, at ${where}` : ''}.`,
      announceNow: (title, where) =>
        `This station is ${title}.${where ? ` ${where}.` : ''} Please mind the gap between the train and the platform.`,
    },

    // Beck-style diagram: ticks for stops, linked rings for interchanges.
    map: { track: 7, stop: 'tick' },

    lineOptions: { lines: TFL_LINES },
  };

  // ---------------------------------------------------------- Split-flap
  // The mechanical departure board of mainline stations and airports. It
  // speaks in scheduled times and remarks (ON TIME, BOARDING, FINAL CALL)
  // rather than minute countdowns, so it only changes at event boundaries.
  const FLAP_COLORS = [
    { id: 'blue', hex: '#1F5AA6', ink: '#FFFFFF', label: 'Blue' },
    { id: 'orange', hex: '#E8711C', ink: '#FFFFFF', label: 'Orange' },
    { id: 'red', hex: '#C8102E', ink: '#FFFFFF', label: 'Red' },
    { id: 'yellow', hex: '#F2C500', ink: '#111111', label: 'Yellow' },
    { id: 'green', hex: '#2E8540', ink: '#FFFFFF', label: 'Green' },
    { id: 'magenta', hex: '#B0287A', ink: '#FFFFFF', label: 'Magenta' },
    { id: 'teal', hex: '#00838F', ink: '#FFFFFF', label: 'Teal' },
    { id: 'purple', hex: '#6A4BAF', ink: '#FFFFFF', label: 'Purple' },
    { id: 'brown', hex: '#8B5A2B', ink: '#FFFFFF', label: 'Brown' },
    { id: 'white', hex: '#EDEAE0', ink: '#111111', label: 'White' },
    { id: 'gray', hex: '#7D8085', ink: '#FFFFFF', label: 'Gray' },
  ];
  // Lines without a flap colour borrow the hue of their NYC bullet.
  const NYC_TO_FLAP = {
    blue: 'blue', orange: 'orange', red: 'red', yellow: 'yellow', green: 'green', purple: 'magenta',
    lime: 'green', brown: 'brown', gray: 'gray', shuttle: 'gray', teal: 'teal',
  };

  // Three-letter board code from a line name, consonant-first like
  // "Work" -> WRK, "Personal" -> PRS, "Health" -> HLT.
  function flapCode(name) {
    const letters = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!letters) {
      // Non-Latin names: their own first characters, so lines stay distinct.
      return Array.from(String(name || '').replace(/\s+/g, '')).slice(0, 3).join('').toUpperCase() || 'LN';
    }
    // First letter, then consonants; pad with the skipped letters, keeping
    // each letter's position so nothing repeats (Bob -> BOB, Eat -> EAT).
    const picked = [0];
    for (let i = 1; i < letters.length && picked.length < 3; i++) {
      if (!'AEIOU'.includes(letters[i])) picked.push(i);
    }
    for (let i = 1; i < letters.length && picked.length < 3; i++) {
      if (!picked.includes(i)) picked.push(i);
    }
    return picked.sort((a, b) => a - b).map((i) => letters[i]).join('');
  }

  const flapClock = makeClock('en-US', true);
  const flap = {
    id: 'flap',
    name: 'Split-Flap Departures',
    tagline: 'Mechanical station board: times, remarks, flipping flaps',
    themeColor: '#161616',
    locale: 'en-US',
    voiceLang: 'en-US',
    chimeNotes: [783.99, 659.25, 523.25],
    layout: 'flap',
    ...flapClock,

    style(line) {
      const cfg = line.flap || {};
      const colorId = cfg.color || NYC_TO_FLAP[(line.nyc || {}).color] || 'blue';
      const c = FLAP_COLORS.find((x) => x.id === colorId) || FLAP_COLORS[0];
      const code = (cfg.code || flapCode(line.name)).slice(0, 3);
      return { hex: c.hex, ink: c.ink, mark: code, title: code };
    },

    // A coloured flap tile carrying the line's code; hollow for all-day events.
    badge(line, { allDay = false, outline = false } = {}) {
      const st = this.style(line);
      return h('span', {
        class: `badge ftile${allDay ? ' hollow' : ''}${outline ? ' outline' : ''}`,
        style: { '--c': st.hex, '--i': st.ink },
        role: 'img',
        'aria-label': `${st.mark} line, ${line.name}${allDay ? ', all day' : ''}`,
      }, h('span', { class: 'mark', 'aria-hidden': 'true' }, st.mark));
    },

    // Remarks column: changes only at event boundaries.
    remark(e, now) {
      if (e.allDay) return { text: 'ALL DAY', tone: 'info' };
      if (e.end <= now && e.start < now) return { text: 'DEPARTED', tone: 'past' };
      if (e.start <= now) return { text: 'NOW', tone: 'live' };
      const m = minutesBetween(now, e.start);
      if (m <= 2) return { text: 'FINAL CALL', tone: 'final' };
      if (m <= 15) return { text: 'BOARDING', tone: 'boarding' };
      return { text: 'ON TIME', tone: 'ontime' };
    },

    // "10:30A" style board time: five cells plus an A/P cell on a 12-hour clock.
    boardTime(t, hour12) {
      const p = flapClock.timeParts(t, hour12);
      return p.main.padStart(5, ' ') + (p.ap ? p.ap.charAt(0) : '');
    },

    dateLong: (t) => fmt('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(t),
    dateShort: (t) => fmt('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(t).replace(',', '').toUpperCase(),
    monthTitle: (t) => fmt('en-US', { month: 'long', year: 'numeric' }).format(t),
    weekStart: 0,

    countdown(mins, live) {
      if (mins < 1) return live ? { big: '<1', unit: 'MIN LEFT' } : { big: 'NOW', unit: 'FINAL CALL' };
      if (mins < 60) return { big: String(mins), unit: live ? 'MIN LEFT' : 'MIN' };
      return { big: hhmm(mins), unit: live ? 'HR LEFT' : 'HR' };
    },

    copy: {
      departures: 'Time · Destination',
      timeCol: 'Remarks',
      timeColOther: 'Remarks',
      scheduled: 'Scheduled', // remark on a future day's board
      arriving: 'Final call',
      liveTag: 'Now',
      allDay: (n) => `${n} all-day`,
      allDayTitle: 'All-day',
      empty: 'No departures scheduled',
      emptySub: 'Nothing on the board for this day.',
      ended: 'All trains have departed',
      endedSub: 'That was the last departure today.',
      departed: 'Departed',
      linesTitle: 'Lines',
      addLine: 'Add line',
      mapTitle: 'Route map',
      mapEmpty: 'No service to map for this day.',
      now: 'Now',
      nextTrain: 'Next departure',
      noMore: 'No more departures today',
      status: { none: 'No service', good: 'On time', minor: 'Delayed', severe: 'Delayed' },
      display: { ln: '', event: 'DESTINATION', min: 'REMARKS', allDay: 'ALL DAY', live: 'NOW' },
      sample: 'Sample day',
      announceSoon: (title, mins, where) =>
        `Now boarding: ${title}${where ? `, at ${where}` : ''}. Departing in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`,
      announceNow: (title, where) =>
        `${title}${where ? `, at ${where},` : ''} is now departing. All aboard.`,
    },

    map: { track: 6, stop: 'circle' },

    lineOptions: { colors: FLAP_COLORS },
  };

  DB.SYSTEMS = { nyc, london, flap };
  DB.systemList = [nyc, london, flap];
  DB.palette = { MTA_COLORS, MTA_LETTERS, MTA_LETTER_COLOR, TFL_LINES, TFL_BLUE, TFL_RED, FLAP_COLORS, NYC_TO_FLAP, flapCode };
  DB.minutesBetween = minutesBetween;
})(window.DB);
