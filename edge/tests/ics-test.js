// node edge/tests/ics-test.js  (run with TZ=Europe/London)
const ICS = require('../common/ics.js');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'}: ${m}`); if (!c) fails++; };
const T = (s) => new Date(s).getTime();
const fold = (s) => s.replace(/(.{70})/g, '$1\r\n ');

const ics = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:me@gmail.com', 'X-WR-TIMEZONE:Europe/London',
  'BEGIN:VTIMEZONE', 'TZID:Europe/London', 'BEGIN:STANDARD', 'DTSTART:19701025T020000', 'END:STANDARD', 'END:VTIMEZONE',
  // Weekly Mon/Wed 9:00 London, from 5 Oct, except 14 Oct; 21 Oct moved to 11:00.
  'BEGIN:VEVENT', 'UID:standup', 'SUMMARY:Standup', 'DTSTART;TZID=Europe/London:20261005T090000', 'DTEND;TZID=Europe/London:20261005T091500',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=Europe/London:20261014T090000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:standup', 'RECURRENCE-ID;TZID=Europe/London:20261021T090000', 'SUMMARY:Standup (moved)',
  'DTSTART;TZID=Europe/London:20261021T110000', 'DTEND;TZID=Europe/London:20261021T111500', 'END:VEVENT',
  // Monthly on the 2nd Tuesday, New York time, 5 times.
  'BEGIN:VEVENT', 'UID:board', 'SUMMARY:Board call', 'DTSTART;TZID=America/New_York:20260908T100000', 'DURATION:PT1H',
  'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=5', 'END:VEVENT',
  // Last Friday of the month, until 31 Dec 2026.
  'BEGIN:VEVENT', 'UID:drinks', 'SUMMARY:Team drinks\\, bar', 'LOCATION:The Pub\; upstairs', 'DTSTART:20260925T170000Z', 'DTEND:20260925T190000Z',
  'RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;UNTIL=20261231T235959Z', 'END:VEVENT',
  // Every other day, 3 times.
  'BEGIN:VEVENT', 'UID:pills', 'SUMMARY:Pills', 'DTSTART;TZID=Europe/London:20261022T080000', 'DTEND;TZID=Europe/London:20261022T080500',
  'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3', 'END:VEVENT',
  // All-day, three days.
  'BEGIN:VEVENT', 'UID:trip', 'SUMMARY:Bristol trip', 'DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261029', 'END:VEVENT',
  // Yearly birthday.
  'BEGIN:VEVENT', 'UID:bday', 'SUMMARY:Emma birthday', 'DTSTART;VALUE=DATE:20091017', 'RRULE:FREQ=YEARLY', 'END:VEVENT',
  // Cancelled, and declined by the calendar's owner.
  'BEGIN:VEVENT', 'UID:gone', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'DTSTART:20261026T120000Z', 'DTEND:20261026T130000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:nope', 'SUMMARY:Declined meeting', 'DTSTART:20261026T140000Z', 'DTEND:20261026T150000Z',
  'ATTENDEE;CN=Me;PARTSTAT=DECLINED:mailto:me@gmail.com', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@corp.com', 'END:VEVENT',
  // A long folded title with an alarm inside.
  'BEGIN:VEVENT', 'UID:long', fold('SUMMARY:Grab cards at the card shop on the way home from Convene Sancroft before it closes'),
  'DTSTART:20261026T160000Z', 'DTEND:20261026T163000Z', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const cal = ICS.parse(ics);
ok(cal.name === 'me@gmail.com' && cal.zone === 'Europe/London' && cal.events.length === 10, `parses the calendar (${cal.events.length} events)`);
const ev = ICS.expand(cal, T('2026-10-01T00:00:00+01:00'), T('2027-01-01T00:00:00Z'));
const at = (title) => ev.filter((e) => e.title === title).map((e) => new Date(e.start).toISOString());

const standup = at('Standup');
ok(standup[0] === '2026-10-05T08:00:00.000Z' && !standup.includes('2026-10-14T08:00:00.000Z'), 'weekly series starts on time; EXDATE skips 14 Oct');
ok(standup.includes('2026-10-26T09:00:00.000Z'), 'after the clock change it is still 9:00 in London (09:00Z)');
ok(at('Standup (moved)')[0] === '2026-10-21T10:00:00.000Z' && !standup.includes('2026-10-21T08:00:00.000Z'), 'a moved instance replaces the original');
ok(JSON.stringify(at('Board call')) === JSON.stringify(['2026-10-13T14:00:00.000Z', '2026-11-10T15:00:00.000Z', '2026-12-08T15:00:00.000Z']), `2nd Tuesday 10:00 New York, COUNT=5 from Sept (${at('Board call')})`);
ok(JSON.stringify(at('Team drinks, bar')) === JSON.stringify(['2026-10-30T17:00:00.000Z', '2026-11-27T17:00:00.000Z', '2026-12-25T17:00:00.000Z']), `last Friday via BYSETPOS=-1 (${at('Team drinks, bar')})`);
ok(ev.find((e) => e.title === 'Team drinks, bar').location === 'The Pub; upstairs', 'text escapes');
ok(JSON.stringify(at('Pills')) === JSON.stringify(['2026-10-22T07:00:00.000Z', '2026-10-24T07:00:00.000Z', '2026-10-26T08:00:00.000Z']), `every other day, 3 times, across the clock change (${at('Pills')})`);
const trip = ev.find((e) => e.title === 'Bristol trip');
ok(trip.allDay && trip.start === new Date(2026, 9, 26).getTime() && trip.end === new Date(2026, 9, 29).getTime(), 'all-day: local midnights, end exclusive');
ok(at('Emma birthday').length === 1 && ev.find((e) => e.title === 'Emma birthday').start === new Date(2026, 9, 17).getTime(), 'yearly all-day from 2009 lands on 17 Oct 2026');
ok(!at('Cancelled thing').length && !at('Declined meeting').length, 'cancelled and declined events are left out');
ok(ev.some((e) => e.title === 'Grab cards at the card shop on the way home from Convene Sancroft before it closes'), 'folded lines unfold; alarms ignored');
ok(ICS.parseDuration('P1DT2H') === 26 * 3600e3 && ICS.parseDuration('-PT15M') === -15 * 60e3, 'durations');

// Window filtering: only what overlaps the window.
const day = ICS.expand(cal, T('2026-10-26T00:00:00Z'), T('2026-10-27T00:00:00Z'));
ok(day.map((e) => e.title).join('|') === 'Bristol trip|Pills|Standup|Grab cards at the card shop on the way home from Convene Sancroft before it closes', `one day's events, in order (${day.map((e) => e.title).join('|')})`);
if (fails) { console.log(`${fails} FAILED`); process.exitCode = 1; } else console.log('ALL OK');
