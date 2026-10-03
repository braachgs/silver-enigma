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
