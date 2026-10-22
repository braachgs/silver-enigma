/* Day Board — the phone's own calendars, when the board runs inside the
 * Day Board Android app. The app exposes window.DayBoardPhone (see
 * dayboard-android BoardActivity / PhoneBridge), which reads and writes
 * Android's calendar store: every Google account synced to the phone, work
 * included, with no Google sign-in, no client ID and no hourly reconnect.
 *
 * It stands in for DB.google with the same calls (fetchWindow, createEvent,
 * updateEvent, deleteEvent, saveLine), and makes events look exactly like
 * Google ones (key "g|email|calendarId|googleEventId"), so lines picked in
 * the browser carry over.
 */
(function (DB) {
  'use strict';

  const bridge = window.DayBoardPhone;
  if (!bridge) {
    DB.phone = { active: false };
    return;
  }
  const { dayStart, dateKey, findUrl, plainText } = DB.util;
  const store = DB.store;

  const call = (name, ...args) => {
    const raw = bridge[name](...args);
    const r = raw ? JSON.parse(raw) : {};
    if (r && r.error) throw new Error(r.error);
    return r;
  };

  // Android access levels (CalendarContract.Calendars): 500 contributor, 700 owner.
  const roleOf = (access) => (access >= 700 ? 'owner' : access >= 500 ? 'writer' : 'reader');
  const hex = (argb) => `#${((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;

  // A phone calendar's Google id. Android keeps it in one of a few columns;
  // prefer one the browser version already used (so its calendar lines carry
  // over), then anything shaped like a Google calendar id.
  const looksLikeId = (x) => !!x && x.includes('@') && !/[\s/]/.test(x);
  function calIdFor(c, known, taken) {
    const cands = [c.name, c.syncId, c.owner].filter(Boolean);
    const id = cands.find((x) => known.has(x)) || cands.find(looksLikeId) || `phone:${c.id}`;
    return taken.has(id) ? `phone:${c.id}` : id;
  }

  let phoneCals = new Map(); // "email|calId" -> phone calendar row (with .calId)

  // Accounts and calendars as Android has them. Lines, on/off switches and
  // account lines set earlier stay with each calendar.
  function refreshAccounts() {
    const cals = call('calendars');
    if (!Array.isArray(cals) || !cals.length) return false;
    const byAccount = new Map();
    for (const c of cals) {
      if (!byAccount.has(c.account)) byAccount.set(c.account, []);
      byAccount.get(c.account).push(c);
    }
    const next = new Map();
    for (const [email, list] of byAccount) {
      const acct = store.account(email);
      const known = new Set(acct ? acct.calendars.map((k) => k.id) : []);
      const taken = new Set();
      const rows = list.map((c) => {
        const calId = calIdFor(c, known, taken);
        taken.add(calId);
        next.set(`${email}|${calId}`, { ...c, calId });
        return {
          id: calId, name: c.displayName || c.name || calId, color: hex(c.color), role: roleOf(c.access),
          primary: c.primary, selected: c.visible,
        };
      });
      store.upsertAccount(email, rows, { write: true });
    }
    phoneCals = next;
    // Accounts the phone doesn't have can't be read here.
    for (const a of [...store.state.accounts]) if (!byAccount.has(a.email)) store.removeAccount(a.email);
    return true;
  }

  // Google numbers a repeating event's instances "<series>_<original start
  // in UTC>" (all-day: the date), as js/google.js sees them with singleEvents.
  function stamp(t, allDay) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    const day = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
    return allDay ? day : `${day}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }
  // All-day instances are stored as UTC midnights: the same date at local midnight.
  const utcDayToLocal = (t) => dayStart(new Date(t).toISOString().slice(0, 10));

  function normalize(it, email, cal) {
    if (it.status === 2 || it.selfStatus === 2) return null; // cancelled, or you declined
    const allDay = !!it.allDay;
    const start = allDay ? utcDayToLocal(it.begin) : it.begin;
    let end = allDay ? utcDayToLocal(it.end) : it.end;
    if (allDay && end <= start) end = dayStart(dateKey(start + 36e5 * 30));
    if (!(end >= start)) end = start;
    const series = it.syncId || `p${it.eventId}`;
    const id = it.repeats ? `${series}_${stamp(it.begin, allDay)}` : series;
    const notes = plainText(it.description || '');
    return {
      key: `g|${email}|${cal.calId}|${id}`,
      source: 'google',
      id,
      phoneId: it.eventId,
      phoneCal: cal.id,
      recurring: !!(it.repeats || it.exception),
      email,
      calId: cal.calId,
      calName: cal.displayName || cal.name,
      title: it.title || '(No title)',
      location: it.location || '',
      notes,
      allDay,
      start,
      end,
      link: null,
      video: findUrl(it.location) || findUrl(notes),
      extLine: null,
      extLineName: null,
      writable: roleOf(cal.access) !== 'reader',
    };
  }

  // A line picked for an event before Google gave it an id ("p123") moves to
  // its Google key once the phone has synced it.
  function adoptOverrides(events) {
    const o = store.state.overrides;
    let moved = false;
    for (const e of events) {
      if (e.id.startsWith('p')) continue;
      const temp = `g|${e.email}|${e.calId}|p${e.phoneId}`;
      if (o[temp] && !o[e.key]) { o[e.key] = o[temp]; delete o[temp]; moved = true; }
    }
    if (moved) store.commit();
  }

  async function fetchWindow(from, to) {
    const startedAt = Date.now();
    refreshAccounts();
    const rows = call('events', from, to);
    const results = {};
    for (const a of store.state.accounts) {
      for (const c of a.calendars) if (c.enabled) results[`${a.email}|${c.id}`] = [];
    }
    const byPhoneCal = new Map([...phoneCals.entries()].map(([k, c]) => [c.id, { key: k, cal: c }]));
    for (const it of Array.isArray(rows) ? rows : []) {
      const hit = byPhoneCal.get(it.calendarId);
      if (!hit || !results[hit.key]) continue;
      const ev = normalize(it, hit.key.slice(0, hit.key.indexOf('|')), hit.cal);
      if (ev) results[hit.key].push(ev);
    }
    adoptOverrides(Object.values(results).flat());
    store.putWindow(from, to, results, startedAt);
    return { errors: [] };
  }

  const around = (t) => [dayStart(dateKey(t)) - 864e5, dayStart(dateKey(t)) + 2 * 864e5];
  async function refetch(...times) {
    const ts = times.filter(Number.isFinite);
    const [from] = around(Math.min(...ts));
    const [, to] = around(Math.max(...ts));
    await fetchWindow(from, to);
  }

  function fields(d) {
    const out = {};
    if (d.title != null) out.title = d.title;
    if (d.location != null) out.location = d.location;
    if (d.notes != null) out.description = d.notes;
    if (d.start != null) {
      out.allDay = !!d.allDay;
      // All-day events are stored as UTC midnights, timed ones in this phone's zone.
      out.start = d.allDay ? Date.parse(`${dateKey(d.start)}T00:00:00Z`) : d.start;
      out.end = d.allDay ? Date.parse(`${dateKey(d.end)}T00:00:00Z`) : d.end;
      out.timeZone = d.allDay ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    return out;
  }

  function phoneCal(email, calId) {
    const c = phoneCals.get(`${email}|${calId}`);
    if (!c) throw new Error('That calendar is no longer on this phone.');
    return c;
  }

  // Repeating events need Android's own editor (this one, or every one?).
  function inCalendarApp(ev, what) {
    bridge.openEvent(String(ev.phoneId), String(ev.start));
    throw new Error(`${what} repeating events in your Calendar app. It's open now.`);
  }

  async function createEvent(email, calId, d) {
    const c = phoneCal(email, calId);
    const r = call('insertEvent', JSON.stringify({ calendar: c.id, ...fields(d) }));
    await refetch(d.start);
    const all = store.cachedEvents(email, calId);
    const ev = all.find((e) => String(e.phoneId) === String(r.id)) || null;
    // Android won't let apps save extra data on an event: the line is kept here.
    if (ev && d.line) store.setOverride(ev.key, d.line);
    return ev;
  }

  async function updateEvent(ev, d) {
    if (ev.recurring) inCalendarApp(ev, 'Edit');
    call('updateEvent', String(ev.phoneId), JSON.stringify(fields(d)));
    await refetch(ev.start, d.start);
    return store.cachedEvents(ev.email, ev.calId).find((e) => e.phoneId === ev.phoneId) || null;
  }

  async function deleteEvent(ev) {
    if (ev.recurring) inCalendarApp(ev, 'Delete');
    call('deleteEvent', String(ev.phoneId));
    store.dropEvent(ev);
  }

  // The line is already kept as an override; Android has nowhere else for it.
  const saveLine = async () => {};

  const openEvent = (ev) => bridge.openEvent(String(ev.phoneId), String(ev.start));

  // The widget follows the board's lines without "Send lines to widget".
  let sent = '';
  let sendTimer = null;
  function sendLines() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      const text = store.widgetSetup();
      if (text === sent) return;
      try { bridge.saveLines(text); sent = text; } catch (_) { /* the next change retries */ }
    }, 800);
  }
  store.subscribe(sendLines);
  sendLines();

  // The calendar store changed (a sync, or another app): fetch again.
  // (Also after calendar access is first allowed: pick up the accounts.)
  window.DayBoardPhoneChanged = () => {
    try { refreshAccounts(); } catch (_) { /* still no access */ }
    if (DB.app && DB.app.sync) DB.app.sync(true);
  };

  // Every phone account is always "connected".
  store.token = () => ({ phone: true, write: true });

  DB.phone = {
    active: true, fetchWindow, createEvent, updateEvent, deleteEvent, saveLine, openEvent, refreshAccounts,
    openWidgetSettings: () => bridge.openWidgetSettings(),
  };
  // The board calls DB.google: route those calls here.
  Object.assign(DB.google, {
    fetchWindow, createEvent, updateEvent, deleteEvent, saveLine,
    hasClientId: () => true,
    addAccount: async () => { throw new Error('Add accounts in Android Settings > Accounts.'); },
    reconnect: async () => { throw new Error('Phone accounts never need reconnecting.'); },
  });
  try { refreshAccounts(); } catch (_) { /* no calendar access yet: the app asks */ }
})(window.DB);
