import { describe, it, expect, vi } from 'vitest';

// savedBracket.js reaches bracketSlotsFor through firestoreService, which
// imports the real Firebase init — stub it like firestoreService.test.js.
vi.mock('../firebase', () => ({ db: undefined, auth: undefined, functions: undefined }));

const { savedSlotRef, savedBracketResolved } = await import('./savedBracket.js');

// Volleyball FEMALE after Match 1 (UB-SF1): Green Sultan beat Black Beetles.
const matches = [
  { id: 'sf1', stage: 'Upper Bracket – Semifinals', matchLabel: 'UB-SF1', teamA: 'Black Beetles', teamB: 'Green Sultan' },
  { id: 'sf2', stage: 'Upper Bracket – Semifinals', matchLabel: 'UB-SF2', teamA: 'Red Datu', teamB: 'Yellow Rajah' },
  { id: 'ubf', stage: 'Upper Bracket – Finals', matchLabel: 'UB-Finals',
    teamA: 'Green Sultan', teamAFrom: { matchId: 'sf1', result: 'winner' }, teamB: 'Winner SF2' },
  { id: 'lb1', stage: 'Lower Bracket – Round 1', matchLabel: 'LB1',
    teamA: 'Black Beetles', teamAFrom: { matchId: 'sf1', result: 'loser' }, teamB: 'Loser UB-SF2' },
];
const byId = new Map(matches.map((m) => [m.id, m]));

describe('savedSlotRef', () => {
  it('rebuilds the original placeholder of a filled slot, so the tree stays connected', () => {
    expect(savedSlotRef(matches[2], 'A', byId)).toBe('Winner SF1');
    expect(savedSlotRef(matches[3], 'A', byId)).toBe('Loser UB-SF1');
  });

  it('keeps unfilled placeholders and first-round teams as they are', () => {
    expect(savedSlotRef(matches[2], 'B', byId)).toBe('Winner SF2');
    expect(savedSlotRef(matches[0], 'A', byId)).toBe('Black Beetles');
  });
});

describe('savedBracketResolved', () => {
  it('maps each filled placeholder to the team now holding it', () => {
    const resolved = savedBracketResolved(matches);
    expect(resolved['Winner SF1']).toBe('Green Sultan');
    expect(resolved['Loser UB-SF1']).toBe('Black Beetles');
    expect(resolved['Winner SF2']).toBeUndefined(); // Match 2 not played yet
  });

  it("also answers to the tree's own key for the upper-bracket final", () => {
    const gf = { id: 'gf', stage: 'Grand Final', matchLabel: 'GF',
      teamA: 'Green Sultan', teamAFrom: { matchId: 'ubf', result: 'winner' }, teamB: 'Winner LB-F' };
    const resolved = savedBracketResolved([...matches, gf]);
    expect(resolved['Winner UB-F']).toBe('Green Sultan');
    expect(resolved['Winner Finals']).toBe('Green Sultan');
  });
});
