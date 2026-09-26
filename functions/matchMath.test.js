const test = require('node:test');
const assert = require('node:assert/strict');
const {
  round4,
  replayScope,
  scheduleOrder,
  norm,
  displayCategory,
  rankingScopeKey,
  pointsInScope,
  overallRating,
  expectedScore,
  signedPerformance,
  timeGapMmSs,
  isBetter,
  pairComputation,
  buildComputation,
  computeEditFinalPoints,
} = require('./matchMath');

test('round4 rounds to 4 decimal places', () => {
  assert.equal(round4(1.123456), 1.1235);
  assert.equal(round4(1200), 1200);
});

test('norm lowercases and trims', () => {
  assert.equal(norm('  Team A  '), 'team a');
  assert.equal(norm(null), '');
});

test('displayCategory strips a trailing "N v N" suffix', () => {
  assert.equal(displayCategory('Boys Basketball 5v5'), 'Boys Basketball');
  assert.equal(displayCategory('Chess'), 'Chess');
});

test('rankingScopeKey combines normalized sport and category', () => {
  assert.equal(rankingScopeKey('Basketball', 'Boys 5v5'), 'basketball::boys');
});

test('pointsInScope finds a team case-insensitively', () => {
  const teamMap = { 'Team A': 1200, 'Team B': 1100 };
  assert.equal(pointsInScope(teamMap, 'team a'), 1200);
  assert.equal(pointsInScope(teamMap, 'missing'), null);
  assert.equal(pointsInScope(null, 'team a'), null);
});

test('overallRating averages per-sport averages across scopes', () => {
  const allRankings = {
    'basketball::boys': { 'Team A': 1200, 'Team B': 1000 },
    'volleyball::boys': { 'Team A': 1400 },
  };
  // basketball avg for Team A = 1200, volleyball avg = 1400 -> overall = 1300
  assert.equal(overallRating(allRankings, 'Team A'), 1300);
  assert.equal(overallRating(allRankings, 'Unknown Team'), null);
});

test('expectedScore is 0.5 for equal ratings', () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
});

test('expectedScore favors the higher-rated team', () => {
  assert.ok(expectedScore(1400, 1200) > 0.5);
  assert.ok(expectedScore(1200, 1400) < 0.5);
});

test('signedPerformance flips sign for time mode (lower is better)', () => {
  assert.equal(signedPerformance('points', 50, 30), 20);
  assert.equal(signedPerformance('time', 50, 30), -20);
});

test('isBetter: higher wins for points, lower wins for time', () => {
  assert.equal(isBetter('points', 50, 30), true);
  assert.equal(isBetter('time', 50, 30), false);
});

test('pairComputation: equal ratings and equal scores is a draw (S=0.5, no rating change)', () => {
  const result = pairComputation({
    mode: 'points', ownRating: 1200, oppRating: 1200,
    ownScore: 10, oppScore: 10, violations: 0, comeback: false,
  });
  assert.equal(result.S, 0.5);
  assert.equal(result.change, 0);
});

test('pairComputation: a comeback win adds the comeback bonus to the change', () => {
  const withoutComeback = pairComputation({
    mode: 'points', ownRating: 1200, oppRating: 1200,
    ownScore: 20, oppScore: 10, violations: 0, comeback: false,
  });
  const withComeback = pairComputation({
    mode: 'points', ownRating: 1200, oppRating: 1200,
    ownScore: 20, oppScore: 10, violations: 0, comeback: true,
  });
  assert.ok(withComeback.change > withoutComeback.change);
});

test('buildComputation: higher score wins in points mode and gains rating', () => {
  const { teams, winnerId } = buildComputation({
    mode: 'points',
    rows: [
      { id: 'a', name: 'Team A', score: 20, prevPoints: 1200, totalViolations: 0, comeback: false },
      { id: 'b', name: 'Team B', score: 10, prevPoints: 1200, totalViolations: 0, comeback: false },
    ],
  });
  assert.equal(winnerId, 'a');
  const teamA = teams.find((t) => t.id === 'a');
  const teamB = teams.find((t) => t.id === 'b');
  assert.equal(teamA.place, 1);
  assert.ok(teamA.finalPoints > teamA.prevPoints);
  assert.ok(teamB.finalPoints < teamB.prevPoints);
});

test('buildComputation: winnerOverrideId forces the winner regardless of score', () => {
  const { winnerId } = buildComputation({
    mode: 'points',
    winnerOverrideId: 'b',
    rows: [
      { id: 'a', name: 'Team A', score: 20, prevPoints: 1200, totalViolations: 0, comeback: false },
      { id: 'b', name: 'Team B', score: 10, prevPoints: 1200, totalViolations: 0, comeback: false },
    ],
  });
  assert.equal(winnerId, 'b');
});

test('computeEditFinalPoints: higher points score wins and gains rating', () => {
  const result = computeEditFinalPoints({
    ratingA: 1200, ratingB: 1200,
    violA: 0, violB: 0,
    comebackA: false, comebackB: false,
    isPoints: true, pA: 20, pB: 10, mA: null, mB: null,
    fallbackWinner: 'A',
  });
  assert.equal(result.winner, 'A');
  assert.ok(result.finalPointsA > 1200);
  assert.ok(result.finalPointsB < 1200);
});

test('computeEditFinalPoints: falls back to fallbackWinner on a tie', () => {
  const result = computeEditFinalPoints({
    ratingA: 1200, ratingB: 1200,
    violA: 0, violB: 0,
    comebackA: false, comebackB: false,
    isPoints: true, pA: 10, pB: 10, mA: null, mB: null,
    fallbackWinner: 'B',
  });
  assert.equal(result.winner, 'B');
});

test('computeEditFinalPoints: comeback bonus only applies to the winner', () => {
  const base = {
    ratingA: 1200, ratingB: 1200, violA: 0, violB: 0,
    isPoints: true, pA: 20, pB: 10, mA: null, mB: null, fallbackWinner: 'A',
  };
  const none = computeEditFinalPoints({ ...base, comebackA: false, comebackB: false });
  const withBonus = computeEditFinalPoints({ ...base, comebackA: true, comebackB: false });
  const loserFlag = computeEditFinalPoints({ ...base, comebackA: false, comebackB: true });
  assert.ok(withBonus.finalPointsA > none.finalPointsA);
  assert.equal(loserFlag.finalPointsB, none.finalPointsB);
});

test('replayScope carries a team rating from one game into the next', () => {
  const mk = (id, createdAt, a, b, pa, pb, winner) => ({
    id, createdAt, sportName: 'Basketball', category: 'Men', mode: 'points', winner,
    teamA: { id: a, name: a, points: pa, prevPoints: 1200 },
    teamB: { id: b, name: b, points: pb, prevPoints: 1200 },
    participants: [],
  });
  const recs = [
    mk('r1', 1, 'Fox', 'Blue', 33, 22, 'A'),
    mk('r2', 2, 'Fox', 'Eagles', 33, 43, 'B'), // stored stale: Fox prev 1200
  ];
  const key = rankingScopeKey('Basketball', 'Men');
  const { records, latest } = replayScope(recs, key);
  assert.ok(records[0].teamA.finalPoints > 1200);
  assert.equal(records[1].teamA.prevPoints, records[0].teamA.finalPoints);
  assert.equal(latest.Fox, records[1].teamA.finalPoints);
});

test('replayScope orders by schedule, even when recorded out of order', () => {
  const mk = (id, createdAt, sid, a, b, pa, pb, winner, prevA, prevB) => ({
    id, createdAt, scheduleId: sid, sportName: 'Basketball', category: 'Women', mode: 'points', winner,
    teamA: { id: a, name: a, points: pa, prevPoints: prevA },
    teamB: { id: b, name: b, points: pb, prevPoints: prevB },
    participants: [],
  });
  const schedules = [
    { id: 's1', date: '2026-09-21', time: '06:16' },
    { id: 's2', date: '2026-09-21', time: '08:16' },
  ];
  // s2 (Fox vs Blue, later game) was recorded first at 1200; s1 (Fox vs Eagles, earlier game) recorded second.
  const recs = [
    mk('r2', 1, 's2', 'Fox', 'Blue', 33, 22, 'A', 1200, 1200),
    mk('r1', 2, 's1', 'Fox', 'Eagles', 40, 30, 'A', 1221.5, 1200),
  ];
  const key = rankingScopeKey('Basketball', 'Women');
  const { records } = replayScope(recs, key, scheduleOrder(schedules));
  const r1 = records.find((r) => r.id === 'r1');
  const r2 = records.find((r) => r.id === 'r2');
  assert.equal(r1.teamA.prevPoints, 1200);                    // earlier game starts at the base
  assert.equal(r2.teamA.prevPoints, r1.teamA.finalPoints);    // later game adopts it
});

test('a requested rematch follows the regular game even when dated earlier', () => {
  const mk = (id, createdAt, sid, winner) => ({
    id, createdAt, scheduleId: sid, sportName: 'Basketball', category: 'Women', mode: 'points', winner,
    teamA: { id: 'Fox', name: 'Fox', points: winner === 'A' ? 40 : 30, prevPoints: 1200 },
    teamB: { id: 'Blue', name: 'Blue', points: winner === 'A' ? 30 : 40, prevPoints: 1200 },
    participants: [],
  });
  const schedules = [
    { id: 's1', date: '2026-09-30', time: '08:00' },
    { id: 's2', date: '2026-09-26', time: '08:00', requestId: 'req1', round: null },
  ];
  const recs = [mk('r1', 1, 's1', 'A'), mk('r2', 2, 's2', 'B')];
  const { records } = replayScope(recs, rankingScopeKey('Basketball', 'Women'), scheduleOrder(schedules));
  const r1 = records.find((r) => r.id === 'r1');
  const r2 = records.find((r) => r.id === 'r2');
  assert.equal(r1.teamA.prevPoints, 1200);
  assert.equal(r2.teamA.prevPoints, r1.teamA.finalPoints);
});

test('DRAW sentinel: equal ratings and scores leave both teams unchanged, both place 1st', () => {
  const rows = [
    { id: 'a', name: 'A', score: 11, totalViolations: 0, comeback: false, prevPoints: 1200 },
    { id: 'b', name: 'B', score: 11, totalViolations: 0, comeback: false, prevPoints: 1200 },
  ];
  const comp = require('./matchMath').buildComputation({ rows, mode: 'points', winnerOverrideId: 'DRAW' });
  assert.equal(comp.winnerId, 'DRAW');
  comp.teams.forEach((t) => {
    assert.equal(t.place, 1);
    assert.equal(t.finalPoints, 1200);
  });
});

test('DRAW: the lower-rated team gains and the higher-rated team loses', () => {
  const rows = [
    { id: 'a', name: 'A', score: 5, totalViolations: 0, comeback: false, prevPoints: 1400 },
    { id: 'b', name: 'B', score: 5, totalViolations: 0, comeback: false, prevPoints: 1200 },
  ];
  const comp = require('./matchMath').buildComputation({ rows, mode: 'points', winnerOverrideId: 'DRAW' });
  assert.ok(comp.teams[0].change < 0);
  assert.ok(comp.teams[1].change > 0);
});

test('timeGapMmSs writes a time gap as MM.SS, carrying seconds properly', () => {
  const t = (mm, ss) => mm + ss / 60; // decimal minutes, how times are stored
  assert.equal(timeGapMmSs(t(10, 30) - t(5, 1)), 5.29);   // 5 min 29 s, not 5.4833
  assert.equal(timeGapMmSs(t(15, 25) - t(10, 30)), 4.55); // 4 min 55 s (a borrow), not 4.95
  assert.equal(timeGapMmSs(t(10, 30) - t(10, 50)), -0.2); // sign kept, 20 s
  assert.equal(timeGapMmSs(0), 0);
  assert.equal(signedPerformance('time', t(5, 1), t(10, 30)), 5.29);
  assert.equal(signedPerformance('time', t(10, 30), t(5, 1)), -5.29);
});

test('buildComputation: 4-team timed race matches the hand worksheet (E to 4 decimals, F1 in MM.SS)', () => {
  const t = (mm, ss) => mm + ss / 60;
  const rows = [
    { id: 'P', name: 'Purple Jaguars', score: t(5, 1), totalViolations: 2, comeback: true, prevPoints: 1500 },
    { id: 'O', name: 'Orange Bulldogs', score: t(10, 30), totalViolations: 3, comeback: false, prevPoints: 1400 },
    { id: 'M', name: 'Maroon Owls', score: t(10, 50), totalViolations: 8, comeback: false, prevPoints: 1400 },
    { id: 'Y', name: 'Yellow Vipers', score: t(15, 25), totalViolations: 5, comeback: false, prevPoints: 1300 },
  ];
  const { teams, winnerId } = buildComputation({ rows, mode: 'time', winnerOverrideId: null });
  const by = Object.fromEntries(teams.map((x) => [x.id, x]));
  const gains = (id) => by[id].pairings.map((p) => round4(p.change));
  const gaps = (id) => by[id].pairings.map((p) => p.f1);

  assert.equal(winnerId, 'P');
  assert.deepEqual(teams.map((x) => x.place), [1, 2, 3, 4]);
  // Time differences (F1), MM.SS: 10:30−05:01 = 5.29, 10:50−05:01 = 5.49, 15:25−05:01 = 10.24, …
  assert.deepEqual(gaps('P'), [5.29, 5.49, 10.24]);
  assert.deepEqual(gaps('O'), [-5.29, 0.2, 4.55]);
  assert.deepEqual(gaps('M'), [-5.49, -0.2, 4.35]);
  assert.deepEqual(gaps('Y'), [-10.24, -4.55, -4.35]);
  // Each per-opponent gain: K(S − E) + Ppu(F1 − F2 + F3), with E to 4 decimals.
  assert.deepEqual(gains('P'), [23.1618, 23.2618, 21.8096]);
  assert.deepEqual(gains('O'), [-15.6618, 14.6, 12.2918]);
  assert.deepEqual(gains('M'), [-18.2618, -20.1, 9.6918]);
  assert.deepEqual(gains('Y'), [-15.3096, -16.2918, -16.1918]);
  // Overall change is the sum of the pairings, added once to the previous rating.
  assert.equal(by.P.finalPoints, 1568.2332);
  assert.equal(by.O.finalPoints, 1411.23);
  assert.equal(by.M.finalPoints, 1371.33);
  assert.equal(by.Y.finalPoints, 1252.2068);
  assert.equal(round4(by.P.totalF1), 21.02);
  assert.equal(round4(by.Y.totalF1), -19.14);
});

test('expectedScore is rounded to 4 decimals', () => {
  assert.equal(expectedScore(1500, 1400), 0.6401);
  assert.equal(expectedScore(1400, 1500), 0.3599);
});
