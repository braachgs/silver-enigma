/* Day Board — state and persistence (localStorage).
 *
 * Lines are your categories ("Work", "Personal"...). Each line carries one
 * style per subway system, so switching systems restyles every line without
 * losing your choices. Events reach a line through, in order:
 *   1. a per-event override you picked on this device
 *   2. the line saved on the event itself (local events, or Day Board's private
 *      extended property on Google events)
 *   3. the line assigned to its Google calendar
 *   4. the default line of its Google account  (work account -> A, personal -> D)
 *   5. the first line */
(function (DB) {
  'use strict';
  const { uid, todayKey, addDays, dayStart } = DB.util;

  const KEY = 'dayboard.v1';
  const TOKENS_KEY = 'dayboard.v1.tokens';
  const CACHE_KEY = 'dayboard.v1.cache';

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  // flap.code is left unset so the board code follows the name (Work -> WRK).
  const DEFAULT_LINES = [
    { name: 'Work', nyc: { letter: 'A', color: 'blue' }, london: { line: 'victoria' }, flap: { color: 'blue' } },
    { name: 'Focus', nyc: { letter: 'B', color: 'orange' }, london: { line: 'bakerloo' }, flap: { color: 'orange' } },
    { name: 'Deadlines', nyc: { letter: 'C', color: 'red' }, london: { line: 'central' }, flap: { color: 'red' } },
    { name: 'Personal', nyc: { letter: 'D', color: 'yellow' }, london: { line: 'circle' }, flap: { color: 'yellow' } },
    { name: 'Health', nyc: { letter: 'E', color: 'green' }, london: { line: 'district' }, flap: { color: 'green' } },
    { name: 'Social', nyc: { letter: 'F', color: 'purple' }, london: { line: 'metropolitan' }, flap: { color: 'magenta' } },
  ];

  function freshState() {
    return {
      version: 1,
      system: 'nyc',
      lines: DEFAULT_LINES.map((l) => ({ id: uid(), name: l.name, nyc: { ...l.nyc }, london: { ...l.london }, flap: { ...l.flap } })),
      accounts: [], // { email, defaultLine, write, calendars: [{ id, name, color, role, primary, enabled, line }] }
      localEvents: [], // { id, title, allDay, start, end, location, notes, line }
      overrides: {}, // event key -> line id
      settings: {
        hour12: 'auto', // 'auto' | true | false
        showDeparted: false,
        announce: false,
        flapSound: false,
        sample: true,
        clientId: '',
        lastDest: 'local',
      },
    };
  }

  const base = freshState();
  const saved = read(KEY);
  const state = saved && saved.version === 1
    ? { ...base, ...saved, settings: { ...base.settings, ...(saved.settings || {}) } }
    : base;
  if (!Array.isArray(state.lines) || !state.lines.length) state.lines = base.lines;
  if (!DB.SYSTEMS[state.system]) state.system = 'nyc';

  let tokens = read(TOKENS_KEY) || {};
  let cache = read(CACHE_KEY) || { cals: {}, fetched: null };

  const listeners = new Set();
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function commit() {
    write(KEY, state);
    listeners.forEach((fn) => fn());
  }

  // ---------------------------------------------------------------- lines
  const lineById = (id) => (id ? state.lines.find((l) => l.id === id) : null);
  const lineByName = (name) => (name ? state.lines.find((l) => l.name.toLowerCase() === String(name).toLowerCase()) : null);

  function nextLineDefaults() {
    const P = DB.palette;
    const usedLetters = new Set(state.lines.map((l) => l.nyc && l.nyc.letter));
    const letter = P.MTA_LETTERS.find((x) => !usedLetters.has(x)) || 'S';
    const usedTube = new Set(state.lines.map((l) => l.london && l.london.line));
    const tube = (P.TFL_LINES.find((x) => !usedTube.has(x.id)) || P.TFL_LINES[0]).id;
    const color = P.MTA_LETTER_COLOR[letter] || 'blue';
    return { nyc: { letter, color }, london: { line: tube }, flap: { color: P.NYC_TO_FLAP[color] || 'blue' } };
  }

  function addLine(name, styles) {
    const line = { id: uid(), name: name || 'New line', ...nextLineDefaults(), ...(styles || {}) };
    state.lines.push(line);
    commit();
    return line;
  }
  function updateLine(id, patch) {
    const l = lineById(id);
    if (!l) return;
    if (patch.name != null) l.name = patch.name;
    if (patch.nyc) l.nyc = { ...l.nyc, ...patch.nyc };
    if (patch.london) l.london = { ...l.london, ...patch.london };
    if (patch.flap) {
      l.flap = { ...(l.flap || {}), ...patch.flap };
      if (!l.flap.code) delete l.flap.code; // blank code -> derive from the name
    }
    commit();
  }
  function removeLine(id) {
    if (state.lines.length <= 1) return;
    state.lines = state.lines.filter((l) => l.id !== id);
    for (const a of state.accounts) {
      if (a.defaultLine === id) a.defaultLine = null;
      for (const c of a.calendars) if (c.line === id) c.line = null;
    }
    for (const e of state.localEvents) if (e.line === id) e.line = state.lines[0].id;
    for (const k of Object.keys(state.overrides)) if (state.overrides[k] === id) delete state.overrides[k];
    commit();
  }
  function moveLine(id, dir) {
    const i = state.lines.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.lines.length) return;
    [state.lines[i], state.lines[j]] = [state.lines[j], state.lines[i]];
    commit();
  }

  function account(email) {
    return state.accounts.find((a) => a.email === email) || null;
  }

  function resolveLine(ev) {
    const o = lineById(state.overrides[ev.key]);
    if (o) return o;
    const own = lineById(ev.line) || lineById(ev.extLine) || lineByName(ev.extLineName);
    if (own) return own;
    if (ev.source === 'google') {
      const a = account(ev.email);
      const c = a && a.calendars.find((x) => x.id === ev.calId);
      const viaCal = lineById(c && c.line) || lineById(a && a.defaultLine);
      if (viaCal) return viaCal;
    }
    return state.lines[0];
  }
  function setOverride(key, lineId) {
    if (lineId) state.overrides[key] = lineId;
    else delete state.overrides[key];
    commit();
  }

  // -------------------------------------------------------------- accounts
  function upsertAccount(email, calendars, grant) {
    let a = account(email);
    if (!a) {
      // Give each new account its own line: first account -> first line,
      // later accounts -> "Personal" if free, else the next unused line.
      const taken = new Set(state.accounts.map((x) => x.defaultLine));
      const personal = lineByName('Personal');
      const pick = !state.accounts.length
        ? state.lines[0]
        : (personal && !taken.has(personal.id) ? personal : state.lines.find((l) => !taken.has(l.id)) || state.lines[0]);
      a = { email, defaultLine: pick.id, write: false, calendars: [] };
      state.accounts.push(a);
    }
    a.write = !!(grant && grant.write);
    const prev = new Map(a.calendars.map((c) => [c.id, c]));
    a.calendars = calendars.map((c) => {
      const old = prev.get(c.id);
      return {
        id: c.id, name: c.name, color: c.color, role: c.role, primary: c.primary,
        enabled: old ? old.enabled : (c.primary || c.selected),
        line: old ? old.line : null,
      };
    });
    // Primary first, then alphabetical.
    a.calendars.sort((x, y) => (y.primary - x.primary) || x.name.localeCompare(y.name));
    commit();
    return a;
  }
  function updateAccount(email, patch) {
    const a = account(email);
    if (!a) return;
    Object.assign(a, patch);
    commit();
  }
  function updateCalendar(email, calId, patch) {
    const a = account(email);
    const c = a && a.calendars.find((x) => x.id === calId);
    if (!c) return;
    Object.assign(c, patch);
    commit();
  }
  function removeAccount(email) {
    state.accounts = state.accounts.filter((a) => a.email !== email);
    delete tokens[email];
    write(TOKENS_KEY, tokens);
    for (const k of Object.keys(cache.cals)) if (k.startsWith(`${email}|`)) delete cache.cals[k];
    write(CACHE_KEY, cache);
    commit();
  }

  // ---------------------------------------------------------------- tokens
  function token(email) {
    const t = tokens[email];
    return t && t.exp > Date.now() ? t : null;
  }
  function setToken(email, t) {
    tokens[email] = t;
    write(TOKENS_KEY, tokens);
  }
  function clearToken(email) {
    delete tokens[email];
    write(TOKENS_KEY, tokens);
  }

  // ----------------------------------------------------------------- cache
  // cache.cals["email|calendarId"] = normalized events; cache.fetched = last window.
  function cachedEvents(email, calId) {
    return cache.cals[`${email}|${calId}`] || [];
  }
  function putWindow(from, to, results) {
    for (const [calKey, events] of Object.entries(results)) {
      // Fresh copies replace old ones by id, wherever the old ones sat. Google
      // judges an all-day event's end in its calendar's time zone, so a UTC
      // or New York all-day event ending at London midnight comes back in
      // the next window too, and an event moved on Google keeps its id while
      // its old copy may sit outside the window; keeping both would duplicate
      // or ghost it.
      const fresh = new Set(events.map((e) => e.id));
      const keep = (cache.cals[calKey] || []).filter((e) => !fresh.has(e.id) && (e.end <= from || e.start >= to));
      cache.cals[calKey] = keep.concat(events);
    }
    cache.fetched = { from, to, at: Date.now() };
    pruneCache();
    write(CACHE_KEY, cache);
    commit();
  }
  function putEvent(ev) {
    const calKey = `${ev.email}|${ev.calId}`;
    cache.cals[calKey] = (cache.cals[calKey] || []).filter((e) => e.id !== ev.id).concat(ev);
    write(CACHE_KEY, cache);
    commit();
  }
  function dropEvent(ev) {
    const calKey = `${ev.email}|${ev.calId}`;
    cache.cals[calKey] = (cache.cals[calKey] || []).filter((e) => e.id !== ev.id);
    write(CACHE_KEY, cache);
    commit();
  }
  function pruneCache() {
    const lo = dayStart(addDays(todayKey(), -30));
    const hi = dayStart(addDays(todayKey(), 60));
    for (const k of Object.keys(cache.cals)) cache.cals[k] = cache.cals[k].filter((e) => e.end > lo && e.start < hi);
  }
  function covered(from, to, maxAge) {
    const f = cache.fetched;
    return !!(f && f.from <= from && f.to >= to && Date.now() - f.at < maxAge);
  }
  function lastFetch() {
    return cache.fetched && cache.fetched.at;
  }

  // ---------------------------------------------------------- local events
  function addLocal(ev) {
    const e = { id: uid(), ...ev };
    state.localEvents.push(e);
    commit();
    return e;
  }
  function updateLocal(id, patch) {
    const e = state.localEvents.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    commit();
  }
  function removeLocal(id) {
    state.localEvents = state.localEvents.filter((x) => x.id !== id);
    commit();
  }

  function set(path, value) {
    if (path === 'system') state.system = value;
    else state.settings[path] = value;
    commit();
  }

  function resetAll() {
    for (const k of [KEY, TOKENS_KEY, CACHE_KEY]) {
      try { localStorage.removeItem(k); } catch (_) { /* storage unavailable */ }
    }
  }

  DB.store = {
    state, subscribe, commit, set,
    lineById, nextLineDefaults, addLine, updateLine, removeLine, moveLine, resolveLine, setOverride,
    account, upsertAccount, updateAccount, updateCalendar, removeAccount,
    token, setToken, clearToken,
    cachedEvents, putWindow, putEvent, dropEvent, covered, lastFetch,
    addLocal, updateLocal, removeLocal, resetAll,
  };
})(window.DB);
