/*
 * Broadcast Booth baseball engine: turns the MLB live game feed into
 * commentary lines, pitch by pitch.
 *
 * Same interface as engine.js (hockey) so app.js can drive either sport.
 * Loaded by the browser (window.BallBooth) and by the Node tests.
 *
 * Data source: statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live
 * (MLB's public "GUMBO" feed; undocumented, field names per community clients).
 */
(function (root) {
  'use strict';

  const BASES = ['1B', '2B', '3B'];
  const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;

  // ---------------------------------------------------------------------------
  // Game parsing
  // ---------------------------------------------------------------------------

  function parseTeam(t) {
    t = t || {};
    return {
      id: t.id,
      abbrev: t.abbreviation || (t.teamCode || '').toUpperCase() || '???',
      name: t.teamName || t.clubName || t.name || 'Team',
      full: t.name || t.teamName || 'Team',
    };
  }

  function buildGame(feed) {
    const gd = feed.gameData || {};
    const teams = gd.teams || {};
    return {
      id: feed.gamePk || (gd.game && gd.game.pk),
      status: (gd.status && gd.status.abstractGameState) || '',
      venue: (gd.venue && gd.venue.name) || '',
      away: parseTeam(teams.away),
      home: parseTeam(teams.home),
      players: gd.players || {},
    };
  }

  function refreshGame(game, feed) {
    const fresh = buildGame(feed);
    game.players = fresh.players;
    game.status = fresh.status;
  }

  function surname(game, person) {
    if (!person) return '';
    const p = game.players[`ID${person.id}`];
    if (p && p.lastName) return p.lastName;
    const parts = String(person.fullName || '').split(/\s+/).filter((w) => !SUFFIX.test(w));
    return parts.length ? parts[parts.length - 1] : '';
  }

  // ---------------------------------------------------------------------------
  // Play normalisation
  // ---------------------------------------------------------------------------

  const PRIORITY = {
    'game-end': 10, 'result': 6, 'half': 7, 'action': 4, 'atbat': 3, 'pitch': 2,
  };

  function pitchKind(desc, code) {
    const d = String(desc || '').toLowerCase();
    if (/in play/.test(d) || ['X', 'D', 'E'].includes(code)) return 'inplay';
    if (/hit by pitch/.test(d) || code === 'H') return 'hbp';
    if (/foul/.test(d)) return 'foul';
    if (/swinging|missed bunt/.test(d)) return 'swinging';
    if (/called strike|automatic strike/.test(d)) return 'called';
    if (/ball|pitchout/.test(d)) return 'ball';
    return 'other';
  }

  function heightOf(pd) {
    if (!pd || !pd.coordinates || pd.coordinates.pZ == null || !pd.strikeZoneTop) return '';
    const z = pd.coordinates.pZ;
    if (z > pd.strikeZoneTop + 0.1) return 'high';
    if (z < pd.strikeZoneBottom - 0.1) return 'low';
    return '';
  }

  function ts(s) {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  function movementsOf(game, runners) {
    return (runners || []).map((r) => ({
      runner: surname(game, r.details && r.details.runner),
      start: r.movement && r.movement.start,
      end: r.movement && r.movement.end,
      isOut: !!(r.movement && r.movement.isOut),
      scored: !!(r.details && r.details.isScoringEvent),
      playIndex: r.details ? r.details.playIndex : null,
    }));
  }

  // Stable id for a pitch or action. MLB sometimes inserts or edits events in
  // an at-bat after the fact, which shifts positions; ids based on position
  // made the booth replay old pitches as new. Prefer MLB's own playId, then
  // the pitch number, then the event's time.
  function eventId(ab, pe, i) {
    if (pe.playId) return `${ab}-${pe.playId}`;
    if (pe.isPitch && pe.pitchNumber != null) return `${ab}-p${pe.pitchNumber}`;
    const d = pe.details || {};
    if (pe.startTime) return `${ab}-a${pe.startTime}-${d.eventType || pe.type || ''}`;
    return `${ab}-${pe.index != null ? pe.index : i}`;
  }

  function normalizePlays(feed, game) {
    const plays = (feed.liveData && feed.liveData.plays && feed.liveData.plays.allPlays) || [];
    const evs = [];
    let prevHalf = null;
    let t0 = null;
    let lastT = 0;
    const at = (iso) => {
      const t = ts(iso);
      if (t == null) return (lastT += 15);
      if (t0 == null) t0 = t;
      lastT = Math.max(lastT, (t - t0) / 1000);
      return lastT;
    };

    for (const play of plays) {
      const a = play.about || {};
      const ab = a.atBatIndex != null ? a.atBatIndex : play.atBatIndex;
      const top = a.isTopInning != null ? a.isTopInning : a.halfInning === 'top';
      const batting = top ? game.away : game.home;
      const fielding = top ? game.home : game.away;
      const m = play.matchup || {};
      const common = {
        inning: a.inning || 1, top, team: batting.abbrev, teamName: batting.name, oppName: fielding.name,
        batter: surname(game, m.batter), batterFull: (m.batter && m.batter.fullName) || '',
        pitcher: surname(game, m.pitcher), pitcherFull: (m.pitcher && m.pitcher.fullName) || '',
        batSide: m.batSide && m.batSide.code, pitchHand: m.pitchHand && m.pitchHand.code,
      };
      const events = play.playEvents || [];
      const runners = movementsOf(game, play.runners);
      const actionIdx = new Set();

      const halfKey = `${common.inning}-${top}`;
      if (halfKey !== prevHalf) {
        evs.push({ ...common, id: `${ab}-half`, type: 'half', sortOrder: ab * 1000, replayAt: at(a.startTime) });
        prevHalf = halfKey;
      }

      const firstPitch = events.findIndex((e) => e.isPitch);
      const introAt = firstPitch < 0 ? events.length : firstPitch;
      let pushedIntro = false;
      const pushIntro = (time) => {
        if (pushedIntro) return;
        pushedIntro = true;
        evs.push({ ...common, id: `${ab}-atbat`, type: 'atbat', sortOrder: ab * 1000 + 1 + introAt - 0.5, replayAt: at(time), wall: ts(time) });
      };

      events.forEach((pe, i) => {
        const d = pe.details || {};
        if (i === introAt) pushIntro(pe.startTime || a.startTime);
        // wall: when it happened (ms since epoch), for measuring feed lag.
        const base = { ...common, sortOrder: ab * 1000 + 1 + i, replayAt: at(pe.startTime), wall: ts(pe.startTime) };
        if (pe.isPitch) {
          const desc = (d.call && d.call.description) || d.description || '';
          const code = (d.call && d.call.code) || d.code;
          const pd = pe.pitchData || {};
          evs.push({
            ...base, id: eventId(ab, pe, i), type: 'pitch',
            kind: pitchKind(desc, code), call: desc,
            pitchType: (d.type && d.type.description) || 'pitch',
            speed: pd.startSpeed ? Math.round(pd.startSpeed) : null,
            height: heightOf(pd),
            count: pe.count ? { balls: pe.count.balls, strikes: pe.count.strikes, outs: pe.count.outs } : null,
            hit: pe.hitData || null,
          });
        } else if (pe.type === 'action' || pe.type === 'pickoff' || d.eventType) {
          actionIdx.add(pe.index != null ? pe.index : i);
          evs.push({
            ...base, id: eventId(ab, pe, i), type: 'action',
            eventType: d.eventType || '', event: d.event || '', description: d.description || '',
            score: d.awayScore != null && d.homeScore != null ? { away: d.awayScore, home: d.homeScore } : null,
            outs: pe.count ? pe.count.outs : null,
            movements: runners.filter((r) => r.playIndex === (pe.index != null ? pe.index : i)),
          });
        }
      });
      pushIntro(a.startTime);

      const r = play.result || {};
      if (a.isComplete && r.eventType) {
        const inPlay = [...events].reverse().find((e) => e.hitData);
        const lastPitch = [...events].reverse().find((e) => e.isPitch);
        const lastDesc = lastPitch ? ((lastPitch.details && lastPitch.details.call && lastPitch.details.call.description) || '') : '';
        evs.push({
          ...common, id: `${ab}-result`, type: 'result', sortOrder: ab * 1000 + 999,
          replayAt: at(a.endTime || play.playEndTime), wall: ts(a.endTime || play.playEndTime),
          eventType: r.eventType, event: r.event || '', description: r.description || '',
          rbi: r.rbi || 0,
          score: r.awayScore != null && r.homeScore != null ? { away: r.awayScore, home: r.homeScore } : null,
          outsAfter: play.count ? play.count.outs : null,
          looking: /called/i.test(lastDesc),
          pitchType: lastPitch && lastPitch.details && lastPitch.details.type ? lastPitch.details.type.description : null,
          hit: inPlay ? inPlay.hitData : null,
          scorers: runners.filter((x) => x.scored).map((x) => x.runner).filter(Boolean),
          movements: runners.filter((x) => !actionIdx.has(x.playIndex)),
        });
      }
    }

    if (game.status === 'Final' && plays.length) {
      evs.push({ id: 'final', type: 'game-end', sortOrder: 1e12, replayAt: lastT + 5, inning: 9, top: false });
    }
    for (const ev of evs) ev.priority = PRIORITY[ev.type] || 1;
    return evs.sort((x, y) => x.sortOrder - y.sortOrder);
  }

  function inProgress(evs) {
    return evs.some((e) => e.type === 'pitch' || e.type === 'result');
  }

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------

  class GameState {
    constructor(game) {
      this.game = game;
      this.score = { away: 0, home: 0 };
      this.prevScore = { away: 0, home: 0 };
      this.inning = 1;
      this.top = true;
      this.outs = 0;
      this.balls = 0; this.strikes = 0;
      this.prevBalls = 0; this.prevStrikes = 0;
      this.bases = { '1B': null, '2B': null, '3B': null };
      this.batter = ''; this.pitcher = '';
      this.history = new Map(); // batter -> [eventType]
      this.pitches = new Map(); // pitcher -> count
      this.used = new Map();
      this.lastColourAt = -Infinity;
      this.eventIndex = 0;
      this.lastType = null;
      this.over = false;
    }

    moveRunners(moves) {
      for (const m of moves || []) {
        if (m.start && BASES.includes(m.start)) this.bases[m.start] = null;
        if (!m.isOut && BASES.includes(m.end)) this.bases[m.end] = m.runner || 'runner';
      }
    }

    apply(ev) {
      this.eventIndex++;
      this.prevBalls = this.balls; this.prevStrikes = this.strikes;
      this.prevScore = { ...this.score };
      if (ev.inning) { this.inning = ev.inning; this.top = ev.top; }
      switch (ev.type) {
        case 'half':
          this.outs = 0; this.balls = 0; this.strikes = 0;
          this.bases = { '1B': null, '2B': null, '3B': null };
          break;
        case 'atbat':
          this.balls = 0; this.strikes = 0;
          this.batter = ev.batter; this.pitcher = ev.pitcher;
          break;
        case 'pitch':
          if (ev.count) { this.balls = ev.count.balls; this.strikes = ev.count.strikes; }
          this.pitches.set(ev.pitcher, (this.pitches.get(ev.pitcher) || 0) + 1);
          break;
        case 'action':
          if (ev.score) this.score = { ...ev.score };
          if (ev.outs != null) this.outs = ev.outs;
          this.moveRunners(ev.movements);
          break;
        case 'result':
          if (ev.score) this.score = { ...ev.score };
          if (ev.outsAfter != null) this.outs = ev.outsAfter;
          this.moveRunners(ev.movements);
          if (ev.batter) this.history.set(ev.batter, [...(this.history.get(ev.batter) || []), pastTense(ev)]);
          this.balls = 0; this.strikes = 0;
          break;
        case 'game-end':
          this.over = true;
          break;
      }
    }

    seed(events) {
      for (const ev of events) this.apply(ev);
      if (events.length) this.lastType = events[events.length - 1].type;
    }

    runnersOn() {
      return BASES.filter((b) => this.bases[b]);
    }
  }

  // ---------------------------------------------------------------------------
  // Words
  // ---------------------------------------------------------------------------

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  const halfText = (inning, top) => `${top ? 'top' : 'bottom'} of the ${ordinal(inning)}`;
  const NUM = ['oh', 'one', 'two', 'three'];
  const OUTS = ['nobody out', 'one out', 'two outs', 'three outs'];

  function countText(b, s) {
    if (b === 3 && s === 2) return 'full count';
    return `${NUM[b] || b} and ${NUM[s] || s}`;
  }

  function basesText(state) {
    const on = state.runnersOn();
    if (!on.length) return 'bases empty';
    if (on.length === 3) return 'bases loaded';
    const names = { '1B': 'first', '2B': 'second', '3B': 'third' };
    return `runner${on.length > 1 ? 's' : ''} on ${on.map((b) => names[b]).join(' and ')}`;
  }

  function scoreLine(state, persona) {
    const g = state.game, { away, home } = state.score, w = persona.numberWord || String;
    if (away === home) return away === 0 ? (persona.scoreless || 'No score') : (persona.tied ? persona.tied(w(away)) : `We're tied at ${w(away)}`);
    const lead = away > home ? g.away : g.home;
    const hi = Math.max(away, home), lo = Math.min(away, home);
    return persona.leads ? persona.leads(lead.name, w(hi), w(lo)) : `The ${lead.name} lead it, ${w(hi)} to ${w(lo)}`;
  }

  function finalLine(state, persona) {
    const g = state.game, { away, home } = state.score, w = persona.numberWord || String;
    if (away === home) return scoreLine(state, persona);
    const win = away > home ? g.away : g.home;
    const hi = Math.max(away, home), lo = Math.min(away, home);
    return persona.wins ? persona.wins(win.name, w(hi), w(lo)) : `The ${win.name} win it, ${w(hi)} to ${w(lo)}`;
  }

  const PAST = {
    single: 'singled', double: 'doubled', triple: 'tripled', home_run: 'homered',
    strikeout: 'struck out', walk: 'walked', intent_walk: 'walked', hit_by_pitch: 'got plunked',
    field_out: 'made an out', force_out: 'grounded into a force', grounded_into_double_play: 'hit into a double play',
    sac_fly: 'hit a sac fly', field_error: 'reached on an error', fielders_choice: 'reached on a fielder\'s choice',
  };

  function pastTense(ev) {
    if (ev.eventType === 'field_out') {
      const tr = ev.hit && ev.hit.trajectory;
      return { ground_ball: 'grounded out', fly_ball: 'flew out', line_drive: 'lined out', popup: 'popped up' }[tr] || 'made an out';
    }
    if (ev.eventType === 'strikeout') return ev.looking ? 'struck out looking' : 'struck out swinging';
    return PAST[ev.eventType] || 'made an out';
  }

  function describeTrajectory(hit) {
    const tr = hit && hit.trajectory;
    return { ground_ball: 'grounds out', fly_ball: 'flies out', line_drive: 'lines out', popup: 'pops up' }[tr] || 'is retired';
  }

  // ---------------------------------------------------------------------------
  // Factual description (transcript + Claude input)
  // ---------------------------------------------------------------------------

  function situation(state) {
    const g = state.game;
    return `${g.away.name} ${state.score.away}, ${g.home.name} ${state.score.home}. ` +
      `${cap(halfText(state.inning, state.top))}, ${OUTS[state.outs] || ''}, ${basesText(state)}, count ${state.balls}-${state.strikes}.`;
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function describe(ev, state) {
    const where = `[${ev.top ? 'T' : 'B'}${ev.inning}]`;
    switch (ev.type) {
      case 'half': return `${cap(halfText(ev.inning, ev.top))}. ${ev.teamName} batting.`;
      case 'atbat': return `${where} Now batting: ${ev.batterFull || ev.batter}${ev.batSide ? ` (${ev.batSide})` : ''} vs ${ev.pitcherFull || ev.pitcher}${ev.pitchHand ? ` (${ev.pitchHand}HP)` : ''}` +
        (state ? `. ${OUTS[state.outs]}, ${basesText(state)}.` : '.');
      case 'pitch': return `${where} ${ev.speed ? ev.speed + ' mph ' : ''}${ev.pitchType}: ${ev.call}${ev.height ? ` (${ev.height})` : ''}` +
        (ev.count && ev.kind !== 'inplay' ? `. Count ${ev.count.balls}-${ev.count.strikes}.` : '.');
      case 'action': return `${where} ${ev.description || ev.event}`;
      case 'result': {
        const h = ev.hit;
        const hitBits = h && h.launchSpeed ? ` (${Math.round(h.launchSpeed)} mph off the bat${h.totalDistance ? `, ${Math.round(h.totalDistance)} ft` : ''})` : '';
        return `${where} RESULT: ${ev.description || ev.event}${hitBits}` +
          (ev.score ? ` Score: ${state ? `${state.game.away.name} ${ev.score.away}, ${state.game.home.name} ${ev.score.home}` : `${ev.score.away}-${ev.score.home}`}.` : '') +
          (ev.outsAfter != null ? ` ${ev.outsAfter} out${ev.outsAfter === 1 ? '' : 's'}.` : '');
      }
      case 'game-end': return 'Final out. Game over.';
      default: return `${where} ${ev.type}`;
    }
  }

  function boardText(state, ev) {
    const g = state.game;
    const arrow = state.top ? '▲' : '▼';
    return {
      main: `${g.away.abbrev} ${state.score.away} – ${state.score.home} ${g.home.abbrev}`,
      sub: state.over ? 'Final'
        : state.outs >= 3 ? `${state.top ? 'Middle' : 'End'} of the ${ordinal(state.inning)}`
          : `${arrow} ${ordinal(state.inning)} · ${state.outs} out · ${state.balls}-${state.strikes} · ${basesText(state)}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Director
  // ---------------------------------------------------------------------------

  // Which persona line list an event maps to.
  function lineKey(ev, state) {
    switch (ev.type) {
      case 'half': return 'half';
      case 'atbat': return 'atbat';
      case 'game-end': return 'game-end';
      case 'pitch': {
        // Strike three and ball four are called by the result instead.
        if (ev.kind === 'inplay' || ev.kind === 'hbp') return null;
        if ((ev.kind === 'swinging' || ev.kind === 'called') && state.prevStrikes === 2) return null;
        if (ev.kind === 'ball' && state.prevBalls === 3) return null;
        return ['ball', 'called', 'swinging', 'foul'].includes(ev.kind) ? ev.kind : null;
      }
      case 'action': {
        const t = ev.eventType || '';
        if (/^stolen_base/.test(t)) return 'steal';
        if (/^caught_stealing|^pickoff_caught/.test(t)) return 'caught-stealing';
        if (/^pickoff/.test(t)) return 'pickoff';
        if (t === 'wild_pitch' || t === 'passed_ball') return 'wild-pitch';
        if (t === 'pitching_substitution') return 'pitching-change';
        return null;
      }
      case 'result': {
        const t = ev.eventType;
        if (t === 'home_run') return 'home_run';
        if (t === 'single' || t === 'double' || t === 'triple') return t;
        if (t === 'strikeout') return ev.looking ? 'strikeout-looking' : 'strikeout';
        if (t === 'walk' || t === 'intent_walk') return 'walk';
        if (t === 'hit_by_pitch') return 'hbp';
        if (/double_play|triple_play/.test(t)) return 'double-play';
        if (t === 'sac_fly') return 'sac-fly';
        if (t === 'field_out' || t === 'force_out' || t === 'fielders_choice_out') return 'out';
        return 'other';
      }
    }
    return null;
  }

  const CALL_RATE = {
    'half': 1, 'atbat': 0.85, 'ball': 0.55, 'called': 0.8, 'swinging': 0.85, 'foul': 0.5,
    'game-end': 1, 'steal': 1, 'caught-stealing': 1, 'pickoff': 0.6, 'wild-pitch': 1, 'pitching-change': 1,
  };

  const REQUIRED = { atbat: ['batter'], ball: [], called: ['batter'], swinging: ['batter'], foul: ['batter'] };

  function walkOff(ev, state) {
    return !ev.top && ev.inning >= 9 && state.score.home > state.score.away && state.prevScore.home <= state.prevScore.away;
  }

  function excitementFor(key, ev, state) {
    if (ev.type === 'result' && walkOff(ev, state)) return 2;
    const close = Math.abs(state.score.away - state.score.home) <= 2;
    const late = state.inning >= 7;
    const tookLead = ev.score && Math.sign(state.score.away - state.score.home) !== Math.sign(state.prevScore.away - state.prevScore.home) &&
      state.score.away !== state.score.home;
    if (key === 'home_run') return close || late ? 2 : 1;
    if (ev.type === 'result' && ev.scorers && ev.scorers.length) return tookLead && late ? 2 : 1;
    if (['double', 'triple', 'double-play', 'steal', 'caught-stealing'].includes(key)) return 1;
    if (key === 'strikeout' && state.outs === 3 && state.runnersOn().length) return 1;
    return 0;
  }

  function wantsColour(key, ev, state, rng) {
    const since = state.eventIndex - state.lastColourAt;
    if (key === 'home_run' || key === 'game-end') return true;
    if (key === 'pitching-change') return rng() < 0.8;
    if (ev.type === 'result' && ev.scorers && ev.scorers.length) return rng() < 0.6;
    if (ev.type === 'result' && ev.outsAfter === 3) return rng() < 0.45;
    if (since < 7) return false;
    if (key === 'atbat' && (state.history.get(ev.batter) || []).length) return rng() < 0.4;
    if (key === 'ball' || key === 'foul') return rng() < 0.2;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Template filling
  // ---------------------------------------------------------------------------

  function pick(list, state, rng) {
    if (!list || !list.length) return null;
    let min = Infinity;
    for (const t of list) min = Math.min(min, state.used.get(t) || 0);
    const pool = list.filter((t) => (state.used.get(t) || 0) === min);
    const t = pool[Math.floor(rng() * pool.length)];
    state.used.set(t, (state.used.get(t) || 0) + 1);
    return t;
  }

  function fill(template, ev, state, persona) {
    const g = state.game;
    const h = ev.hit || {};
    const prior = state.history.get(ev.batter) || [];
    const last = prior[prior.length - 1];
    const awayAhead = state.score.away >= state.score.home;
    const vars = {
      batter: ev.batter, pitcher: ev.pitcher || state.pitcher, team: ev.teamName || (awayAhead ? g.away.name : g.home.name),
      opp: ev.oppName || (awayAhead ? g.home.name : g.away.name),
      pitchType: ev.pitchType ? String(ev.pitchType).toLowerCase() : null, speed: ev.speed,
      height: ev.height, count: countText(state.balls, state.strikes),
      // "Three outs now" reads oddly; templates needing {outs} give way to the side-retired call.
      outs: state.outs < 3 ? OUTS[state.outs] : null, half: halfText(state.inning, state.top), bases: basesText(state),
      score: scoreLine(state, persona), final: finalLine(state, persona),
      distance: h.totalDistance ? Math.round(h.totalDistance) : null,
      exitVelo: h.launchSpeed ? Math.round(h.launchSpeed) : null,
      outVerb: describeTrajectory(h),
      scorers: ev.scorers && ev.scorers.length ? ev.scorers.join(' and ') : null,
      scores: ev.scorers && ev.scorers.length ? `${ev.scorers.join(' and ')} ${ev.scorers.length > 1 ? 'score' : 'scores'}` : null,
      // Season tallies like "homers (21)" read badly aloud.
      description: String(ev.description || ev.event || '').replace(/\s*\(\d+\)/g, ''), prior: last || null,
      pitchCount: state.pitches.get(ev.pitcher || state.pitcher) || null,
      away: g.away.name, home: g.home.name, venue: g.venue || 'the ballpark',
    };
    // Templates that need a missing value are not usable.
    const needs = (template.match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1));
    if (needs.some((k) => vars[k] == null || vars[k] === '')) return null;
    const out = template.replace(/\{(\w+)\}/g, (m, k) => vars[k]);
    return out.replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim()
      .replace(/(^|[^.][.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }

  // Try templates (least used first) until one has all its values.
  function line(list, ev, state, persona, rng) {
    if (!list) return null;
    const tried = new Set();
    for (let i = 0; i < list.length; i++) {
      const t = pick(list.filter((x) => !tried.has(x)), state, rng);
      if (!t) return null;
      tried.add(t);
      const text = fill(t, ev, state, persona);
      if (text) return text;
    }
    return null;
  }

  function canCall(key, ev) {
    return (REQUIRED[key] || []).every((k) => ev[k]);
  }

  /**
   * Commentary lines for one event. Call state.apply(ev) first.
   * Returns [{speaker, text, excitement, priority, eventId}].
   */
  function templateLines(ev, persona, state, rng) {
    rng = rng || Math.random;
    const key = lineKey(ev, state);
    const lines = [];
    const push = (speaker, list, exc) => {
      const text = line(list, ev, state, persona, rng);
      if (text) lines.push({ speaker, text, excitement: exc || 0, priority: ev.priority, eventId: ev.id });
      return !!text;
    };
    if (key && canCall(key, ev)) {
      const rate = ev.type === 'result' ? 1 : (CALL_RATE[key] != null ? CALL_RATE[key] : 0);
      if (rng() < rate) {
        push('pbp', persona.pbp[key] || persona.pbp.other, excitementFor(key, ev, state));
        if (ev.type === 'result' && ev.scorers && ev.scorers.length && key !== 'home_run') push('pbp', persona.pbp.scores);
        if (ev.type === 'result' && walkOff(ev, state)) push('pbp', persona.pbp.walkoff, 2);
        else if (ev.type === 'result' && (ev.scorers && ev.scorers.length)) push('pbp', persona.pbp.scoreUpdate);
        if (ev.type === 'result' && ev.outsAfter === 3 && !state.over) push('pbp', persona.pbp['half-end']);
      }
    }
    if (key && wantsColour(key, ev, state, rng)) {
      let list = persona.colour[key] || persona.colour.general;
      if (key === 'atbat') list = persona.colour.recap;
      else if (ev.type === 'result' && ev.outsAfter === 3 && !(ev.scorers && ev.scorers.length)) list = persona.colour['half-end'];
      else if (ev.type === 'result' && ev.scorers && ev.scorers.length && key !== 'home_run') list = persona.colour.scoring;
      if (push('colour', list)) state.lastColourAt = state.eventIndex;
    }
    state.lastType = ev.type;
    return lines;
  }

  function joinLine(persona, state) {
    return line(persona.pbp.join, { type: 'join' }, state, persona, Math.random) || '';
  }

  // ---------------------------------------------------------------------------
  // Personas
  // ---------------------------------------------------------------------------

  const PERSONAS = {};

  PERSONAS.cookie = {
    id: 'cookie',
    label: 'Cookie Monster Calls Baseball (parody)',
    blurb: 'A hungry blue monster who thinks the baseball is a very disappointing cookie.',
    scoreless: 'No score yet. Zero. Like cookies left in me jar',
    leads: (team, hi, lo) => `${team} winning ${hi} to ${lo}`,
    wins: (team, hi, lo) => `${team} WIN ${hi} to ${lo}`,
    voices: {
      pbp: { langs: ['en-US', 'en'], pitch: 0.2, rate: 1.05, prefer: ['male', 'fred', 'ralph', 'grandpa'] },
      colour: { langs: ['en-US', 'en'], pitch: 0.35, rate: 0.95, prefer: ['male', 'fred', 'ralph'] },
    },
    llmStyle:
      'Parody: Cookie Monster is the play-by-play AND colour commentator (colour lines are his tangents). ' +
      'Speech: broken grammar ("me love", "ball go far", "om nom nom"), boundless enthusiasm, everything ' +
      'compared to cookies and snacks, sincere confusion about baseball rules (why it called "pitch"? why ' +
      'they not eat the plate?). Family friendly. Still gets every fact right: pitch results, count, outs, who scored, the score.',
    pbp: {
      join: ['Hello baseball fans! Me Cookie Monster! Me join game already going. It {half}. {score}. Me brought cookies.'],
      half: ['It {half}! {team} come to bat! Me ready! Me have snacks!', 'Here we go, {half}! Om nom nom!'],
      atbat: ['Now batting... {batter}! Me like {batter}. Him look hungry.', '{batter} step up to plate. Plate empty. Very sad. No cookies on plate.', 'Here come {batter}. {outs}, {bases}.'],
      ball: ['Ball. {pitcher} miss. Count {count}.', 'Ball! That pitch no good. Like raisin pretending to be chocolate chip.', 'Ball {height}. Me would have eaten it anyway.'],
      called: ['Strike! {batter} just watch it go by. Me NEVER let cookie go by!', 'Called strike! Count {count}.', 'Strike! {batter} no swing. Why no swing?!'],
      swinging: ['{batter} swing... and MISS! Me know feeling. Me miss mouth sometimes.', 'Swing and miss! {speed} mile per hour! That faster than me running to cookie jar!', 'Whiff! Count {count}.'],
      foul: ['Foul ball! Go into crowd! Somebody get souvenir. Me hope it cookie.', 'Foul. {batter} still alive. Count {count}.', 'Foul ball! Me not know what foul mean, but me think it rude.'],
      single: ['{batter} hit it! Base hit! {batter} run to first like me run to bakery!', 'Single! {batter} on first base. First base very nice place. Is it made of cookie?'],
      double: ['{batter} hit it in the gap! Double! Two base! Two cookies!', 'DOUBLE! {batter} on second! Me so excited me drop me milk!'],
      triple: ['TRIPLE! {batter} run and run and run! Three base! Me tired just watching!'],
      home_run: [
        'Hit high... hit far... it GONE! HOME RUN {batter}! COOKIE FOR EVERYBODY!',
        '{batter} SMASH IT! {distance} feet! That ball never coming back! Like cookie me eat yesterday!',
        'OHHH! HOME RUN! {batter}! Ball go {exitVelo} mile per hour! OM NOM NOM NOM!',
      ],
      strikeout: ['{batter} swing and miss... STRIKE THREE! {batter} strike out! Him get no cookie!', 'Struck him out! {pitcher} too good! Sorry {batter}!'],
      'strikeout-looking': ['Strike three called! {batter} just stand there! Me would at least TRY!', '{batter} look at strike three. Look but no take. Me never do that with cookie.'],
      walk: ['Ball four. {batter} walk to first. Me only walk when going to kitchen.', '{batter} take walk! Free base! Free things very nice!'],
      hbp: ['Ow! Pitch hit {batter}! {batter} go to first. Me give {batter} cookie to feel better.'],
      'double-play': ['DOUBLE PLAY! Two out on one play! That like eating two cookies in one bite! Me respect that!'],
      'sac-fly': ['{batter} fly out, but run come home! Sacrifice fly! Me no understand sacrifice. Me never sacrifice cookie.'],
      out: ['{batter} {outVerb}. Out. Him get no cookie.', '{batter} {outVerb}. {outs} now.', 'Out! {batter} {outVerb}. Better luck next time.'],
      other: ['{description} Me think that good? Me not sure. Me eat cookie while me figure out.'],
      scores: ['{scores}! Run count! Me love counting! One cookie, two cookie...'],
      scoreUpdate: ['{score}.', '{score}! Me count on fingers to be sure.'],
      'half-end': ['Three out! That end of {half}. {score}. Me go get snack.', 'Inning half over! {score}. Commercial time mean cookie time!'],
      steal: ['Runner STEAL base! Sneaky! Me respect sneaky! {description}'],
      'caught-stealing': ['Ooh, runner caught stealing! Me know that feeling too. {description}'],
      pickoff: ['{pitcher} throw over to keep runner close. Runner no trust {pitcher}. Me no trust anybody near me cookies.'],
      'wild-pitch': ['Pitch get away! Ball rolling! Runners moving! Chaos! Me LOVE chaos! {description}'],
      'pitching-change': ['Pitching change! New monster on mound! {description}'],
      walkoff: ['WALK-OFF! {team} WIN! Everybody run on field! Me run on field too! Me bring cookies!'],
      'game-end': ['GAME OVER! {final}! Now we all eat cookies! That how game supposed to end!', 'That the final out! {final}! Me Cookie Monster, good night! Om nom nom!'],
    },
    colour: {
      home_run: ['Me think home run ball look like cookie when it fly through air. Cookie of victory.', 'That ball go so far it probably land in bakery. Lucky ball.'],
      scoring: ['Runs very good. Runs like cookies. More is always better.', 'Me think team should celebrate with snack. Me volunteer to bring snack. And eat snack.'],
      'half-end': ['Baseball very long game. Very good for snacking. Best sport for snacking.', 'Me count every pitch. {pitcher} throw {pitchCount} pitches. Me eat {pitchCount} cookies. Coincidence? No.'],
      'pitching-change': ['New pitcher walk in from bullpen. Bullpen sound like place with lots of cows. Cows make milk. Milk go with cookies. Baseball very smart.'],
      recap: ['Last time {batter} {prior}. Me remember. Me have good memory for everything except where me put cookies.'],
      'game-end': ['Great game. Me give it ten cookies out of ten. Me already eat all ten.'],
      general: [
        'You know what baseball look like? Small white cookie with red stitches. Me tried once. Not good. Not good at all.',
        'Why it called "the plate" if there no food on it? Me write letter to baseball.',
        'Seventh-inning stretch coming eventually. Me stretch every inning. To reach snack bar.',
        'Me think {pitcher} must eat lots of cookies to throw like that.',
        'Crowd very loud. Probably because hot dogs very good. Not as good as cookies.',
      ],
    },
  };

  PERSONAS.radio = {
    id: 'radio',
    label: 'Golden-Age Radio Booth',
    blurb: 'Warm, unhurried radio storytelling, with "there\'s a drive!" calls and a folksy partner.',
    scoreless: 'No runs, no hits... well, no runs anyway',
    voices: {
      pbp: { langs: ['en-US', 'en'], pitch: 0.95, rate: 0.98, prefer: ['male', 'daniel', 'david', 'guy', 'christopher', 'alex'] },
      colour: { langs: ['en-US', 'en'], pitch: 0.8, rate: 0.95, prefer: ['male', 'fred', 'eric', 'roger'] },
    },
    llmStyle:
      'A two-man radio booth in the manner of golden-age baseball radio. PLAY-BY-PLAY: warm, unhurried, ' +
      'paints the picture, reads the count often ("one ball, two strikes"), builds suspense on fly balls ' +
      '("there\'s a drive... deep left... it\'s gone!"), occasional gentle humour, never shouts except for ' +
      'a home run. COLOUR: a folksy former catcher who talks about pitch sequencing, what the pitcher is ' +
      'trying to do, and little stories that sound like the old days (never invent real facts about real players).',
    pbp: {
      join: ['Hello again everybody, and a very pleasant good evening to you. We join this one in the {half}. {score}.'],
      half: ['Here in the {half}, the {team} coming up to hit.', 'We go to the {half}.'],
      atbat: ['{batter} steps in. {outs}, {bases}.', 'And here\'s {batter}. {outs}.', 'Now batting, {batter}. {pitcher} takes the sign.'],
      ball: ['Ball, {height}. {count}.', 'Wide, ball. The count goes to {count}.', '{pitcher} misses, ball. {count}.', 'Ball. {count}.'],
      called: ['Strike, called. {count}.', 'Got him looking, strike. {count}.', '{speed} mile-an-hour {pitchType}, called a strike.'],
      swinging: ['Swung on and missed. {count}.', 'He swings, and misses the {pitchType}. {count}.', 'Swing and a miss, {speed} on the gun.'],
      foul: ['Fouled back. {count}.', 'Fouled off, and still {count}.', '{batter} spoils it, foul ball.'],
      single: ['Line drive, base hit! {batter} on first.', 'Ground ball through the hole, base hit, {batter}.', 'Bloop, and it falls in. A single for {batter}.'],
      double: ['There\'s a drive into the gap... it\'ll roll to the wall! {batter} into second with a double!', 'Hit down the line, fair ball! {batter} cruising into second.'],
      triple: ['Drive to deep right-center, off the wall! Here comes {batter} around second... he\'ll make it to third! A triple!'],
      home_run: [
        'There\'s a drive... deep... way back... and it is GONE! A home run for {batter}!',
        '{batter} swings, high fly ball... back, back... GONE! {distance} feet!',
        'Swung on, and hit high and deep... that ball is outta here! {batter}!',
      ],
      strikeout: ['Swung on and missed, strike three! {pitcher} gets him.', 'He struck him out! {batter} goes down swinging.'],
      'strikeout-looking': ['Strike three called! {batter} caught looking.', 'And he froze him! Strike three on the {pitchType}.', 'Called strike three, and {batter} is out.'],
      walk: ['Ball four, and {batter} will take his base.', '{pitcher} walks him. {bases}.'],
      hbp: ['And he hits him. {batter} trots down to first.'],
      'double-play': ['Ground ball, to second, over to first... a double play! Two down on one swing.', 'Hit sharply, they turn two! Beautifully done.'],
      'sac-fly': ['Fly ball, deep enough... the catch, and the run will score. A sacrifice fly.'],
      out: ['{batter} {outVerb}. {outs}.', 'And {batter} {outVerb}.', '{batter} {outVerb}, and that\'s {outs}.'],
      other: ['{description}'],
      scores: ['{scores}!', 'And {scores}.'],
      scoreUpdate: ['{score}.', '{score} here in the {half}.'],
      'half-end': ['And that\'ll do it. Middle of the inning. {score}.', 'That retires the side. {score}.'],
      steal: ['There goes the runner... here\'s the throw... safe! {description}'],
      'caught-stealing': ['Here\'s the throw... and he is out! {description}'],
      pickoff: ['Throw over to first, and the runner gets back.'],
      'wild-pitch': ['In the dirt, and it gets away! {description}'],
      'pitching-change': ['And the skipper is coming out to make a change. {description}'],
      walkoff: ['And the {team} win it! A walk-off! They\'re mobbing {batter} out there!', 'Here comes the winning run... and the {team} walk it off!'],
      'game-end': ['And that\'s the ballgame! {final}.', 'There it is, the final out. {final}.'],
    },
    colour: {
      home_run: ['He was sitting on that one. Pitcher left it right out over the plate and he didn\'t miss it.', 'You hang one up there to a hitter like that, that\'s what happens.'],
      scoring: ['You get men on base, you\'ve got to drive \'em in. And they did.', 'That\'s the kind of at-bat that wins you ballgames.'],
      'half-end': ['A nice tidy inning. You\'ll take that every time.', '{pitcher} is up to {pitchCount} pitches. Something to keep an eye on.'],
      'pitching-change': ['Fresh arm. The skipper didn\'t like what he was seeing, and I can\'t say I blame him.'],
      recap: ['{batter} {prior} his last time up.', 'Remember, {batter} {prior} earlier in this one.'],
      'game-end': ['A good, crisp ballgame. That\'s baseball the way it ought to be played.'],
      general: [
        'You know, I caught for eleven years, and the thing about a count like this is the pitcher\'s got to come to him.',
        'Lovely night for a ballgame here at {venue}.',
        'He\'s working him away, away, away. Sooner or later he\'ll come inside.',
        'The infield is shading him a step toward the pull side.',
        'Always liked watching a fella who works the count. Makes the pitcher earn it.',
      ],
    },
  };

  PERSONAS.scottish = {
    id: 'scottish',
    label: 'Glasgow Fitba Booth (Scottish football commentators)',
    blurb: 'Two Scottish football men, utterly baffled by baseball and loving it.',
    numberWord: (n) => (n === 0 ? 'nil' : String(n)),
    scoreless: 'Still nil-nil',
    tied: (w) => `All square at ${w} apiece`,
    leads: (team, hi, lo) => `The ${team} lead ${hi}-${lo}`,
    wins: (team, hi, lo) => `The ${team} win it ${hi}-${lo}`,
    voices: {
      pbp: { langs: ['en-GB', 'en-IE', 'en'], pitch: 1.0, rate: 1.08, prefer: ['male', 'scot', 'daniel', 'ryan', 'george'] },
      colour: { langs: ['en-GB', 'en-IE', 'en'], pitch: 0.9, rate: 1.0, prefer: ['male', 'scot', 'oliver', 'arthur', 'thomas'] },
    },
    llmStyle:
      'Two Scottish football (soccer) broadcasters calling baseball, which they barely understand, using ' +
      'football vocabulary and Scottish idiom. PLAY-BY-PLAY: excitable, "get in there!", "what a strike" for ' +
      'home runs, scores read as "two-nil". COLOUR: a dry former Scottish Premiership defender, fond of "see, ' +
      'the thing is", "cannae", "wee", "shambolic", "pure dead brilliant", compares everything to cricket or ' +
      'Saturday afternoon football, baffled by how long it takes. Keep it readable, never mock-Scots gibberish. ' +
      'Facts (count, outs, who scored) must still be right.',
    pbp: {
      join: ['Good evening from across the pond, where we join this... baseball... in the {half}. {score}.'],
      half: ['Right, the {half}, and the {team} are having a go now.', 'Here we go, the {half}.'],
      atbat: ['{batter} steps up to the wicket, sorry, the plate.', 'Next man in is {batter}. {outs}, {bases}.'],
      ball: ['Wide. That\'s a ball, apparently. {count}.', 'Ball. {count}, as they say.', 'Oh, that was well off target. Ball.'],
      called: ['Strike! He didnae even move his bat!', 'That\'s a strike, the umpire says. {count}.'],
      swinging: ['Swing and a miss! Fresh air!', '{batter} swings at that and gets nothing but the Glasgow breeze.', 'Missed it! {speed} miles an hour, mind.'],
      foul: ['Oh, sliced it into the stand. Foul.', 'Foul ball. Somebody\'s got a souvenir.', 'Shanked that one. Still {count}.'],
      single: ['He\'s hit it! {batter} away to first base!', 'Lovely contact from {batter}, and he\'s on first.'],
      double: ['Oh, he\'s skelped that one! {batter} on to second!', 'Into the gap and {batter} is motoring! Two bases!'],
      triple: ['{batter}\'s away... second... he\'s going for third! Made it! Like a winger beating three men!'],
      home_run: [
        '{batter}... OH, THAT\'S A STRIKE! Into the stand! Get in there!',
        'He\'s absolutely leathered that! {distance} feet! It\'s gone out the ground!',
        'WHAT A HIT! {batter}! That\'s in the back of the net, or the seats, or whatever!',
      ],
      strikeout: ['Three strikes and he\'s off! {batter} trudges away.', 'Struck out! {pitcher} has done him there.'],
      'strikeout-looking': ['Never even swung at it! Three strikes and off he goes. Shambolic.'],
      walk: ['Four wides, and {batter} gets a free walk to first. Nice work if you can get it.'],
      hbp: ['Oh, that\'s hit him! That would be a red card where I come from.'],
      'double-play': ['Two out in one go! That\'s a proper counter-attack, that!'],
      'sac-fly': ['He\'s been caught, but the runner\'s gone home! A "sacrifice". Very noble.'],
      out: ['{batter} {outVerb}. Nae luck.', '{batter} {outVerb}. {outs}.', 'Out! {batter} {outVerb}.'],
      other: ['{description} Don\'t ask me, I\'m just reading what it says here.'],
      scores: ['{scores}! Get in!', 'And {scores}!'],
      scoreUpdate: ['{score}.', '{score}, and the place is bouncing.'],
      'half-end': ['Three out, all change! {score}.', 'That\'s them done for now. {score}.'],
      steal: ['He\'s nicked a base! Cheeky! {description}'],
      'caught-stealing': ['Caught! Tried to nick a base and got done. {description}'],
      pickoff: ['Throws it to first base for no reason I can see.'],
      'wild-pitch': ['Oh, the keeper\'s let that through his legs! {description}'],
      'pitching-change': ['Substitution! The manager\'s making a change. {description}'],
      walkoff: ['THAT\'S THE WINNER! The {team} have won it at the death! Get in there!'],
      'game-end': ['And there\'s the final whistle! {final}!', 'Full time! {final}!'],
    },
    colour: {
      home_run: ['See, that\'s what I\'m talking about. You give a player that much space, he\'ll punish you.', 'Pure dead brilliant, that. Like a thirty-yarder into the top corner.'],
      scoring: ['That\'s a goal, basically. A run. Whatever. It counts.', 'Clinical. You cannae teach that.'],
      'half-end': ['I\'ve been here two hours and we\'re only in the {half}. Two hours! At Hampden that\'s the whole match and the bus home.', 'Grand bit of defending that inning.'],
      'pitching-change': ['Fresh legs. Well, fresh arm. Same thing.'],
      recap: ['{batter} {prior} last time. I\'m keeping notes now, look at me.'],
      'game-end': ['Proper performance. I\'m a convert. Well, almost.'],
      general: [
        'See, the thing is, in cricket they\'d have stopped for tea by now.',
        'I still don\'t understand why they keep spitting.',
        'The pitcher\'s a wee bit like a goalkeeper, isn\'t he? Except he\'s the one taking the penalties.',
        'Lovely atmosphere at {venue} tonight.',
        'Honestly, the tension in this. It\'s like a penalty shootout that lasts three hours.',
      ],
    },
  };

  const BallBooth = {
    sport: 'mlb', buildGame, refreshGame, normalizePlays, inProgress, describe, situation, boardText,
    GameState, templateLines, joinLine, scoreLine, finalLine, lineKey, PERSONAS, countText, basesText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BallBooth;
  else root.BallBooth = BallBooth;
})(typeof window !== 'undefined' ? window : globalThis);
