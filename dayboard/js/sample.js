/* Day Board — the sample day shown until you add events or connect a calendar.
 * Times are relative to "now" so the board always has something live,
 * something due and a full afternoon ahead. */
(function (DB) {
  'use strict';
  const { addDays, dayStart, todayKey } = DB.util;

  // [title, line name, NYC place, London place, starts in (min), duration (min)]
  const TIMED = [
    ['Coffee with the team', 'Personal', 'Kitchen 2F', 'Kitchen 2F', -10, 20],
    ['Launch readiness review and final go/no-go', 'Work', 'Studio 4A · Video call', 'Studio 4A · Video call', -4, 27],
    ['Morning standup', 'Work', 'Conf Room B', 'Meeting room B', 18, 15],
    ['Deep work', 'Focus', 'Home office', 'Home office', 52, 90],
    ['Lunch with Priya', 'Social', 'The Canteen 3F', 'The Canteen 3F', 118, 60],
    ['Send final cut', 'Deadlines', '', '', 195, 15],
    ['Dentist appointment', 'Health', 'Smile Dental, 5th Ave', 'Smile Dental, Marylebone', 288, 45],
    ['Train home', 'Personal', 'Grand Central', "King's Cross St. Pancras", 450, 40],
  ];
  const ALL_DAY = [
    ['Quarterly planning week', 'Work'],
    ['Posting buffer: no organic posts', 'Deadlines'],
    ["Mom's birthday", 'Personal', "Mum's birthday"],
  ];

  function build(now, systemId) {
    const lines = DB.store.state.lines;
    const lineFor = (name, i) => (lines.find((l) => l.name.toLowerCase() === name.toLowerCase()) || lines[i % lines.length]).id;
    const t0 = Math.floor(now / 60000) * 60000;
    const london = systemId === 'london';
    const out = TIMED.map(([title, line, nyc, ldn, inMin, dur], i) => ({
      key: `s|${i}`,
      source: 'sample',
      title,
      location: london ? ldn : nyc,
      notes: '',
      allDay: false,
      start: t0 + inMin * 60000,
      end: t0 + (inMin + dur) * 60000,
      line: lineFor(line, i),
      writable: false,
    }));
    const today = todayKey();
    ALL_DAY.forEach(([title, line, gbTitle], i) => out.push({
      key: `s|a${i}`,
      source: 'sample',
      title: london && gbTitle ? gbTitle : title,
      location: '',
      notes: '',
      allDay: true,
      start: dayStart(today),
      end: dayStart(addDays(today, 1)),
      line: lineFor(line, i),
      writable: false,
    }));
    return out;
  }

  DB.sample = { build };
})(window.DB);
