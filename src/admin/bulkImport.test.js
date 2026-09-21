import { describe, it, expect } from 'vitest';
import { buildImport, resolveFormat } from './bulkImport';

describe('resolveFormat', () => {
  it('accepts ids, labels and loose hints', () => {
    expect(resolveFormat('single-time')).toBe('single-time');
    expect(resolveFormat('1 vs Many (Point Basis)')).toBe('team-play');
    expect(resolveFormat('time')).toBe('single-time');
    expect(resolveFormat('')).toBe('');
    expect(resolveFormat('gibberish')).toBe(null);
  });
});

describe('blank sport cells', () => {
  it('continue the sport from the row above', () => {
    const plan = buildImport({ sportRows: [
      { sport: 'Volleyball', category: 'Men', division: 'Senior', format: '1 vs 1 (Point Basis)', positions: 'Setter', violations: '' },
      { sport: '', category: 'Men', division: 'Junior', format: '1 vs 1 (Point Basis)', positions: '', violations: '' },
      { sport: '', category: 'Women', division: 'Senior', format: '1 vs 1 (Point Basis)', positions: '', violations: '' },
    ] });
    expect(plan.sports).toHaveLength(1);
    expect(plan.sports[0].categoryGroups.map(g => [g.label, g.divisions.length])).toEqual([['MEN', 2], ['WOMEN', 1]]);
  });
});

describe('buildImport', () => {
  const sportRows = [
    { sport: '', category: 'X', division: '', format: '', positions: '', violations: '' },
    { sport: 'Basketball', category: 'male', division: 'Senior', format: '1 vs 1 (Point Basis)', positions: 'Guard, Forward', violations: 'Foul' },
    { sport: 'basketball', category: 'Female', division: 'Senior', format: 'point', positions: '', violations: '' },
  ];
  const teamRows = [
    { team: 'Red', sports: 'Basketball, Chess' },
    { team: 'Blue', sports: 'ALL' },
  ];

  it('groups divisions per sport and category, and warns on bad rows', () => {
    const plan = buildImport({ sportRows, teamRows });
    expect(plan.sports).toHaveLength(1);
    expect(plan.sports[0].categoryGroups.map(g => g.label)).toEqual(['MALE', 'FEMALE']);
    expect(plan.sports[0].positions).toEqual(['Guard', 'Forward']);
    expect(plan.warnings.some(w => /no sport name/.test(w))).toBe(true);
    expect(plan.warnings.some(w => /"Chess"/.test(w))).toBe(true);
  });

  it('assigns teams, expanding ALL', () => {
    const plan = buildImport({ sportRows, teamRows });
    expect(plan.teams.find(t => t.name === 'Red').sportIds).toEqual(['Basketball']);
    expect(plan.teams.find(t => t.name === 'Blue').sportIds).toEqual(['Basketball']);
  });

  it('updates existing entries in place, keeping id and logo', () => {
    const plan = buildImport({
      sportRows,
      existingSports: [{ id: 's1', name: 'BASKETBALL', logo: 'data:x', categoryGroups: [], violations: [], positions: [] }],
      existingTeams: [{ id: 't1', name: 'red', logo: 'data:y', sportIds: ['Chess'], color: '#000' }],
      teamRows,
    });
    expect(plan.sports).toHaveLength(1);
    expect(plan.sports[0]).toMatchObject({ id: 's1', logo: 'data:x' });
    expect(plan.summary).toMatchObject({ addedSports: 0, updatedSports: 1, addedTeams: 1, updatedTeams: 1 });
    expect(plan.teams.find(t => t.id === 't1').sportIds).toEqual(['Chess', 'BASKETBALL']);
  });
});
