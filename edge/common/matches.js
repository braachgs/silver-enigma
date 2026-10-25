/* Match Board logic for the Xeneon Edge: a port of the Android app's
 * dayboard.match (Matches.kt, MatchBoard.kt), tested against the same
 * football-data.org v4 sample (edge/tests). Times are in this PC's zone.
 */
(function (root) {
  const MIN = 60000;
  const DAY = 864e5;

  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const dayStart = (t, plus = 0) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus).getTime(); };
  const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const MO = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  /** " 3:00P": five flaps plus an A/P flap, as Day Board's split-flap times. */
  function boardTime(t) {
    const d = new Date(t);
    const h = d.getHours() % 12 || 12;
    return `${h}:${pad2(d.getMinutes())}`.padStart(5, ' ') + (d.getHours() < 12 ? 'A' : 'P');
  }
  const dayLabel = (t) => { const d = new Date(t); return `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`; };
  const clock = (t) => { const d = new Date(t); return `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`; };

  const STATUSES = ['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'POSTPONED', 'SUSPENDED', 'CANCELLED', 'AWARDED'];
  const status = (s) => (s === 'LIVE' ? 'IN_PLAY' : STATUSES.includes(s) ? s : 'UNKNOWN');
  const isLive = (s) => s === 'IN_PLAY' || s === 'PAUSED';
  const isDone = (s) => s === 'FINISHED' || s === 'AWARDED';
  const isUpcoming = (s) => s === 'SCHEDULED' || s === 'TIMED';

  // football-data.org's short names, where a fan would say it differently.
  const NAMES = {
    'Brighton Hove': 'Brighton', Wolverhampton: 'Wolves', Nottingham: "Nott'm Forest", 'Ipswich Town': 'Ipswich',
    'Leicester City': 'Leicester', 'Leeds United': 'Leeds', 'Sheffield Utd': 'Sheff Utd',
  };
  const COMPACT = {
    'Crystal Palace': 'Palace', "Nott'm Forest": 'Forest', 'Aston Villa': 'Villa', Bournemouth: "B'mouth",
    Southampton: 'Saints', 'Man United': 'Man Utd', Sunderland: "S'land", Tottenham: 'Spurs',
  };
  const clubName = (t) => NAMES[t.shortName] || t.shortName;
  function fitName(t, cells) {
    const full = clubName(t);
    if (full.length <= cells) return full;
    const short = COMPACT[full];
    if (short && short.length <= cells) return short;
    return t.tla.slice(0, cells);
  }

  function team(t) {
    if (!t || t.id == null) return null;
    const name = t.name || t.shortName;
    if (!name) return null;
    return { id: t.id, name, shortName: t.shortName || name, tla: t.tla || name.slice(0, 3).toUpperCase() };
  }

  /** Matches from a /competitions/PL/matches (or /teams/{id}/matches) response. */
  function parseMatches(json) {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    const out = [];
    for (const m of (doc && doc.matches) || []) {
      const kickoff = Date.parse(m.utcDate);
      const home = team(m.homeTeam);
      const away = team(m.awayTeam);
      if (m.id == null || !Number.isFinite(kickoff) || !home || !away) continue;
      // During a match v4 keeps the running score in fullTime. Never filled in by the widget.
      const ft = (m.score && m.score.fullTime) || {};
      const w = m.score && m.score.winner;
      out.push({
        id: m.id, kickoff, status: status(m.status), home, away,
        homeScore: Number.isFinite(ft.home) ? ft.home : null,
        awayScore: Number.isFinite(ft.away) ? ft.away : null,
        winner: w === 'HOME_TEAM' ? 'HOME' : w === 'AWAY_TEAM' ? 'AWAY' : w === 'DRAW' ? 'DRAW' : null,
      });
    }
    return out;
  }

  const roundUp5 = (m) => Math.ceil(m / 5) * 5;

  /** The status flap. Only the feed says live, half time or over; before kickoff it counts down. */
  function statusOf(m, now) {
    const today = dayStart(now);
    const d = dayStart(m.kickoff);
    switch (m.status) {
      case 'IN_PLAY': return { text: 'LIVE', tone: 'LIVE' };
      case 'PAUSED': return { text: 'HALF TIME', tone: 'BOARDING' };
      case 'FINISHED': case 'AWARDED': return { text: 'FULL TIME', tone: 'INFO' };
      case 'POSTPONED': return { text: 'POSTPONED', tone: 'FINAL' };
      case 'SUSPENDED': return { text: 'SUSPENDED', tone: 'FINAL' };
      case 'CANCELLED': return { text: 'CANCELLED', tone: 'FINAL' };
      default:
        if (d > dayStart(now, 1)) { const k = new Date(m.kickoff); return { text: `${WD[k.getDay()]} ${k.getDate()} ${MO[k.getMonth()]}`, tone: 'INFO' }; }
        if (d > today) return { text: 'TOMORROW', tone: 'INFO' };
        if (m.kickoff > now) {
          const mins = Math.ceil((m.kickoff - now) / MIN);
          if (mins > 60) return { text: 'ON TIME', tone: 'ON_TIME' };
          return { text: `IN ${roundUp5(mins)} MIN`, tone: mins <= 5 ? 'FINAL' : 'BOARDING' };
        }
        if (d === today) return { text: 'KICK OFF', tone: 'INFO' }; // past kickoff; the feed hasn't said it's live
        return { text: 'NO RESULT', tone: 'PAST' };
    }
  }

  /** The followed club's match in play, else its next one. */
  function pinned(matches, followed, now) {
    if (followed == null) return null;
    const mine = matches.filter((m) => m.home.id === followed || m.away.id === followed);
    const first = (list) => list.sort((a, b) => a.kickoff - b.kickoff)[0] || null;
    return first(mine.filter((m) => isLive(m.status)))
      || first(mine.filter((m) => isUpcoming(m.status) && (m.kickoff > now || dayStart(m.kickoff) === dayStart(now))));
  }

  /** Today's matches, then upcoming, then recent results (newest first); the pinned match on top. */
  function order(matches, followed, now) {
    const today = dayStart(now);
    const pin = pinned(matches, followed, now);
    const time = (m, s) => {
      if (s !== 'RECENT') return boardTime(m.kickoff);
      const k = new Date(m.kickoff);
      return `${WD[k.getDay()]} ${k.getDate()}`.padEnd(6);
    };
    const row = (m, section) => ({
      match: m, section, pinned: !!pin && m.id === pin.id, time: time(m, section), status: statusOf(m, now),
      home: m.home, away: m.away, homeScore: m.homeScore, awayScore: m.awayScore, winner: m.winner, done: isDone(m.status),
      homeName: (n) => fitName(m.home, n), awayName: (n) => fitName(m.away, n),
    });
    const rest = matches.filter((m) => !pin || m.id !== pin.id);
    const byTime = (a, b) => a.kickoff - b.kickoff || a.id - b.id;
    const todays = rest.filter((m) => dayStart(m.kickoff) === today).sort(byTime).map((m) => row(m, 'TODAY'));
    const upcoming = rest.filter((m) => dayStart(m.kickoff) > today).sort(byTime).map((m) => row(m, 'UPCOMING'));
    const recent = rest.filter((m) => dayStart(m.kickoff) < today).sort((a, b) => b.kickoff - a.kickoff || a.id - b.id).map((m) => row(m, 'RECENT'));
    const top = pin ? [row(pin, dayStart(pin.kickoff) === today ? 'TODAY' : dayStart(pin.kickoff) > today ? 'UPCOMING' : 'RECENT')] : [];
    return top.concat(todays, upcoming, recent);
  }

  /**
   * state: { matches, fetchedAt, error, message }. Scores are exactly as last
   * fetched; the footer says when ("AS OF 2:39 PM", "AS OF SAT 7:10 PM · OFFLINE").
   */
  function build(state, followed, now, maxRows) {
    const rows = state.message ? [] : order(state.matches, followed, now);
    const shown = rows.slice(0, Math.max(1, maxRows));
    const msg = state.message
      || (state.fetchedAt == null && state.error) || (state.fetchedAt == null ? 'WAITING FOR THE FIRST UPDATE' : null)
      || (rows.length ? null : 'NO PREMIER LEAGUE MATCHES THIS WEEK');
    let asOf = null;
    if (state.fetchedAt != null) {
      const sameDay = dayStart(state.fetchedAt) === dayStart(now);
      asOf = `AS OF ${sameDay ? '' : `${WD[new Date(state.fetchedAt).getDay()]} `}${clock(state.fetchedAt)}`;
    }
    const footerParts = [asOf, state.fetchedAt != null ? state.error : null].filter(Boolean);
    return {
      now, dayLabel: dayLabel(now), rows: msg ? [] : shown, message: msg,
      footer: footerParts.join(' · '), stale: footerParts.length > 1,
      more: msg ? 0 : rows.length - shown.length,
      nextChange: nextChange(state.matches || [], now),
    };
  }

  /** The next moment a status flap changes without new data: a countdown step, a kickoff, or midnight. */
  function nextChange(matches, now) {
    const midnight = dayStart(now, 1);
    let next = midnight;
    for (const m of matches) {
      if (!isUpcoming(m.status) || m.kickoff <= now || m.kickoff >= midnight) continue;
      const rem = m.kickoff - now;
      const t = rem > 60 * MIN ? m.kickoff - 60 * MIN : m.kickoff - (roundUp5(Math.ceil(rem / MIN)) - 5) * MIN;
      if (t > now && t < next) next = t;
    }
    return next;
  }

  /** Finished: YouTube highlights. Live or upcoming: Peacock's Premier League page. */
  function link(m) {
    if (isDone(m.status)) {
      const q = `${clubName(m.home)} vs ${clubName(m.away)} highlights Premier League NBC Sports`;
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(q).replace(/%20/g, '+')}`;
    }
    return 'https://www.peacocktv.com/sports/premier-league';
  }

  /** The club whose name, short name or code matches [text] ("Brentford", "Spurs", "BRE"). */
  function findClub(matches, text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return null;
    const teams = new Map();
    for (const m of matches) { teams.set(m.home.id, m.home); teams.set(m.away.id, m.away); }
    const all = [...teams.values()];
    const exact = all.find((t) => [t.name, t.shortName, t.tla, clubName(t), COMPACT[clubName(t)]].some((x) => x && x.toLowerCase() === q));
    return exact || all.find((t) => t.name.toLowerCase().includes(q) || clubName(t).toLowerCase().includes(q)) || null;
  }

  const api = { parseMatches, statusOf, pinned, order, build, nextChange, link, findClub, clubName, fitName, boardTime, dayLabel, isLive, isDone, isUpcoming, dayKey, dayStart, DAY, MIN };
  root.Matches = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
