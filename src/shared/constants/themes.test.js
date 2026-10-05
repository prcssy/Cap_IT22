import { describe, it, expect } from 'vitest';
import {
  getTheme, buildCustomColors, normalizeCustomColors, contrastRatio, deepenColor,
  CUSTOM_THEME_KEY, DEFAULT_CUSTOM_COLORS,
} from './themes';

describe('custom theme', () => {
  it('uses the picked accents as-is', () => {
    const c = buildCustomColors({ primary: '#7a1020', accent: '#00ccff', accent2: '#0099cc' });
    expect(c.gold).toBe('#00ccff');
    expect(c['gold-2']).toBe('#0099cc');
  });

  it('derives every navy-family shade', () => {
    const c = buildCustomColors({ primary: '#7a1020', accent: '#00ccff', accent2: '#0099cc' });
    ['dark', 'dark-2', 'navy', 'navy-2', 'navy-3', 'navy-4'].forEach((k) => {
      expect(c[k]).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  it('keeps white text readable even for a very light primary', () => {
    const c = buildCustomColors({ primary: '#ffeeaa', accent: '#fcbf19', accent2: '#f5a623' });
    expect(contrastRatio('#ffffff', c.navy)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', c.dark)).toBeGreaterThanOrEqual(4.5);
  });

  it('falls back to defaults for invalid colors', () => {
    expect(normalizeCustomColors({ primary: 'red', accent: '#12', accent2: null })).toEqual(DEFAULT_CUSTOM_COLORS);
    expect(normalizeCustomColors(undefined)).toEqual(DEFAULT_CUSTOM_COLORS);
  });

  it('getTheme resolves the custom key', () => {
    const t = getTheme(CUSTOM_THEME_KEY, { primary: '#0a5d2a', accent: '#ffffff', accent2: '#eeeeee' });
    expect(t.name).toBe('Custom');
    expect(t.colors.gold).toBe('#ffffff');
  });

  it('deepenColor returns a darker shade', () => {
    expect(contrastRatio(deepenColor('#fcbf19'), '#000000')).toBeLessThan(contrastRatio('#fcbf19', '#000000'));
  });
});
