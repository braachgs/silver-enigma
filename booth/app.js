/* Broadcast Booth UI: game picking, live polling / replay, Claude batching,
 * speech scheduling with a sync delay. Sport-specific commentary logic lives
 * in engine.js (hockey) and mlb-engine.js (baseball); the SPORTS table below
 * adapts each league's schedule and feed. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5000;      // live feed poll
  const BATCH_MS = 6000;     // how often to send events to Claude
  const STALE_MS = 15000;    // drop routine lines this late
  const LOG_MAX = 300;

  // Shown on the page and in the log, to confirm a reload picked up new code.
  const BUILD = 'stable-ids-1';

  const store = {
    get(k, d) { try { const v = localStorage.getItem('booth.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('booth.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------------------------------------------------------------------------
  // Sports
  // ---------------------------------------------------------------------------

  // Normalised game status: 'live' | 'final' | 'future'.
  const NHL_STATUS = (st) => (st === 'LIVE' || st === 'CRIT' ? 'live' : st === 'FINAL' || st === 'OFF' ? 'final' : 'future');
  const MLB_STATUS = (st) => (st === 'Live' ? 'live' : st === 'Final' ? 'final' : 'future');

  const SPORTS = {
    nhl: {
      label: 'Hockey', engine: window.Booth, defaultPersona: 'hnic90',
      demoUrl: 'demo-game.json', demoLabel: 'Demo: MTL @ TOR (fictional)',
      syncHint: 'When a whistle or a shot happens on TV, click <b>sync</b> next to that event below.',
      async listGames(date) {
        const data = await getJSON(`/api/nhl/score/${date}`);
        return (data.games || []).map((g) => ({
          id: g.id, status: NHL_STATUS(g.gameState), label: `${g.awayTeam?.abbrev ?? '?'} @ ${g.homeTeam?.abbrev ?? '?'}`,
          start: g.startTimeUTC, awayScore: g.awayTeam?.score, homeScore: g.homeTeam?.score,
        }));
      },
      feedUrl: (id) => `/api/nhl/gamecenter/${id}/play-by-play`,
      feedStatus: (pbp) => NHL_STATUS(pbp.gameState),
    },
    mlb: {
      label: 'Baseball', engine: window.BallBooth, defaultPersona: 'cookie',
      demoUrl: 'mlb-demo-game.json', demoLabel: 'Demo: BOS @ TOR (fictional)',
      syncHint: 'When the pitcher delivers on TV, click <b>sync</b> next to that pitch below. Calls are then timed to when each pitch happened, so one sync should hold; re-sync only if you pause the TV.',
      async listGames(date) {
        const data = await getJSON(`/api/mlb/v1/schedule?sportId=1&date=${date}&hydrate=team`);
        const games = (data.dates || []).flatMap((d) => d.games || []);
        return games.map((g) => {
          const a = g.teams?.away, h = g.teams?.home;
          const ab = (t) => t?.team?.abbreviation || t?.team?.teamName || t?.team?.name || '?';
          return {
            id: g.gamePk, status: MLB_STATUS(g.status?.abstractGameState), label: `${ab(a)} @ ${ab(h)}`,
            note: g.seriesDescription && g.gameType !== 'R' ? g.seriesDescription : '',
            start: g.gameDate, awayScore: a?.score, homeScore: h?.score, detailed: g.status?.detailedState,
          };
        });
      },
      feedUrl: (id) => `/api/mlb/v1.1/game/${id}/feed/live`,
      feedStatus: (feed) => MLB_STATUS(feed.gameData?.status?.abstractGameState),
    },
  };

  const app = {
    sport: 'nhl',
    llm: false, selected: null, running: false, mode: null,
    game: null, state: null, seen: new Set(), queue: [], speaking: null, seq: 0,
    pending: [], inFlight: false, recent: [], joining: false, lastLineAt: 0,
    timers: [], delay: 20, finished: false,
    spoken: [], events: [], // recent history for flags
    lags: [], lastPollAt: 0,
    late: [], // ms each recent pitch reached the booth after its TV moment
    macVoices: [], // from the server's `say -v ?`
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  async function getJSON(url) {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  async function postJSON(url, data) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

  function setStatus(text, err) {
    $('status').textContent = text;
    $('status').classList.toggle('err', !!err);
  }

  // ---------------------------------------------------------------------------
  // Session log: batched to the server, which writes logs/session-*.jsonl and
  // prints warnings, errors and flags in its terminal as they happen.
  // Logging must never break the booth, so everything here swallows errors.
  // ---------------------------------------------------------------------------

  const logBuf = [];
  function log(kind, data) {
    try {
      logBuf.push({ kind, t: Date.now(), ...data });
      if (logBuf.length > 500) logBuf.splice(0, logBuf.length - 500);
      if (kind === 'error' || kind === 'warn' || kind === 'flag') flushLog();
    } catch { /* ignore */ }
  }

  function flushLog() {
    if (!logBuf.length) return;
    try {
      const body = JSON.stringify({ entries: logBuf.splice(0) });
      fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 }).catch(() => {});
    } catch { /* ignore */ }
  }

  setInterval(flushLog, 5000);
  window.addEventListener('pagehide', flushLog);
  window.addEventListener('error', (e) => log('error', { message: e.message, where: `${e.filename}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => log('error', { message: String((e.reason && e.reason.message) || e.reason) }));

  // Background-safe clock. Browsers throttle timers in hidden or covered tabs
  // (Chrome: down to once a minute), which made the feed arrive in bursts.
  // Worker timers aren't throttled that way, so a worker drives a heartbeat
  // and every booth timer runs off it.
  const ticker = (() => {
    const jobs = new Set();
    const beat = () => {
      const now = Date.now();
      for (const j of [...jobs]) {
        if (now < j.next || !jobs.has(j)) continue;
        if (j.every) j.next = now + j.every; else jobs.delete(j);
        try { j.fn(); } catch (e) { log('error', { message: `timer: ${e.message}` }); }
      }
    };
    try {
      const src = 'setInterval(() => postMessage(0), 100);';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = beat;
    } catch {
      setInterval(beat, 100);
    }
    return {
      every(ms, fn) { const j = { every: ms, next: Date.now() + ms, fn }; jobs.add(j); return j; },
      after(ms, fn) { const j = { next: Date.now() + ms, fn }; jobs.add(j); return j; },
      cancel(j) { jobs.delete(j); },
    };
  })();

  document.addEventListener('visibilitychange', () => log('visibility', { state: document.visibilityState }));

  // Median of recent feed lags (arrival minus when it happened), in seconds.
  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // How far behind your TV the booth's data is arriving (seconds), if at all.
  function behindTv() {
    const m = median(app.late);
    return m != null && m > 2500 ? Math.round(m / 1000) : null;
  }

  function feedLag() {
    if (!app.lags.length) return null;
    const s = [...app.lags].sort((a, b) => a - b);
    return Math.round(s[Math.floor(s.length / 2)] / 1000);
  }

  function flag() {
    const note = $('flagNote').value.trim();
    log('flag', {
      note,
      situation: app.state ? eng().situation(app.state) : '',
      recentLines: app.spoken.slice(-6),
      recentEvents: app.events.slice(-6),
      delay: app.delay, sport: app.sport, persona: $('persona').value, source: $('source').value,
    });
    $('flagNote').value = '';
    $('flagBtn').textContent = 'Flagged ✓';
    setTimeout(() => { $('flagBtn').textContent = 'Flag'; }, 1500);
  }

  const sport = () => SPORTS[app.sport];
  const eng = () => sport().engine;
  const persona = () => eng().PERSONAS[$('persona').value] || eng().PERSONAS[sport().defaultPersona];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const todayLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  // ---------------------------------------------------------------------------
  // Setup: personas, voices, status
  // ---------------------------------------------------------------------------

  function onPersonaChange() {
    $('blurb').textContent = persona().blurb;
    store.set(`${app.sport}.persona`, $('persona').value);
    fillVoiceSelects();
  }

  function initPersonas() {
    $('persona').innerHTML = '';
    for (const p of Object.values(eng().PERSONAS)) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      $('persona').appendChild(o);
    }
    const saved = store.get(`${app.sport}.persona`, sport().defaultPersona);
    $('persona').value = eng().PERSONAS[saved] ? saved : sport().defaultPersona;
    onPersonaChange();
  }

  function englishVoices() {
    return speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  }

  // Best voice for a persona slot: language order, then quality, then name hints.
  function autoVoice(spec, exclude) {
    const voices = englishVoices();
    let best = null, bestScore = -Infinity;
    for (const v of voices) {
      if (exclude && v.voiceURI === exclude.voiceURI && voices.length > 1) continue;
      const lang = v.lang.replace('_', '-').toLowerCase();
      const li = spec.langs.findIndex((l) => lang.startsWith(l.toLowerCase()));
      if (li < 0) continue;
      const name = v.name.toLowerCase();
      let score = (spec.langs.length - li) * 10;
      if (/natural|neural|online|premium|enhanced|google/.test(name)) score += 6;
      score += spec.prefer.filter((k) => name.includes(k)).length * 2;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best || voices[0] || null;
  }

  const useMac = () => $('engine').value === 'mac';
  const voiceKey = (speaker) => `${persona().id}.${speaker}${useMac() ? 'Mac' : ''}Voice`;

  // Mac voice for a slot: '' means the System Voice (which may be a Siri voice).
  function macVoiceFor(speaker) {
    const sel = $(speaker === 'pbp' ? 'pbpVoice' : 'colourVoice').value;
    if (sel !== 'auto') return sel;
    if (speaker === 'pbp') return '';
    // Colour: a different, good voice so the booth has two people in it.
    const good = app.macVoices.find((v) => /premium|enhanced/i.test(v.name));
    return good ? good.name : '';
  }

  function voiceName(speaker) {
    if (useMac()) return macVoiceFor(speaker) || 'System Voice';
    return (voiceFor(speaker) || {}).name;
  }

  function voiceFor(speaker) {
    const sel = $(speaker === 'pbp' ? 'pbpVoice' : 'colourVoice').value;
    const all = speechSynthesis.getVoices();
    if (sel) { const v = all.find((x) => x.voiceURI === sel); if (v) return v; }
    const spec = persona().voices[speaker];
    if (speaker === 'colour') return autoVoice(spec, voiceFor('pbp'));
    return autoVoice(spec);
  }

  function fillVoiceSelects() {
    const mac = useMac();
    // [value, label] pairs for this engine.
    const options = mac
      ? [['auto', 'Auto'], ['', 'System Voice (Settings › Spoken Content)'], ...app.macVoices.map((v) => [v.name, `${v.name} (${v.lang})`])]
      : [['', 'Auto'], ...englishVoices().map((v) => [v.voiceURI, `${v.name} (${v.lang})`])];
    for (const [id, speaker] of [['pbpVoice', 'pbp'], ['colourVoice', 'colour']]) {
      const sel = $(id);
      const saved = store.get(voiceKey(speaker), mac ? 'auto' : '');
      sel.innerHTML = '';
      for (const [value, label] of options) {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = options.some(([v]) => v === saved) ? saved : options[0][0];
      sel.onchange = () => store.set(voiceKey(speaker), sel.value);
    }
  }

  async function loadMacVoices() {
    try {
      const r = await getJSON('/api/voices');
      app.macVoices = r.voices || [];
    } catch { app.macVoices = []; }
  }

  async function initStatus() {
    try {
      const s = await getJSON('/api/status');
      app.llm = !!s.llm;
      const opt = $('source').querySelector('option[value=claude]');
      opt.disabled = !s.llm;
      if (s.llm) opt.textContent = `Claude (${s.model})`;
      $('llmStatus').textContent = s.llm ? '' : `Claude unavailable: ${s.llmError}. Using built-in lines.`;
      $('logFile').textContent = `Build ${BUILD}. ` + (s.logFile ? `Logging to ${s.logFile}` : 'Logging is off.');
      $('engine').querySelector('option[value=mac]').disabled = !s.macVoices;
      if (s.macVoices) await loadMacVoices();
      $('engine').value = s.macVoices && store.get('engine', 'browser') === 'mac' ? 'mac' : 'browser';
      fillVoiceSelects();
    } catch (e) {
      $('llmStatus').textContent = 'Server not reachable. Start it with: python3 server.py';
    }
    const want = store.get('source', 'templates');
    $('source').value = want === 'claude' && app.llm ? 'claude' : 'templates';
    $('source').addEventListener('change', () => store.set('source', $('source').value));
    $('engine').addEventListener('change', () => { store.set('engine', $('engine').value); stopSpeech(); fillVoiceSelects(); });
  }

  // ---------------------------------------------------------------------------
  // Game list
  // ---------------------------------------------------------------------------

  function gameTag(g) {
    if (g.status === 'live') return ['LIVE', 'live'];
    if (g.status === 'final') return [`Final ${g.awayScore ?? ''}–${g.homeScore ?? ''}`, ''];
    if (g.detailed && /postpon|suspend|cancel/i.test(g.detailed)) return [g.detailed, ''];
    if (g.start) return [new Date(g.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), ''];
    return ['', ''];
  }

  let loadSeq = 0;
  async function loadGames() {
    const date = $('date').value || todayLocal();
    const box = $('games');
    const seq = ++loadSeq;
    box.innerHTML = '<div class="status">Loading…</div>';
    try {
      const games = await sport().listGames(date);
      if (seq !== loadSeq) return; // sport or date changed meanwhile
      box.innerHTML = games.length ? '' : `<div class="status">No ${sport().label.toLowerCase()} games on this date. Try another day, or the demo game.</div>`;
      for (const g of games) {
        const [tag, cls] = gameTag(g);
        const b = document.createElement('button');
        b.className = 'game';
        b.innerHTML = `<span>${esc(g.label)}${g.note ? ` <span class="note">${esc(g.note)}</span>` : ''}</span><span class="tag ${cls}">${esc(tag)}</span>`;
        b.onclick = () => selectGame({ id: g.id, status: g.status, label: g.label }, b);
        box.appendChild(b);
      }
    } catch (e) {
      if (seq === loadSeq) box.innerHTML = `<div class="status err">Couldn't load games: ${esc(e.message)}. The demo game works offline.</div>`;
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function selectGame(sel, btn) {
    if (app.running) stop();
    app.selected = sel;
    document.querySelectorAll('.game').forEach((b) => b.classList.remove('sel'));
    if (btn) btn.classList.add('sel');
    const finished = sel.demo || sel.status === 'final';
    $('startBtn').disabled = false;
    $('startBtn').textContent = finished ? 'Replay' : sel.status === 'live' ? 'Start live' : `Wait for ${app.sport === 'mlb' ? 'first pitch' : 'puck drop'}`;
    $('speed').classList.toggle('hidden', !finished);
    $('delayBox').classList.toggle('hidden', finished);
    $('syncHint').classList.toggle('hidden', finished);
    setStatus(`${sel.label} selected.`);
  }

  // ---------------------------------------------------------------------------
  // Board + log
  // ---------------------------------------------------------------------------

  function updateBoard(ev) {
    const b = eng().boardText(app.state, ev);
    $('score').innerHTML = `${esc(b.main)} <small id="period">${esc(b.sub)}</small>`;
  }

  function logRow(el) {
    const log = $('log');
    log.appendChild(el);
    while (log.children.length > LOG_MAX) log.removeChild(log.firstChild);
  }

  function logEvent(ev, arrivedAt, desc) {
    const row = document.createElement('div');
    row.className = 'ev';
    const span = document.createElement('span');
    span.textContent = desc;
    if (app.mode === 'live') {
      const b = document.createElement('button');
      b.textContent = 'sync';
      b.title = 'Click the moment this happens on your TV';
      // Baseball pitches carry the time they happened, so sync against that:
      // your TV's lag behind live is steady even when the feed is bursty.
      b.onclick = () => {
        setDelay(Math.round((Date.now() - (ev.wall || arrivedAt)) / 1000));
        log('sync', { delay: app.delay, event: desc, anchor: ev.wall ? 'event time' : 'arrival' });
      };
      row.appendChild(b);
    }
    row.appendChild(span);
    logRow(row);
  }

  function logLine(line) {
    const row = document.createElement('div');
    row.className = `line ${line.speaker}${line.excitement === 2 ? ' huge' : ''}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = line.speaker === 'pbp' ? 'PBP' : 'Colour';
    row.append(who, document.createTextNode(line.text));
    logRow(row);
  }

  function setDelay(sec) {
    app.delay = clamp(sec, 0, 600);
    $('delay').textContent = `${app.delay}s`;
    store.set(`${app.sport}.delay`, app.delay);
  }

  // ---------------------------------------------------------------------------
  // Speech scheduler
  // ---------------------------------------------------------------------------

  // wall: when the event happened (baseball). Lines with one are timed to
  // wall + delay (the delay is then "your TV is behind live by");
  // otherwise to arrival + delay.
  function enqueue(lines, arrivedAt, wall) {
    for (const l of lines) app.queue.push({ ...l, arrivedAt, wall: wall || null, seq: ++app.seq });
  }

  // Stop whatever is being said. For Mac voices, only the line we're cutting
  // off is stopped (a stale stop request mustn't kill the next line).
  function stopSpeech() {
    speechSynthesis.cancel();
    if (useMac() && app.speaking) {
      fetch('/api/say/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upTo: app.speaking.tok }) }).catch(() => {});
    }
  }

  function speakMac(line, spec) {
    const tok = ++app.seq;
    app.speaking = { tok, line, startedAt: Date.now() };
    const rate = Math.round(185 * spec.rate * (1 + 0.08 * line.excitement));
    postJSON('/api/say', { text: line.text, voice: macVoiceFor(line.speaker), rate, id: tok })
      .catch((e) => log('warn', { message: `Mac voice failed: ${e.message}` }))
      .finally(() => { if (app.speaking && app.speaking.tok === tok) app.speaking = null; });
  }

  function speak(line, lateMs) {
    const spec = persona().voices[line.speaker];
    if (useMac()) {
      speakMac(line, spec);
      app.lastLineAt = Date.now();
      logLine(line);
      app.spoken.push(line.text);
      if (app.spoken.length > 20) app.spoken.shift();
      log('line', { speaker: line.speaker, text: line.text, eventId: line.eventId, excitement: line.excitement, lateMs: Math.round(lateMs || 0), engine: 'mac' });
      return;
    }
    const u = new SpeechSynthesisUtterance(line.text);
    const v = voiceFor(line.speaker);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = spec.langs[0];
    u.rate = clamp(spec.rate + 0.12 * line.excitement, 0.5, 2);
    u.pitch = clamp(spec.pitch + 0.12 * line.excitement, 0, 2);
    const tok = ++app.seq;
    const done = () => { if (app.speaking && app.speaking.tok === tok) app.speaking = null; };
    u.onend = done; u.onerror = done;
    app.speaking = { tok, line, startedAt: Date.now() };
    app.lastLineAt = Date.now();
    speechSynthesis.speak(u);
    logLine(line);
    app.spoken.push(line.text);
    if (app.spoken.length > 20) app.spoken.shift();
    log('line', { speaker: line.speaker, text: line.text, eventId: line.eventId, excitement: line.excitement, lateMs: Math.round(lateMs || 0) });
  }

  function tick() {
    const now = Date.now();
    const delayMs = app.mode === 'live' ? app.delay * 1000 : 0;
    const dueAt = (l) => (app.mode === 'live' && l.wall ? l.wall : l.arrivedAt) + delayMs;
    const stale = app.queue.filter((l) => l.priority < 5 && now - dueAt(l) > STALE_MS);
    if (stale.length) {
      app.queue = app.queue.filter((l) => !stale.includes(l));
      log('drop', { reason: 'stale', lines: stale.map((l) => l.text) });
    }
    let due = app.queue.filter((l) => dueAt(l) <= now).sort((a, b) => a.seq - b.seq);
    if (!due.length) return maybeFinish();

    const urgent = due.find((l) => l.excitement === 2 && l.speaker === 'pbp');
    if (app.speaking) {
      if (now - app.speaking.startedAt > 20000) { stopSpeech(); app.speaking = null; }
      else if (urgent && app.speaking.line.priority < 8) { stopSpeech(); app.speaking = null; }
      else return;
    }
    // A goal jumps the queue; routine chatter before it is dropped.
    if (urgent) {
      const drop = new Set(due.filter((l) => l.seq < urgent.seq && l.priority < 8));
      app.queue = app.queue.filter((l) => !drop.has(l));
      due = due.filter((l) => !drop.has(l));
    } else if (due.length > 3) {
      // Backlog: thin routine lines, keep the newest.
      const keep = new Set(due.slice(-2));
      const drop = new Set(due.filter((l) => l.priority <= 3 && !keep.has(l)));
      app.queue = app.queue.filter((l) => !drop.has(l));
      due = due.filter((l) => !drop.has(l));
    }
    const next = due[0];
    app.queue = app.queue.filter((l) => l !== next);
    speak(next, now - dueAt(next));
  }

  function maybeFinish() {
    if (app.finished && !app.queue.length && !app.speaking && !app.inFlight && !app.pending.length) {
      setStatus('Final. Thanks for watching.');
      stop(true);
    }
  }

  // ---------------------------------------------------------------------------
  // Event processing
  // ---------------------------------------------------------------------------

  function setupGame(pbp) {
    app.game = eng().buildGame(pbp);
    app.state = new (eng().GameState)(app.game);
    app.seen = new Set();
    app.queue = []; app.pending = []; app.recent = [];
    app.finished = false;
    app.lags = []; app.lastPollAt = 0; app.late = [];
  }

  function process(events, arrivedAt) {
    const claude = $('source').value === 'claude';
    for (const ev of events) {
      app.seen.add(ev.id);
      app.state.apply(ev);
      const lines = eng().templateLines(ev, persona(), app.state);
      const desc = eng().describe(ev, app.state);
      logEvent(ev, arrivedAt, desc);
      updateBoard(ev);
      app.events.push(desc);
      if (app.events.length > 20) app.events.shift();
      const lagMs = app.mode === 'live' && ev.wall ? arrivedAt - ev.wall : null;
      if (lagMs != null && ev.type === 'pitch' && lagMs > -60000 && lagMs < 600000) {
        app.lags.push(lagMs);
        if (app.lags.length > 15) app.lags.shift();
      }
      if (lagMs != null && ev.type === 'pitch') {
        app.late.push(arrivedAt - (ev.wall + app.delay * 1000));
        if (app.late.length > 10) app.late.shift();
      }
      log('event', { id: ev.id, type: ev.type, desc, arrivedAt, feedLagMs: lagMs, situation: eng().situation(app.state) });
      if (claude) {
        app.pending.push({ ev, arrivedAt, fallback: lines, desc, wall: app.mode === 'live' ? ev.wall : null });
        if (ev.type === 'goal') flushClaude();
      } else {
        enqueue(lines, arrivedAt, app.mode === 'live' ? ev.wall : null);
      }
      if (ev.type === 'game-end') app.finished = true;
      if (claude && ev.type === 'game-end') flushClaude();
    }
  }

  async function flushClaude() {
    if (app.inFlight || (!app.pending.length && !app.joining)) return;
    const batch = app.pending.splice(0);
    const worth = app.joining || batch.some((b) => b.ev.priority >= 3) || Date.now() - app.lastLineAt > 25000;
    if (!worth) return; // faceoffs only: not worth a request
    app.inFlight = true;
    const g = app.game, p = persona();
    const arrivedAt = batch.length ? batch[0].arrivedAt : Date.now();
    const maxPri = Math.max(1, ...batch.map((b) => b.ev.priority));
    const payload = {
      sport: app.sport,
      persona: { label: p.label, style: p.llmStyle },
      game: { away: g.away.name, home: g.home.name, venue: g.venue },
      situation: eng().situation(app.state),
      joining: app.joining,
      recent: app.recent.slice(-12),
      events: batch.map((b) => b.desc),
    };
    try {
      const r = await postJSON('/api/commentary', payload);
      const lines = r.lines.map((l) => ({ ...l, priority: l.excitement === 2 ? 10 : maxPri }));
      if (app.running) enqueue(lines, arrivedAt, batch.length ? batch[0].wall : null);
      app.recent.push(...lines.map((l) => `${l.speaker}: ${l.text}`));
      app.recent = app.recent.slice(-24);
      const late = app.mode === 'live' && r.seconds > app.delay;
      if (late) log('warn', { message: `Claude took ${r.seconds}s, longer than the ${app.delay}s delay` });
      $('llmStatus').textContent = `Claude answered in ${r.seconds}s` + (late ? `, which is longer than your delay. Raise the delay above ${Math.ceil(r.seconds) + 2}s.` : '.');
    } catch (e) {
      log('warn', { message: `Claude failed: ${e.message}` });
      $('llmStatus').textContent = `Claude failed (${e.message}). Using built-in lines for that stretch.`;
      if (app.running) for (const b of batch) enqueue(b.fallback, b.arrivedAt, b.wall);
    } finally {
      app.inFlight = false;
      app.joining = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Live mode
  // ---------------------------------------------------------------------------

  async function startLive() {
    app.mode = 'live';
    const id = app.selected.id;
    setStatus('Connecting to the NHL feed…');
    const pbp = await getJSON(sport().feedUrl(id));
    setupGame(pbp);
    const evs = eng().normalizePlays(pbp, app.game);
    if (eng().inProgress(evs)) {
      evs.forEach((e) => app.seen.add(e.id));
      app.state.seed(evs);
      updateBoard(evs[evs.length - 1]);
      if ($('source').value === 'claude') { app.joining = true; flushClaude(); }
      else enqueue([{ speaker: 'pbp', text: eng().joinLine(persona(), app.state), excitement: 0, priority: 9 }], Date.now() - app.delay * 1000);
    } else {
      process(evs, Date.now());
    }
    setStatus(`Live: ${app.game.away.name} at ${app.game.home.name}. Mute your TV.`);

    const poll = async () => {
      if (!app.running) return;
      try {
        const t0 = Date.now();
        const data = await getJSON(sport().feedUrl(id));
        eng().refreshGame(app.game, data);
        const now = Date.now();
        const added = eng().normalizePlays(data, app.game).filter((e) => !app.seen.has(e.id));
        if (added.length) process(added, now);
        log('poll', { ms: now - t0, sinceLast: app.lastPollAt ? t0 - app.lastPollAt : null, added: added.length, hidden: document.hidden });
        app.lastPollAt = t0;
        if (sport().feedStatus(data) === 'final' && !app.finished) { app.finished = true; log('final', { situation: eng().situation(app.state) }); }
        const lag = feedLag();
        const behind = behindTv();
        if (!app.finished) setStatus(`Live: ${app.game.away.name} at ${app.game.home.name}. Feed updated ${new Date().toLocaleTimeString()}.` +
          (lag != null ? ` MLB's feed is running about ${lag}s behind live.` : '') +
          (behind != null ? ` Pitches reach the booth about ${behind}s after your TV shows them: pause the TV for ~${behind + 3}s, then sync on the next pitch.` : ''),
          behind != null);
      } catch (e) {
        log('warn', { message: `feed poll failed: ${e.message}` });
        setStatus(`Feed hiccup (${e.message}); retrying…`, true);
      }
      if (app.running && !app.finished) app.timers.push(ticker.after(POLL_MS, poll));
    };
    app.timers.push(ticker.after(POLL_MS, poll));
  }

  // ---------------------------------------------------------------------------
  // Replay mode (finished games and the demo)
  // ---------------------------------------------------------------------------

  async function startReplay() {
    app.mode = 'replay';
    setStatus('Loading game…');
    const pbp = await getJSON(app.selected.demo ? sport().demoUrl : sport().feedUrl(app.selected.id));
    setupGame(pbp);
    const evs = eng().normalizePlays(pbp, app.game);
    const speed = Number($('speed').value) || 4;
    let i = 0, clock = -2, last = Date.now();
    setStatus(`Replay at ${speed}×: ${app.game.away.name} at ${app.game.home.name}.`);
    const step = () => {
      if (!app.running) return;
      const now = Date.now();
      clock += ((now - last) / 1000) * speed;
      last = now;
      // Skip dead air (between innings, long stoppages) once the booth is quiet.
      const quiet = !app.queue.length && !app.speaking && !app.inFlight && !app.pending.length;
      if (quiet && i < evs.length && evs[i].replayAt - clock > 3 * speed) clock = evs[i].replayAt - speed;
      const out = [];
      while (i < evs.length && evs[i].replayAt <= clock) out.push(evs[i++]);
      if (out.length) process(out, now);
      if (i >= evs.length) app.finished = true;
    };
    app.timers.push(ticker.every(250, step));
  }

  // ---------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------

  async function start() {
    if (!app.selected) return;
    app.running = true;
    $('startBtn').disabled = true; $('stopBtn').disabled = false;
    $('log').innerHTML = '';
    stopSpeech();
    app.speaking = null;
    app.timers.push(ticker.every(200, tick));
    app.timers.push(ticker.every(BATCH_MS, flushClaude));
    const sel = app.selected;
    log('start', {
      build: BUILD, sport: app.sport, game: sel.label, gameId: sel.id, status: sel.status || 'demo', persona: $('persona').value,
      source: $('source').value, delay: app.delay, speed: $('speed').value,
      engine: $('engine').value, voices: { pbp: voiceName('pbp'), colour: voiceName('colour') }, userAgent: navigator.userAgent,
    });
    try {
      if (sel.demo || sel.status === 'final') await startReplay();
      else if (sel.status === 'live') await startLive();
      else await waitForStart();
    } catch (e) {
      log('error', { message: `couldn't start: ${e.message}` });
      setStatus(`Couldn't start: ${e.message}`, true);
      stop();
    }
  }

  async function waitForStart() {
    setStatus(`Waiting for ${app.sport === 'mlb' ? 'first pitch' : 'puck drop'}. Leave this tab open.`);
    const check = async () => {
      if (!app.running) return;
      try {
        const feed = await getJSON(sport().feedUrl(app.selected.id));
        if (sport().feedStatus(feed) === 'live') { app.selected.status = 'live'; return startLive(); }
      } catch { /* keep waiting */ }
      app.timers.push(ticker.after(30000, check));
    };
    check();
  }

  function stop(keepStatus) {
    if (app.running) log('stop', { situation: app.state ? eng().situation(app.state) : '' });
    app.running = false;
    app.timers.forEach((t) => ticker.cancel(t));
    app.timers = [];
    app.queue = []; app.pending = [];
    stopSpeech();
    app.speaking = null;
    $('startBtn').disabled = !app.selected; $('stopBtn').disabled = true;
    if (!keepStatus) setStatus('Stopped.');
  }

  // ---------------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------------

  function init() {
    if (!('speechSynthesis' in window)) {
      setStatus('This browser has no speech synthesis. Try Chrome, Edge or Safari.', true);
      return;
    }
    app.sport = SPORTS[store.get('sport', 'nhl')] ? store.get('sport', 'nhl') : 'nhl';
    document.querySelectorAll('[data-sport]').forEach((b) => b.addEventListener('click', () => switchSport(b.dataset.sport)));
    $('persona').addEventListener('change', onPersonaChange);
    applySport();
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', fillVoiceSelects);
    initStatus();
    setDelay(app.delay);
    document.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
      setDelay(app.delay + Number(b.dataset.d));
      log('delay', { delay: app.delay });
    }));
    $('flagBtn').onclick = flag;
    $('flagNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') flag(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'f' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('flagNote').focus(); }
    });
    $('date').value = todayLocal();
    $('loadGames').onclick = loadGames;
    $('date').onchange = loadGames;
    $('demoBtn').onclick = () => selectGame({ demo: true, id: 'demo', label: sport().demoLabel });
    $('startBtn').onclick = start;
    $('stopBtn').onclick = () => stop();
    loadGames();
  }

  function applySport() {
    document.querySelectorAll('[data-sport]').forEach((b) => b.classList.toggle('on', b.dataset.sport === app.sport));
    // Baseball syncs to when each pitch happened, so the number means "TV lag".
    $('delayLabel').textContent = app.sport === 'mlb' ? 'Your TV is behind live by' : 'Commentary delay';
    setDelay(store.get(`${app.sport}.delay`, app.sport === 'mlb' ? 30 : 20));
    $('syncHintSport').innerHTML = sport().syncHint;
    initPersonas();
  }

  function switchSport(id) {
    if (id === app.sport || !SPORTS[id]) return;
    if (app.running) stop();
    app.sport = id;
    store.set('sport', id);
    app.selected = null;
    $('startBtn').disabled = true;
    $('score').innerHTML = '—';
    $('log').innerHTML = '';
    setStatus('Select a game.');
    applySport();
    loadGames();
  }

  init();
})();
