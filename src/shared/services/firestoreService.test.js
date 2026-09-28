import { describe, it, expect, vi } from 'vitest';

// firestoreService.js imports the real Firebase init (which touches
// `window`/env config) purely as a side effect of the module graph — the
// functions under test here never call Firestore, so we stub it out instead
// of pulling in jsdom/real Firebase just to satisfy that import.
vi.mock('../firebase', () => ({
  db: undefined,
  auth: undefined,
  functions: undefined,
}));

const {
  getEventKey, getEventLabel, EVENT_TYPES, withCurrentLogos, isSingleBracketMatch, laterBracketMatchesWith,
  bracketSlotsFor, planBracketSwap, isPlaceholderTeam, planResultsReset,
} = await import('./firestoreService.js');

describe('planResultsReset', () => {
  // Badminton MALE (1 v 1) single bracket: SF1 and SF2 played, Finals filled —
  // Finals' Green Sultan was advanced before slots remembered their source.
  const set = { sport: 'Badminton', category: 'MALE (1 v 1)', divisionId: 'd1' };
  const matches = [
    { ...set, id: 'sf1', stage: 'Semifinals', round: 1, matchLabel: 'SF1', teamA: 'Black Beetles', teamB: 'Green Sultan', finished: true },
    { ...set, id: 'sf2', stage: 'Semifinals', round: 1, matchLabel: 'SF2', teamA: 'Red Datu', teamB: 'Yellow Rajah', extraMinutes: 15 },
    { ...set, id: 'fin', stage: 'Finals', round: 2, matchLabel: 'Finals',
      teamA: 'Green Sultan', teamALogo: 'data:x',
      teamB: 'Yellow Rajah', teamBFrom: { matchId: 'sf2', result: 'winner' } },
    { id: 'other', sport: 'Basketball', category: 'MALE', teamA: 'Green Sultan', teamB: 'Red Datu', finished: true },
  ];
  const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));

  it('puts filled bracket slots back to their placeholders', () => {
    const next = byId(planResultsReset(matches, set.sport, set.category, set.divisionId));
    expect(next.fin.teamA).toBe('Winner SF1'); // name-based fallback
    expect(next.fin.teamB).toBe('Winner SF2'); // from the remembered source
    expect(next.fin.teamALogo).toBeNull();
    expect(next.fin.teamBFrom).toBeUndefined();
  });

  it('keeps round-1 teams and clears finished / added time', () => {
    const next = byId(planResultsReset(matches, set.sport, set.category, set.divisionId));
    expect(next.sf1.teamA).toBe('Black Beetles');
    expect(next.sf1.finished).toBeUndefined();
    expect(next.sf2.extraMinutes).toBeUndefined();
  });

  it('never touches another sport or division', () => {
    const next = byId(planResultsReset(matches, set.sport, set.category, set.divisionId));
    expect(next.other).toEqual(matches[3]);
  });
});

describe('getEventKey', () => {
  it('resolves by exact key', () => {
    expect(getEventKey('sportsfest')).toBe('sportsfest');
  });

  it('resolves by display label, case-insensitively', () => {
    expect(getEventKey('Prisaa')).toBe('prisaa');
    expect(getEventKey('INTRAMURALS')).toBe('intramurals');
  });

  it('returns an empty string for an unknown value', () => {
    expect(getEventKey('not-a-real-event')).toBe('');
  });

  it('returns an empty string for falsy input', () => {
    expect(getEventKey('')).toBe('');
    expect(getEventKey(null)).toBe('');
    expect(getEventKey(undefined)).toBe('');
  });

  it('resolves against a custom event list when one is passed', () => {
    const customList = [{ key: 'custom', label: 'Custom Event' }];
    expect(getEventKey('Custom Event', customList)).toBe('custom');
    expect(getEventKey('sportsfest', customList)).toBe('');
  });
});

describe('getEventLabel', () => {
  it('resolves the display label from a key', () => {
    expect(getEventLabel('prisaa')).toBe('Prisaa');
  });

  it('resolves the display label from an already-correct label', () => {
    expect(getEventLabel('Intramurals')).toBe('Intramurals');
  });

  it('returns an empty string when nothing matches', () => {
    expect(getEventLabel('unknown')).toBe('');
  });
});

describe('withCurrentLogos', () => {
  const teams = [
    { name: 'Black Beetles', logo: 'data:new-beetles' },
    { name: 'Red Datu', logo: 'data:new-datu' },
    { name: 'No Logo Team' },
  ];

  it("replaces a match's stored logo copies with the team's current logo", () => {
    const [m] = withCurrentLogos([
      { teamA: 'black beetles', teamALogo: 'data:old', teamB: 'Red Datu', teamBLogo: null },
    ], teams);
    expect(m.teamALogo).toBe('data:new-beetles');
    expect(m.teamBLogo).toBe('data:new-datu');
  });

  it('keeps the stored copy when the team has no current logo or is gone', () => {
    const [m] = withCurrentLogos([
      { teamA: 'No Logo Team', teamALogo: 'data:old-a', teamB: 'Deleted Team', teamBLogo: 'data:old-b' },
    ], teams);
    expect(m.teamALogo).toBe('data:old-a');
    expect(m.teamBLogo).toBe('data:old-b');
  });

  it('updates race participants too', () => {
    const [m] = withCurrentLogos([
      { race: true, teamA: 'Red Datu', teamB: 'X', participants: [{ name: 'Red Datu', logo: 'data:old' }, { name: 'X', logo: 'data:x' }] },
    ], teams);
    expect(m.participants).toEqual([{ name: 'Red Datu', logo: 'data:new-datu' }, { name: 'X', logo: 'data:x' }]);
  });
});

describe('laterBracketMatchesWith', () => {
  const qf1 = { id: 'qf1', sport: 'Basketball', category: 'MALE', divisionId: 'd1', stage: 'Quarterfinals', round: 1, matchLabel: 'QF1', teamA: 'Black Beetles', teamB: 'Red Datu' };
  const matches = [
    qf1,
    { id: 'qf2', sport: 'Basketball', category: 'MALE', divisionId: 'd1', stage: 'Quarterfinals', round: 1, teamA: 'Green Sultan', teamB: 'Yellow Rajah' },
    { id: 'sf1', sport: 'Basketball', category: 'MALE', divisionId: 'd1', stage: 'Semifinals', round: 2, teamA: 'Black Beetles', teamB: 'Green Sultan' },
    { id: 'fin', sport: 'Basketball', category: 'MALE', divisionId: 'd1', stage: 'Finals', round: 3, teamA: 'black beetles', teamB: 'Winner SF2' },
    // Same team elsewhere — must never be touched:
    { id: 'other-division', sport: 'Basketball', category: 'MALE', divisionId: 'd2', stage: 'Semifinals', round: 2, teamA: 'Black Beetles', teamB: 'X' },
    { id: 'other-sport', sport: 'Badminton', category: 'MALE', stage: 'Semifinals', round: 2, teamA: 'Black Beetles', teamB: 'X' },
    { id: 'round-robin', sport: 'Basketball', category: 'MALE', divisionId: 'd1', round: 2, teamA: 'Black Beetles', teamB: 'X' },
    { id: 'double', sport: 'Basketball', category: 'MALE', divisionId: 'd1', stage: 'Upper Bracket – Semifinals', round: 2, teamA: 'Black Beetles', teamB: 'X' },
  ];

  it('finds every later round of the same bracket that lists the team', () => {
    expect(laterBracketMatchesWith(matches, qf1, 'Black Beetles').map((m) => m.id)).toEqual(['sf1', 'fin']);
  });

  it('ignores other divisions, sports, round-robin and double-elimination fixtures', () => {
    const ids = laterBracketMatchesWith(matches, qf1, 'Black Beetles').map((m) => m.id);
    ['other-division', 'other-sport', 'round-robin', 'double'].forEach((id) => expect(ids).not.toContain(id));
  });

  it('classifies only single-elimination stages as brackets', () => {
    expect(isSingleBracketMatch({ stage: 'Semifinals' })).toBe(true);
    expect(isSingleBracketMatch({ stage: 'Grand Final' })).toBe(false);
    expect(isSingleBracketMatch({ stage: 'Lower Bracket – Round 1' })).toBe(false);
    expect(isSingleBracketMatch({})).toBe(false);
  });
});

describe('bracketSlotsFor', () => {
  // Placeholder texts must match AdminSchedulePage's generators exactly.
  it('single elimination sends only the winner on', () => {
    expect(bracketSlotsFor({ stage: 'Quarterfinals', matchLabel: 'QF1' })).toEqual({ winner: ['Winner QF1'], loser: [] });
  });

  it('upper bracket sends the winner up and the loser down', () => {
    const s = bracketSlotsFor({ stage: 'Upper Bracket – Semifinals', matchLabel: 'UB-SF2' });
    expect(s.winner).toContain('Winner SF2');
    expect(s.loser).toContain('Loser UB-SF2');
  });

  it('upper bracket final feeds the Grand Final and the Losers Final', () => {
    const s = bracketSlotsFor({ stage: 'Upper Bracket – Finals', matchLabel: 'UB-Finals' });
    expect(s.winner).toContain('Winner UB-F');
    expect(s.loser).toContain('Loser UB-F');
  });

  it('a lower-bracket loser is eliminated; the Grand Final feeds nothing', () => {
    expect(bracketSlotsFor({ stage: 'Lower Bracket – Round 1', matchLabel: 'LB1' })).toEqual({ winner: ['Winner LB1'], loser: [] });
    expect(bracketSlotsFor({ stage: 'Grand Final', matchLabel: 'GF' })).toEqual({ winner: [], loser: [] });
  });

  it('recognises unfilled slots', () => {
    expect(isPlaceholderTeam('Loser UB-SF1')).toBe(true);
    expect(isPlaceholderTeam('Winner LB-F')).toBe(true);
    expect(isPlaceholderTeam('Black Beetles')).toBe(false);
  });
});

describe('planBracketSwap', () => {
  // UB-F was recorded as Beetles beating Datu: Beetles went to the Grand
  // Final, Datu dropped to the Losers Final, won it, and reached the GF too.
  const from = (matchId, result) => ({ matchId, result });
  const matches = [
    { id: 'ubf', teamA: 'Black Beetles', teamB: 'Red Datu' },
    { id: 'lbf', teamA: 'Green Sultan', teamB: 'Red Datu', teamBFrom: from('ubf', 'loser') },
    { id: 'gf', teamA: 'Black Beetles', teamAFrom: from('ubf', 'winner'), teamB: 'Red Datu', teamBFrom: from('lbf', 'winner') },
  ];

  it('swaps winner and loser along every slot the old result filled', () => {
    const { matches: next, renames } = planBracketSwap(matches, 'ubf', 'Black Beetles', 'Red Datu');
    const byId = Object.fromEntries(next.map((m) => [m.id, m]));
    expect(byId.lbf.teamB).toBe('Black Beetles');      // Beetles drops down instead
    expect(byId.gf.teamA).toBe('Red Datu');            // Datu goes straight to the GF
    expect(byId.gf.teamB).toBe('Black Beetles');       // …and the LB-F winner slot follows the rename
    expect(byId.ubf).toEqual(matches[0]);              // the corrected match itself is untouched
    expect(renames).toHaveLength(3);
  });

  it('never flips a slot twice when both teams meet again', () => {
    const { matches: next } = planBracketSwap(matches, 'ubf', 'Black Beetles', 'Red Datu');
    const gf = next.find((m) => m.id === 'gf');
    expect(gf.teamA).not.toBe(gf.teamB);
  });

  it('leaves fixtures with no link to the corrected match alone', () => {
    const unrelated = [...matches, { id: 'x', teamA: 'Black Beetles', teamB: 'Red Datu' }];
    const { matches: next } = planBracketSwap(unrelated, 'ubf', 'Black Beetles', 'Red Datu');
    expect(next.find((m) => m.id === 'x')).toEqual({ id: 'x', teamA: 'Black Beetles', teamB: 'Red Datu' });
  });
});

describe('EVENT_TYPES', () => {
  it('is the single source of truth with the 3 known events', () => {
    expect(EVENT_TYPES.map((e) => e.key)).toEqual(['intramurals', 'sportsfest', 'prisaa']);
  });
});
