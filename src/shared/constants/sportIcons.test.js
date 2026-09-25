import { describe, it, expect } from 'vitest';
import { SPORT_ICONS, DEFAULT_SPORT_ICON, guessSportIconKey, resolveSportIcon } from './sportIcons';

describe('guessSportIconKey', () => {
  it.each([
    ['Basketball', 'basketball'],
    ['  basketball ', 'basketball'],
    ['3x3 Basketball', 'basketball'],
    ['Beach Volleyball', 'volleyball'],
    ['Football', 'football'],
    ['American Football', 'american-football'],
    ['Tennis', 'tennis'],
    ['Table Tennis', 'table-tennis'],
    ['Badminton', 'badminton'],
    ['Sepak Takraw', 'sepak-takraw'],
    ['Track and Field', 'athletics'],
    ['Taekwondo', 'martial-arts'],
    ['Kickboxing', 'martial-arts'],
    ['Boxing', 'boxing'],
    ['Mobile Legends', 'esports'],
    ['Swimming Pool Relay', 'swimming'],
    ['Water Polo', 'swimming'],
    ['Chess', 'chess'],
    ['Archery', 'archery'],
    ['Quiz Bee', 'puzzle'],
  ])('%s -> %s', (name, key) => {
    expect(guessSportIconKey(name)).toBe(key);
  });

  it('matches whole words only, never fragments', () => {
    expect(guessSportIconKey('HTML')).toBeNull();
    expect(guessSportIconKey('Paradigm')).toBeNull();
  });

  it('returns null for blank or unknown names', () => {
    expect(guessSportIconKey('')).toBeNull();
    expect(guessSportIconKey(undefined)).toBeNull();
    expect(guessSportIconKey('Underwater Basket Weaving')).toBeNull();
  });
});

describe('resolveSportIcon', () => {
  it('lets an explicit pick win over the name', () => {
    const r = resolveSportIcon({ name: 'Basketball', icon: 'chess' });
    expect(r).toMatchObject({ key: 'chess', source: 'chosen' });
  });

  it('follows the name when no icon is picked', () => {
    expect(resolveSportIcon({ name: 'Volleyball', icon: null })).toMatchObject({ key: 'volleyball', source: 'auto' });
  });

  it('falls back to the general trophy for unknown names and stale keys', () => {
    expect(resolveSportIcon({ name: 'Zorbing' })).toMatchObject({ key: DEFAULT_SPORT_ICON.key, source: 'default' });
    expect(resolveSportIcon({ name: 'Chess', icon: 'no-such-icon' })).toMatchObject({ key: 'chess', source: 'auto' });
    expect(resolveSportIcon(undefined)).toMatchObject({ source: 'default' });
  });
});

describe('catalogue', () => {
  it('has unique keys and a renderable icon for every entry', () => {
    const keys = SPORT_ICONS.map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    SPORT_ICONS.forEach(i => expect(typeof i.Icon).toBe('function'));
  });

  it("each entry's first match term resolves back to itself", () => {
    SPORT_ICONS.forEach(i => expect(guessSportIconKey(i.match[0])).toBe(i.key));
  });
});
