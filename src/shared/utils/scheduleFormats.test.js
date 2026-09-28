import { describe, it, expect, vi } from 'vitest';

/* End-to-end checks of the five Match Schedules formats, run on the SAME
   code the app uses at each step:
     generate + save  buildScheduleMatches   (AdminSchedulePage "Save Generated Schedule")
     record + advance applyBracketResult     (firestoreService, after every confirmed result)
     who can be played isPlaceholderTeam     (Moderator: "Waiting" until both teams are known)
     champion         decidingMatch / roundRobinLeader / raceWinnerName (Match Schedules page)
     bracket drawing  savedBracketResolved   (Admin + Match Schedules bracket trees)
     corrections      planBracketSwap        (Moderator: editing a result flips the winner)
     reset            planResultsReset       (Moderator: "Reset results")
   Each tournament is played out match by match, only ever picking a fixture
   whose two teams are already known — exactly what a moderator can do. */

vi.mock('../firebase', () => ({ db: undefined, auth: undefined, functions: undefined }));

const svc = await import('../services/firestoreService.js');
const { buildScheduleMatches, decidingMatch, roundRobinLeader, generateDoubleBracket } = await import('./scheduleFormats.js');
const { isRaceMatch, raceParticipants, raceWinnerName, RACE_FORMAT_ID } = await import('./raceFormat.js');
const { savedBracketResolved } = await import('./savedBracket.js');

const teams = (n) => Array.from({ length: n }, (_, i) => ({ name: `Team ${i + 1}`, logo: null }));
const num = (name) => Number(String(name).replace('Team ', ''));

function generate(formatId, n) {
  let seq = 0;
  const buildMatch = (extra) => ({
    id: `m${++seq}`, sport: 'Basketball', category: 'MALE', divisionId: 'd1',
    format: formatId, status: 'scheduled', source: 'generated', ...extra,
  });
  return buildScheduleMatches(formatId, teams(n), buildMatch);
}

// A saved 1v1 result, shaped like submitMatchRecord's.
function result(match, winner) {
  return {
    id: `r-${match.id}`, scheduleId: match.id, sportName: match.sport, category: match.category, winner,
    teamA: { name: match.teamA, points: winner === 'A' ? 10 : 5 },
    teamB: { name: match.teamB, points: winner === 'B' ? 10 : 5 },
  };
}
const winnerOf = (r) => (r.winner === 'A' ? r.teamA.name : r.winner === 'B' ? r.teamB.name : null);
const loserOf = (r) => (r.winner === 'A' ? r.teamB.name : r.winner === 'B' ? r.teamA.name : null);

// Seeded pseudo-random, so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/* Plays every fixture that becomes playable, advancing after each result,
   like a moderator working through the list. */
function playAll(matches, pickWinner) {
  const records = [];
  for (let guard = 0; guard < 1000; guard += 1) {
    const done = new Set(records.map((r) => r.scheduleId));
    const next = matches.find((m) => !done.has(m.id)
      && !svc.isPlaceholderTeam(m.teamA) && !svc.isPlaceholderTeam(m.teamB));
    if (!next) break;
    const rec = result(next, pickWinner(next));
    records.push(rec);
    matches = svc.applyBracketResult(matches, rec);
  }
  return { matches, records };
}
const resultFor = (records) => (m) => records.find((r) => r.scheduleId === m.id) || null;
const favourite = (m) => (num(m.teamA) < num(m.teamB) ? 'A' : 'B'); // lower number always wins
const underdog = (m) => (num(m.teamA) > num(m.teamB) ? 'A' : 'B');  // higher number always wins

const lossCounts = (records) => {
  const losses = {};
  records.forEach((r) => { const l = loserOf(r); losses[l] = (losses[l] || 0) + 1; });
  return losses;
};

/* ───────────────────────── Round-robin / double ───────────────────────── */
describe.each([2, 3, 4, 5, 6, 7, 8, 9])('Round-robin with %i teams', (n) => {
  it('pairs every two teams exactly once, never a team with itself or a BYE', () => {
    const matches = generate('single-rr', n);
    expect(matches).toHaveLength((n * (n - 1)) / 2);
    const pairs = new Set(matches.map((m) => [m.teamA, m.teamB].sort().join('|')));
    expect(pairs.size).toBe(matches.length);
    matches.forEach((m) => {
      expect(m.teamA).not.toBe(m.teamB);
      expect([m.teamA, m.teamB]).not.toContain('BYE');
      expect(m.stage).toBeUndefined(); // never mistaken for a bracket
    });
  });

  it('crowns nobody until every game is played, then the team with most wins', () => {
    const matches = generate('single-rr', n);
    const { records } = playAll(matches, favourite);
    expect(records).toHaveLength(matches.length);      // every game was playable
    expect(roundRobinLeader(matches, resultFor(records.slice(0, -1)), winnerOf)).toBeNull();
    expect(roundRobinLeader(matches, resultFor(records), winnerOf)).toBe('Team 1');
    expect(decidingMatch(matches)).toBeNull();          // not a bracket
    // Nothing to advance in a round-robin: fixtures never change.
    expect(playAll(matches, favourite).matches).toEqual(matches);
  });
});

describe.each([2, 3, 4, 5, 6])('Double round-robin with %i teams', (n) => {
  it('pairs every two teams twice, once each way round', () => {
    const matches = generate('double-rr', n);
    expect(matches).toHaveLength(n * (n - 1));
    const ordered = new Set(matches.map((m) => `${m.teamA}>${m.teamB}`));
    expect(ordered.size).toBe(matches.length);          // A-vs-B and B-vs-A both present, no repeats
  });

  it('a level head-to-head record means no champion yet (TBA)', () => {
    if (n !== 2) return;
    const matches = generate('double-rr', 2);
    const records = [result(matches[0], 'A'), result(matches[1], 'A')]; // one win each
    expect(roundRobinLeader(matches, resultFor(records), winnerOf)).toBeNull();
  });
});

/* ───────────────────────── Single bracket ───────────────────────── */
describe.each([2, 3, 4, 5, 6, 7, 8, 11, 16])('Single bracket with %i teams', (n) => {
  it('needs exactly n − 1 games, and every one becomes playable', () => {
    const matches = generate('bracket', n);
    expect(matches).toHaveLength(n - 1);
    const { matches: after, records } = playAll(matches, favourite);
    expect(records).toHaveLength(n - 1);
    after.forEach((m) => {
      expect(svc.isPlaceholderTeam(m.teamA)).toBe(false);
      expect(svc.isPlaceholderTeam(m.teamB)).toBe(false);
      expect(m.teamA).not.toBe(m.teamB);
    });
  });

  it.each([['favourites', favourite], ['upsets', underdog]])('knocks every team out once except the champion (%s)', (_, pick) => {
    const { matches, records } = playAll(generate('bracket', n), pick);
    const losses = lossCounts(records);
    const final = decidingMatch(matches);
    const champion = winnerOf(resultFor(records)(final));
    expect(champion).toBe(pick === favourite ? 'Team 1' : `Team ${n}`);
    expect(losses[champion]).toBeUndefined();
    expect(Object.keys(losses)).toHaveLength(n - 1);
    Object.values(losses).forEach((c) => expect(c).toBe(1));
  });

  it('shows no champion while only the semifinals are played', () => {
    if (n < 4) return;
    const matches = generate('bracket', n);
    const final = decidingMatch(matches);
    const { records } = playAll(matches, favourite);
    const withoutFinal = records.filter((r) => r.scheduleId !== final.id);
    expect(resultFor(withoutFinal)(final)).toBeNull();
    expect(final.stage).toBe('Finals');
  });

  it('"Reset results" puts the bracket back exactly as generated', () => {
    const generated = generate('bracket', n);
    const { matches: played } = playAll(generated, favourite);
    const reset = svc.planResultsReset(played, 'Basketball', 'MALE', 'd1');
    expect(reset.map(({ teamA, teamB }) => [teamA, teamB])).toEqual(generated.map(({ teamA, teamB }) => [teamA, teamB]));
  });
});

/* ───────────────────────── Double bracket ───────────────────────── */
describe.each([3, 4, 5, 6, 7, 8, 12, 16])('Double bracket with %i teams', (n) => {
  it('saves the advertised number of games, and every one becomes playable', () => {
    const matches = generate('double-bracket', n);
    expect(matches).toHaveLength(generateDoubleBracket(teams(n).map((t) => t.name)).totalMatches);
    const { matches: after, records } = playAll(matches, favourite);
    expect(records).toHaveLength(matches.length);
    after.forEach((m) => {
      expect(svc.isPlaceholderTeam(m.teamA)).toBe(false);
      expect(svc.isPlaceholderTeam(m.teamB)).toBe(false);
      expect(m.teamA).not.toBe(m.teamB);
    });
  });

  it.each([1, 2, 3, 4, 5])('two losses eliminate; only the Grand Final loser may have one (random run %i)', (seed) => {
    const rand = rng(seed * 7919 + n);
    const { matches, records } = playAll(generate('double-bracket', n), () => (rand() < 0.5 ? 'A' : 'B'));
    const losses = lossCounts(records);
    const gf = decidingMatch(matches);
    expect(gf.stage).toBe('Grand Final');
    const gfResult = resultFor(records)(gf);
    const champion = winnerOf(gfResult);

    // Everyone except the champion lost at least once; the champion has 0
    // losses (came through the upper bracket) or 1 (came up the lower one).
    teams(n).forEach(({ name }) => { if (name !== champion) expect(losses[name]).toBeGreaterThanOrEqual(1); });
    expect(losses[champion] || 0).toBeLessThanOrEqual(1);
    Object.entries(losses).forEach(([team, c]) => {
      expect(c).toBeLessThanOrEqual(2);
      if (team !== champion && team !== loserOf(gfResult)) expect(c).toBe(2); // eliminated twice
    });

    // Nobody plays again after their second loss.
    const out = new Set();
    const count = {};
    records.forEach((r) => {
      expect(out.has(r.teamA.name)).toBe(false);
      expect(out.has(r.teamB.name)).toBe(false);
      const l = loserOf(r);
      count[l] = (count[l] || 0) + 1;
      if (count[l] === 2) out.add(l);
    });
  });

  it('upper-bracket losers drop into the lower bracket; the lower bracket feeds the Grand Final', () => {
    const { matches, records } = playAll(generate('double-bracket', n), favourite);
    const byId = new Map(matches.map((m) => [m.id, m]));
    records.forEach((r) => {
      const src = byId.get(r.scheduleId);
      if (!src.stage.startsWith('Upper Bracket')) return;
      // Its loser shows up in a Lower Bracket fixture fed by this match (unless it's the only UB game).
      const droppedTo = matches.find((m) => ['A', 'B'].some((s) => m[`team${s}From`]?.matchId === src.id
        && m[`team${s}From`].result === 'loser'));
      if (droppedTo) {
        expect(droppedTo.stage.startsWith('Lower Bracket')).toBe(true);
        expect([droppedTo.teamA, droppedTo.teamB]).toContain(loserOf(r));
      }
    });
    const gf = decidingMatch(matches);
    expect(gf.teamAFrom?.result).toBe('winner');
    expect(gf.teamBFrom?.result).toBe('winner');
  });

  it('the bracket drawing resolves every filled slot to its real team', () => {
    const { matches } = playAll(generate('double-bracket', n), favourite);
    const resolved = savedBracketResolved(matches);
    matches.forEach((m) => ['A', 'B'].forEach((s) => {
      if (!m[`team${s}From`]) return;
      expect(Object.values(resolved)).toContain(m[`team${s}`]);
    }));
  });

  it('"Reset results" puts the bracket back exactly as generated', () => {
    const generated = generate('double-bracket', n);
    const { matches: played } = playAll(generated, () => 'B');
    const reset = svc.planResultsReset(played, 'Basketball', 'MALE', 'd1');
    expect(reset.map(({ teamA, teamB }) => [teamA, teamB])).toEqual(generated.map(({ teamA, teamB }) => [teamA, teamB]));
    reset.forEach((m) => { expect(m.teamAFrom).toBeUndefined(); expect(m.teamBFrom).toBeUndefined(); });
  });

  it('correcting an upper-bracket result gives the same bracket as if it had gone the other way', () => {
    const generated = generate('double-bracket', n);
    const first = generated.find((m) => m.stage.startsWith('Upper Bracket') && m.round === 1);
    // Recorded as A winning, then corrected to B …
    const asA = svc.applyBracketResult(generated, result(first, 'A'));
    const corrected = svc.planBracketSwap(asA, first.id, first.teamA, first.teamB).matches;
    // … must match recording B as the winner in the first place.
    const asB = svc.applyBracketResult(generated, result(first, 'B'));
    const slots = (list) => list.map(({ id, teamA, teamB }) => ({ id, teamA, teamB }));
    expect(slots(corrected)).toEqual(slots(asB));
  });
});

/* ───────────────────────── Single race ───────────────────────── */
describe.each([2, 3, 5, 8])('Single race with %i teams', (n) => {
  it('is ONE fixture holding the whole field, never read as a bracket', () => {
    const matches = generate(RACE_FORMAT_ID, n);
    expect(matches).toHaveLength(1);
    const [race] = matches;
    expect(isRaceMatch(race)).toBe(n >= 2);
    expect(race.stage).toBeUndefined();
    expect(raceParticipants(race).map((p) => p.name)).toEqual(teams(n).map((t) => t.name));
    expect(decidingMatch(matches)).toBeNull();
    // Recording it never touches any fixture (nothing to advance).
    expect(svc.applyBracketResult(matches, { scheduleId: race.id, winner: 'A', teamA: { name: race.teamA }, teamB: { name: race.teamB } })).toEqual(matches);
  });

  it('the first-placed team is the champion; a tie for first is TBA', () => {
    if (n < 3) return;
    const [race] = generate(RACE_FORMAT_ID, n);
    const places = raceParticipants(race).map((p, i) => ({ name: p.name, place: n - i, minutes: 10 + i }));
    expect(raceWinnerName({ scheduleId: race.id, participants: places })).toBe(`Team ${n}`);
    const tied = places.map((p) => ({ ...p, place: p.place <= 2 ? 1 : p.place }));
    expect(raceWinnerName({ scheduleId: race.id, participants: tied })).toBeNull();
  });
});
