import { describe, it, expect } from 'vitest';
import { coachDivisionOptions, coachHandles } from './coachScope';

const archery = {
  name: 'Archery',
  categoryGroups: [
    { id: 'g1', label: 'Women', divisions: [{ id: 'd30', name: '30 Meters' }, { id: 'd50', name: '50 Meters' }] },
    { id: 'g2', label: 'Men', divisions: [{ id: 'dm', name: 'Men' }] },
  ],
};

describe('coachDivisionOptions', () => {
  it('lists real divisions, and categories without divisions', () => {
    expect(coachDivisionOptions(archery)).toEqual([
      { key: 'archery::d:d30', label: 'Women · 30 Meters' },
      { key: 'archery::d:d50', label: 'Women · 50 Meters' },
      { key: 'archery::c:men', label: 'Men' },
    ]);
  });
});

describe('coachHandles', () => {
  const coach = { teams: ['Purple Jaguars'], sports: ['Archery', 'Chess'], divisions: ['archery::d:d30', 'archery::c:men'] };
  const reg = (extra) => ({ teamName: 'Purple Jaguars', sport: 'Archery', ...extra });

  it('matches a picked division or category', () => {
    expect(coachHandles(coach, reg({ divisionId: 'd30' }))).toBe(true);
    expect(coachHandles(coach, reg({ category: 'MEN' }))).toBe(true);
  });

  it('rejects a division the coach did not pick', () => {
    expect(coachHandles(coach, reg({ divisionId: 'd50' }))).toBe(false);
  });

  it('a sport with no division picks is handled in full', () => {
    expect(coachHandles(coach, reg({ sport: 'Chess', category: 'Women' }))).toBe(true);
  });

  it('respects team and sport', () => {
    expect(coachHandles(coach, reg({ teamName: 'Red Rhinos', divisionId: 'd30' }))).toBe(false);
    expect(coachHandles(coach, reg({ sport: 'Basketball' }))).toBe(false);
  });

  it('older coaches without divisions keep handling everything', () => {
    expect(coachHandles({ teams: ['Purple Jaguars'], sports: ['Archery'] }, reg({ divisionId: 'd50' }))).toBe(true);
  });
});
