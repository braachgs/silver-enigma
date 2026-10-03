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
      syncHint: 'When the pitcher delivers on TV, click <b>sync</b> next to that pitch below.',
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
    timers: [], delay: store.get('delay', 20), finished: false,
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

  function voiceFor(speaker) {
    const sel = $(speaker === 'pbp' ? 'pbpVoice' : 'colourVoice').value;
    const all = speechSynthesis.getVoices();
    if (sel) { const v = all.find((x) => x.voiceURI === sel); if (v) return v; }
    const spec = persona().voices[speaker];
    if (speaker === 'colour') return autoVoice(spec, voiceFor('pbp'));
    return autoVoice(spec);
  }

  function fillVoiceSelects() {
    const voices = englishVoices();
    for (const [id, speaker] of [['pbpVoice', 'pbp'], ['colourVoice', 'colour']]) {
      const sel = $(id);
      const saved = store.get(`${persona().id}.${speaker}Voice`, '');
      sel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = ''; auto.textContent = 'Auto';
      sel.appendChild(auto);
      for (const v of voices) {
        const o = document.createElement('option');
        o.value = v.voiceURI; o.textContent = `${v.name} (${v.lang})`;
        sel.appendChild(o);
      }
      sel.value = voices.some((v) => v.voiceURI === saved) ? saved : '';
      sel.onchange = () => store.set(`${persona().id}.${speaker}Voice`, sel.value);
    }
  }

  async function initStatus() {
    try {
      const s = await getJSON('/api/status');
      app.llm = !!s.llm;
      const opt = $('source').querySelector('option[value=claude]');
      opt.disabled = !s.llm;
      if (s.llm) opt.textContent = `Claude (${s.model})`;
      $('llmStatus').textContent = s.llm ? '' : `Claude unavailable: ${s.llmError}. Using built-in lines.`;
    } catch (e) {
      $('llmStatus').textContent = 'Server not reachable. Start it with: python3 server.py';
    }
    const want = store.get('source', 'templates');
    $('source').value = want === 'claude' && app.llm ? 'claude' : 'templates';
    $('source').addEventListener('change', () => store.set('source', $('source').value));
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

  function logEvent(ev, arrivedAt) {
    const row = document.createElement('div');
    row.className = 'ev';
    const span = document.createElement('span');
    span.textContent = eng().describe(ev, app.state);
    if (app.mode === 'live') {
      const b = document.createElement('button');
      b.textContent = 'sync';
      b.title = 'Click the moment this happens on your TV';
      b.onclick = () => setDelay(Math.round((Date.now() - arrivedAt) / 1000));
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
    app.delay = clamp(sec, 0, 180);
    $('delay').textContent = `${app.delay}s`;
    store.set('delay', app.delay);
  }

  // ---------------------------------------------------------------------------
  // Speech scheduler
  // ---------------------------------------------------------------------------

  function enqueue(lines, arrivedAt) {
    for (const l of lines) app.queue.push({ ...l, arrivedAt, seq: ++app.seq });
  }

  function speak(line) {
    const spec = persona().voices[line.speaker];
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
  }

  function tick() {
    const now = Date.now();
    const delayMs = app.mode === 'live' ? app.delay * 1000 : 0;
    const dueAt = (l) => l.arrivedAt + delayMs;
    app.queue = app.queue.filter((l) => !(l.priority < 5 && now - dueAt(l) > STALE_MS));
    let due = app.queue.filter((l) => dueAt(l) <= now).sort((a, b) => a.seq - b.seq);
    if (!due.length) return maybeFinish();

    const urgent = due.find((l) => l.excitement === 2 && l.speaker === 'pbp');
    if (app.speaking) {
      if (now - app.speaking.startedAt > 20000) { speechSynthesis.cancel(); app.speaking = null; }
      else if (urgent && app.speaking.line.priority < 8) { speechSynthesis.cancel(); app.speaking = null; }
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
    speak(next);
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
  }

  function process(events, arrivedAt) {
    const claude = $('source').value === 'claude';
    for (const ev of events) {
      app.seen.add(ev.id);
      app.state.apply(ev);
      const lines = eng().templateLines(ev, persona(), app.state);
      logEvent(ev, arrivedAt);
      updateBoard(ev);
      if (claude) {
        app.pending.push({ ev, arrivedAt, fallback: lines, desc: eng().describe(ev, app.state) });
        if (ev.type === 'goal') flushClaude();
      } else {
        enqueue(lines, arrivedAt);
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
      if (app.running) enqueue(lines, arrivedAt);
      app.recent.push(...lines.map((l) => `${l.speaker}: ${l.text}`));
      app.recent = app.recent.slice(-24);
      const late = app.mode === 'live' && r.seconds > app.delay;
      $('llmStatus').textContent = `Claude answered in ${r.seconds}s` + (late ? `, which is longer than your delay. Raise the delay above ${Math.ceil(r.seconds) + 2}s.` : '.');
    } catch (e) {
      $('llmStatus').textContent = `Claude failed (${e.message}). Using built-in lines for that stretch.`;
      if (app.running) for (const b of batch) enqueue(b.fallback, b.arrivedAt);
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
        const data = await getJSON(sport().feedUrl(id));
        eng().refreshGame(app.game, data);
        const now = Date.now();
        const added = eng().normalizePlays(data, app.game).filter((e) => !app.seen.has(e.id));
        if (added.length) process(added, now);
        if (sport().feedStatus(data) === 'final' && !app.finished) app.finished = true;
        if (!app.finished) setStatus(`Live: ${app.game.away.name} at ${app.game.home.name}. Feed updated ${new Date().toLocaleTimeString()}.`);
      } catch (e) {
        setStatus(`Feed hiccup (${e.message}); retrying…`, true);
      }
      if (app.running && !app.finished) app.timers.push(setTimeout(poll, POLL_MS));
    };
    app.timers.push(setTimeout(poll, POLL_MS));
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
    app.timers.push(setInterval(step, 250));
  }

  // ---------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------

  async function start() {
    if (!app.selected) return;
    app.running = true;
    $('startBtn').disabled = true; $('stopBtn').disabled = false;
    $('log').innerHTML = '';
    speechSynthesis.cancel();
    app.speaking = null;
    app.timers.push(setInterval(tick, 200));
    app.timers.push(setInterval(flushClaude, BATCH_MS));
    const sel = app.selected;
    try {
      if (sel.demo || sel.status === 'final') await startReplay();
      else if (sel.status === 'live') await startLive();
      else await waitForStart();
    } catch (e) {
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
      app.timers.push(setTimeout(check, 30000));
    };
    check();
  }

  function stop(keepStatus) {
    app.running = false;
    app.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    app.timers = [];
    app.queue = []; app.pending = [];
    speechSynthesis.cancel();
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
    document.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => setDelay(app.delay + Number(b.dataset.d))));
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
