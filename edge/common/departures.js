/* Day Board departures for the Xeneon Edge: a port of the Android widget's
 * BoardBuilder and Remarks (dayboard-android/core: Board.kt, Remarks.kt).
 * Today's live and upcoming events, then tomorrow's first ones, with the
 * split-flap remarks: ON TIME, BOARDING, FINAL CALL, NOW, TOMORROW.
 */
(function (root) {
  const MIN = 60000;
  const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayStart = (t, plus = 0) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus).getTime(); };

  function boardTime(t, hour12) {
    const d = new Date(t);
    if (!hour12) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const h = d.getHours() % 12 || 12;
    return `${h}:${pad2(d.getMinutes())}`.padStart(5, ' ') + (d.getHours() < 12 ? 'A' : 'P');
  }
  const dayLabel = (t) => { const d = new Date(t); return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`; };

  const minutesUntil = (now, t) => Math.max(0, Math.ceil((t - now) / MIN));
  function remark(start, end, now) {
    if (end <= now && start < now) return { text: 'DEPARTED', tone: 'PAST' };
    if (start <= now) return { text: 'NOW', tone: 'LIVE' };
    const m = minutesUntil(now, start);
    if (m <= 2) return { text: 'FINAL CALL', tone: 'FINAL' };
    if (m <= 15) return { text: 'BOARDING', tone: 'BOARDING' };
    return { text: 'ON TIME', tone: 'ON_TIME' };
  }
  const remarkChange = (start, end, now) => [start - 15 * MIN, start - 2 * MIN, start, end].filter((t) => t > now).sort((a, b) => a - b)[0];

  /**
   * events: [{ title, start, end, allDay, line: {code, color} }].
   * Returns { dayLabel, rows, allDay, moreToday, message, nextChange }.
   */
  function build(events, now, maxRows, { hour12 = true, message = null } = {}) {
    const today = dayStart(now);
    const tomorrow = dayStart(now, 1);
    const dayAfter = dayStart(now, 2);
    const order = (a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title);
    const timed = events.filter((e) => !e.allDay);
    const todays = timed.filter((e) => e.start < tomorrow && e.end > now && (e.end > e.start || e.start >= now)).sort(order);
    const tomorrows = timed.filter((e) => e.start >= tomorrow && e.start < dayAfter).sort(order);
    const rows = [];
    for (const e of todays) {
      if (rows.length >= maxRows) break;
      rows.push({ event: e, line: e.line, title: e.title, time: boardTime(e.start, hour12), remark: remark(e.start, e.end, now), tomorrow: false });
    }
    for (const e of tomorrows) {
      if (rows.length >= maxRows) break;
      // Just before midnight, a departure just after it counts down as usual.
      const r = e.start - now <= 15 * MIN ? remark(e.start, e.end, now) : { text: 'TOMORROW', tone: 'INFO' };
      rows.push({ event: e, line: e.line, title: e.title, time: boardTime(e.start, hour12), remark: r, tomorrow: true });
    }
    const allDay = events.filter((e) => e.allDay && e.start < tomorrow && e.end > today).sort(order);
    const soon = tomorrows.filter((e) => e.start - 15 * MIN < tomorrow);
    const changes = todays.concat(soon).map((e) => remarkChange(e.start, e.end, now)).filter(Boolean).concat([tomorrow]);
    const emptyText = message
      || (rows.length ? null : timed.some((e) => e.end > today && e.end <= now) ? 'NO MORE DEPARTURES TODAY' : 'NO DEPARTURES TODAY');
    return {
      dayLabel: dayLabel(now),
      rows: message ? [] : rows,
      allDay: message ? [] : allDay,
      moreToday: message ? 0 : Math.max(0, todays.length - rows.filter((r) => !r.tomorrow).length),
      message: emptyText,
      nextChange: Math.min(...changes.filter((t) => t > now), tomorrow),
    };
  }

  const api = { build, remark, boardTime, dayLabel, dayStart };
  root.Departures = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
