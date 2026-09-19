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

const { getEventKey, getEventLabel, EVENT_TYPES } = await import('./firestoreService.js');

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

describe('EVENT_TYPES', () => {
  it('is the single source of truth with the 3 known events', () => {
    expect(EVENT_TYPES.map((e) => e.key)).toEqual(['intramurals', 'sportsfest', 'prisaa']);
  });
});
