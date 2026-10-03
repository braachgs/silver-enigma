/*
 * Broadcast Booth engine: turns NHL play-by-play JSON into commentary lines.
 *
 * Pure logic, no DOM. Loaded by the browser (window.Booth) and by the Node
 * tests (module.exports).
 *
 * Data source: api-web.nhle.com/v1/gamecenter/{id}/play-by-play
 * (undocumented public API; field names per community references).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Game + roster parsing
  // ---------------------------------------------------------------------------

  function txt(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v.default || Object.values(v)[0] || '';
  }

  function parseTeam(t) {
    t = t || {};
    return {
      id: t.id,
      abbrev: t.abbrev || '???',
      name: txt(t.commonName) || txt(t.name) || t.abbrev || 'Team',
      place: txt(t.placeName) || txt(t.placeNameWithPreposition) || '',
    };
  }

  function buildGame(pbp) {
    const game = {
      id: pbp.id,
      state: pbp.gameState,
      venue: txt(pbp.venue),
      away: parseTeam(pbp.awayTeam),
      home: parseTeam(pbp.homeTeam),
      roster: new Map(),
    };
    for (const r of pbp.rosterSpots || []) {
      game.roster.set(r.playerId, {
        id: r.playerId,
        first: txt(r.firstName),
        last: txt(r.lastName),
        number: r.sweaterNumber,
        teamId: r.teamId,
        pos: r.positionCode,
      });
    }
    return game;
  }

  function teamById(game, id) {
    if (id === game.away.id) return game.away;
    if (id === game.home.id) return game.home;
    return null;
  }

  function otherTeam(game, team) {
    if (!team) return null;
    return team === game.away ? game.home : game.away;
  }

  function playerName(game, id, full) {
    const p = game.roster.get(id);
    if (!p) return '';
    return full ? `${p.first} ${p.last}`.trim() : p.last;
  }

  // ---------------------------------------------------------------------------
  // Play normalisation
  // ---------------------------------------------------------------------------

  const PRIORITY = {
    'goal': 10, 'game-end': 10, 'penalty': 8, 'period-start': 7, 'period-end': 7,
    'shootout-complete': 7, 'shot-on-goal': 5, 'delayed-penalty': 4, 'hit': 4,
    'missed-shot': 3, 'blocked-shot': 3, 'takeaway': 2, 'giveaway': 2,
    'stoppage': 2, 'faceoff': 1, 'failed-shot-attempt': 1,
  };

  function clockToSeconds(mmss) {
    if (!mmss || typeof mmss !== 'string') return 0;
    const [m, s] = mmss.split(':').map(Number);
    return (m || 0) * 60 + (s || 0);
  }

  function humanize(key) {
    return String(key || '').replace(/-/g, ' ').trim();
  }

  const SHOT_TYPES = {
    'wrist': 'wrist shot', 'snap': 'snapshot', 'slap': 'slapshot',
    'backhand': 'backhand', 'tip-in': 'tip', 'deflected': 'deflection',
    'wrap-around': 'wraparound', 'bat': 'bat-in', 'between-legs': 'between-the-legs shot',
    'poke': 'poke', 'cradle': 'lacrosse-style shot',
  };

  function normalizePlay(play, game) {
    const d = play.details || {};
    const type = play.typeDescKey;
    const pd = play.periodDescriptor || {};
    const team = teamById(game, d.eventOwnerTeamId);
    const n = (id) => playerName(game, id);
    const ev = {
      id: play.eventId,
      sortOrder: play.sortOrder != null ? play.sortOrder : play.eventId,
      type,
      priority: PRIORITY[type] || 1,
      period: pd.number || 1,
      periodType: pd.periodType || 'REG',
      timeInPeriod: play.timeInPeriod || '00:00',
      timeRemaining: play.timeRemaining || '',
      gameSeconds: ((pd.number || 1) - 1) * 1200 + clockToSeconds(play.timeInPeriod),
      replayAt: ((pd.number || 1) - 1) * 1200 + clockToSeconds(play.timeInPeriod),
      team: team ? team.abbrev : '',
      teamName: team ? team.name : '',
      opp: team ? otherTeam(game, team).abbrev : '',
      oppName: team ? otherTeam(game, team).name : '',
      zone: d.zoneCode || '',
      p: {},
      score: null,
      sog: null,
    };
    switch (type) {
      case 'goal':
        ev.p.scorer = n(d.scoringPlayerId);
        ev.p.scorerFull = playerName(game, d.scoringPlayerId, true);
        ev.p.assist1 = n(d.assist1PlayerId);
        ev.p.assist2 = n(d.assist2PlayerId);
        ev.p.goalie = n(d.goalieInNetId);
        ev.p.scorerTotal = d.scoringPlayerTotal;
        ev.shotType = SHOT_TYPES[d.shotType] || d.shotType || 'shot';
        ev.emptyNet = !d.goalieInNetId;
        break;
      case 'shot-on-goal':
      case 'missed-shot':
      case 'failed-shot-attempt':
        ev.p.shooter = n(d.shootingPlayerId);
        ev.p.goalie = n(d.goalieInNetId);
        ev.shotType = SHOT_TYPES[d.shotType] || d.shotType || 'shot';
        ev.reason = humanize(d.reason);
        break;
      case 'blocked-shot':
        ev.p.shooter = n(d.shootingPlayerId);
        ev.p.blocker = n(d.blockingPlayerId);
        break;
      case 'hit':
        ev.p.hitter = n(d.hittingPlayerId);
        ev.p.hittee = n(d.hitteePlayerId);
        break;
      case 'faceoff':
        ev.p.winner = n(d.winningPlayerId);
        ev.p.loser = n(d.losingPlayerId);
        break;
      case 'giveaway':
      case 'takeaway':
        ev.p.player = n(d.playerId);
        break;
      case 'penalty':
        ev.p.player = n(d.committedByPlayerId) || n(d.servedByPlayerId) || (team ? team.name : '');
        ev.p.drawnBy = n(d.drawnByPlayerId);
        ev.penalty = humanize(d.descKey) || 'an infraction';
        ev.minutes = d.duration || 2;
        break;
      case 'stoppage':
        ev.reason = humanize(d.reason);
        break;
    }
    if (d.awayScore != null && d.homeScore != null) ev.score = { away: d.awayScore, home: d.homeScore };
    if (d.awaySOG != null && d.homeSOG != null) ev.sog = { away: d.awaySOG, home: d.homeSOG };
    return ev;
  }

  function normalizePlays(pbp, game) {
    return (pbp.plays || [])
      .map((p) => normalizePlay(p, game))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // Plain factual description, used for the transcript and as LLM input.
  function describe(ev) {
    const P = ev.p;
    const per = periodLabel(ev.period, ev.periodType);
    const at = `[${per} ${ev.timeRemaining || ev.timeInPeriod} left]`;
    switch (ev.type) {
      case 'goal': {
        const a = [P.assist1, P.assist2].filter(Boolean);
        return `${at} GOAL ${ev.team}: ${P.scorerFull || P.scorer} (${ev.shotType}${P.scorerTotal ? `, his ${ordinal(P.scorerTotal)} of the season` : ''})` +
          `${a.length ? `, assists ${a.join(' and ')}` : ', unassisted'}${ev.emptyNet ? ', empty net' : P.goalie ? `, beat ${P.goalie}` : ''}.` +
          (ev.score ? ` Score: ${scoreText(ev.score)}.` : '');
      }
      case 'shot-on-goal': return `${at} ${ev.team} shot on goal: ${P.shooter} ${ev.shotType}, saved by ${P.goalie || 'the goalie'}.`;
      case 'missed-shot': return `${at} ${ev.team} missed shot: ${P.shooter} ${ev.shotType}${ev.reason ? ` (${ev.reason})` : ''}.`;
      case 'failed-shot-attempt': return `${at} ${ev.team} failed shot attempt: ${P.shooter}.`;
      case 'blocked-shot': return `${at} ${P.shooter || 'shot'} blocked by ${P.blocker || 'a defender'}.`;
      case 'hit': return `${at} ${ev.team} hit: ${P.hitter} on ${P.hittee}.`;
      case 'faceoff': return `${at} Faceoff won by ${P.winner} (${ev.team}) over ${P.loser}.`;
      case 'giveaway': return `${at} Giveaway by ${P.player} (${ev.team}).`;
      case 'takeaway': return `${at} Takeaway by ${P.player} (${ev.team}).`;
      case 'penalty': return `${at} PENALTY ${ev.team}: ${P.player}, ${ev.minutes} minutes for ${ev.penalty}${P.drawnBy ? `, drawn by ${P.drawnBy}` : ''}.`;
      case 'delayed-penalty': return `${at} Delayed penalty coming against ${ev.team}.`;
      case 'stoppage': return `${at} Whistle${ev.reason ? `: ${ev.reason}` : ''}.`;
      case 'period-start': return `Start of the ${per}.`;
      case 'period-end': return `End of the ${per}.`;
      case 'shootout-complete': return 'Shootout complete.';
      case 'game-end': return 'Final horn. Game over.';
      default: return `${at} ${humanize(ev.type)}.`;
    }
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function periodLabel(num, type) {
    if (type === 'OT') return num > 4 ? `${ordinal(num - 3)} overtime` : 'overtime';
    if (type === 'SO') return 'shootout';
    return `${ordinal(num)} period`;
  }

  function scoreText(s) {
    return `away ${s.away}, home ${s.home}`;
  }

  // ---------------------------------------------------------------------------
  // Game state the director and persona templates read from
  // ---------------------------------------------------------------------------

  class GameState {
    constructor(game) {
      this.game = game;
      this.score = { away: 0, home: 0 };
      this.sog = { away: 0, home: 0 };
      this.period = 1;
      this.periodType = 'REG';
      this.lastType = null;
      this.used = new Map(); // template text -> times used (catchphrase budget)
      this.lastColourAt = -Infinity; // event index
      this.eventIndex = 0;
    }

    apply(ev) {
      this.eventIndex++;
      this.period = ev.period;
      this.periodType = ev.periodType;
      if (ev.score) this.score = { ...ev.score };
      if (ev.sog) this.sog = { ...ev.sog };
    }

    seed(events) {
      for (const ev of events) this.apply(ev);
      if (events.length) this.lastType = events[events.length - 1].type;
    }
  }

  // ---------------------------------------------------------------------------
  // Director: decides which events get called and how often colour speaks
  // ---------------------------------------------------------------------------

  const CALL_RATE = {
    'goal': 1, 'penalty': 1, 'period-start': 1, 'period-end': 1, 'game-end': 1,
    'shootout-complete': 1, 'shot-on-goal': 0.9, 'delayed-penalty': 0.8, 'hit': 0.6,
    'blocked-shot': 0.45, 'missed-shot': 0.45, 'takeaway': 0.35, 'giveaway': 0.35,
    'faceoff': 0.25, 'stoppage': 0, 'failed-shot-attempt': 0,
  };

  function shouldCall(ev, state, rng) {
    if (ev.type === 'faceoff') {
      // Call the draw after a whistle or to open a period; otherwise rarely.
      const after = state.lastType === 'stoppage' || state.lastType === 'period-start' ||
        state.lastType === 'goal' || state.lastType === 'penalty';
      return after ? rng() < 0.7 : rng() < 0.1;
    }
    const r = CALL_RATE[ev.type];
    return r == null ? false : rng() < r;
  }

  function wantsColour(ev, state, rng) {
    const since = state.eventIndex - state.lastColourAt;
    if (['goal', 'period-end', 'game-end'].includes(ev.type)) return true;
    if (ev.type === 'penalty') return rng() < 0.7;
    if (since < 6) return false; // let the play-by-play breathe
    if (ev.type === 'stoppage') return rng() < 0.55;
    if (ev.type === 'hit') return rng() < 0.25;
    if (ev.type === 'shot-on-goal') return rng() < 0.12;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Template filling
  // ---------------------------------------------------------------------------

  function pick(list, state, rng) {
    // Least-used first, random among ties: keeps catchphrases from repeating.
    if (!list || !list.length) return null;
    let min = Infinity;
    for (const t of list) min = Math.min(min, state.used.get(t) || 0);
    const pool = list.filter((t) => (state.used.get(t) || 0) === min);
    const t = pool[Math.floor(rng() * pool.length)];
    state.used.set(t, (state.used.get(t) || 0) + 1);
    return t;
  }

  function scoreLine(state, persona) {
    const g = state.game;
    const { away, home } = state.score;
    const w = persona.numberWord || String;
    if (away === home) return persona.tied ? persona.tied(w(away)) : `We're tied at ${w(away)}`;
    const lead = away > home ? g.away : g.home;
    const hi = Math.max(away, home), lo = Math.min(away, home);
    return persona.leads ? persona.leads(lead.name, w(hi), w(lo)) : `${lead.name} lead it ${w(hi)} to ${w(lo)}`;
  }

  function finalLine(state, persona) {
    const g = state.game;
    const { away, home } = state.score;
    const w = persona.numberWord || String;
    if (away === home) return scoreLine(state, persona);
    const win = away > home ? g.away : g.home;
    const hi = Math.max(away, home), lo = Math.min(away, home);
    return persona.wins ? persona.wins(win.name, w(hi), w(lo)) : `The ${win.name} win it, ${w(hi)} to ${w(lo)}`;
  }

  function fill(template, ev, state, persona) {
    const P = ev.p;
    const g = state.game;
    const assists = [P.assist1, P.assist2].filter(Boolean);
    // Events with no owning team (period end etc.) talk about the leader.
    const awayAhead = state.score.away >= state.score.home;
    const vars = {
      team: ev.teamName || (awayAhead ? g.away.name : g.home.name),
      opp: ev.oppName || (awayAhead ? g.home.name : g.away.name),
      scorer: P.scorer, shooter: P.shooter, goalie: P.goalie || 'the goaltender',
      blocker: P.blocker, hitter: P.hitter, hittee: P.hittee, winner: P.winner,
      loser: P.loser, player: P.player, drawnBy: P.drawnBy || 'the other fella',
      penalty: ev.penalty, mins: ev.minutes, shotType: ev.shotType,
      assists: assists.length ? assists.join(' and ') : 'nobody, he did it all himself',
      score: scoreLine(state, persona),
      final: finalLine(state, persona),
      period: periodLabel(state.period, state.periodType),
      nextPeriod: periodLabel(state.period + 1, state.period + 1 > 3 ? 'OT' : 'REG'),
      away: g.away.name, home: g.home.name, venue: g.venue || 'the building',
      awaySog: state.sog.away, homeSog: state.sog.home,
    };
    const out = template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? vars[k] : ''));
    return out.replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }

  function excitementFor(ev, state) {
    if (ev.type !== 'goal') return ev.type === 'penalty' || ev.type === 'hit' ? 1 : 0;
    const diff = Math.abs(state.score.away - state.score.home);
    const late = ev.period >= 3 && clockToSeconds(ev.timeRemaining) < 300;
    return diff <= 1 || late || ev.periodType === 'OT' ? 2 : 1;
  }

  // Missing names make a template unusable (e.g. a goal with no scorer).
  const REQUIRED = {
    'goal': ['scorer'], 'shot-on-goal': ['shooter'], 'missed-shot': ['shooter'],
    'blocked-shot': ['blocker'], 'hit': ['hitter', 'hittee'], 'faceoff': ['winner'],
    'giveaway': ['player'], 'takeaway': ['player'], 'penalty': ['player'],
  };

  function canCall(ev) {
    return (REQUIRED[ev.type] || []).every((k) => ev.p[k]);
  }

  /**
   * Commentary lines for one event using persona templates.
   * Call state.apply(ev) BEFORE this so scores are current.
   * Returns [{speaker: 'pbp'|'colour', text, excitement, priority, eventId}].
   */
  function templateLines(ev, persona, state, rng) {
    rng = rng || Math.random;
    const lines = [];
    const push = (speaker, list) => {
      const t = pick(list, state, rng);
      if (t) lines.push({ speaker, text: fill(t, ev, state, persona), excitement: speaker === 'pbp' ? excitementFor(ev, state) : 0, priority: ev.priority, eventId: ev.id });
    };
    if (canCall(ev) && shouldCall(ev, state, rng)) {
      let key = ev.type;
      if (ev.type === 'goal' && ev.emptyNet && persona.pbp['goal-empty-net']) key = 'goal-empty-net';
      push('pbp', persona.pbp[key]);
      if (ev.type === 'goal' || ev.type === 'period-end') push('pbp', persona.pbp.scoreUpdate);
    }
    if (wantsColour(ev, state, rng)) {
      const before = lines.length;
      push('colour', persona.colour[ev.type] || persona.colour.general);
      if (lines.length > before) state.lastColourAt = state.eventIndex;
    }
    state.lastType = ev.type;
    return lines;
  }

  // Line for joining a game already in progress.
  function joinLine(persona, state) {
    const t = pick(persona.pbp.join, state, Math.random);
    return t ? fill(t, { p: {} }, state, persona) : '';
  }

  // ---------------------------------------------------------------------------
  // Personas
  // ---------------------------------------------------------------------------

  const PERSONAS = {};

  PERSONAS.hnic90 = {
    id: 'hnic90',
    label: "Saturday Night '93 (classic HNIC style)",
    blurb: 'Rising-crescendo play-by-play and an old-school ex-player on colour.',
    voices: {
      pbp: { langs: ['en-CA', 'en-US', 'en'], pitch: 1.0, rate: 1.08, prefer: ['male', 'daniel', 'david', 'guy', 'christopher'] },
      colour: { langs: ['en-CA', 'en-US', 'en'], pitch: 0.85, rate: 1.0, prefer: ['male', 'fred', 'alex', 'eric', 'roger'] },
    },
    llmStyle:
      'Two-man booth in the style of early-1990s CBC Hockey Night in Canada. PLAY-BY-PLAY: a classic Canadian ' +
      'voice whose calls build in a crescendo ("Here\'s So-and-so... shoots... SCORES!"), economical between ' +
      'whistles, uses surnames, and saves "Oh baby!" for truly huge moments (at most once or twice a game). ' +
      'COLOUR: a plain-spoken former NHL defenceman. Old-school values: grit, getting pucks deep, going to the ' +
      'net, finishing checks, "that\'s a character guy". Mild disdain for fancy plays and for diving. ' +
      'No modern analytics vocabulary (no "expected goals", "Corsi", "high-danger"). Canadian spelling and idiom.',
    pbp: {
      'join': ['Good evening, and welcome to Hockey Night. We join the {away} and the {home} already in progress. {score}.'],
      'period-start': ['And we are under way in the {period}.', 'Here we go, the {period} is under way.', 'The puck is dropped and away we go in the {period}.'],
      'goal': [
        'Here\'s {scorer}... shoots... SCORES! {scorer}!',
        '{scorer}... in close... he SCORES! Oh baby!',
        'Shot... and it\'s in! {scorer} scores for the {team}!',
        '{scorer} lets it go... SCORES! What a goal by {scorer}!',
        'They score! {scorer}! And this place goes wild!',
        'Puck in front... {scorer}... SCORES!',
      ],
      'goal-empty-net': ['{scorer} into the empty net. That should do it.', 'And {scorer} hits the empty cage.'],
      'scoreUpdate': ['{score}.', '{score} here in the {period}.'],
      'shot-on-goal': [
        '{shooter} shoots... save, {goalie}.',
        '{shooter} with the {shotType}... and {goalie} is there.',
        'Here\'s {shooter}... shot... stopped!',
        '{shooter} lets one go from out there, {goalie} handles it.',
        'Big save by {goalie} on {shooter}!',
        '{shooter} in tight... {goalie} with the pad!',
      ],
      'missed-shot': ['{shooter} fires... wide.', '{shooter} shoots, misses the net.', '{shooter}... over the net.'],
      'blocked-shot': ['Shot blocked by {blocker}.', '{blocker} gets in the lane and blocks it.', '{shooter} tries to get it through... {blocker} blocks it.'],
      'hit': ['{hitter} lines up {hittee}... and down he goes!', 'Big hit by {hitter}!', '{hitter} finishes his check on {hittee}.', '{hitter} rubs out {hittee} along the boards.'],
      'faceoff': ['{winner} wins the draw.', 'Puck is dropped, {winner} gets it back.', '{winner} beats {loser} on the faceoff.'],
      'giveaway': ['And a giveaway by {player}.', '{player} coughs it up.'],
      'takeaway': ['{player} picks his pocket!', 'Nice takeaway by {player}.', '{player} strips him of the puck.'],
      'penalty': ['And there\'s a penalty. {player}, {mins} minutes, {penalty}.', 'The arm goes up... {player} is going off for {penalty}.', '{player} heads to the box. {mins} minutes for {penalty}.'],
      'delayed-penalty': ['Delayed penalty coming...', 'The arm is up, delayed penalty.'],
      'period-end': ['And that will end the {period}.', 'There\'s the horn to end the {period}.'],
      'shootout-complete': ['And the shootout is over.'],
      'game-end': ['And that\'s the final horn. {final}.', 'It\'s all over! {final}!'],
    },
    colour: {
      'goal': [
        'You know what I like about that? He went to the net. That\'s where goals are scored, right in front.',
        'Look at the work down low on that play. Nobody picked up {scorer}. You can\'t leave him alone like that.',
        'That\'s what happens when you shoot the puck. Good things happen.',
        'Great hands. That kid\'s got a set of hands on him, I\'ll tell you that.',
        'Somebody\'s gotta be accountable on that goal. That\'s a breakdown, plain and simple.',
        'That\'s a character goal. He paid the price to score that one.',
      ],
      'penalty': [
        'That\'s a lazy penalty. You can\'t take that, especially in the offensive zone.',
        'I didn\'t mind that one, he was finishing his check. But the ref\'s gotta call what he sees.',
        'Now the power play\'s gotta go to work. Shoot the puck, get traffic in front.',
        'Undisciplined. The coach is not gonna be happy with that one.',
      ],
      'hit': ['That\'s good, honest hockey right there.', 'He\'ll feel that one in the morning.', 'That\'s how you set the tone. Finish your checks.'],
      'period-end': [
        'Well, a good period for the {team}. The {opp} have gotta get more pucks deep.',
        'Shots in that one: {awaySog} for the {away}, {homeSog} for the {home}. Somebody\'s gotta pick it up.',
        'They\'ll be talking in that room. You gotta win the battles along the boards.',
      ],
      'game-end': ['They earned that one. Hard work beats talent when talent doesn\'t work hard.', 'Two points is two points. They\'ll take it and move on.'],
      'general': [
        'You gotta get pucks deep, you gotta get pucks to the net. Simple as that.',
        'That\'s a big, strong kid. Plays the game the right way.',
        'Defence wins championships. You can quote me on that.',
        'I like the way this team competes. They don\'t quit.',
        'When I played, you got the puck in deep and you went to work. Same game today.',
        'The goaltender\'s been solid. He sees it, he stops it.',
      ],
    },
  };

  PERSONAS.scottish = {
    id: 'scottish',
    label: 'Glasgow Fitba Booth (Scottish football commentators)',
    blurb: 'Two Scottish football men calling ice hockey as if it were Old Firm day.',
    numberWord: (n) => (n === 0 ? 'nil' : String(n)),
    tied: (w) => (w === 'nil' ? 'Still goalless' : `All square at ${w} apiece`),
    leads: (team, hi, lo) => `The ${team} lead ${hi}-${lo}`,
    wins: (team, hi, lo) => `The ${team} win it ${hi}-${lo}`,
    voices: {
      pbp: { langs: ['en-GB', 'en-IE', 'en'], pitch: 1.0, rate: 1.1, prefer: ['male', 'scot', 'fiona', 'daniel', 'ryan', 'george'] },
      colour: { langs: ['en-GB', 'en-IE', 'en'], pitch: 0.9, rate: 1.0, prefer: ['male', 'scot', 'oliver', 'arthur', 'thomas'] },
    },
    llmStyle:
      'Two Scottish football (soccer) broadcasters calling an ice hockey game with football vocabulary and ' +
      'Scottish idiom. PLAY-BY-PLAY: excitable, lyrical, "get in there!", "in the back of the net", "what a strike", ' +
      'scores read as "two-nil". COLOUR: a dry, blunt former Scottish Premiership defender, fond of "see, the thing is", ' +
      '"shambolic", "pure dead brilliant", "cannae", "wee", "dunt", "a stramash in front of goal". Gentle bemusement at ' +
      'hockey customs (line changes, the sin bin, fighting) but genuine respect for the toughness. Never mock-Scots ' +
      'gibberish; keep it readable.',
    pbp: {
      'join': ['Good evening from across the pond, where we join the {away} and the {home}. {score}.'],
      'period-start': ['And we\'re off again for the {period}!', 'Here we go then, the {period}, the puck\'s dropped.'],
      'goal': [
        'Oh, it\'s in! {scorer}! Get in there!',
        '{scorer}... and that\'s in the back of the net! Absolutely magnificent!',
        'What a strike from {scorer}! The keeper had no chance!',
        '{scorer} hits it... GOAL! Oh, you beauty!',
        'It\'s a stramash in front... and {scorer} pokes it home!',
      ],
      'goal-empty-net': ['{scorer} rolls it into the empty net. That\'s the game, surely.'],
      'scoreUpdate': ['{score}.', '{score}, and what a game this is.'],
      'shot-on-goal': [
        '{shooter} hits it... and {goalie} gets down well to that.',
        'Lovely effort from {shooter}, but {goalie} is equal to it.',
        '{shooter}... saved! Good hands from {goalie}.',
        '{shooter} lets fly with a {shotType}... the keeper holds on.',
      ],
      'missed-shot': ['{shooter}... oh, that\'s gone wide.', '{shooter} skies it! That\'s nearer the bus lane than the net.', '{shooter} pulls it wide. Should\'ve done better.'],
      'blocked-shot': ['Blocked! {blocker} throws himself in front of it. Brave.', '{blocker} gets a body on it. Whatever it takes.'],
      'hit': ['Oh, that\'s a dunt! {hitter} clatters into {hittee}!', '{hitter} absolutely flattens {hittee}... and the referee\'s not interested!', 'Crunching challenge from {hitter} on {hittee}.'],
      'faceoff': ['{winner} wins the restart.', 'It\'s the bully-off... and {winner} comes away with it.'],
      'giveaway': ['Oh, sloppy from {player}. Gives it away.', '{player} gives the ball, sorry, the puck, away cheaply.'],
      'takeaway': ['{player} nicks it! Lovely bit of tackling.', 'Great recovery from {player}.'],
      'penalty': [
        'And {player} is off to the sin bin! {mins} minutes for {penalty}.',
        'The referee\'s seen that... {player}, {penalty}, {mins} minutes in the naughty chair.',
      ],
      'delayed-penalty': ['The referee\'s playing the advantage here...'],
      'period-end': ['And that\'s the end of the {period}. Time for a cup of tea.', 'There\'s the hooter to end the {period}.'],
      'shootout-complete': ['And the penalty shootout is done!'],
      'game-end': ['And there\'s the final hooter! {final}!', 'Full time! {final}!'],
    },
    colour: {
      'goal': [
        'See, the thing is, you cannae give a player like {scorer} that much space. Shambolic defending.',
        'Pure dead brilliant, that. Didnae even look up.',
        'Where\'s the marking? I\'m asking you, where is the marking?',
        'That\'s a striker\'s finish. You can coach a lot, but you cannae coach that.',
      ],
      'penalty': [
        'Two minutes in the sin bin for that? In the Scottish game you\'d be lucky to get a free kick.',
        'Daft. Absolutely daft. You\'re letting your teammates down there.',
        'I\'ve seen worse on a wet Tuesday at Firhill and nobody got sent anywhere.',
      ],
      'hit': ['Now THAT is a tackle. They\'d love that in Glasgow.', 'He\'ll be needing a wee lie down after that.'],
      'period-end': ['It\'s a game of two halves. Well, three periods. You know what I mean.', 'Shots on target, {awaySog} for the {away}, {homeSog} for the {home}. Tells its own story.'],
      'game-end': ['Proper performance, that. They\'ll enjoy the bus home.', 'Fair result. Nobody can complain.'],
      'general': [
        'The substitutions in this game are mental. They\'re changing the whole team every forty seconds.',
        'Honestly, the pace of this. My knees hurt just watching it.',
        'See, I like this sport. It\'s like football but everybody\'s allowed to clatter each other.',
        'The keeper\'s wearing more padding than a Glasgow sofa.',
        'Lovely atmosphere in {venue} tonight.',
      ],
    },
  };

  PERSONAS.cookie = {
    id: 'cookie',
    label: 'Cookie Monster Calls Hockey (parody)',
    blurb: 'A hungry blue monster who would rather the puck were a cookie.',
    leads: (team, hi, lo) => `${team} winning ${hi} to ${lo}`,
    wins: (team, hi, lo) => `${team} WIN ${hi} to ${lo}`,
    voices: {
      pbp: { langs: ['en-US', 'en'], pitch: 0.2, rate: 1.05, prefer: ['male', 'fred', 'ralph', 'grandpa'] },
      colour: { langs: ['en-US', 'en'], pitch: 0.35, rate: 0.95, prefer: ['male', 'fred', 'ralph'] },
    },
    llmStyle:
      'Parody: Cookie Monster is the play-by-play AND colour commentator (colour lines are his tangents and ' +
      'musings). Speech: broken grammar ("me love", "puck go in net", "om nom nom"), boundless enthusiasm, ' +
      'everything compared to cookies and snacks, frequent food tangents, sincere but confused about hockey rules. ' +
      'Family friendly. Still gets the facts of each play right: who shot, who scored, the score.',
    pbp: {
      'join': ['Hello hockey fans! Me Cookie Monster! Me join game already going. {score}. Me also join snack table already going.'],
      'period-start': ['Puck drop! {period} start! Om nom nom, let\'s go!', 'Here we go! The {period}! Me have cookies ready!'],
      'goal': [
        'GOAL! ME LOVE GOAL! {scorer} score! Om nom nom nom nom!',
        'Puck go in net! {scorer} get cookie! COOKIE FOR EVERYBODY!',
        '{scorer} shoot... IT GO IN! Me so happy me eat microphone!',
        'GOOOAL! {scorer}! That more satisfying than chocolate chip!',
      ],
      'goal-empty-net': ['{scorer} put puck in empty net. Nobody home! Like cookie jar when me done with it.'],
      'scoreUpdate': ['{score}! Me count on fingers to be sure.', '{score}. Om nom.'],
      'shot-on-goal': [
        '{shooter} shoot... but {goalie} catch it! Goalie hog puck like me hog cookie!',
        '{shooter} shoot! {goalie} say NO. Rude.',
        'Ooh, {shooter} try! {goalie} stop it. {goalie} must have had good breakfast.',
      ],
      'missed-shot': ['{shooter} shoot... miss net! Me know feeling. Me miss mouth sometimes. Crumbs everywhere.', '{shooter} miss! Puck go wide like cookie roll under couch.'],
      'blocked-shot': ['{blocker} block shot with own body! Brave monster! Or maybe him just hungry.', 'Shot blocked by {blocker}! That gonna leave crumb. Me mean bruise.'],
      'hit': ['Ooh! {hitter} crunch {hittee} like chocolate chip cookie! CRUNCH!', '{hitter} smash {hittee} into wall! Me do that to cookie jar once.', 'BIG HIT! {hitter} on {hittee}! Me spill milk!'],
      'faceoff': ['Puck drop. {winner} get it. Me still waiting for cookie.', '{winner} win faceoff! Him fast like me when oven timer go ding.'],
      'giveaway': ['{player} give puck away! Why?! Me NEVER give anything away!', 'Uh oh, {player} drop puck. Five second rule! No? Okay.'],
      'takeaway': ['{player} TAKE puck! Me respect that. Me take cookies same way.', 'Ooh, {player} steal it! Sneaky monster!'],
      'penalty': [
        '{player} go to sin bin for {mins} minute! For {penalty}! Me once go to sin bin for eating whole snack table.',
        'Penalty! {player}, {penalty}. {mins} minute in timeout. Timeout no have cookies. Very sad.',
      ],
      'delayed-penalty': ['Referee arm up! Somebody in trouble! Not me this time!'],
      'period-end': ['Horn go! {period} over! Intermission mean snack time!', 'That end of {period}! Me go find cookie, be right back!'],
      'shootout-complete': ['Shootout over! Me need to lie down. And eat.'],
      'game-end': ['GAME OVER! {final}! Now we all eat cookies! That how game supposed to end!', 'Final horn! {final}! Me Cookie Monster, good night! Om nom nom!'],
    },
    colour: {
      'goal': ['You know, net look like big cookie jar. Puck go in jar, everybody happy. Science.', 'Me think goal taste like victory. Victory taste like oatmeal raisin. Disappointing but still good.'],
      'penalty': ['Me no understand rule. But me understand sitting in box alone. Very lonely. Need snack.', 'Ref very strict. Ref would never let me in bakery.'],
      'hit': ['Hockey players very strong. Me think they eat lots of cookies. Me think that is the secret.'],
      'period-end': ['Shots so far: {awaySog} for {away}, {homeSog} for {home}. Me count all of them. Me hungry from counting.', 'Ice very cold. Me put milk on it, make it extra cold. Then dip cookie. Genius.'],
      'game-end': ['Great game. Me give it ten cookies out of ten. Me already eat all ten.'],
      'general': [
        'You know what puck look like? Big black cookie. Me no eat it. Me learn that lesson long time ago.',
        'Zamboni is giant cookie-making machine? No? Okay. Disappointing.',
        'Why they call it "icing"? Me see no icing! False advertising!',
        'Me think hockey stick would be good for reaching cookie on high shelf.',
        'Crowd very loud. Probably because snack stand is open.',
      ],
    },
  };

  // ---------------------------------------------------------------------------
  // Sport interface used by app.js (shared with mlb-engine.js)
  // ---------------------------------------------------------------------------

  function refreshGame(game, pbp) {
    const fresh = buildGame(pbp);
    if (fresh.roster.size) game.roster = fresh.roster;
    game.state = fresh.state;
  }

  function inProgress(events) {
    return events.some((e) => e.type !== 'period-start' && e.type !== 'faceoff');
  }

  function boardText(state, ev) {
    const g = state.game;
    return {
      main: `${g.away.abbrev} ${state.score.away} – ${state.score.home} ${g.home.abbrev}`,
      sub: `${periodLabel(state.period, state.periodType)}${ev && ev.timeRemaining ? ' · ' + ev.timeRemaining : ''} · SOG ${state.sog.away}–${state.sog.home}`,
    };
  }

  function situation(state) {
    const g = state.game;
    return `${g.away.name} ${state.score.away}, ${g.home.name} ${state.score.home}. ` +
      `Shots ${state.sog.away}-${state.sog.home}. ${periodLabel(state.period, state.periodType)}.`;
  }

  const Booth = {
    sport: 'nhl', buildGame, refreshGame, normalizePlay, normalizePlays, inProgress, describe,
    situation, boardText, GameState, templateLines, joinLine, shouldCall, wantsColour, scoreLine,
    fill, PERSONAS, periodLabel, clockToSeconds, canCall,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Booth;
  else root.Booth = Booth;
})(typeof window !== 'undefined' ? window : globalThis);
