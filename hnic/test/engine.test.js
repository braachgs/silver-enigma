// Run: node --test hnic/test
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Booth = require('../engine.js');

const pbp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo-game.json'), 'utf8'));

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('buildGame parses teams and roster', () => {
  const g = Booth.buildGame(pbp);
  assert.strictEqual(g.away.abbrev, 'MTL');
  assert.strictEqual(g.home.name, 'Maple Leafs');
  assert.strictEqual(g.roster.size, 14);
});

test('normalizePlays orders events and resolves names', () => {
  const g = Booth.buildGame(pbp);
  const evs = Booth.normalizePlays(pbp, g);
  assert.strictEqual(evs.length, pbp.plays.length);
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i].sortOrder > evs[i - 1].sortOrder);
  const goal = evs.find((e) => e.type === 'goal');
  assert.ok(goal.p.scorer && goal.p.assist1 && goal.p.goalie);
  assert.deepStrictEqual(goal.score, { away: 0, home: 1 });
  assert.match(Booth.describe(goal), /GOAL TOR: \w+ \w+ .*assists .* and .*Score: away 0, home 1/);
});

test('describe covers every event type in the demo without "undefined"', () => {
  const g = Booth.buildGame(pbp);
  for (const ev of Booth.normalizePlays(pbp, g)) {
    const d = Booth.describe(ev);
    assert.ok(d.length > 5);
    assert.ok(!/undefined|null|NaN/.test(d), d);
  }
});

for (const id of Object.keys(Booth.PERSONAS)) {
  test(`persona ${id}: full game produces clean lines`, () => {
    const persona = Booth.PERSONAS[id];
    const g = Booth.buildGame(pbp);
    const state = new Booth.GameState(g);
    const rng = seeded(42);
    const lines = [];
    for (const ev of Booth.normalizePlays(pbp, g)) {
      state.apply(ev);
      lines.push(...Booth.templateLines(ev, persona, state, rng));
    }
    assert.ok(lines.length > 40, `only ${lines.length} lines`);
    for (const l of lines) {
      assert.ok(['pbp', 'colour'].includes(l.speaker));
      assert.ok(!/[{}]|undefined|null|NaN/.test(l.text), `${id}: ${l.text}`);
      assert.ok(l.text.length > 2);
    }
    // Every goal gets a play-by-play call.
    const goalIds = Booth.normalizePlays(pbp, g).filter((e) => e.type === 'goal').map((e) => e.id);
    for (const gid of goalIds) assert.ok(lines.some((l) => l.eventId === gid && l.speaker === 'pbp'), `goal ${gid} uncalled`);
    // Colour should be a minority voice.
    const colour = lines.filter((l) => l.speaker === 'colour').length;
    assert.ok(colour < lines.length / 2, `colour ${colour}/${lines.length}`);
  });
}

test('catchphrase budget: goal calls do not repeat until the pool is exhausted', () => {
  const persona = Booth.PERSONAS.hnic90;
  const g = Booth.buildGame(pbp);
  const state = new Booth.GameState(g);
  const goals = Booth.normalizePlays(pbp, g).filter((e) => e.type === 'goal');
  const calls = goals.map((ev) => { state.apply(ev); return Booth.templateLines(ev, persona, state, seeded(1))[0].text; });
  const pool = persona.pbp.goal.length;
  assert.strictEqual(new Set(calls.slice(0, pool)).size, Math.min(pool, calls.length));
});

test('Scottish persona reads zero as nil', () => {
  const g = Booth.buildGame(pbp);
  const s = new Booth.GameState(g);
  s.score = { away: 0, home: 2 };
  assert.strictEqual(Booth.scoreLine(s, Booth.PERSONAS.scottish), 'The Maple Leafs lead 2-nil');
  s.score = { away: 0, home: 0 };
  assert.strictEqual(Booth.scoreLine(s, Booth.PERSONAS.scottish), 'Still goalless');
  s.score = { away: 1, home: 3 };
  assert.strictEqual(Booth.scoreLine(s, Booth.PERSONAS.hnic90), 'Maple Leafs lead it 3 to 1');
});

test('events with missing player data are not called', () => {
  const g = Booth.buildGame(pbp);
  const ev = Booth.normalizePlay({ eventId: 9999, typeDescKey: 'goal', periodDescriptor: { number: 1 }, details: { eventOwnerTeamId: 8, scoringPlayerId: 1 } }, g);
  assert.strictEqual(Booth.canCall(ev), false);
});
