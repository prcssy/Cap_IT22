import { describe, it, expect } from 'vitest';
import { validatePersonName, validateSection, validatePassword, looksLikeGibberish } from './validation';

const REAL_NAMES = [
  'Juan Dela Cruz', 'Maria Clara Santos', 'José Rizal', 'Ma. Teresa Ng',
  "John O'Neil", 'Anne-Marie Reyes', 'Niño Bautista', 'Christopher Schwartz',
  'Kristine Joy Macapagal', 'Mark Anthony Villanueva Jr.', 'Lyn Dy',
  'Rhea Mae Gonzales', 'Jhon Lloyd Pangilinan', 'Ashley Quiñones', 'Sasha Salas',
  'Dela Cruz, Juan Santos', 'Reyes,Maria Clara',
];

describe('validatePersonName', () => {
  it.each(REAL_NAMES)('accepts real name %s', (name) => {
    expect(validatePersonName(name)).toBeNull();
  });

  it.each([
    ['dlashdasd', /complete/],
    ['dlashdasd dasdasd', /real name/],
    ['asdf qwer', /real name/],
    ['Juan Xkcdz', /real name/],
    ['Jjjohn Cruz', /real name/],
    ['Juan123 Cruz', /only contain letters/],
    ['', /required/],
    ['   ', /required/],
    ['Juan', /complete/],
  ])('rejects %s', (name, pattern) => {
    expect(validatePersonName(name)).toMatch(pattern);
  });

  describe('lastNameFirst format ("Last Name, First Name, Middle Name")', () => {
    const opts = ['Full name', { lastNameFirst: true }];
    it.each([
      'Dela Cruz, Juan Santos', 'Dela Cruz, Juan, Santos', 'Reyes, Maria Clara',
      'Ng, Ma. Teresa', "O'Neil, John", 'Bautista, Niño', 'Dela Cruz, Juan,',
    ])('accepts %s', (name) => {
      expect(validatePersonName(name, ...opts)).toBeNull();
    });
    it.each([
      ['Juan Dela Cruz', /format/],
      [', Juan Santos', /only contain letters/],
      ['Dela Cruz,', /format/],
      ['A, B, C, D', /format/],
      ['dlashdasd', /format/],
      ['Dlashdasd, Dasdasd', /real name/],
      ['', /required/],
    ])('rejects %s', (name, pattern) => {
      expect(validatePersonName(name, ...opts)).toMatch(pattern);
    });
  });

  it('rejects names over 100 characters', () => {
    expect(validatePersonName(`Juan ${'a'.repeat(100)}`)).toMatch(/100 characters/);
  });
});

describe('validateSection', () => {
  it.each(['A', 'St. Luke', '12-B', 'Section Rizal', 'BSIT 3A'])('accepts %s', (s) => {
    expect(validateSection(s)).toBeNull();
  });
  it.each(['', 'dlashdasd', 'qwerty', '<script>'])('rejects %s', (s) => {
    expect(validateSection(s)).not.toBeNull();
  });
});

describe('validatePassword', () => {
  it('accepts a strong password', () => {
    expect(validatePassword('Sports2026')).toBeNull();
  });
  it.each(['short1A', 'alllowercase1', 'ALLUPPER1', 'NoNumbersHere'])('rejects %s', (p) => {
    expect(validatePassword(p)).not.toBeNull();
  });
});

describe('looksLikeGibberish', () => {
  it('flags keyboard mashing', () => {
    expect(looksLikeGibberish('asdfgh')).toBe(true);
    expect(looksLikeGibberish('bcdfgh')).toBe(true);
  });
  it('allows normal words', () => {
    expect(looksLikeGibberish('Basketball Team')).toBe(false);
  });
});
