/**
 * Server-side mirror of the rating formulas in src/moderator/ModeratorPage.jsx
 * (search that file for the same function names). This is the AUTHORITATIVE
 * copy — the client still runs its own copy for the live confirmation-screen
 * preview, but the value that actually gets persisted to Firestore always
 * comes from running these same functions here, against prevPoints read
 * fresh from Firestore, never from whatever prevPoints/finalPoints a client
 * request claims. Keep this in sync with ModeratorPage.jsx if the formula
 * ever changes there.
 */

const K_FACTOR = 32;
const PPU = 0.5;
const COMEBACK_BONUS = 20;
const DEFAULT_POINTS = 1200;

const LEVEL_LABELS = {
  elementary: 'Elementary',
  highSchool: 'High School',
  college: 'College',
};

function norm(str) {
  return (str || '').trim().toLowerCase();
}

function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

function rankingScopeKey(sportName, category) {
  return `${norm(sportName)}::${norm(displayCategory(category))}`;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function pointsInScope(teamMap, teamName) {
  if (!teamMap || !teamName) return null;
  const hit = Object.entries(teamMap).find(([name]) => norm(name) === norm(teamName));
  const value = hit ? Number(hit[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function overallRating(allRankings, teamName) {
  const bySport = new Map();
  Object.entries(allRankings || {}).forEach(([scopeKey, teamMap]) => {
    const points = pointsInScope(teamMap, teamName);
    if (points == null) return;
    const [scopeSport] = String(scopeKey).split('::');
    if (!bySport.has(scopeSport)) bySport.set(scopeSport, []);
    bySport.get(scopeSport).push(points);
  });
  const sportAverages = [...bySport.values()]
    .map((list) => list.reduce((sum, p) => sum + p, 0) / list.length);
  if (!sportAverages.length) return null;
  return sportAverages.reduce((sum, avg) => sum + avg, 0) / sportAverages.length;
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

function signedPerformance(mode, ownScore, oppScore) {
  return mode === 'points' ? ownScore - oppScore : oppScore - ownScore;
}

function isBetter(mode, a, b) {
  return mode === 'points' ? a > b : a < b;
}

function pairComputation({ mode, ownRating, oppRating, ownScore, oppScore, violations, comeback, sOverride }) {
  const E = expectedScore(ownRating, oppRating);
  let S;
  if (sOverride != null) S = sOverride;
  else if (ownScore === oppScore) S = 0.5;
  else S = isBetter(mode, ownScore, oppScore) ? 1 : 0;
  const f1 = signedPerformance(mode, ownScore, oppScore);
  const f2 = violations || 0;
  const f3 = comeback && S === 1 ? COMEBACK_BONUS : 0;
  const change = K_FACTOR * (S - E) + PPU * (f1 - f2 + f3);
  return { E, S, f1, f2, f3, change, ownRating, oppRating };
}

function buildComputation({ rows, mode, winnerOverrideId: rawWinnerOverrideId }) {
  /* 'DRAW' is a sentinel winner: a two-team match that ended level. Each side
     scores S = 0.5 against the other and both share 1st place. */
  const isDraw = rawWinnerOverrideId === 'DRAW' && rows.length === 2;
  const winnerOverrideId = isDraw ? null : rawWinnerOverrideId;
  const ordered = [...rows].sort((a, b) => {
    if (winnerOverrideId) {
      if (a.id === winnerOverrideId && b.id !== winnerOverrideId) return -1;
      if (b.id === winnerOverrideId && a.id !== winnerOverrideId) return 1;
    }
    return mode === 'points' ? b.score - a.score : a.score - b.score;
  });
  const placeById = {};
  ordered.forEach((r, i) => { placeById[r.id] = isDraw ? 1 : i + 1; });

  const teams = rows.map((t) => {
    const opponents = rows.filter((o) => o.id !== t.id);
    const pairings = opponents.map((o) => {
      const sOverride = isDraw
        ? 0.5
        : winnerOverrideId && (t.id === winnerOverrideId || o.id === winnerOverrideId)
          ? (winnerOverrideId === t.id ? 1 : 0)
          : null;
      const p = pairComputation({
        mode,
        ownRating: t.prevPoints,
        oppRating: o.prevPoints,
        ownScore: t.score,
        oppScore: o.score,
        violations: t.totalViolations,
        comeback: t.comeback,
        sOverride,
      });
      return { ...p, oppId: o.id, oppName: o.name, oppScore: o.score };
    });
    const change = pairings.reduce((s, p) => s + p.change, 0);
    const expected = pairings.length ? pairings.reduce((s, p) => s + p.E, 0) / pairings.length : 0;
    const totalF1 = pairings.reduce((s, p) => s + p.f1, 0);
    const wins = pairings.filter((p) => p.S === 1).length;
    return {
      ...t,
      pairings,
      expected,
      change,
      totalF1,
      wins,
      finalPoints: round4(t.prevPoints + change),
      place: placeById[t.id],
    };
  });

  const winnerId = isDraw
    ? 'DRAW'
    : winnerOverrideId
      ? winnerOverrideId
      : (teams.find((t) => t.place === 1)?.id ?? null);

  return { teams, winnerId };
}

/* Mirrors computeEditFinalPoints in ModeratorPage.jsx (the inline
   summary-table quick-edit, 1v1 records only). */
function computeEditFinalPoints({ ratingA, ratingB, violA, violB, comebackA, comebackB, isPoints, pA, pB, mA, mB, fallbackWinner }) {
  let f1A, f1B;
  if (isPoints) {
    const valid = pA != null && pB != null && !Number.isNaN(pA) && !Number.isNaN(pB);
    f1A = valid ? pA - pB : 0;
    f1B = valid ? pB - pA : 0;
  } else {
    const valid = mA != null && mB != null && !Number.isNaN(mA) && !Number.isNaN(mB);
    f1A = valid ? mB - mA : 0;
    f1B = valid ? mA - mB : 0;
  }

  // An edit that leaves a recorded draw level stays a draw (S = 0.5 each).
  const isDraw = f1A === 0 && fallbackWinner === 'DRAW';
  const isWinnerA = f1A > 0 ? true : f1A < 0 ? false : fallbackWinner === 'A';
  const eA = expectedScore(ratingA, ratingB);
  const eB = expectedScore(ratingB, ratingA);
  const sA = isDraw ? 0.5 : (isWinnerA ? 1 : 0);
  const sB = isDraw ? 0.5 : (isWinnerA ? 0 : 1);
  // Like pairComputation, the comeback bonus only counts for the winner.
  const changeA = K_FACTOR * (sA - eA) + PPU * (f1A - violA + (comebackA && sA === 1 ? COMEBACK_BONUS : 0));
  const changeB = K_FACTOR * (sB - eB) + PPU * (f1B - violB + (comebackB && sB === 1 ? COMEBACK_BONUS : 0));

  return {
    finalPointsA: round4(ratingA + changeA),
    finalPointsB: round4(ratingB + changeB),
    winner: isDraw ? 'DRAW' : (isWinnerA ? 'A' : 'B'),
  };
}

/* Builds the "which game came first" ordering used by replayScope: the
   fixture's scheduled date/time when the record came from the Match
   Schedule, else the moment it was recorded. */
function scheduleOrder(schedules) {
  const byId = new Map((schedules || []).map((s) => [s.id, s]));
  return (rec) => {
    const s = rec.scheduleId ? byId.get(rec.scheduleId) : null;
    if (s && s.date) {
      const t = new Date(`${s.date}T${s.time || '00:00'}`).getTime();
      if (!Number.isNaN(t)) return t;
    }
    return rec.createdAt || 0;
  };
}

/* Re-runs every record of ONE ranking scope (sport + division) in game order (oldest → newest)
   so a team's rating flows from one game into the next. A saved record keeps
   its own frozen prevPoints, so editing/saving an earlier game would otherwise
   leave later games on a stale baseline (e.g. still 1200) and overwrite the
   live ranking with the earlier game's result. A team's first appearance in
   the scope keeps its stored prevPoints (this preserves ratings carried over
   from other divisions). Returns the refreshed records plus each team's
   latest rating. */
function replayScope(records, scopeKey, orderOf) {
  const inScope = records
    .map((rec, index) => ({ rec, index }))
    .filter(({ rec }) => rankingScopeKey(rec.sportName, rec.category) === scopeKey)
    .sort((a, b) => {
      const oa = orderOf ? orderOf(a.rec) : (a.rec.createdAt || 0);
      const ob = orderOf ? orderOf(b.rec) : (b.rec.createdAt || 0);
      return oa - ob || (a.rec.createdAt || 0) - (b.rec.createdAt || 0) || a.index - b.index;
    });

  /* Each team's starting rating in this scope = what it held going into the
     FIRST game ever recorded for it here (by recording time, not game order),
     so recording a later fixture before an earlier one can't make the live
     rating the earlier game's baseline. Remembered as basePoints so later
     replays keep the same anchor even after prevPoints get rewritten. */
  const seeds = new Map();
  [...inScope]
    .sort((a, b) => (a.rec.createdAt || 0) - (b.rec.createdAt || 0) || a.index - b.index)
    .forEach(({ rec }) => {
      const list = rec.participants && rec.participants.length ? rec.participants : [rec.teamA, rec.teamB];
      list.forEach((p) => {
        if (!p || seeds.has(norm(p.name))) return;
        // Ratings are per sport + division and nothing carries over from other
        // scopes, so a team's first game here always starts at the baseline —
        // never a stored value, which could be a leftover from deleted records.
        seeds.set(norm(p.name), DEFAULT_POINTS);
      });
    });

  const running = new Map(); // norm(name) -> latest rating
  const latest = {};         // name -> latest rating
  const replaced = new Map(); // record id -> refreshed record

  inScope.forEach(({ rec }) => {
    const multi = !!(rec.participants && rec.participants.length);
    const list = multi ? rec.participants : [rec.teamA, rec.teamB];
    const mode = rec.mode || (rec.teamA && rec.teamA.points != null ? 'points' : 'time');
    const rows = list.map((p, i) => ({
      id: p.id || `t${i}`,
      name: p.name,
      score: mode === 'time' ? p.minutes : p.points,
      totalViolations: Number(p.totalViolations) || 0,
      comeback: !!p.comeback,
      prevPoints: running.has(norm(p.name)) ? running.get(norm(p.name)) : seeds.get(norm(p.name)),
    }));
    if (rows.some((r) => r.score == null || Number.isNaN(r.score))) return;

    let winnerOverrideId = null;
    if (multi) {
      const first = list.find((p) => p.place === 1);
      winnerOverrideId = first ? (first.id || null) : null;
    } else if (rec.winner === 'DRAW') {
      winnerOverrideId = 'DRAW';
    } else if (rec.winner === 'A' || rec.winner === 'B') {
      winnerOverrideId = rows[rec.winner === 'A' ? 0 : 1].id;
    }

    const comp = buildComputation({ rows, mode, winnerOverrideId });
    const refreshed = comp.teams.map((t, i) => ({
      ...list[i],
      basePoints: seeds.get(norm(list[i].name)),
      prevPoints: round4(t.prevPoints),
      expected: round4(t.expected),
      f1: round4(t.totalF1),
      change: round4(t.change),
      finalPoints: round4(t.finalPoints),
      place: t.place,
    }));
    refreshed.forEach((p) => {
      running.set(norm(p.name), p.finalPoints);
      latest[p.name] = p.finalPoints;
    });

    const next = { ...rec };
    if (multi) {
      // teamA/teamB are the first two entries, participants are by place.
      const pick = (side) => refreshed.find((p) => norm(p.name) === norm(side.name)) || side;
      next.teamA = { ...rec.teamA, ...pick(rec.teamA) };
      next.teamB = { ...rec.teamB, ...pick(rec.teamB) };
      next.participants = [...refreshed].sort((a, b) => a.place - b.place);
    } else {
      next.teamA = refreshed[0];
      next.teamB = refreshed[1];
    }
    replaced.set(rec.id, next);
  });

  return { records: records.map((r) => replaced.get(r.id) || r), latest };
}

module.exports = {
  replayScope, scheduleOrder,
  K_FACTOR, PPU, COMEBACK_BONUS, DEFAULT_POINTS, LEVEL_LABELS,
  norm, displayCategory, rankingScopeKey, round4,
  pointsInScope, overallRating, expectedScore, signedPerformance, isBetter,
  pairComputation, buildComputation, computeEditFinalPoints,
};
