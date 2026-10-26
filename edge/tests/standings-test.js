// node edge/tests/standings-test.js : the Championship table, as core's StandingsTest.
const fs = require('fs');
const path = require('path');
const S = require('../common/standings.js');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'}: ${m}`); if (!c) fails++; };
const t = S.parse(fs.readFileSync(path.join(__dirname, '../../dayboard-android/core/src/test/resources/elc-standings.json'), 'utf8'));
ok(t.length === 24 && t[0].position === 1, `24 clubs in order (${t.length})`);
ok(S.zone(2, 24) === 'PROMOTED' && S.zone(3, 24) === 'PLAYOFF' && S.zone(6, 24) === 'PLAYOFF' && S.zone(7, 24) === 'NONE' && S.zone(22, 24) === 'RELEGATED' && S.zone(1, 20) === 'NONE', 'zones');
ok(S.find(t, 'wrexham') && S.find(t, 'WRE') === S.find(t, 'Wrexham'), 'finds Wrexham by name or code');
ok(['1ST', '2ND', '3RD', '11TH', '12TH', '22ND'].join() === [1, 2, 3, 11, 12, 22].map(S.ordinal).join(), 'ordinals');
const now = Date.parse('2026-10-25T14:40:00Z');
const m = S.build({ table: t, fetchedAt: now - 60000 }, 'Wrexham', now, 7);
const pos = S.find(t, 'Wrexham').position;
ok(m.rows.length === 7 && m.rows.some((r) => r.favourite) && m.rows[3].favourite, `a run of 7 centred on Wrexham (${m.rows.map((r) => r.standing.position)})`);
ok(m.favouriteLine === `WREXHAM ${S.ordinal(pos)}` && /^AS OF /.test(m.footer), `${m.favouriteLine} · ${m.footer}`);
ok(S.build({ table: t, fetchedAt: now }, 'Wrexham', now, 30).rows.length === 24, 'all when it fits');
ok(S.build({ table: [], fetchedAt: null }, 'Wrexham', now, 7).message === 'WAITING FOR THE FIRST UPDATE', 'waiting');
process.exit(fails ? 1 : 0);
