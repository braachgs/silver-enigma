/* Broadcast Booth UI: game picking, live polling / replay, Claude batching,
 * speech scheduling with a sync delay. Commentary logic lives in engine.js. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const B = window.Booth;
  const POLL_MS = 5000;      // live feed poll
  const BATCH_MS = 6000;     // how often to send events to Claude
  const STALE_MS = 15000;    // drop routine lines this late
  const LOG_MAX = 300;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('booth.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('booth.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const app = {
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

  const persona = () => B.PERSONAS[$('persona').value] || B.PERSONAS.hnic90;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const todayLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  // ---------------------------------------------------------------------------
  // Setup: personas, voices, status
  // ---------------------------------------------------------------------------

  function initPersonas() {
    for (const p of Object.values(B.PERSONAS)) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      $('persona').appendChild(o);
    }
    $('persona').value = store.get('persona', 'hnic90');
    const upd = () => { $('blurb').textContent = persona().blurb; store.set('persona', $('persona').value); fillVoiceSelects(); };
    $('persona').addEventListener('change', upd);
    upd();
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
    const st = g.gameState;
    if (st === 'LIVE' || st === 'CRIT') return ['LIVE', 'live'];
    if (st === 'FINAL' || st === 'OFF') return [`Final ${g.awayTeam?.score ?? ''}–${g.homeTeam?.score ?? ''}`, ''];
    if (g.startTimeUTC) return [new Date(g.startTimeUTC).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), ''];
    return [st || '', ''];
  }

  async function loadGames() {
    const date = $('date').value || todayLocal();
    const box = $('games');
    box.innerHTML = '<div class="status">Loading…</div>';
    try {
      const data = await getJSON(`/api/nhl/score/${date}`);
      const games = data.games || [];
      box.innerHTML = games.length ? '' : '<div class="status">No NHL games on this date. Try another day, or the demo game.</div>';
      for (const g of games) {
        const [tag, cls] = gameTag(g);
        const b = document.createElement('button');
        b.className = 'game';
        b.innerHTML = `<span>${g.awayTeam?.abbrev ?? '?'} @ ${g.homeTeam?.abbrev ?? '?'}</span><span class="tag ${cls}">${tag}</span>`;
        b.onclick = () => selectGame({ id: g.id, state: g.gameState, label: `${g.awayTeam?.abbrev} @ ${g.homeTeam?.abbrev}` }, b);
        box.appendChild(b);
      }
    } catch (e) {
      box.innerHTML = `<div class="status err">Couldn't load games: ${e.message}. The demo game works offline.</div>`;
    }
  }

  function selectGame(sel, btn) {
    if (app.running) stop();
    app.selected = sel;
    document.querySelectorAll('.game').forEach((b) => b.classList.remove('sel'));
    if (btn) btn.classList.add('sel');
    const finished = sel.demo || sel.state === 'FINAL' || sel.state === 'OFF';
    $('startBtn').disabled = false;
    $('startBtn').textContent = finished ? 'Replay' : sel.state === 'LIVE' || sel.state === 'CRIT' ? 'Start live' : 'Wait for puck drop';
    $('speed').classList.toggle('hidden', !finished);
    $('delayBox').classList.toggle('hidden', finished);
    $('syncHint').classList.toggle('hidden', finished);
    setStatus(`${sel.label} selected.`);
  }

  // ---------------------------------------------------------------------------
  // Board + log
  // ---------------------------------------------------------------------------

  function updateBoard(ev) {
    const s = app.state, g = app.game;
    $('score').innerHTML = `${g.away.abbrev} ${s.score.away} – ${s.score.home} ${g.home.abbrev}` +
      `<small id="period">${B.periodLabel(s.period, s.periodType)}${ev && ev.timeRemaining ? ' · ' + ev.timeRemaining : ''} · SOG ${s.sog.away}–${s.sog.home}</small>`;
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
    span.textContent = B.describe(ev);
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
    app.game = B.buildGame(pbp);
    app.state = new B.GameState(app.game);
    app.seen = new Set();
    app.queue = []; app.pending = []; app.recent = [];
    app.finished = false;
  }

  function process(events, arrivedAt) {
    const claude = $('source').value === 'claude';
    for (const ev of events) {
      app.seen.add(ev.id);
      app.state.apply(ev);
      const lines = B.templateLines(ev, persona(), app.state);
      logEvent(ev, arrivedAt);
      updateBoard(ev);
      if (claude) {
        app.pending.push({ ev, arrivedAt, fallback: lines });
        if (ev.type === 'goal') flushClaude();
      } else {
        enqueue(lines, arrivedAt);
      }
      if (ev.type === 'game-end') app.finished = true;
    }
  }

  async function flushClaude() {
    if (app.inFlight || (!app.pending.length && !app.joining)) return;
    const batch = app.pending.splice(0);
    const worth = app.joining || batch.some((b) => b.ev.priority >= 3) || Date.now() - app.lastLineAt > 25000;
    if (!worth) return; // faceoffs only: not worth a request
    app.inFlight = true;
    const s = app.state, g = app.game, p = persona();
    const arrivedAt = batch.length ? batch[0].arrivedAt : Date.now();
    const maxPri = Math.max(1, ...batch.map((b) => b.ev.priority));
    const payload = {
      persona: { label: p.label, style: p.llmStyle },
      game: { away: g.away.name, home: g.home.name, venue: g.venue },
      state: { awayScore: s.score.away, homeScore: s.score.home, awaySog: s.sog.away, homeSog: s.sog.home, period: B.periodLabel(s.period, s.periodType) },
      joining: app.joining,
      recent: app.recent.slice(-12),
      events: batch.map((b) => B.describe(b.ev)),
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
    const pbp = await getJSON(`/api/nhl/gamecenter/${id}/play-by-play`);
    setupGame(pbp);
    const evs = B.normalizePlays(pbp, app.game);
    const inProgress = evs.some((e) => e.type !== 'period-start' && e.type !== 'faceoff');
    if (inProgress) {
      evs.forEach((e) => app.seen.add(e.id));
      app.state.seed(evs);
      updateBoard(evs[evs.length - 1]);
      if ($('source').value === 'claude') { app.joining = true; flushClaude(); }
      else enqueue([{ speaker: 'pbp', text: B.joinLine(persona(), app.state), excitement: 0, priority: 9 }], Date.now() - app.delay * 1000);
    } else {
      process(evs, Date.now());
    }
    setStatus(`Live: ${app.game.away.name} at ${app.game.home.name}. Mute your TV.`);

    const poll = async () => {
      if (!app.running) return;
      try {
        const data = await getJSON(`/api/nhl/gamecenter/${id}/play-by-play`);
        const fresh = B.buildGame(data);
        if (fresh.roster.size) { app.game.roster = fresh.roster; }
        const now = Date.now();
        const added = B.normalizePlays(data, app.game).filter((e) => !app.seen.has(e.id));
        if (added.length) process(added, now);
        if ((data.gameState === 'FINAL' || data.gameState === 'OFF') && !app.finished) app.finished = true;
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
    const pbp = app.selected.demo ? await getJSON('demo-game.json') : await getJSON(`/api/nhl/gamecenter/${app.selected.id}/play-by-play`);
    setupGame(pbp);
    const evs = B.normalizePlays(pbp, app.game);
    const speed = Number($('speed').value) || 4;
    let i = 0, clock = -2, last = Date.now();
    setStatus(`Replay at ${speed}×: ${app.game.away.name} at ${app.game.home.name}.`);
    const step = () => {
      if (!app.running) return;
      const now = Date.now();
      clock += ((now - last) / 1000) * speed;
      last = now;
      const out = [];
      while (i < evs.length && evs[i].gameSeconds <= clock) out.push(evs[i++]);
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
      if (sel.demo || sel.state === 'FINAL' || sel.state === 'OFF') await startReplay();
      else if (sel.state === 'LIVE' || sel.state === 'CRIT') await startLive();
      else await waitForPuckDrop();
    } catch (e) {
      setStatus(`Couldn't start: ${e.message}`, true);
      stop();
    }
  }

  async function waitForPuckDrop() {
    setStatus('Waiting for puck drop. Leave this tab open.');
    const check = async () => {
      if (!app.running) return;
      try {
        const pbp = await getJSON(`/api/nhl/gamecenter/${app.selected.id}/play-by-play`);
        if (pbp.gameState === 'LIVE' || pbp.gameState === 'CRIT') { app.selected.state = pbp.gameState; return startLive(); }
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
    initPersonas();
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', fillVoiceSelects);
    initStatus();
    setDelay(app.delay);
    document.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => setDelay(app.delay + Number(b.dataset.d))));
    $('date').value = todayLocal();
    $('loadGames').onclick = loadGames;
    $('date').onchange = loadGames;
    $('demoBtn').onclick = () => selectGame({ demo: true, id: 'demo', label: 'Demo: MTL @ TOR (fictional)' });
    $('startBtn').onclick = start;
    $('stopBtn').onclick = () => stop();
    loadGames();
  }

  init();
})();
