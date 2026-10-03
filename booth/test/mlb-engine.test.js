// Run: node --test booth/test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const B = require('../mlb-engine.js');

const feed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mlb-demo-game.json'), 'utf8'));

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function playGame(personaId, rng) {
  const g = B.buildGame(feed);
  const state = new B.GameState(g);
  const evs = B.normalizePlays(feed, g);
  const lines = [];
  for (const ev of evs) {
    state.apply(ev);
    lines.push(...B.templateLines(ev, B.PERSONAS[personaId], state, rng));
  }
  return { g, state, evs, lines };
}

test('buildGame reads teams, venue and players', () => {
  const g = B.buildGame(feed);
  assert.strictEqual(g.away.abbrev, 'BOS');
  assert.strictEqual(g.home.name, 'Blue Jays');
  assert.strictEqual(g.status, 'Final');
  assert.ok(Object.keys(g.players).length >= 22);
});

test('normalizePlays: ordered, unique ids, intro before first pitch, result last', () => {
  const g = B.buildGame(feed);
  const evs = B.normalizePlays(feed, g);
  const ids = new Set(evs.map((e) => e.id));
  assert.strictEqual(ids.size, evs.length);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].sortOrder > evs[i - 1].sortOrder);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].replayAt >= evs[i - 1].replayAt, `replayAt goes backwards at ${evs[i].id}`);
  // Each at-bat: intro precedes its pitches; result follows them.
  const ab0 = evs.filter((e) => e.id.startsWith('0-'));
  assert.deepStrictEqual(ab0.map((e) => e.type)[0], 'half');
  assert.strictEqual(ab0[1].type, 'atbat');
  assert.strictEqual(ab0[ab0.length - 1].type, 'result');
  assert.strictEqual(evs[evs.length - 1].type, 'game-end');
  // Pitching change action comes before that at-bat's intro.
  const change = evs.find((e) => e.type === 'action' && e.eventType === 'pitching_substitution');
  const intro = evs.find((e) => e.type === 'atbat' && e.id.split('-')[0] === change.id.split('-')[0]);
  assert.ok(change.sortOrder < intro.sortOrder);
});

test('game state tracks score, outs, bases and count over the whole game', () => {
  const g = B.buildGame(feed);
  const state = new B.GameState(g);
  const plays = feed.liveData.plays.allPlays;
  for (const ev of B.normalizePlays(feed, g)) {
    state.apply(ev);
    assert.ok(state.outs >= 0 && state.outs <= 3);
    assert.ok(state.balls <= 4 && state.strikes <= 3);
    if (ev.type === 'half') assert.strictEqual(state.runnersOn().length, 0);
  }
  const last = plays[plays.length - 1].result;
  assert.deepStrictEqual(state.score, { away: last.awayScore, home: last.homeScore });
  assert.strictEqual(state.over, true);
});

test('bases follow runner movements (walk forces, steals, scoring)', () => {
  const g = { players: {}, away: { abbrev: 'A', name: 'A' }, home: { abbrev: 'H', name: 'H' } };
  const s = new B.GameState(g);
  s.moveRunners([{ runner: 'Bat', start: null, end: '1B' }]);
  s.moveRunners([{ runner: 'Bat', start: '1B', end: '2B' }]);
  s.moveRunners([{ runner: 'Two', start: null, end: '1B' }]);
  assert.deepStrictEqual(s.runnersOn(), ['1B', '2B']);
  assert.strictEqual(B.basesText(s), 'runners on first and second');
  s.moveRunners([{ runner: 'Bat', start: '2B', end: 'score' }, { runner: 'Two', start: '1B', end: null, isOut: true }]);
  assert.deepStrictEqual(s.runnersOn(), []);
});

test('describe never prints undefined/null/NaN', () => {
  const g = B.buildGame(feed);
  const state = new B.GameState(g);
  for (const ev of B.normalizePlays(feed, g)) {
    state.apply(ev);
    const d = B.describe(ev, state);
    assert.ok(!/undefined|null|NaN/.test(d), d);
  }
  assert.match(B.situation(state), /^Red Sox 3, Blue Jays 4\./);
});

for (const id of Object.keys(B.PERSONAS)) {
  test(`persona ${id}: full game produces clean, complete commentary`, () => {
    const { evs, lines } = playGame(id, seeded(7));
    assert.ok(lines.length > 150, `only ${lines.length}`);
    for (const l of lines) {
      assert.ok(!/[{}]|undefined|null|NaN|\(\d+\)/.test(l.text), `${id}: ${l.text}`);
      assert.ok(/^[^a-z]/.test(l.text), `lowercase start: ${l.text}`);
    }
    // Every completed at-bat gets a play-by-play call.
    for (const ev of evs.filter((e) => e.type === 'result')) {
      assert.ok(lines.some((l) => l.eventId === ev.id && l.speaker === 'pbp'), `result ${ev.id} uncalled: ${ev.description}`);
    }
    // Home runs and the walk-off are big moments.
    for (const ev of evs.filter((e) => e.type === 'result' && e.eventType === 'home_run')) {
      assert.ok(lines.some((l) => l.eventId === ev.id && l.excitement >= 1));
    }
    const final = evs.filter((e) => e.type === 'result').pop();
    assert.ok(lines.some((l) => l.eventId === final.id && l.excitement === 2), 'walk-off not called as huge');
    assert.ok(lines.some((l) => l.eventId === 'final'), 'no sign-off');
    // Strike three is never called as an ordinary strike.
    const colour = lines.filter((l) => l.speaker === 'colour').length;
    assert.ok(colour < lines.length / 3, `colour ${colour}/${lines.length}`);
  });
}

test('strike three and ball four are left to the at-bat result', () => {
  const g = B.buildGame(feed);
  const state = new B.GameState(g);
  for (const ev of B.normalizePlays(feed, g)) {
    state.apply(ev);
    const key = B.lineKey(ev, state);
    if (ev.type === 'pitch' && ev.count && (ev.count.strikes === 3 || ev.count.balls === 4)) assert.strictEqual(key, null, ev.id);
  }
});

test('score phrasing per persona', () => {
  const s = new B.GameState(B.buildGame(feed));
  s.score = { away: 0, home: 2 };
  assert.strictEqual(B.scoreLine(s, B.PERSONAS.scottish), 'The Blue Jays lead 2-nil');
  assert.strictEqual(B.scoreLine(s, B.PERSONAS.radio), 'The Blue Jays lead it, 2 to 0');
  s.score = { away: 0, home: 0 };
  assert.strictEqual(B.scoreLine(s, B.PERSONAS.scottish), 'Still nil-nil');
  assert.strictEqual(B.countText(3, 2), 'full count');
  assert.strictEqual(B.countText(0, 2), 'oh and two');
});

test('live feed: in-progress at-bat produces intro and pitches but no result yet', () => {
  const partial = JSON.parse(JSON.stringify(feed));
  partial.gameData.status.abstractGameState = 'Live';
  const plays = partial.liveData.plays.allPlays;
  const cur = plays[10];
  cur.about.isComplete = false;
  cur.playEvents = cur.playEvents.slice(0, 1);
  partial.liveData.plays.allPlays = plays.slice(0, 11);
  const g = B.buildGame(partial);
  const evs = B.normalizePlays(partial, g);
  const mine = evs.filter((e) => e.id.startsWith(`${cur.about.atBatIndex}-`));
  assert.ok(mine.some((e) => e.type === 'atbat'));
  assert.ok(!mine.some((e) => e.type === 'result'));
  assert.ok(!evs.some((e) => e.type === 'game-end'));
  assert.ok(B.inProgress(evs));
});

test('events carry wall-clock times for feed-lag measurement; board shows inning breaks', () => {
  const g = B.buildGame(feed);
  const evs = B.normalizePlays(feed, g);
  const pitches = evs.filter((e) => e.type === 'pitch');
  assert.ok(pitches.length && pitches.every((e) => Number.isFinite(e.wall)));
  assert.ok(evs.filter((e) => e.type === 'result').every((e) => Number.isFinite(e.wall)));
  const state = new B.GameState(g);
  for (const ev of evs) {
    state.apply(ev);
    if (ev.type === 'result' && ev.outsAfter === 3 && ev.top) {
      assert.match(B.boardText(state).sub, /^Middle of the \d+(st|nd|rd|th)$/);
      return;
    }
  }
  assert.fail('no half-inning ended');
});

test('event ids survive MLB inserting an event earlier in an at-bat', () => {
  const g = B.buildGame(feed);
  const before = new Set(B.normalizePlays(feed, g).map((e) => e.id));
  const edited = JSON.parse(JSON.stringify(feed));
  const play = edited.liveData.plays.allPlays[12];
  // MLB adds a mound visit at the start of the at-bat; every later index shifts.
  play.playEvents.unshift({ index: 0, type: 'action', isPitch: false, startTime: play.about.startTime,
    details: { event: 'Mound Visit', eventType: 'mound_visit', description: 'Mound visit.' } });
  play.playEvents.forEach((e, i) => { e.index = i; });
  const after = B.normalizePlays(edited, B.buildGame(edited)).map((e) => e.id);
  const fresh = after.filter((id) => !before.has(id));
  assert.strictEqual(fresh.length, 1, `unexpected new ids: ${fresh}`);
  // And MLB's own playId wins when present.
  const withIds = JSON.parse(JSON.stringify(feed));
  withIds.liveData.plays.allPlays[0].playEvents[0].playId = 'abc-123';
  assert.ok(B.normalizePlays(withIds, B.buildGame(withIds)).some((e) => e.id === '0-abc-123'));
});

test('results are timed to the pitch that ended the at-bat, not to when MLB scored it', () => {
  const g = B.buildGame(feed);
  const evs = B.normalizePlays(feed, g);
  for (const r of evs.filter((e) => e.type === 'result')) {
    const ab = r.id.split('-')[0];
    const pitches = evs.filter((e) => e.type === 'pitch' && e.id.split('-')[0] === ab);
    if (!pitches.length) continue;
    const last = pitches[pitches.length - 1];
    const gap = r.wall - last.wall;
    assert.ok(gap === 500 || gap === 2500, `${r.id}: result ${gap}ms after last pitch`);
    if (r.hit) assert.strictEqual(gap, 2500);
  }
});

test('batting averages are spoken the way broadcasters say them', () => {
  assert.strictEqual(B.avgWords('.290'), 'two-ninety');
  assert.strictEqual(B.avgWords('.305'), 'three-oh-five');
  assert.strictEqual(B.avgWords('.300'), 'three hundred');
  assert.strictEqual(B.avgWords('.247'), 'two-forty-seven');
  assert.strictEqual(B.avgWords('.000'), null);
  assert.strictEqual(B.avgWords('1.000'), 'a thousand');
  assert.strictEqual(B.avgWords('-.--'), null);
});

function withStats() {
  const f = JSON.parse(JSON.stringify(feed));
  const g = B.buildGame(f);
  const ids = new Set();
  for (const pl of f.liveData.plays.allPlays) { ids.add(pl.matchup.batter.id); ids.add(pl.matchup.pitcher.id); }
  // Shape of statsapi /people/{id}/stats season splits and the feed's boxscore "stats".
  for (const id of ids) {
    B.setSeasonStats(g, id, 'hitting', { avg: '.287', homeRuns: 19, rbi: 71, atBats: 512 });
    B.setSeasonStats(g, id, 'pitching', { era: '3.41', wins: 12, losses: 7, strikeOuts: 188, inningsPitched: '181.2' });
    g.today.set(id, { batting: { atBats: 2, hits: 1 }, pitching: { numberOfPitches: 64, strikeOuts: 5 } });
  }
  return { f, g };
}

test('stats appear in intros and colour, read aloud properly', () => {
  for (const id of Object.keys(B.PERSONAS)) {
    const { f, g } = withStats();
    const state = new B.GameState(g);
    const rng = seeded(11);
    const lines = [];
    for (const ev of B.normalizePlays(f, g)) { state.apply(ev); lines.push(...B.templateLines(ev, B.PERSONAS[id], state, rng)); }
    const statLines = lines.filter((l) => /two-eighty-seven|19 home runs|71 runs|3\.41|64 pitches|one for two|12 and 7|188/.test(l.text));
    assert.ok(statLines.length >= 5, `${id}: only ${statLines.length} stat lines`);
    for (const l of lines) assert.ok(!/[{}]|undefined|null|NaN|\.287/.test(l.text), `${id}: ${l.text}`);
  }
});

test('no stats, no stat lines (and nothing breaks)', () => {
  const g = B.buildGame(feed);
  const v = B.statVars(g, 1, 2);
  assert.ok(Object.values(v).every((x) => x == null));
});

test('rosterIds reads lineups and pitchers from the boxscore', () => {
  const f = { liveData: { boxscore: { teams: { away: { batters: [1, 2], pitchers: [3] }, home: { batters: [4], pitchers: [5, 6] } } } } };
  assert.deepStrictEqual(B.rosterIds(f).map((x) => `${x.id}:${x.group}`), ['1:hitting', '2:hitting', '3:pitching', '4:hitting', '5:pitching', '6:pitching']);
});

// A real MLB live feed captured during the Oct 3 2026 ALDS game (CWS @ CLE),
// saved by the booth's logger in the bottom of the 9th.
const real = JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'mlb-cws-cle-2026-10-03.json.gz'))));

test('real feed: unique ids, every event timed, times never run backwards', () => {
  const g = B.buildGame(real);
  const evs = B.normalizePlays(real, g);
  assert.ok(evs.length > 400);
  assert.strictEqual(new Set(evs.map((e) => e.id)).size, evs.length);
  for (const e of evs.filter((x) => x.type !== 'game-end')) assert.ok(Number.isFinite(e.wall), `${e.id} ${e.type} has no time`);
  for (let i = 1; i < evs.length; i++) if (evs[i].wall && evs[i - 1].wall) assert.ok(evs[i].wall >= evs[i - 1].wall, `${evs[i].id}`);
  // Inning header comes no later than its first batter.
  for (const h of evs.filter((e) => e.type === 'half')) {
    const ab = evs.find((e) => e.type === 'atbat' && e.id.split('-')[0] === h.id.split('-')[0]);
    if (ab) assert.ok(h.wall <= ab.wall, h.id);
  }
});

test('real feed: every booth produces clean lines; state matches MLB', () => {
  for (const id of Object.keys(B.PERSONAS)) {
    const g = B.buildGame(real);
    const state = new B.GameState(g);
    const lines = [];
    for (const ev of B.normalizePlays(real, g)) { state.apply(ev); lines.push(...B.templateLines(ev, B.PERSONAS[id], state, seeded(3))); }
    assert.ok(lines.length > 250, `${id}: ${lines.length}`);
    for (const l of lines) assert.ok(!/[{}]|undefined|null|NaN|\(\d+\)|Pitching Change:/.test(l.text), `${id}: ${l.text}`);
    assert.deepStrictEqual(state.score, { away: 3, home: 0 });
  }
  assert.ok(B.rosterIds(real).length >= 40);
  assert.ok(B.buildGame(real).today.size >= 40);
});
