import { describe, it, expect } from 'vitest';
import { sportCategoryOptions, categoryDivisionLabel } from './sportCategory';

describe('sportCategoryOptions', () => {
  it('returns each labelled group with its real divisions', () => {
    const sport = {
      categoryGroups: [
        { id: 'g1', label: 'Male', divisions: [{ id: 'd1', name: '5 V 5' }, { id: 'd2', name: '3 V 3' }] },
        { id: 'g2', label: ' ', divisions: [{ id: 'd3', name: 'x' }] },
      ],
    };
    expect(sportCategoryOptions(sport)).toEqual([
      { id: 'g1', label: 'Male', divisions: [{ id: 'd1', name: '5 V 5' }, { id: 'd2', name: '3 V 3' }] },
    ]);
  });

  it('treats a division that repeats the category name as no divisions', () => {
    const sport = { categoryGroups: [{ id: 'g', label: 'MEN', divisions: [{ id: 'g_auto', name: 'men' }] }] };
    expect(sportCategoryOptions(sport)[0].divisions).toEqual([]);
  });

  it('handles sports with no categories', () => {
    expect(sportCategoryOptions(null)).toEqual([]);
    expect(sportCategoryOptions({})).toEqual([]);
  });
});

describe('categoryDivisionLabel', () => {
  it('joins whichever parts are set', () => {
    expect(categoryDivisionLabel({ category: 'Male', division: '5 V 5' })).toBe('Male · 5 V 5');
    expect(categoryDivisionLabel({ category: 'Male' })).toBe('Male');
    expect(categoryDivisionLabel({})).toBe('');
  });
});
