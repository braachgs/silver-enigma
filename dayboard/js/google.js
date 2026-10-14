/* Day Board — Google Calendar, any number of Google accounts.
 *
 * Runs entirely in the browser with Google Identity Services' token model:
 * each "Add Google account" opens Google's account chooser and returns a
 * short-lived (about an hour) access token for that account. No server, no
 * refresh tokens; when a token lapses the board keeps showing cached events
 * and offers a one-tap "Reconnect".
 *
 * Needs an OAuth client ID (Settings -> Google Calendar, or config.js). See
 * README.md for the five-minute Google Cloud setup. */
(function (DB) {
  'use strict';
  const { plainText, findUrl, dateKey } = DB.util;

  const API = 'https://www.googleapis.com/calendar/v3';
  const SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
  const SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar.events';

  class AuthError extends Error {
    constructor(email) {
      super(`Reconnect ${email} to keep syncing`);
      this.email = email;
      this.auth = true;
    }
  }

  function clientId() {
    return (DB.store.state.settings.clientId || (window.DayBoardConfig || {}).googleClientId || '').trim();
  }

  let gisLoading = null;
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = 'https://accounts.google.com/gsi/client';
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => {
          gisLoading = null;
          reject(new Error('Could not load Google sign-in. Check your connection.'));
        };
        document.head.append(el);
      });
    }
    return gisLoading;
  }

  // Must be called from a user gesture (it opens Google's popup).
  function requestToken(email) {
    if (!clientId()) return Promise.reject(new Error('Add your Google OAuth client ID in Settings first.'));
    return loadGis().then(() => new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId(),
        scope: `${SCOPE_READ} ${SCOPE_WRITE}`,
        include_granted_scopes: true,
        prompt: email ? '' : 'select_account',
        login_hint: email || undefined,
        callback: (r) => {
          if (r && r.access_token) resolve(r);
          else reject(new Error((r && (r.error_description || r.error)) || 'Google sign-in failed'));
        },
        error_callback: (e) => reject(new Error(
          e && e.type === 'popup_closed' ? 'The Google sign-in window was closed.'
            : e && e.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in window.'
              : (e && (e.message || e.type)) || 'Google sign-in failed')),
      });
      client.requestAccessToken();
    }));
  }

  function grantFrom(r) {
    const o = google.accounts.oauth2;
    return {
      token: r.access_token,
      exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000,
      read: o.hasGrantedAllScopes(r, SCOPE_READ),
      write: o.hasGrantedAllScopes(r, SCOPE_WRITE),
    };
  }

  async function call(email, path, { method = 'GET', body, grant } = {}) {
    const t = grant || DB.store.token(email);
    if (!t) throw new AuthError(email);
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${t.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      DB.store.clearToken(email);
      throw new AuthError(email);
    }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error.message; } catch (_) { /* non-JSON error */ }
      throw new Error(msg || `Google Calendar returned ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function listCalendars(email, grant) {
    const out = [];
    let page = '';
    do {
      const q = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250' });
      if (page) q.set('pageToken', page);
      const r = await call(email, `/users/me/calendarList?${q}`, { grant });
      out.push(...(r.items || []));
      page = r.nextPageToken || '';
    } while (page);
    return out.map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      color: c.backgroundColor || '#888888',
      role: c.accessRole,
      primary: !!c.primary,
      selected: !!c.selected && !c.hidden,
    }));
  }

  // Identify the account behind a fresh token and store it.
  async function adopt(grant) {
    if (!grant.read && !grant.write) throw new Error('Day Board needs calendar access to show your events.');
    let email;
    let cals;
    if (grant.read) {
      cals = await listCalendars('(new account)', grant);
      const primary = cals.find((c) => c.primary) || cals[0];
      if (!primary) throw new Error('This Google account has no calendars.');
      email = primary.id;
    } else {
      // Only the events scope was granted: we can still use the primary calendar.
      const r = await call('(new account)', '/calendars/primary/events?maxResults=1', { grant });
      email = r.summary || 'Google account';
      cals = [{ id: 'primary', name: email, color: '#888888', role: 'owner', primary: true, selected: true }];
    }
    DB.store.setToken(email, grant);
    DB.store.upsertAccount(email, cals, grant);
    return email;
  }

  async function addAccount() {
    const r = await requestToken(null);
    return adopt(grantFrom(r));
  }

  async function reconnect(email) {
    const r = await requestToken(email);
    return adopt(grantFrom(r));
  }

  function normalize(it, acct, cal) {
    if (it.status === 'cancelled' || it.eventType === 'workingLocation') return null;
    const me = (it.attendees || []).find((a) => a.self);
    if (me && me.responseStatus === 'declined') return null;
    const allDay = !!(it.start && it.start.date);
    let start;
    let end;
    if (allDay) {
      start = DB.util.dayStart(it.start.date);
      end = DB.util.dayStart((it.end && it.end.date) || DB.util.addDays(it.start.date, 1));
      if (end <= start) end = DB.util.dayStart(DB.util.addDays(it.start.date, 1));
    } else {
      start = Date.parse(it.start && it.start.dateTime);
      end = Date.parse(it.end && it.end.dateTime);
      if (!Number.isFinite(start)) return null;
      if (!Number.isFinite(end) || end < start) end = start;
    }
    const notes = plainText(it.description || '');
    const entry = ((it.conferenceData && it.conferenceData.entryPoints) || []).find((e) => e.entryPointType === 'video');
    const priv = (it.extendedProperties && it.extendedProperties.private) || {};
    return {
      key: `g|${acct.email}|${cal.id}|${it.id}`,
      source: 'google',
      id: it.id,
      email: acct.email,
      calId: cal.id,
      calName: cal.name,
      title: it.summary || '(No title)',
      location: it.location || '',
      notes,
      allDay,
      start,
      end,
      link: it.htmlLink || null,
      video: it.hangoutLink || (entry && entry.uri) || findUrl(it.location) || findUrl(notes),
      extLine: priv.dayboardLine || null,
      extLineName: priv.dayboardLineName || null,
      writable: !!acct.write && (cal.role === 'owner' || cal.role === 'writer'),
    };
  }

  async function fetchCalendar(acct, cal, from, to) {
    const out = [];
    let page = '';
    do {
      const q = new URLSearchParams({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        maxAttendees: '1', // still includes you, so declined events can be hidden
      });
      if (page) q.set('pageToken', page);
      const r = await call(acct.email, `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      for (const it of r.items || []) {
        const ev = normalize(it, acct, cal);
        if (ev) out.push(ev);
      }
      page = r.nextPageToken || '';
    } while (page && out.length < 2500);
    return out;
  }

  // Fetch every enabled calendar of every connected account for [from, to).
  async function fetchWindow(from, to) {
    const startedAt = Date.now(); // saves made after this beat what the fetch returns
    const results = {};
    const errors = [];
    const jobs = [];
    for (const acct of DB.store.state.accounts) {
      if (!DB.store.token(acct.email)) {
        errors.push(new AuthError(acct.email));
        continue;
      }
      for (const cal of acct.calendars) {
        if (!cal.enabled) continue;
        jobs.push(fetchCalendar(acct, cal, from, to)
          .then((evs) => { results[`${acct.email}|${cal.id}`] = evs; })
          .catch((e) => errors.push(e)));
      }
    }
    await Promise.all(jobs);
    if (Object.keys(results).length || !errors.length) DB.store.putWindow(from, to, results, startedAt);
    return { errors };
  }

  // d: { title, allDay, start, end, location, notes, line }
  function eventBody(d, { patch } = {}) {
    const line = DB.store.lineById(d.line);
    const b = {
      summary: d.title,
      extendedProperties: { private: { dayboardLine: d.line || '', dayboardLineName: line ? line.name : '' } },
    };
    if (!patch || d.location != null) b.location = d.location || '';
    if (!patch || d.notes != null) b.description = d.notes || '';
    if (patch && d.start == null) return b; // times unchanged: leave them as Google has them
    if (d.allDay) {
      b.start = { date: dateKey(d.start), dateTime: patch ? null : undefined };
      b.end = { date: dateKey(d.end), dateTime: patch ? null : undefined };
    } else {
      // A new event gets this device's time zone. An edit leaves the event's
      // own zone alone (PATCH merges into start/end): a New York family
      // event edited in London stays a New York event. The UTC dateTime
      // fixes the instant either way.
      const tz = patch ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone;
      b.start = { dateTime: new Date(d.start).toISOString(), timeZone: tz, date: patch ? null : undefined };
      b.end = { dateTime: new Date(d.end).toISOString(), timeZone: tz, date: patch ? null : undefined };
    }
    return b;
  }

  function calOf(email, calId) {
    const acct = DB.store.account(email);
    const cal = acct && acct.calendars.find((c) => c.id === calId);
    if (!cal) throw new Error('That calendar is no longer connected.');
    return { acct, cal };
  }

  async function createEvent(email, calId, d) {
    const { acct, cal } = calOf(email, calId);
    const it = await call(email, `/calendars/${encodeURIComponent(calId)}/events`, { method: 'POST', body: eventBody(d) });
    const ev = normalize(it, acct, cal);
    if (ev) DB.store.putEvent(ev);
    return ev;
  }

  async function updateEvent(ev, d) {
    const { acct, cal } = calOf(ev.email, ev.calId);
    const it = await call(ev.email, `/calendars/${encodeURIComponent(ev.calId)}/events/${encodeURIComponent(ev.id)}`,
      { method: 'PATCH', body: eventBody(d, { patch: true }) });
    const out = normalize(it, acct, cal);
    if (out) DB.store.putEvent(out);
    else DB.store.dropEvent(ev);
    return out;
  }

  async function deleteEvent(ev) {
    await call(ev.email, `/calendars/${encodeURIComponent(ev.calId)}/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
    DB.store.dropEvent(ev);
  }

  // Save a line choice onto the event so it follows you to other devices.
  async function saveLine(ev, lineId) {
    const line = DB.store.lineById(lineId);
    await call(ev.email, `/calendars/${encodeURIComponent(ev.calId)}/events/${encodeURIComponent(ev.id)}`, {
      method: 'PATCH',
      body: { extendedProperties: { private: { dayboardLine: lineId, dayboardLineName: line ? line.name : '' } } },
    });
  }

  DB.google = {
    clientId, addAccount, reconnect, fetchWindow, createEvent, updateEvent, deleteEvent, saveLine,
    hasClientId: () => !!clientId(),
  };
})(window.DB);
