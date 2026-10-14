/* Day Board — the app: Board, Lines and Add tabs, sheets, platform display,
 * announcements and Google sync. */
(function (DB) {
  'use strict';
  const U = DB.util;
  const { h, s, icon, todayKey, addDays, dayStart, dayEnd, dateKey } = U;
  const store = DB.store;
  const sys = () => DB.SYSTEMS[store.state.system];
  const h12 = () => store.state.settings.hour12;
  const mins = DB.minutesBetween;

  const ui = {
    tab: 'board',
    date: todayKey(),
    filter: null, // line id
    picker: false,
    pickerMonth: null, // any day key inside the month shown
    allDayOpen: false,
    departedOpen: null, // null -> follow settings.showDeparted
    editKey: null,
    syncing: false,
    sampleAnchor: Date.now(),
  };

  const view = document.getElementById('view');
  const bannerEl = document.getElementById('banner');
  const tabsEl = document.getElementById('tabs');
  const dialog = document.getElementById('sheet');
  const displayEl = document.getElementById('display');
  const toastEl = document.getElementById('toast');

  // ------------------------------------------------------------- events
  let sampleCache = null;

  function sampleActive() {
    const st = store.state;
    return !!st.settings.sample && !st.accounts.length && !st.localEvents.length;
  }

  function localEvent(e) {
    return {
      key: `l|${e.id}`, source: 'local', id: e.id, title: e.title, location: e.location || '', notes: e.notes || '',
      allDay: !!e.allDay, start: e.start, end: e.end, line: e.line, writable: true,
      video: U.findUrl(e.location) || U.findUrl(e.notes),
    };
  }

  function allEvents() {
    const st = store.state;
    const out = [];
    if (sampleActive()) {
      if (!sampleCache || sampleCache.system !== st.system) {
        sampleCache = { system: st.system, events: DB.sample.build(ui.sampleAnchor, st.system) };
      }
      out.push(...sampleCache.events);
    }
    for (const e of st.localEvents) out.push(localEvent(e));
    for (const a of st.accounts) {
      for (const c of a.calendars) if (c.enabled) out.push(...store.cachedEvents(a.email, c.id));
    }
    return out;
  }

  const withLine = (e) => ({ ...e, lineObj: store.resolveLine(e) });
  const byStart = (a, b) => a.start - b.start || a.end - b.end || a.title.localeCompare(b.title);

  function eventsOn(key) {
    const a = dayStart(key);
    const b = dayEnd(key);
    return allEvents()
      .filter((e) => e.start < b && (e.end > a || (e.end === e.start && e.start >= a)))
      .map(withLine);
  }

  function findEvent(key) {
    const e = allEvents().find((x) => x.key === key);
    return e ? withLine(e) : null;
  }

  const safeHref = (u) => (u && /^https?:\/\//i.test(u) ? u : null);
  // Preview hosts (e.g. an embedded viewer) can't load Google sign-in.
  const isPreview = () => !!(window.DayBoardConfig || {}).preview;

  // Two-tap confirmation for destructive buttons: works everywhere, unlike
  // window.confirm, which some app views block.
  function confirmTap(btn, prompt, action) {
    if (btn.dataset.armed === '1') {
      action();
      return;
    }
    const label = btn.textContent;
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = prompt;
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.dataset.armed = '';
      btn.classList.remove('armed');
      btn.textContent = label;
    }, 4000);
  }

  function durText(m) {
    if (m < 60) return `${m} min`;
    const r = m % 60;
    return `${Math.floor(m / 60)} hr${r ? ` ${r} min` : ''}`;
  }

  function relText(e, now) {
    const S = sys();
    if (e.allDay) return S.copy.allDayTitle;
    const sameDay = dateKey(e.start) === todayKey();
    if (e.start <= now && e.end > now) return `${S.copy.liveTag} · ${durText(mins(now, e.end))} left`;
    if (e.start > now) {
      if (!sameDay) return S.dateShort(e.start);
      const m = mins(now, e.start);
      return m < 1 ? S.copy.arriving : `In ${durText(m)}`;
    }
    return sameDay ? S.copy.departed : S.dateShort(e.start);
  }

  function timeRange(e) {
    const S = sys();
    if (e.allDay) {
      const days = Math.round((e.end - e.start) / 86400000);
      return days > 1 ? `${S.copy.allDayTitle} · ${days} days` : S.copy.allDayTitle;
    }
    return `${S.time(e.start, h12())} – ${S.time(e.end, h12())}`;
  }

  function ago(t) {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    return `${Math.floor(m / 60)} hr ago`;
  }

  // Events (on any line) that overlap another timed event: "delays".
  function conflictCounts(timed) {
    const counts = new Map();
    for (const e of timed) {
      if (timed.some((o) => o !== e && o.start < e.end && e.start < o.end)) {
        counts.set(e.lineObj.id, (counts.get(e.lineObj.id) || 0) + 1);
      }
    }
    return counts;
  }

  // ------------------------------------------------------------- render
  let holdUntil = 0; // a day swipe owns the screen until then (see initSwipe)
  let missedRender = false;

  let shownDate = ui.date; // the day the screen last showed (renders can be held)

  function render() {
    if (Date.now() < holdUntil) { missedRender = true; return; }
    missedRender = false;
    rollover();
    shownDate = ui.date;
    const S = sys();
    document.documentElement.dataset.system = S.id;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', S.themeColor);
    renderBanner();
    renderTabs();
    if (ui.tab === 'board') view.replaceChildren(boardView());
    else if (ui.tab === 'lines') view.replaceChildren(linesView());
    else if (!view.querySelector('.add-view')) view.replaceChildren(addView());
  }

  function renderBanner() {
    const S = sys();
    const items = [];
    if (sampleActive()) {
      items.push(h('div', { class: 'banner' },
        h('span', {}, S.copy.sample),
        h('button', {
          class: 'banner-x', 'aria-label': 'Hide the sample day',
          onclick: () => { store.set('sample', false); toast('Sample day hidden. Turn it back on in Settings.'); },
        }, icon('close', 18))));
    }
    const expired = store.state.accounts.filter((a) => !store.token(a.email));
    if (expired.length) {
      items.push(h('button', { class: 'banner warn', onclick: () => reconnectFlow(expired[0].email) },
        h('span', {}, expired.length === 1 ? `Reconnect ${expired[0].email}` : `Reconnect ${expired.length} Google accounts`),
        h('span', { class: 'banner-cta' }, 'Tap')));
    }
    bannerEl.replaceChildren(...items);
  }

  const TABS = [
    { id: 'board', label: 'Board', icon: 'board' },
    { id: 'lines', label: 'Lines', icon: 'lines' },
    { id: 'add', label: 'Add', icon: 'plus' },
  ];
  function renderTabs() {
    if (!tabsEl.children.length) {
      tabsEl.append(...TABS.map((t) => h('button', { class: 'tab-btn', 'data-tab': t.id, onclick: () => setTab(t.id) },
        icon(t.icon, 22), h('span', {}, t.label))));
    }
    for (const b of tabsEl.children) b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false');
  }

  function setTab(t) {
    if (t !== 'add') ui.editKey = null;
    ui.tab = t;
    ui.picker = false;
    if (t === 'add') view.replaceChildren(addView());
    render();
    window.scrollTo(0, 0);
  }

  function goDate(k) {
    ui.date = k;
    ui.filter = null;
    ui.allDayOpen = false;
    ui.picker = false;
    render();
    sync(false);
  }

  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const panes = () => [...view.querySelectorAll('.swipe-pane')];

  // Move to day k with the board's own transition: split-flap rows flip in
  // from blank, and subway boards slide in from the side the day came from.
  function moveTo(k, dir) {
    holdUntil = 0;
    const flapIn = ui.tab === 'board' && sys().layout === 'flap';
    if (flapIn) DB.flap.prime('board');
    goDate(k);
    if (flapIn || reduceMotion() || !dir) return;
    for (const p of panes()) {
      if (p.animate) {
        p.animate([{ transform: `translateX(${dir * 24}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
          { duration: 220, easing: 'cubic-bezier(.2, .7, .2, 1)' });
      }
    }
  }
  // One day on from the day on screen. While a swipe holds rendering, the
  // midnight rollover may already have moved ui.date past what you can see.
  const shiftDay = (step) => moveTo(addDays(shownDate, step), step);

  // Whole days from a to b, counted on day keys so a 23- or 25-hour
  // clock-change day still counts as one.
  const daysBetween = (a, b) => Math.round((U.parseKey(b) - U.parseKey(a)) / 86400000);

  // "today", "tomorrow", "yesterday", "in 3 days", "2 days ago".
  function relDay(k) {
    const n = daysBetween(todayKey(), k);
    try {
      return new Intl.RelativeTimeFormat(sys().locale, { numeric: 'auto' }).format(n, 'day');
    } catch (_) {
      return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`;
    }
  }

  // Which day is on screen, said in words above the date: TODAY on today,
  // TOMORROW, 3 DAYS AGO and so on otherwise. The word "today" only ever
  // appears next to the day that really is today.
  function dayKicker() {
    return h('span', { class: `hdr-kicker${ui.date === todayKey() ? ' is-today' : ''}` }, relDay(ui.date));
  }

  // On any other day, a jump back to today on its own row under the date, so
  // it reads as an action rather than as a tag on the date.
  function backToToday() {
    const today = todayKey();
    if (ui.date === today) return null;
    const ahead = ui.date > today;
    return h('button', {
      class: 'today-btn', 'aria-label': `Back to today, ${sys().dateLong(dayStart(today))}`,
      onclick: () => moveTo(today, ahead ? -1 : 1),
    }, ahead ? icon('left', 14) : null, h('span', {}, 'Back to today'), ahead ? null : icon('right', 14));
  }

  function chromeTop() {
    return h('div', { class: 'rule-band', 'aria-hidden': 'true' });
  }

  function headerActions(extra) {
    return h('div', { class: 'hdr-actions' }, extra,
      h('button', { class: 'icon-btn', 'aria-label': 'Settings', onclick: openSettings }, icon('gear', 22)));
  }

  // -------------------------------------------------------------- board
  function boardHeader(evs) {
    const S = sys();
    const isToday = ui.date === todayKey();
    const timed = evs.filter((e) => !e.allDay);
    const allDay = evs.filter((e) => e.allDay);
    const present = store.state.lines.filter((l) => evs.some((e) => e.lineObj.id === l.id));

    const badges = present.map((l) => h('button', {
      class: `line-filter${ui.filter && ui.filter !== l.id ? ' dim' : ''}`,
      'aria-pressed': String(ui.filter === l.id),
      title: ui.filter === l.id ? 'Show all lines' : `Show only ${l.name}`,
      onclick: () => { ui.filter = ui.filter === l.id ? null : l.id; render(); },
    }, S.badge(l, { allDay: !timed.some((e) => e.lineObj.id === l.id) })));

    return h('header', { class: 'chrome' },
      chromeTop(),
      h('div', { class: 'hdr' },
        S.logo ? h('span', { class: 'hdr-logo' }, S.logo(40)) : null,
        h('div', { class: 'hdr-day' },
          dayKicker(),
          h('button', {
            class: 'date-btn', 'aria-expanded': String(ui.picker),
            'aria-label': `${S.dateLong(dayStart(ui.date))}, ${relDay(ui.date)}, choose date`,
            onclick: () => { ui.picker = !ui.picker; ui.pickerMonth = ui.date; render(); },
          }, h('span', { class: 'date-text' }, S.dateLong(dayStart(ui.date))), h('span', { class: 'chev' }, icon('chevron', 22))),
          backToToday()),
        headerActions(h('button', { class: 'icon-btn', 'aria-label': 'Platform display', onclick: openDisplay }, icon('display', 20)))),
      ui.picker ? datePicker() : null,
      badges.length || allDay.length
        ? h('div', { class: 'hdr-lines' }, badges,
          allDay.length ? h('button', {
            class: 'pill', 'aria-expanded': String(ui.allDayOpen),
            onclick: () => { ui.allDayOpen = !ui.allDayOpen; render(); },
          }, h('span', { class: 'pill-diamond', 'aria-hidden': 'true' }), S.copy.allDay(allDay.length)) : null)
        : null,
      ui.allDayOpen && allDay.length ? allDayPanel(allDay) : null,
      h('div', { class: 'colhead' }, h('span', {}, S.copy.departures), h('span', {}, isToday ? S.copy.timeCol : S.copy.timeColOther)));
  }

  function allDayPanel(list) {
    const S = sys();
    return h('ul', { class: 'allday-list' }, list.map((e) => h('li', {},
      h('button', { class: 'allday-item', onclick: () => openDetail(e.key) },
        S.badge(e.lineObj, { allDay: true }), h('span', {}, e.title)))));
  }

  function datePicker() {
    const S = sys();
    const first = U.parseKey(ui.pickerMonth || ui.date);
    first.setDate(1);
    const y = first.getFullYear();
    const m = first.getMonth();
    const from = first.getTime();
    const to = new Date(y, m + 1, 1).getTime();
    const dots = new Map();
    for (const e of allEvents()) {
      if (e.start >= to || e.end <= from) continue;
      const hex = S.style(store.resolveLine(e)).hex;
      let k = dateKey(Math.max(e.start, from));
      for (let i = 0; i < 31 && dayStart(k) < Math.min(Math.max(e.end, e.start + 1), to); i++, k = addDays(k, 1)) {
        if (!dots.has(k)) dots.set(k, new Set());
        dots.get(k).add(hex);
      }
    }
    const weekday = new Intl.DateTimeFormat(S.locale, { weekday: 'narrow' });
    const sunday = new Date(2026, 0, 4); // a Sunday
    const heads = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(sunday);
      d.setDate(4 + ((S.weekStart + i) % 7));
      return h('span', { class: 'pk-wd', 'aria-hidden': 'true' }, weekday.format(d));
    });
    const lead = (first.getDay() - S.weekStart + 7) % 7;
    const count = new Date(y, m + 1, 0).getDate();
    const today = todayKey();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'pk-blank' }));
    for (let d = 1; d <= count; d++) {
      const k = dateKey(new Date(y, m, d));
      const ds = [...(dots.get(k) || [])].slice(0, 3);
      cells.push(h('button', {
        class: `pk-day${k === today ? ' today' : ''}${k === ui.date ? ' sel' : ''}`,
        'aria-label': k === today ? `${S.dateLong(dayStart(k))}, today` : S.dateLong(dayStart(k)),
        'aria-current': k === ui.date ? 'date' : null,
        onclick: () => goDate(k),
      }, h('span', {}, String(d)), h('span', { class: 'pk-dots' }, ds.map((c) => h('i', { style: { background: c } })))));
    }
    const shift = (n) => { const d = U.parseKey(dateKey(first)); d.setMonth(d.getMonth() + n); ui.pickerMonth = dateKey(d); render(); };
    return h('div', { class: 'picker' },
      h('div', { class: 'pk-head' },
        h('button', { class: 'icon-btn sm', 'aria-label': 'Previous month', onclick: () => shift(-1) }, icon('left', 18)),
        h('strong', {}, S.monthTitle(first)),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Next month', onclick: () => shift(1) }, icon('right', 18))),
      h('div', { class: 'pk-grid' }, heads, cells));
  }

  function row(e, { live = false, primary = false, past = false, clock = false, now = Date.now() } = {}) {
    const S = sys();
    if (S.layout === 'flap') return flapRow(e, { live, primary, past, now });
    let count;
    if (clock || past) {
      const p = S.timeParts(e.start, h12());
      count = { big: p.main, unit: p.ap };
    } else {
      count = S.countdown(mins(now, live ? e.end : e.start), live);
    }
    const when = clock || past ? timeRange(e) : S.time(e.start, h12());
    const progress = live ? Math.min(1, Math.max(0, (now - e.start) / Math.max(1, e.end - e.start))) : null;
    return h('button', {
      class: `row${live ? ' live' : ''}${primary ? ' primary' : ''}${past ? ' past' : ''}`,
      onclick: () => openDetail(e.key),
    },
    h('span', { class: 'row-badge' }, S.badge(e.lineObj, { outline: primary })),
    h('span', { class: 'row-main' },
      live ? h('span', { class: 'tag' }, S.copy.liveTag) : null,
      h('span', { class: 'row-title' }, e.title),
      e.location ? h('span', { class: 'row-sub' }, e.location) : null,
      h('span', { class: 'row-when' }, when)),
    h('span', { class: 'row-count' }, h('b', {}, count.big), count.unit ? h('small', {}, count.unit) : null),
    progress != null ? h('span', { class: 'progress', 'aria-hidden': 'true' },
      h('i', { style: { width: `${(progress * 100).toFixed(1)}%` } })) : null);
  }

  // How many flap cells fit across a board row (matches the CSS cell size).
  function flapCells() {
    const vw = Math.min(window.innerWidth || 390, 520);
    const pitch = Math.max(12, Math.min(15, vw * 0.038)) + 2;
    return Math.max(8, Math.floor((vw - 98) / pitch));
  }

  // Split-flap row: scheduled time and remarks on top, the event title across
  // one or two flap lines, then location and duration in small type.
  function flapRow(e, { live = false, primary = false, past = false, now = Date.now() } = {}) {
    const S = sys();
    const F = DB.flap;
    const width = flapCells();
    const time = S.boardTime(e.start, h12());
    // Another day's board isn't live: its departures are SCHEDULED, not ON TIME.
    const rk = e.start > now && ui.date > todayKey() ? { text: S.copy.scheduled, tone: 'info' } : S.remark(e, now);
    const dur = Math.max(0, Math.round((e.end - e.start) / 60000));
    const sub = [e.location, live ? `${durText(mins(now, e.end))} left` : dur ? durText(dur) : null].filter(Boolean).join(' · ');
    const progress = live ? Math.min(1, Math.max(0, (now - e.start) / Math.max(1, e.end - e.start))) : null;
    return h('button', {
      class: `row flaprow${live ? ' live' : ''}${primary ? ' primary' : ''}${past ? ' past' : ''}`,
      onclick: () => openDetail(e.key),
    },
    h('span', { class: 'row-badge' }, S.badge(e.lineObj, { outline: primary })),
    h('span', { class: 'fr-main' },
      h('span', { class: 'fr-top' },
        F.text(time, time.length, `${e.key}|t`, 'board', { cls: 'fl-time' }),
        F.text(rk.text, 10, `${e.key}|r`, 'board', { cls: `fl-remark tone-${rk.tone}`, delay: 120 })),
      F.legible(e.title)
        ? F.wrap(e.title, width, 2).map((line, i) => F.text(line, width, `${e.key}|d${i}`, 'board',
          { cls: 'fl-dest', delay: 60 + i * 80, label: i === 0 ? e.title : '' }))
        : h('span', { class: 'row-title fr-plain' }, e.title),
      sub ? h('span', { class: 'row-sub' }, sub) : null),
    progress != null ? h('span', { class: 'progress', 'aria-hidden': 'true' },
      h('i', { style: { width: `${(progress * 100).toFixed(1)}%` } })) : null);
  }

  function emptyState(title, sub) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-sign' }, chromeTop(), h('p', {}, title)),
      h('p', { class: 'empty-sub' }, sub),
      h('button', { class: 'btn-outline', onclick: () => setTab('add') }, 'Add event'));
  }

  function boardFooter() {
    const st = store.state;
    if (isPreview() && !st.accounts.length) {
      return h('footer', { class: 'board-foot' }, h('span', {}, 'Preview · events you add stay in this browser'));
    }
    if (!st.accounts.length) {
      return h('footer', { class: 'board-foot' },
        h('span', {}, 'Connect Google Calendar in '),
        h('button', { class: 'link-btn', onclick: openSettings }, 'Settings'));
    }
    const last = store.lastFetch();
    return h('footer', { class: 'board-foot' },
      h('span', {}, ui.syncing ? 'Syncing…' : last ? `Synced ${ago(last)}` : 'Not synced yet'),
      ui.syncing ? null : h('button', { class: 'link-btn', onclick: () => sync(true) }, 'Sync now'));
  }

  function boardView() {
    const S = sys();
    const now = Date.now();
    DB.flap.begin('board');
    const today = todayKey();
    const isToday = ui.date === today;
    let evs = eventsOn(ui.date);
    if (ui.filter && !store.lineById(ui.filter)) ui.filter = null;
    const header = boardHeader(evs);
    if (ui.filter) evs = evs.filter((e) => e.lineObj.id === ui.filter);
    const timed = evs.filter((e) => !e.allDay).sort(byStart);
    const list = h('section', { class: 'board swipe-pane', 'aria-label': S.copy.departures });

    if (!timed.length) {
      list.append(emptyState(S.copy.empty, evs.length ? 'Only all-day events on this day.' : S.copy.emptySub));
    } else if (isToday) {
      const live = timed.filter((e) => e.start <= now && e.end > now);
      const next = timed.filter((e) => e.start > now);
      const gone = timed.filter((e) => e.start <= now && e.end <= now);
      live.forEach((e, i) => list.append(row(e, { live: true, primary: i === 0, now })));
      next.forEach((e) => list.append(row(e, { now })));
      if (!live.length && !next.length) list.append(emptyState(S.copy.ended, S.copy.endedSub));
      if (gone.length) {
        const open = ui.departedOpen == null ? store.state.settings.showDeparted : ui.departedOpen;
        list.append(h('button', {
          class: 'departed-toggle', 'aria-expanded': String(open),
          onclick: () => { ui.departedOpen = !open; render(); },
        }, h('span', {}, `${S.copy.departed} · ${gone.length}`), icon('chevron', 16)));
        if (open) gone.forEach((e) => list.append(row(e, { past: true })));
      }
    } else {
      const past = ui.date < today;
      timed.forEach((e) => list.append(row(e, { past, clock: true })));
    }
    list.append(boardFooter());
    DB.flap.end('board');
    // Let a flip cascade finish before the clock-driven redraw replaces it.
    if (DB.flap.takeFlips('board')) flapBusyUntil = Date.now() + 1800;

    return h('div', { class: 'board-view' }, header, list);
  }

  // Swipe anywhere on the Board or Lines tab to change day: left for the next
  // day, right for the previous one. The day follows your finger; a long or
  // quick swipe moves a day and a short one springs back. Vertical scrolling
  // stays with the browser (touch-action: pan-y on #app), and swipes that
  // start at the screen edge are left to Android's back gesture.
  function initSwipe(root) {
    const EDGE = 24;
    let g = null; // the gesture in progress
    let noClickUntil = 0;

    const width = () => view.clientWidth || window.innerWidth;
    const flushLater = (ms) => setTimeout(() => { if (missedRender && Date.now() >= holdUntil) render(); }, ms);

    function follow(dx) {
      if (reduceMotion()) return;
      const fade = String(1 - Math.min(0.5, (Math.abs(dx) / width()) * 0.6));
      for (const p of panes()) {
        p.style.transform = `translateX(${dx}px)`;
        p.style.opacity = fade;
      }
    }

    function springBack() {
      for (const p of panes()) {
        const from = { transform: p.style.transform || 'none', opacity: p.style.opacity || '1' };
        p.style.transform = '';
        p.style.opacity = '';
        if (p.animate && !reduceMotion()) p.animate([from, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'ease-out' });
      }
      holdUntil = Date.now() + 200;
      flushLater(220);
    }

    function finish(dx, v) {
      noClickUntil = Date.now() + 400;
      const far = Math.abs(dx) > Math.min(100, width() * 0.25);
      const flick = Math.abs(dx) > 40 && Math.abs(v) > 0.35 && Math.sign(v) === Math.sign(dx);
      if (!far && !flick) { springBack(); return; }
      const step = dx < 0 ? 1 : -1;
      // Flap boards don't slide: the new day flips in where the board stands.
      if (reduceMotion() || (ui.tab === 'board' && sys().layout === 'flap')) { shiftDay(step); return; }
      holdUntil = Date.now() + 600;
      const out = panes().filter((p) => p.animate).map((p) => p.animate([
        { transform: p.style.transform || 'none', opacity: p.style.opacity || '1' },
        { transform: `translateX(${-step * width()}px)`, opacity: 0 },
      ], { duration: 140, easing: 'ease-in', fill: 'forwards' }).finished);
      Promise.all(out).catch(() => {}).then(() => shiftDay(step));
    }

    root.addEventListener('touchstart', (e) => {
      g = null;
      if (e.touches.length !== 1 || ui.tab === 'add' || dialog.open || !displayEl.hidden) return;
      if (e.target.closest('input, textarea, select, .picker')) return;
      const t = e.touches[0];
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
      g = { x0: t.clientX, y0: t.clientY, x: t.clientX, t: e.timeStamp, dx: 0, v: 0, axis: null };
    }, { passive: true });

    // Not passive: once a drag is horizontal, it mustn't also scroll the page.
    root.addEventListener('touchmove', (e) => {
      if (!g) return;
      if (e.touches.length !== 1) { // a second finger: give the gesture back (pinch zoom)
        if (g.axis === 'x') springBack();
        g = null;
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.axis) {
        if (Math.hypot(dx, dy) < 10) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      if (g.axis !== 'x') return;
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - g.t;
      if (dt > 0) g.v = 0.8 * ((t.clientX - g.x) / dt) + 0.2 * g.v;
      g.x = t.clientX;
      g.t = e.timeStamp;
      g.dx = dx;
      holdUntil = Date.now() + 1500; // keep clock redraws off the panes mid-drag
      follow(dx);
    }, { passive: false });

    root.addEventListener('touchend', () => {
      if (g && g.axis === 'x') finish(g.dx, g.v);
      g = null;
    }, { passive: true });
    root.addEventListener('touchcancel', () => {
      if (g && g.axis === 'x') springBack();
      g = null;
    }, { passive: true });

    // A drag that began on an event row must not also open that event.
    root.addEventListener('click', (e) => {
      if (Date.now() < noClickUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  // -------------------------------------------------------------- lines
  function linesView() {
    const S = sys();
    const evs = eventsOn(ui.date);
    const isToday = ui.date === todayKey();
    const conflicts = conflictCounts(evs.filter((e) => !e.allDay));

    const header = h('header', { class: 'chrome' },
      chromeTop(),
      h('div', { class: 'hdr' },
        S.logo ? h('span', { class: 'hdr-logo' }, S.logo(40)) : null,
        h('div', { class: 'hdr-title' },
          h('h1', {}, S.copy.linesTitle),
          h('div', { class: 'hdr-sub' },
            h('button', { class: 'icon-btn xs', 'aria-label': 'Previous day', onclick: () => shiftDay(-1) }, icon('left', 14)),
            h('span', {}, dayKicker(), ` · ${S.dateShort(dayStart(ui.date))}`),
            h('button', { class: 'icon-btn xs', 'aria-label': 'Next day', onclick: () => shiftDay(1) }, icon('right', 14))),
          backToToday()),
        headerActions(null)));

    const list = h('ul', { class: 'line-list' }, store.state.lines.map((l) => {
      const n = evs.filter((e) => e.lineObj.id === l.id).length;
      const c = conflicts.get(l.id) || 0;
      const st = S.copy.status;
      const status = !n ? st.none : c >= 2 ? st.severe : c ? st.minor : st.good;
      const cls = !n ? 'none' : c ? 'delay' : 'good';
      return h('li', {}, h('button', { class: 'line-row', onclick: () => openLineEditor(l.id) },
        h('span', { class: 'line-badge' }, S.badge(l, { wide: true })),
        h('span', { class: 'line-name' }, h('span', {}, l.name), h('small', { class: `status ${cls}` }, status)),
        h('span', { class: 'line-count' }, isToday ? `${n} today` : `${n} ${n === 1 ? 'event' : 'events'}`),
        h('span', { class: 'line-more', 'aria-hidden': 'true' }, icon('more', 18))));
    }));

    return h('div', { class: 'lines-view' }, header,
      h('div', { class: 'lines-body swipe-pane' }, list,
        h('button', { class: 'btn-outline wide', onclick: () => openLineEditor(null) }, S.copy.addLine)),
      h('section', { class: 'map-section swipe-pane' },
        h('h2', { class: 'section-title' }, S.copy.mapTitle),
        stripMap(evs)));
  }

  // Strip map of the day: one column per line, one stop per event, linked
  // interchanges where events overlap. NYC draws white stop circles; London
  // draws Beck-style ticks and interchange rings.
  function stripMap(evs) {
    const S = sys();
    const now = Date.now();
    const isToday = ui.date === todayKey();
    const timed = evs.filter((e) => !e.allDay).sort(byStart);
    if (!timed.length) return h('p', { class: 'map-empty' }, S.copy.mapEmpty);

    const stations = [];
    for (const e of timed) {
      const last = stations[stations.length - 1];
      if (last && e.start < last.events[0].end && !last.events.some((x) => x.lineObj.id === e.lineObj.id)) last.events.push(e);
      else stations.push({ start: e.start, events: [e] });
    }
    const order = store.state.lines.map((l) => l.id);
    const lineIds = [...new Set(timed.map((e) => e.lineObj.id))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const COL = 24;
    const PADX = 22;
    const ROW = 62;
    const PADY = 30;
    const x = (id) => PADX + lineIds.indexOf(id) * COL;
    const y = (i) => PADY + i * ROW;
    const W = PADX * 2 + (lineIds.length - 1) * COL;
    const H = PADY * 2 + (stations.length - 1) * ROW;
    const tick = S.map.stop === 'tick';
    const stopsOf = (id) => stations.map((st, i) => (st.events.some((e) => e.lineObj.id === id) ? i : -1)).filter((i) => i >= 0);

    const svgEl = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'map-svg', 'aria-hidden': 'true' });
    for (const id of lineIds) {
      const rows = stopsOf(id);
      const ext = rows.length === 1 ? 16 : tick ? 12 : 0;
      svgEl.append(s('line', {
        x1: x(id), x2: x(id), y1: y(rows[0]) - ext, y2: y(rows[rows.length - 1]) + ext,
        stroke: S.style(store.lineById(id)).hex, 'stroke-width': S.map.track, 'stroke-linecap': tick ? 'butt' : 'round',
      }));
    }
    stations.forEach((st, i) => {
      const past = isToday && st.events.every((e) => e.end <= now);
      const g = s('g', { class: `stop${past ? ' past' : ''}` });
      const xs = st.events.map((e) => x(e.lineObj.id));
      const interchange = st.events.length > 1;
      if (interchange) {
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        g.append(s('rect', tick
          ? { x: x0, y: y(i) - 3.5, width: x1 - x0, height: 7, class: 'xlink' }
          : { x: x0 - 8, y: y(i) - 8, width: x1 - x0 + 16, height: 16, rx: 8, class: 'xlink' }));
      }
      for (const e of st.events) {
        const cx = x(e.lineObj.id);
        const rows = stopsOf(e.lineObj.id);
        const terminal = rows.length > 1 && (i === rows[0] || i === rows[rows.length - 1]);
        if (!tick) {
          g.append(s('circle', { cx, cy: y(i), r: interchange ? 6 : terminal ? 8 : 5.5, class: 'dot' }));
        } else if (interchange) {
          g.append(s('circle', { cx, cy: y(i), r: 7.5, class: 'ring' }));
        } else {
          const hex = S.style(e.lineObj).hex;
          g.append(terminal
            ? s('rect', { x: cx - 10, y: y(i) - 3, width: 20, height: 6, fill: hex, class: 'tickmark' })
            : s('rect', { x: cx + 2, y: y(i) - 3, width: 9, height: 6, fill: hex, class: 'tickmark' }));
        }
      }
      svgEl.append(g);
    });

    let nowEl = null;
    if (isToday) {
      let yNow;
      const lastI = stations.length - 1;
      if (now < stations[0].start) yNow = y(0) - 20;
      else if (now >= stations[lastI].start) yNow = y(lastI) + (stations[lastI].events.every((e) => e.end <= now) ? 20 : 0);
      else {
        const i = stations.findIndex((st, j) => st.start <= now && stations[j + 1].start > now);
        yNow = y(i) + ((now - stations[i].start) / (stations[i + 1].start - stations[i].start)) * ROW;
      }
      yNow = Math.max(6, Math.min(H - 6, yNow));
      svgEl.append(s('g', { class: 'now' },
        s('line', { x1: 2, x2: W - 2, y1: yNow, y2: yNow, class: 'now-line' }),
        s('path', { d: `M2 ${yNow - 6}L11 ${yNow}L2 ${yNow + 6}Z`, class: 'now-arrow' })));
      nowEl = h('span', { class: 'map-now', style: { top: `${yNow}px` } }, S.copy.now);
    }

    const labels = stations.map((st, i) => {
      const past = isToday && st.events.every((e) => e.end <= now);
      return h('button', {
        class: `map-label${past ? ' past' : ''}`, style: { top: `${y(i)}px` },
        onclick: () => openDetail(st.events[0].key),
      },
      h('span', { class: 'map-time' }, S.time(st.start, h12())),
      h('span', { class: 'map-name' }, st.events.map((e) => e.title).join(' · ')));
    });

    return h('div', { class: 'strip-map', style: { height: `${H}px`, '--map-w': `${W}px` } }, svgEl, labels, nowEl);
  }

  // ---------------------------------------------------------------- add
  const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];

  function destinations() {
    const out = [{ value: 'local', label: 'On this device' }];
    for (const a of store.state.accounts) {
      if (!a.write) continue;
      for (const c of a.calendars) {
        if (!c.enabled || (c.role !== 'owner' && c.role !== 'writer')) continue;
        out.push({ value: `g|${a.email}|${c.id}`, label: c.name === a.email ? a.email : `${c.name} · ${a.email}`, email: a.email, calId: c.id });
      }
    }
    return out;
  }

  function defaultStart() {
    const now = Date.now();
    if (ui.date === todayKey()) {
      const next = (step) => Math.ceil((now + 60000) / step) * step;
      const t = next(30 * 60000);
      if (t < dayEnd(ui.date)) return t;
      // Late at night the next half hour is tomorrow: stay on today.
      return Math.min(next(5 * 60000), U.fromInputs(ui.date, '23:55'));
    }
    return U.fromInputs(ui.date, '09:00'); // wall-clock 09:00, also on clock-change days
  }

  function addView() {
    const S = sys();
    const st = store.state;
    const editing = ui.editKey ? findEvent(ui.editKey) : null;
    const dests = destinations();
    const destFor = (e) => (e.source === 'google' ? `g|${e.email}|${e.calId}` : 'local');

    const start = editing ? editing.start : defaultStart();
    const dur = editing && !editing.allDay ? Math.max(5, Math.round((editing.end - editing.start) / 60000)) : 30;
    let dest = editing ? destFor(editing) : (dests.find((d) => d.value === st.settings.lastDest) || dests[0]).value;
    let lineTouched = !!editing;

    const lineForDest = (v) => {
      const d = dests.find((x) => x.value === v);
      if (!d || !d.email) return st.lines[0].id;
      return store.resolveLine({ key: '', source: 'google', email: d.email, calId: d.calId }).id;
    };

    const title = h('input', {
      type: 'text', id: 'f-title', class: 'name-input', placeholder: "What's happening?", maxlength: 300,
      autocomplete: 'off', enterkeyhint: 'done', value: editing ? editing.title : '',
    });
    const allDay = h('input', { type: 'checkbox', class: 'switch', id: 'f-allday', checked: editing ? editing.allDay : false });
    const date = h('input', { type: 'date', id: 'f-date', required: true, value: dateKey(start) });
    const time = h('input', { type: 'time', id: 'f-time', step: 300, value: U.timeValue(start), 'aria-label': 'Start time' });
    const durSel = h('select', { id: 'f-dur' },
      [...new Set([...DURATIONS, dur])].sort((a, b) => a - b).map((m) => h('option', { value: m }, durText(m))));
    durSel.value = String(dur);
    const lineSel = h('select', { id: 'f-line', 'aria-label': 'Line' },
      st.lines.map((l) => h('option', { value: l.id }, `${S.style(l).mark} · ${l.name}`)));
    lineSel.value = editing ? editing.lineObj.id : lineForDest(dest);
    const lineBadge = h('span', { class: 'line-pick-badge' });
    const paintBadge = () => lineBadge.replaceChildren(S.badge(store.lineById(lineSel.value) || st.lines[0]));
    paintBadge();
    lineSel.addEventListener('change', () => { lineTouched = true; paintBadge(); });

    const destSel = h('select', { id: 'f-dest', disabled: !!editing, 'aria-label': 'Save to' },
      dests.map((d) => h('option', { value: d.value }, d.label)));
    if (editing && !dests.some((d) => d.value === dest)) destSel.append(h('option', { value: dest }, editing.calName || dest));
    destSel.value = dest;
    destSel.addEventListener('change', () => {
      dest = destSel.value;
      if (!lineTouched) { lineSel.value = lineForDest(dest); paintBadge(); }
    });

    const loc = h('input', { type: 'text', id: 'f-loc', placeholder: 'Location or video link', autocomplete: 'off', value: editing ? editing.location : '' });
    const notes = h('textarea', { id: 'f-notes', rows: 3, placeholder: 'Notes' });
    notes.value = editing ? editing.notes : '';

    // "Starts" with "tomorrow" (or "today", "in 3 days") under it, so the
    // form says which day the event will land on.
    const timeLabel = h('span', {}, 'Starts');
    const relCap = h('small', { class: 'rel-cap' });
    const paintRel = () => { relCap.textContent = /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? relDay(date.value) : ''; };
    date.addEventListener('input', paintRel);
    date.addEventListener('change', paintRel);
    paintRel();
    const timeRow = h('div', { class: 'field' }, h('label', { for: 'f-date' }, timeLabel, relCap), h('span', { class: 'field-pair' }, date, time));
    const durRow = h('div', { class: 'field' }, h('label', { for: 'f-dur' }, 'Duration'), durSel);
    const syncAllDay = () => {
      time.hidden = allDay.checked;
      durRow.hidden = allDay.checked;
      timeLabel.textContent = allDay.checked ? 'Date' : 'Starts';
    };
    allDay.addEventListener('change', syncAllDay);
    syncAllDay();

    const submitBtn = h('button', { type: 'submit', class: 'btn-primary wide' }, editing ? 'Save changes' : 'Add to board');

    async function submit(ev) {
      ev.preventDefault();
      const t = title.value.trim();
      if (!t) {
        title.focus();
        title.classList.remove('shake');
        void title.offsetWidth;
        title.classList.add('shake');
        return;
      }
      if (!date.value) { date.focus(); return; }
      const isAllDay = allDay.checked;
      // An untouched date and time keep the stored instant: re-reading them
      // would move an event in the repeated hour of a clock-change night.
      const sameStart = editing && !editing.allDay && !isAllDay
        && date.value === dateKey(editing.start) && time.value === U.timeValue(editing.start);
      const s0 = isAllDay ? dayStart(date.value) : sameStart ? editing.start : U.fromInputs(date.value, time.value || '09:00');
      // A multi-day all-day event keeps its length; the form has one date field.
      const span = editing && editing.allDay && isAllDay ? Math.max(1, daysBetween(dateKey(editing.start), dateKey(editing.end))) : 1;
      const data = {
        title: t, allDay: isAllDay, start: s0,
        end: isAllDay ? dayStart(addDays(date.value, span)) : s0 + Number(durSel.value) * 60000,
        location: loc.value.trim(), notes: notes.value.trim(), line: lineSel.value,
      };
      const label = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        if (editing) await saveEdit(editing, data);
        else await saveNew(destSel.value, data);
        if (!editing) store.set('lastDest', destSel.value);
        toast(editing ? 'Event updated'
          : date.value === todayKey() ? 'Added to the board' : `Added to ${S.dateLong(dayStart(date.value))}`);
        ui.editKey = null;
        ui.tab = 'board';
        goDate(date.value);
        window.scrollTo(0, 0);
      } catch (err) {
        toast(err.message || 'Could not save the event', true);
        submitBtn.disabled = false;
        submitBtn.textContent = label;
      }
    }

    return h('div', { class: 'add-view' },
      h('header', { class: 'chrome' },
        chromeTop(),
        h('div', { class: 'hdr' },
          S.logo ? h('span', { class: 'hdr-logo' }, S.logo(40)) : null,
          h('div', { class: 'hdr-title' }, h('h1', {}, editing ? 'Edit Event' : 'Add Event')),
          h('div', { class: 'hdr-actions' },
            h('button', {
              class: 'icon-btn', 'aria-label': editing ? 'Cancel editing' : 'Clear the form',
              onclick: () => { ui.editKey = null; view.replaceChildren(addView()); },
            }, icon(editing ? 'close' : 'reset', 20))))),
      h('form', { class: 'form', onsubmit: submit, novalidate: true },
        h('div', { class: 'field col' }, h('label', { class: 'cap', for: 'f-title' }, 'Event name'), title),
        h('div', { class: 'field' }, h('label', { for: 'f-allday' }, 'All day'), allDay),
        timeRow,
        durRow,
        h('div', { class: 'field' }, h('label', { for: 'f-line' }, 'Line'), h('span', { class: 'line-pick' }, lineBadge, lineSel)),
        h('div', { class: 'field col' }, h('label', { class: 'cap', for: 'f-dest' }, 'Save to'), destSel,
          dests.length === 1 && !editing ? h('small', { class: 'help' }, 'Connect Google Calendar in Settings to save to your Google calendars.') : null),
        h('details', { class: 'more', open: !!(editing && (editing.location || editing.notes)) },
          h('summary', {}, icon('plus', 16), 'Location & notes'),
          h('div', { class: 'field col' }, loc),
          h('div', { class: 'field col' }, notes)),
        submitBtn,
        editing && editing.writable ? h('button', {
          type: 'button', class: 'btn-danger wide',
          onclick: (ev) => confirmTap(ev.currentTarget, 'Tap again to delete', () => deleteEvent(editing)),
        }, 'Delete event') : null));
  }

  async function saveNew(dest, data) {
    if (dest === 'local') {
      store.addLocal(data);
      return;
    }
    const d = destinations().find((x) => x.value === dest);
    if (!d) throw new Error('That calendar is no longer available.');
    await DB.google.createEvent(d.email, d.calId, data);
  }

  async function saveEdit(e, data) {
    if (e.source === 'local') store.updateLocal(e.id, data);
    else if (e.source === 'google') {
      const patch = { ...data };
      if (data.notes === e.notes) delete patch.notes; // keep Google's rich-text description intact
      if (data.location === e.location) delete patch.location;
      // Unchanged times stay off the PATCH, so Google keeps the event's own
      // dates and time zone exactly as they were.
      if (data.allDay === e.allDay && data.start === e.start && data.end === e.end) {
        delete patch.start;
        delete patch.end;
      }
      await DB.google.updateEvent(e, patch);
      store.setOverride(e.key, data.line);
    }
  }

  async function deleteEvent(e) {
    try {
      if (e.source === 'local') store.removeLocal(e.id);
      else if (e.source === 'google') await DB.google.deleteEvent(e);
      if (dialog.open) closeSheet();
      if (ui.tab === 'add') { ui.editKey = null; setTab('board'); }
      toast('Event deleted');
    } catch (err) {
      toast(err.message, true);
    }
  }

  function openEdit(key) {
    ui.editKey = key;
    setTab('add');
  }

  // ------------------------------------------------------------- sheets
  let sheet = null; // { build, live }

  function openSheet(build, live = true) {
    sheet = { build, live };
    dialog.replaceChildren(build());
    if (!dialog.open) dialog.showModal();
  }
  function refreshSheet(force) {
    if (!dialog.open || !sheet || (!sheet.live && !force)) return;
    const a = document.activeElement;
    if (!force && a && dialog.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    const top = dialog.scrollTop;
    dialog.replaceChildren(sheet.build());
    dialog.scrollTop = top;
  }
  function closeSheet() {
    if (dialog.open) dialog.close();
  }
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeSheet(); });
  dialog.addEventListener('close', () => {
    sheet = null;
    dialog.replaceChildren();
    // A board style switched to split-flap flips in once the sheet is out of the way.
    if (ui.flapBoot) {
      ui.flapBoot = false;
      if (sys().layout === 'flap') {
        DB.flap.prime('board');
        render();
      }
    }
  });

  function sheetShell(title, ...body) {
    return h('div', { class: 'sheet-inner' },
      h('div', { class: 'sheet-head' },
        h('h2', {}, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: closeSheet }, icon('close', 20))),
      h('div', { class: 'sheet-body' }, body));
  }

  // Event detail
  function openDetail(key) {
    openSheet(() => detailSheet(key));
  }

  function detailSheet(key) {
    const e = findEvent(key);
    if (!e) return sheetShell('Event', h('p', {}, 'This event is no longer on the board.'));
    const S = sys();
    const now = Date.now();
    const live = !e.allDay && e.start <= now && e.end > now;
    const locHref = safeHref(U.findUrl(e.location) === e.location.trim() ? e.location.trim() : null);
    const video = safeHref(e.video);
    const source = e.source === 'sample' ? 'Sample event · not saved anywhere'
      : e.source === 'local' ? 'Saved on this device'
        : `Google Calendar · ${e.calName}${e.calName === e.email ? '' : ` · ${e.email}`}`;

    return sheetShell(e.title,
      h('div', { class: 'detail-top' },
        S.badge(e.lineObj, { allDay: e.allDay }),
        h('div', {},
          h('div', { class: 'detail-when' }, `${S.dateLong(e.start)} · ${timeRange(e)}`),
          h('div', { class: `detail-status${live ? ' live' : ''}` }, relText(e, now)))),
      e.location ? h('div', { class: 'detail-block' }, h('span', { class: 'cap' }, 'Location'),
        locHref ? h('a', { href: locHref, target: '_blank', rel: 'noopener noreferrer' }, e.location) : h('p', {}, e.location)) : null,
      e.notes ? h('div', { class: 'detail-block' }, h('span', { class: 'cap' }, 'Notes'), h('p', { class: 'notes' }, e.notes.slice(0, 1500))) : null,
      video || safeHref(e.link) ? h('div', { class: 'detail-actions' },
        video ? h('a', { class: 'btn-primary', href: video, target: '_blank', rel: 'noopener noreferrer' }, icon('video', 18), 'Join video call') : null,
        safeHref(e.link) ? h('a', { class: 'btn-outline', href: safeHref(e.link), target: '_blank', rel: 'noopener noreferrer' }, icon('link', 16), 'Open in Google Calendar') : null) : null,
      h('div', { class: 'detail-block' }, h('span', { class: 'cap' }, 'Line'),
        h('div', { class: 'line-choices' }, store.state.lines.map((l) => h('button', {
          class: 'line-choice', 'aria-pressed': String(l.id === e.lineObj.id), onclick: () => changeLine(e, l.id),
        }, S.badge(l), h('span', {}, l.name))))),
      h('p', { class: 'detail-source' }, source),
      e.writable ? h('div', { class: 'detail-actions' },
        h('button', { class: 'btn-outline', onclick: () => { closeSheet(); openEdit(e.key); } }, 'Edit'),
        h('button', {
          class: 'btn-danger',
          onclick: (ev) => confirmTap(ev.currentTarget, 'Tap again to delete', () => deleteEvent(e)),
        }, 'Delete')) : null);
  }

  function changeLine(e, lineId) {
    if (e.source === 'local') store.updateLocal(e.id, { line: lineId });
    else store.setOverride(e.key, lineId);
    if (e.source === 'google' && e.writable) {
      DB.google.saveLine(e, lineId).catch(() => { /* the local override still applies */ });
    }
    refreshSheet(true);
  }

  // Line editor
  function openLineEditor(id) {
    openSheet(() => lineEditorSheet(id), false);
  }

  function lineEditorSheet(id) {
    const S = sys();
    const P = DB.palette;
    const existing = id ? store.lineById(id) : null;
    const draft = existing
      ? { name: existing.name, nyc: { ...existing.nyc }, london: { ...existing.london }, flap: { ...(existing.flap || {}) } }
      : { name: '', ...store.nextLineDefaults() };
    const preview = h('div', { class: 'line-preview' });
    const paint = () => {
      const l = { id: 'draft', name: draft.name || 'New line', nyc: draft.nyc, london: draft.london, flap: draft.flap };
      preview.replaceChildren(
        h('div', { class: 'lp-item' }, DB.SYSTEMS.nyc.badge(l), h('small', {}, 'New York')),
        h('div', { class: 'lp-item' }, DB.SYSTEMS.london.badge(l, { wide: true }), h('small', {}, 'London')),
        h('div', { class: 'lp-item' }, DB.SYSTEMS.flap.badge(l), h('small', {}, 'Split-flap')));
      const flapColor = draft.flap.color || P.NYC_TO_FLAP[draft.nyc.color] || 'blue';
      for (const b of body.querySelectorAll('[data-letter]')) b.setAttribute('aria-pressed', String(b.dataset.letter === draft.nyc.letter));
      for (const b of body.querySelectorAll('[data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === draft.nyc.color));
      for (const b of body.querySelectorAll('[data-tube]')) b.setAttribute('aria-pressed', String(b.dataset.tube === draft.london.line));
      for (const b of body.querySelectorAll('[data-fcolor]')) b.setAttribute('aria-pressed', String(b.dataset.fcolor === flapColor));
      const code = body.querySelector('#l-code');
      if (code) code.placeholder = P.flapCode(draft.name || 'New line');
    };
    const name = h('input', {
      type: 'text', class: 'text-input', id: 'l-name', placeholder: 'Work, Family, Gym…', maxlength: 40, value: draft.name,
      oninput: (e) => { draft.name = e.target.value; paint(); },
    });

    const nycPicker = h('div', { class: 'picker-block' },
      h('span', { class: 'cap' }, 'Route bullet'),
      h('div', { class: 'letter-grid' }, P.MTA_LETTERS.map((L) => h('button', {
        type: 'button', class: 'letter', 'data-letter': L,
        onclick: () => { draft.nyc.letter = L; draft.nyc.color = P.MTA_LETTER_COLOR[L]; paint(); },
      }, L))),
      h('span', { class: 'cap' }, 'Color'),
      h('div', { class: 'swatches' }, P.MTA_COLORS.map((c) => h('button', {
        type: 'button', class: 'swatch', 'data-color': c.id, title: c.label, 'aria-label': c.label, style: { '--c': c.hex },
        onclick: () => { draft.nyc.color = c.id; paint(); },
      }))));
    const londonPicker = h('div', { class: 'picker-block' },
      h('span', { class: 'cap' }, 'Tube line'),
      h('div', { class: 'tube-grid' }, P.TFL_LINES.map((t) => h('button', {
        type: 'button', class: 'tube', 'data-tube': t.id, style: { '--c': t.hex, '--i': t.ink },
        onclick: () => { draft.london.line = t.id; paint(); },
      }, t.name))));
    const flapPicker = h('div', { class: 'picker-block' },
      h('label', { class: 'cap', for: 'l-code' }, 'Board code'),
      h('input', {
        type: 'text', class: 'text-input code-input', id: 'l-code', maxlength: 3, value: draft.flap.code || '',
        autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => {
          const v = e.target.value.toUpperCase().replace(/[^A-Z0-9&]/g, '').slice(0, 3);
          e.target.value = v;
          draft.flap.code = v;
          paint();
        },
      }),
      h('small', { class: 'help' }, 'Up to three letters or digits. Leave it blank to use the name.'),
      h('span', { class: 'cap' }, 'Color'),
      h('div', { class: 'swatches' }, P.FLAP_COLORS.map((c) => h('button', {
        type: 'button', class: 'swatch', 'data-fcolor': c.id, title: c.label, 'aria-label': c.label, style: { '--c': c.hex },
        onclick: () => { draft.flap.color = c.id; paint(); },
      }))));
    const pickers = { nyc: nycPicker, london: londonPicker, flap: flapPicker };

    const body = h('div', {},
      preview,
      h('div', { class: 'detail-block' }, h('label', { class: 'cap', for: 'l-name' }, 'Name'), name),
      pickers[S.id] || nycPicker,
      h('p', { class: 'help' }, 'Each board style keeps its own look for this line. Switch styles in Settings to edit the others.'),
      existing ? h('div', { class: 'detail-actions' },
        h('button', { type: 'button', class: 'btn-outline', onclick: () => { store.moveLine(id, -1); toast('Moved up'); } }, 'Move up'),
        h('button', { type: 'button', class: 'btn-outline', onclick: () => { store.moveLine(id, 1); toast('Moved down'); } }, 'Move down')) : null,
      h('div', { class: 'detail-actions' },
        h('button', {
          type: 'button', class: 'btn-primary',
          onclick: () => {
            const nm = draft.name.trim() || 'New line';
            if (existing) store.updateLine(id, { name: nm, nyc: draft.nyc, london: draft.london, flap: draft.flap });
            else store.addLine(nm, { nyc: draft.nyc, london: draft.london, flap: draft.flap });
            closeSheet();
          },
        }, existing ? 'Save line' : 'Add line'),
        existing && store.state.lines.length > 1 ? h('button', {
          type: 'button', class: 'btn-danger',
          onclick: (ev) => confirmTap(ev.currentTarget, 'Tap again: events move to other lines', () => {
            store.removeLine(id);
            closeSheet();
          }),
        }, 'Delete line') : null));
    paint();
    return sheetShell(existing ? 'Edit line' : 'New line', body);
  }

  // Settings
  function openSettings() {
    openSheet(settingsSheet);
  }

  function lineSelect(value, onChange, allowDefault, label) {
    const S = sys();
    const sel = h('select', { class: 'line-select', 'aria-label': label, onchange: (e) => onChange(e.target.value || null) },
      allowDefault ? h('option', { value: '' }, 'Account default') : null,
      store.state.lines.map((l) => h('option', { value: l.id }, `${S.style(l).mark} · ${l.name}`)));
    sel.value = value || (allowDefault ? '' : store.state.lines[0].id);
    return sel;
  }

  function toggleRow(label, checked, onChange, help) {
    const id = `t-${U.uid()}`;
    return h('div', { class: 'set-row' },
      h('label', { for: id }, h('span', {}, label), help ? h('small', { class: 'help' }, help) : null),
      h('input', { type: 'checkbox', class: 'switch', id, checked, onchange: (e) => onChange(e.target.checked) }));
  }

  function sysPreview(x) {
    const demo = store.state.lines.slice(0, x.logo ? 2 : 3);
    return h('span', { class: `sys-preview sys-${x.id}` },
      h('span', { class: 'sp-rule' }),
      x.logo ? x.logo(26) : null,
      h('span', { class: 'sp-badges' }, demo.map((l) => x.badge(l))));
  }

  function accountCard(a) {
    const ok = !!store.token(a.email);
    return h('div', { class: 'acct' },
      h('div', { class: 'acct-head' },
        h('div', { class: 'acct-id' }, h('strong', {}, a.email),
          h('small', { class: ok ? 'ok' : 'warn' }, ok ? (a.write ? 'Connected' : 'Connected · read-only') : 'Needs reconnect')),
        ok ? null : h('button', { class: 'btn-small', onclick: () => reconnectFlow(a.email) }, 'Reconnect'),
        h('button', {
          class: 'btn-small ghost',
          onclick: (ev) => confirmTap(ev.currentTarget, 'Tap to confirm', () => store.removeAccount(a.email)),
        }, 'Remove')),
      h('div', { class: 'acct-default' },
        h('span', {}, 'Account line'),
        lineSelect(a.defaultLine, (v) => store.updateAccount(a.email, { defaultLine: v }), false, `Default line for ${a.email}`)),
      h('ul', { class: 'cal-list' }, a.calendars.map((c) => h('li', { class: 'cal' },
        h('input', {
          type: 'checkbox', class: 'switch sm', checked: c.enabled, 'aria-label': `Show ${c.name}`,
          onchange: (e) => { store.updateCalendar(a.email, c.id, { enabled: e.target.checked }); sync(true); },
        }),
        h('span', { class: 'cal-dot', style: { background: c.color } }),
        h('span', { class: 'cal-name' }, c.name),
        lineSelect(c.line, (v) => store.updateCalendar(a.email, c.id, { line: v }), true, `Line for ${c.name}`)))));
  }

  function settingsSheet() {
    const st = store.state;
    const hasId = DB.google.hasClientId();
    const fromConfig = !!((window.DayBoardConfig || {}).googleClientId);

    const clientIdForm = () => {
      const input = h('input', {
        type: 'text', class: 'text-input', placeholder: '…apps.googleusercontent.com', value: st.settings.clientId,
        spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Google OAuth client ID',
      });
      return h('div', { class: 'detail-block' },
        h('p', { class: 'help' }, 'Day Board talks to Google Calendar straight from your browser. It needs a free OAuth client ID from your own Google Cloud project; README.md walks through it in about five minutes.'),
        h('div', { class: 'inline-form' }, input,
          h('button', {
            class: 'btn-small', onclick: () => { store.set('clientId', input.value.trim()); refreshSheet(true); toast('Client ID saved'); },
          }, 'Save')));
    };

    return sheetShell('Settings',
      h('section', { class: 'set-section' },
        h('h3', { class: 'cap' }, 'Board style'),
        h('div', { class: 'sys-cards' }, DB.systemList.map((x) => h('button', {
          class: 'sys-card', 'aria-pressed': String(x.id === st.system),
          onclick: () => {
            if (x.layout === 'flap' && st.system !== x.id) ui.flapBoot = true;
            store.set('system', x.id);
            refreshSheet(true);
          },
        }, sysPreview(x), h('strong', {}, x.name), h('small', {}, x.tagline))))),

      h('section', { class: 'set-section' },
        h('h3', { class: 'cap' }, 'Google Calendar'),
        isPreview() ? h('p', { class: 'help' },
          'This preview can’t sign in to Google. Google Calendar sync works in the installed version of Day Board (GitHub Pages; see the README). Events you add here stay in this browser.') : null,
        !isPreview() && st.accounts.length ? h('p', { class: 'help' },
          'Each account has its own line, and any calendar can override it, so work and personal events ride different lines. You can still move single events from their detail sheet.') : null,
        !isPreview() && (!hasId || (!fromConfig && !st.accounts.length)) ? clientIdForm() : null,
        st.accounts.map(accountCard),
        isPreview() ? null : h('div', { class: 'detail-actions' },
          h('button', { class: 'btn-primary', disabled: !hasId, onclick: addAccountFlow }, icon('plus', 16), st.accounts.length ? 'Add account' : 'Add Google account'),
          st.accounts.length ? h('button', { class: 'btn-outline', onclick: () => sync(true) }, icon('sync', 16), 'Sync now') : null)),

      h('section', { class: 'set-section' },
        h('h3', { class: 'cap' }, 'Board'),
        h('div', { class: 'set-row' },
          h('span', {}, 'Clock'),
          h('div', { class: 'segmented', role: 'group', 'aria-label': 'Clock format' },
            [['auto', 'Auto'], [true, '12 h'], [false, '24 h']].map(([v, label]) => h('button', {
              'aria-pressed': String(st.settings.hour12 === v),
              onclick: () => { store.set('hour12', v); refreshSheet(true); },
            }, label)))),
        toggleRow('Show departed events', st.settings.showDeparted, (v) => { ui.departedOpen = null; store.set('showDeparted', v); }),
        toggleRow('Spoken announcements', st.settings.announce, (v) => { store.set('announce', v); if (v) testAnnouncement(); },
          'Calls out your next event five minutes ahead and as it starts, while Day Board is open.'),
        st.system === 'flap' ? toggleRow('Flap sound on the platform display', st.settings.flapSound,
          (v) => { store.set('flapSound', v); if (v) ensureAudio(); }) : null,
        toggleRow('Sample day when the board is empty', st.settings.sample, (v) => store.set('sample', v))),

      h('section', { class: 'set-section' },
        h('h3', { class: 'cap' }, 'Data'),
        h('p', { class: 'help' }, 'Everything stays in this browser: your lines, local events, and short-lived Google access tokens. Nothing is sent anywhere except Google Calendar.'),
        h('button', {
          class: 'btn-danger',
          onclick: (ev) => confirmTap(ev.currentTarget, 'Tap again to erase everything', () => {
            store.resetAll();
            location.reload();
          }),
        }, 'Reset Day Board')),

      h('p', { class: 'about' }, 'A rebuild of Day Board, the subway-board calendar by @rillotv. Not affiliated with the MTA, Transport for London, or any railway.'));
  }

  async function addAccountFlow() {
    try {
      const email = await DB.google.addAccount();
      toast(`Connected ${email}`);
      refreshSheet(true);
      await sync(true);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function reconnectFlow(email) {
    try {
      const got = await DB.google.reconnect(email);
      toast(got === email ? 'Reconnected' : `Connected ${got}`);
      refreshSheet(true);
      await sync(true);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ------------------------------------------------------- platform display
  // A full-screen arrivals board for a spare phone or tablet, modelled on
  // Day Board's home-screen widgets (NYC), a Tube dot-matrix indicator
  // (London) and a mechanical split-flap departure board.
  let wakeLock = null;
  let displaySig = '';

  function openDisplay() {
    displayEl.hidden = false;
    displaySig = '';
    if (store.state.settings.flapSound) ensureAudio();
    if (sys().layout === 'flap') DB.flap.prime('display'); // flip every flap in from blank
    renderDisplay();
    const root = document.documentElement;
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
  }
  function closeDisplay() {
    displayEl.hidden = true;
    displayEl.replaceChildren();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  displayEl.addEventListener('click', closeDisplay);

  function renderDisplay() {
    const S = sys();
    const now = Date.now();
    if (S.layout === 'flap') {
      renderFlapDisplay(S, now);
      return;
    }
    const evs = eventsOn(todayKey());
    const timed = evs.filter((e) => !e.allDay && e.end > now).sort(byStart);
    const allDay = evs.filter((e) => e.allDay);

    const isLondon = S.id === 'london';
    const rowsData = timed.slice(0, isLondon ? 8 : 10).map((e, i) => {
      const live = e.start <= now;
      const m = mins(now, e.start);
      let val;
      if (isLondon) val = live ? 'Now' : m < 1 ? 'Due' : m < 60 ? `${m} min${m === 1 ? '' : 's'}` : S.time(e.start, h12());
      else val = live ? 'LIVE' : String(m);
      return { e, i, live, val };
    });
    const next = timed.find((e) => e.start > now);
    const ticker = ['Mind the gap',
      next ? `Next: ${next.title}${next.location && !U.findUrl(next.location) ? ` – ${next.location}` : ''}` : null,
      allDay.length ? `Today: ${allDay.map((e) => e.title).join(', ')}` : null].filter(Boolean).join('    ✱    ');

    // Rebuild only when the content changes; the clock ticks separately so
    // the scrolling ticker never restarts mid-message.
    const sig = JSON.stringify([S.id, h12(), rowsData.map((r) => [r.e.key, r.val, r.e.lineObj.id]), allDay.map((e) => e.key), ticker, timed.length]);
    if (sig !== displaySig) {
      displaySig = sig;
      const panel = isLondon
        ? h('div', { class: 'disp disp-london' },
          h('div', { class: 'd-head' }, S.logo(44), h('strong', {}, S.dateLong(now))),
          h('div', { class: 'dmi' },
            h('div', { class: 'd-rows' }, rowsData.length ? rowsData.map((r) => h('div', { class: 'd-row' },
              h('span', { class: 'd-ord' }, String(r.i + 1)),
              S.badge(r.e.lineObj),
              h('span', { class: 'd-title' }, r.e.title),
              h('span', { class: 'd-val' }, r.val))) : h('div', { class: 'd-empty' }, S.copy.ended)),
            h('div', { class: 'd-ticker' }, h('span', {}, ticker)),
            h('div', { class: 'd-clock' })),
          h('p', { class: 'd-hint' }, 'Tap anywhere to close'))
        : h('div', { class: 'disp disp-nyc' },
          h('div', { class: 'd-head' }, h('strong', {}, S.dateShort(now)), h('span', { class: 'd-clock' })),
          h('div', { class: 'd-cols' }, h('span', {}, 'LN'), h('span', {}, 'EVENT'), h('span', {}, 'MIN')),
          h('div', { class: 'd-rows' }, rowsData.length ? rowsData.map((r) => h('div', { class: 'd-row' },
            S.badge(r.e.lineObj),
            h('span', { class: 'd-title' }, r.e.title),
            h('span', { class: `d-val${r.live ? ' live' : ''}` }, r.val))) : h('div', { class: 'd-empty' }, S.copy.ended)),
          allDay.length ? [
            h('div', { class: 'd-cols' }, h('span', {}, 'LN'), h('span', {}, 'ALL DAY'), h('span', {}, allDay.length > 3 ? `+${allDay.length - 3}` : '')),
            h('div', { class: 'd-rows' }, allDay.slice(0, 3).map((e) => h('div', { class: 'd-row' },
              S.badge(e.lineObj, { allDay: true }), h('span', { class: 'd-title' }, e.title), h('span', { class: 'd-val' })))),
          ] : null,
          h('div', { class: 'd-foot' },
            h('span', {}, h('b', {}, 'DAY BOARD'), h('span', { class: 'pill-diamond' }), String(allDay.length)),
            h('span', {}, timed.length > 10 ? `+${timed.length - 10} more · ` : '', 'Tap to close')));
      displayEl.replaceChildren(panel);
    }
    const clock = displayEl.querySelector('.d-clock');
    if (clock) clock.textContent = isLondon ? S.clock(now, h12(), true) : S.clock(now, h12());
  }

  // Split-flap board: fixed slots like a real board, so when an event departs
  // every row below flips up to the next one. Rebuilt only when content (or
  // the minute on the clock) changes.
  function renderFlapDisplay(S, now) {
    const F = DB.flap;
    const evs = eventsOn(todayKey());
    const timed = evs.filter((e) => !e.allDay && e.end > now).sort(byStart);
    const allDay = evs.filter((e) => e.allDay);
    const vw = window.innerWidth || 390;
    const wide = vw >= 640;
    const inner = Math.min(vw - 32, 1100) - 32; // panel width minus its padding
    const timeLen = S.boardTime(now, h12()).length;
    // Wide: one line per slot. Narrow: time + remarks share a line, so size
    // the cells to fit both beside the line tile.
    const cw = wide
      ? Math.max(14, Math.min(22, vw * 0.02))
      : Math.max(9, Math.min(18, (inner - 58) / (timeLen + 10) - 2));
    const pitch = cw + 2;
    const destLen = Math.max(8, Math.floor((wide ? inner - 52 - (timeLen + 10) * pitch - 32 : inner - 52) / pitch));
    // Fit the slots to the screen height too (landscape phones are short).
    const vh = window.innerHeight || 800;
    const rowH = wide ? cw * 1.6 + 6 : cw * 3.2 + 20;
    const room = vh - 32 - 32 - cw * 2.1 - 14 - (wide ? 24 : 0) - 46;
    const SLOTS = Math.max(3, Math.min(wide ? 8 : 7, Math.floor(room / rowH)));
    const slots = Array.from({ length: SLOTS }, (_, i) => timed[i] || null);
    const clock = S.boardTime(now, h12());
    const sig = JSON.stringify([vw, vh, h12(), clock, destLen, timed.length, allDay.map((e) => [e.key, e.title]),
      slots.map((e) => e && [e.key, e.title, e.lineObj.id, S.remark(e, now).text, e.start])]);
    if (sig === displaySig) return;
    displaySig = sig;

    F.begin('display');
    const rows = slots.map((e, i) => {
      const rk = e ? S.remark(e, now) : { text: '', tone: 'ontime' };
      const d = i * 90;
      const tile = e ? S.badge(e.lineObj) : h('span', { class: 'badge ftile blank', 'aria-hidden': 'true' });
      const time = F.text(e ? S.boardTime(e.start, h12()) : '', timeLen, `s${i}|t`, 'display', { cls: 'fl-time', delay: d });
      const dest = e && !F.legible(e.title)
        ? h('span', { class: 'fd-plain' }, e.title)
        : F.text(e ? F.fit(e.title, destLen) : '', destLen, `s${i}|d`, 'display', { cls: 'fl-dest', delay: d + 60, label: e ? e.title : '' });
      const remark = F.text(rk.text, 10, `s${i}|r`, 'display', { cls: `fl-remark tone-${rk.tone}`, delay: d + 160 });
      return wide
        ? h('div', { class: 'fd-row' }, tile, time, dest, remark)
        : h('div', { class: 'fd-row' }, tile, h('div', { class: 'fd-stack' }, h('div', { class: 'fd-line' }, time, remark), dest));
    });
    const panel = h('div', {
      class: `disp disp-flap${wide ? ' fd-wide' : ''}`,
      style: { '--cw': `${cw.toFixed(2)}px`, '--tw': `${(timeLen * pitch - 2).toFixed(2)}px`, '--rw': `${(10 * pitch - 2).toFixed(2)}px` },
    },
      h('div', { class: 'fd-head' },
        h('div', { class: 'fd-titles' }, h('strong', {}, 'Departures'), h('span', {}, S.dateShort(now))),
        F.text(clock, clock.length, 'clock', 'display', { cls: 'fl-clock' })),
      wide ? h('div', { class: 'fd-cols' }, h('span', {}), h('span', {}, 'Time'), h('span', {}, 'Destination'), h('span', {}, 'Remarks')) : null,
      h('div', { class: 'fd-rows' }, rows),
      h('div', { class: 'fd-foot' },
        h('span', { class: 'fd-allday' }, h('b', {}, 'DAY BOARD'),
          allDay.length ? ` · All day: ${allDay.map((e) => e.title).join(' · ')}` : ''),
        h('span', {}, timed.length > SLOTS ? `+${timed.length - SLOTS} more · ` : '', 'Tap to close')));
    F.end('display');
    displayEl.replaceChildren(panel);
    const flipped = F.takeFlips('display');
    if (store.state.settings.flapSound) clatter(flipped);
  }

  // ------------------------------------------------------- announcements
  const announced = new Set();
  let audio = null;

  function ensureAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (_) {
      audio = null;
    }
  }

  // The rattle of flaps settling: one short filtered noise click per flipped
  // cell, spread over the cascade.
  let clickBuf = null;
  function clatter(n) {
    if (!n || !audio || audio.state !== 'running') return;
    if (!clickBuf) {
      const len = Math.floor(audio.sampleRate * 0.014);
      clickBuf = audio.createBuffer(1, len, audio.sampleRate);
      const d = clickBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    const t0 = audio.currentTime + 0.02;
    const count = Math.min(n, 48);
    for (let i = 0; i < count; i++) {
      const src = audio.createBufferSource();
      const g = audio.createGain();
      src.buffer = clickBuf;
      g.gain.value = 0.12 + Math.random() * 0.08;
      src.connect(g).connect(audio.destination);
      src.start(t0 + i * 0.026 + Math.random() * 0.01);
    }
  }

  function chime() {
    if (!audio || audio.state !== 'running') return 0;
    const notes = sys().chimeNotes || [659.25, 523.25];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t = audio.currentTime + i * 0.42;
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
    return notes.length * 420 + 60;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const S = sys();
    const delay = chime();
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith(S.voiceLang));
      u.voice = voices.find((v) => /google|natural|neural/i.test(v.name)) || voices[0] || null;
      u.lang = S.voiceLang;
      u.rate = 0.95;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    }, delay);
  }

  function testAnnouncement() {
    ensureAudio();
    const now = Date.now();
    const next = eventsOn(todayKey()).filter((e) => !e.allDay && e.start > now).sort(byStart)[0];
    const S = sys();
    speak(next ? S.copy.announceSoon(next.title, mins(now, next.start), '') : S.copy.announceNow('Day Board', ''));
  }

  function announce(now) {
    if (!store.state.settings.announce || document.hidden || !('speechSynthesis' in window)) return;
    const S = sys();
    for (const e of eventsOn(todayKey())) {
      if (e.allDay) continue;
      const until = e.start - now;
      const where = e.location && !U.findUrl(e.location) ? e.location : '';
      if (until > 4 * 60000 && until <= 5 * 60000 && !announced.has(`${e.key}|soon`)) {
        announced.add(`${e.key}|soon`);
        speak(S.copy.announceSoon(e.title, mins(now, e.start), where));
        return;
      }
      if (until <= 0 && until > -60000 && !announced.has(`${e.key}|now`)) {
        announced.add(`${e.key}|now`);
        speak(S.copy.announceNow(e.title, where));
        return;
      }
    }
  }

  // ---------------------------------------------------------------- sync
  async function sync(force) {
    const st = store.state;
    if (!st.accounts.length || ui.syncing) return;
    const from = dayStart(addDays(ui.date, -2));
    const to = dayEnd(addDays(ui.date, 5));
    if (!force && store.covered(from, to, 5 * 60000)) return;
    if (!st.accounts.some((a) => store.token(a.email))) {
      render();
      return;
    }
    ui.syncing = true;
    render();
    try {
      const { errors } = await DB.google.fetchWindow(from, to);
      const other = errors.filter((e) => !e.auth);
      if (other.length) toast(other[0].message, true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      ui.syncing = false;
      render();
    }
  }

  // --------------------------------------------------------------- toast
  let toastTimer = null;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, isError ? 5000 : 2600);
  }

  // ---------------------------------------------------------------- loop
  let lastMinute = Math.floor(Date.now() / 60000);
  let lastFull = Date.now(); // init renders; no redundant redraw a second later
  let flapBusyUntil = 0;
  let lastToday = todayKey();
  let lastSyncCheck = 0;

  // Midnight: a board showing today moves on to the new today. Runs on every
  // tick and at the top of every render, so a phone that slept through
  // midnight never draws yesterday as today when it wakes.
  function rollover() {
    const tk = todayKey();
    if (tk === lastToday) return false;
    if (ui.date === lastToday) ui.date = tk;
    lastToday = tk;
    ui.sampleAnchor = Date.now();
    sampleCache = null;
    flapBusyUntil = 0; // don't hold the new day behind yesterday's flip cascade
    return true;
  }

  function tick() {
    const now = Date.now();
    const rolled = rollover();
    const minute = Math.floor(now / 60000);
    if (ui.tab !== 'add' && (rolled || (now >= flapBusyUntil && (minute !== lastMinute || now - lastFull > 20000)))) {
      lastMinute = minute;
      lastFull = now;
      render();
    }
    if (!displayEl.hidden) renderDisplay();
    announce(now);
    if (now - lastSyncCheck > 60000) {
      lastSyncCheck = now;
      sync(false);
    }
  }

  function init() {
    store.subscribe(() => {
      sampleCache = null;
      render();
      refreshSheet();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !displayEl.hidden) { closeDisplay(); return; }
      if (dialog.open || !displayEl.hidden || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
      if (ui.tab === 'add') return;
      if (e.key === 'ArrowLeft') shiftDay(-1);
      else if (e.key === 'ArrowRight') shiftDay(1);
      else if (e.key === 't') goDate(todayKey());
    });
    initSwipe(document.getElementById('app'));
    let resizeTimer = null;
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth !== lastWidth) {
          lastWidth = window.innerWidth;
          if (ui.tab !== 'add') render();
        }
        if (!displayEl.hidden) { displaySig = ''; renderDisplay(); }
      }, 150);
    });
    // Back after a while away (timers don't run while Android has the app in
    // the background): show today again rather than the day you'd browsed to.
    const AWAY_RESET = 15 * 60000;
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      rollover();
      if (hiddenAt && Date.now() - hiddenAt >= AWAY_RESET && ui.date !== todayKey()) {
        ui.date = todayKey();
        ui.filter = null;
        ui.allDayOpen = false;
        ui.picker = false;
      }
      hiddenAt = 0;
      render();
      sync(false);
    });

    const route = location.hash.replace('#', '');
    if (route === 'lines' || route === 'add') ui.tab = route;
    render();
    if (route === 'display') openDisplay();
    if (route === 'settings') openSettings();
    sync(false);
    setInterval(tick, 1000);

    if (!isPreview() && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  DB.app = { render, ui, openSettings, openDisplay, toast };
  init();
})(window.DB);
