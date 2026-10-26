/* League tables for the Edge Match Board's CHAMPIONSHIP tab: a port of
 * dayboard-android/core match/Standings.kt (same parsing, zones, run around
 * your club, footer), tested against the same sample.
 */
(function (root) {
  const M = root.Matches || (typeof require !== 'undefined' ? require('./matches.js') : null);
  const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const pad2 = (n) => String(n).padStart(2, '0');

  /** The overall ("TOTAL") table from a /competitions/{code}/standings response. */
  function parse(json) {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    const groups = (doc && doc.standings) || [];
    const total = groups.find((g) => g.type === 'TOTAL') || groups[0];
    if (!total) return [];
    return (total.table || []).map((r) => {
      const t = r.team || {};
      if (r.position == null || t.id == null) return null;
      const name = t.name || t.shortName || '';
      return {
        position: r.position,
        team: { id: t.id, name, shortName: t.shortName || name, tla: t.tla || name.slice(0, 3).toUpperCase() },
        played: r.playedGames || 0, won: r.won || 0, draw: r.draw || 0, lost: r.lost || 0,
        goalDifference: r.goalDifference || 0, points: r.points || 0,
      };
    }).filter(Boolean).sort((a, b) => a.position - b.position);
  }

  /** The Championship's places: 1-2 promoted, 3-6 play-offs, the bottom three relegated (24 clubs). */
  function zone(position, size) {
    if (size !== 24) return 'NONE';
    if (position <= 2) return 'PROMOTED';
    if (position <= 6) return 'PLAYOFF';
    if (position > size - 3) return 'RELEGATED';
    return 'NONE';
  }

  function find(table, text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    return table.find((s) => [s.team.name, s.team.shortName, s.team.tla, M.clubName(s.team)].some((x) => x && x.toLowerCase() === q))
      || table.find((s) => s.team.name.toLowerCase().includes(q) || M.clubName(s.team).toLowerCase().includes(q)) || null;
  }

  function ordinal(n) {
    const t = n % 100 >= 11 && n % 100 <= 13 ? 'TH' : ({ 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] || 'TH');
    return `${n}${t}`;
  }

  /** The rows that fit in [capacity]: all, or a run centred on your club. state: { table, fetchedAt, error, message } */
  function build(state, favourite, now, capacity) {
    const table = state.table || [];
    const fav = find(table, favourite);
    const message = state.message
      || (state.fetchedAt == null && state.error) || (state.fetchedAt == null ? 'WAITING FOR THE FIRST UPDATE' : null)
      || (table.length ? null : 'NO TABLE YET');
    const cap = Math.max(1, capacity);
    const start = table.length <= cap || !fav ? 0 : Math.min(Math.max(0, table.indexOf(fav) - Math.floor(cap / 2)), table.length - cap);
    const rows = message ? [] : table.slice(start, start + cap).map((s) => ({ standing: s, zone: zone(s.position, table.length), favourite: s === fav }));
    let asOf = null;
    if (state.fetchedAt != null) {
      const f = new Date(state.fetchedAt);
      const sameDay = M.dayStart(state.fetchedAt) === M.dayStart(now);
      asOf = `AS OF ${sameDay ? '' : `${WD[f.getDay()]} `}${f.getHours() % 12 || 12}:${pad2(f.getMinutes())} ${f.getHours() < 12 ? 'AM' : 'PM'}`;
    }
    const parts = [asOf, state.fetchedAt != null ? state.error : null].filter(Boolean);
    return {
      rows, total: table.length, message, footer: parts.join(' · '), stale: parts.length > 1,
      favouriteLine: fav ? `${M.clubName(fav.team).toUpperCase()} ${ordinal(fav.position)}` : '',
    };
  }

  const api = { parse, zone, find, ordinal, build };
  root.Standings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
