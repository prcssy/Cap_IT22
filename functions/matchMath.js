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

function buildComputation({ rows, mode, winnerOverrideId }) {
  const ordered = [...rows].sort((a, b) => {
    if (winnerOverrideId) {
      if (a.id === winnerOverrideId && b.id !== winnerOverrideId) return -1;
      if (b.id === winnerOverrideId && a.id !== winnerOverrideId) return 1;
    }
    return mode === 'points' ? b.score - a.score : a.score - b.score;
  });
  const placeById = {};
  ordered.forEach((r, i) => { placeById[r.id] = i + 1; });

  const teams = rows.map((t) => {
    const opponents = rows.filter((o) => o.id !== t.id);
    const pairings = opponents.map((o) => {
      const sOverride = winnerOverrideId && (t.id === winnerOverrideId || o.id === winnerOverrideId)
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

  const winnerId = winnerOverrideId
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

  const isWinnerA = f1A > 0 ? true : f1A < 0 ? false : fallbackWinner === 'A';
  const eA = expectedScore(ratingA, ratingB);
  const eB = expectedScore(ratingB, ratingA);
  const changeA = K_FACTOR * ((isWinnerA ? 1 : 0) - eA) + PPU * (f1A - violA + (comebackA ? COMEBACK_BONUS : 0));
  const changeB = K_FACTOR * ((!isWinnerA ? 1 : 0) - eB) + PPU * (f1B - violB + (comebackB ? COMEBACK_BONUS : 0));

  return {
    finalPointsA: round4(ratingA + changeA),
    finalPointsB: round4(ratingB + changeB),
    winner: isWinnerA ? 'A' : 'B',
  };
}

module.exports = {
  K_FACTOR, PPU, COMEBACK_BONUS, DEFAULT_POINTS, LEVEL_LABELS,
  norm, displayCategory, rankingScopeKey, round4,
  pointsInScope, overallRating, expectedScore, signedPerformance, isBetter,
  pairComputation, buildComputation, computeEditFinalPoints,
};
