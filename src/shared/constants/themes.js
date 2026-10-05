/* ════════════════════════════════════════════════════════════════════
   Site color themes. Every stylesheet reads the brand colors through the
   CSS variables below (`var(--c-navy, #0a1d52)` — the fallback is the
   original Santa Rita color), so a theme is just a set of values for them.

   Each theme is a base hue for the dark "navy" family plus a
   complementary accent pair (a bright + a slightly deeper tone). The
   navy family is derived from the ORIGINAL navy shades by rotating their
   hue, so the light/dark relationships (and therefore contrast against
   white text and cards) stay identical in every theme — only the hue
   changes. Accents are all bright enough to read on the dark surfaces
   and to carry dark text when used as a button fill.
   ════════════════════════════════════════════════════════════════════ */

// The original Santa Rita shades — the source the other themes rotate.
const BASE = {
  dark: '#001529',
  'dark-2': '#001a3a',
  'navy-2': '#0b2447',
  navy: '#0a1d52',
  'navy-3': '#16337a',
  'navy-4': '#1a3a6e',
};
const BASE_HUE = 220;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// Rotate a base shade to `hue` (relative to the original 220° family),
// optionally desaturating it (satMul < 1 → charcoal/slate themes).
function shade(hex, hue, satMul) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return toHex(hslToRgb([(h + (hue - BASE_HUE) + 360) % 360, Math.min(1, s * satMul), l]));
}

function buildTheme({ hue, satMul = 1, accent, accent2 }) {
  const colors = { gold: accent, 'gold-2': accent2 };
  Object.entries(BASE).forEach(([k, hex]) => { colors[k] = shade(hex, hue, satMul); });
  return colors;
}

const RGB_VARS = ['dark', 'dark-2', 'navy', 'navy-2', 'gold', 'gold-2'];

// Turn a { name: '#hex' } color map into the full set of CSS variables,
// including the `-rgb` triplets that rgba(var(--c-x-rgb), .5) usages need.
export function themeToCssVars(colors) {
  const vars = {};
  Object.entries(colors).forEach(([k, hex]) => { vars[`--c-${k}`] = hex; });
  RGB_VARS.forEach((k) => { vars[`--c-${k}-rgb`] = hexToRgb(colors[k]).join(', '); });
  return vars;
}

export const DEFAULT_THEME_KEY = 'santa-rita';

export const THEMES = [
  {
    key: 'santa-rita', name: 'Santa Rita', tagline: 'Navy & Gold',
    // Explicit originals — the default must render exactly as before.
    colors: { ...BASE, gold: '#fcbf19', 'gold-2': '#f5a623' },
  },
  { key: 'cobalt-ember', name: 'Cobalt & Ember', tagline: 'Blue & Orange', ...wrap({ hue: 222, accent: '#ff8c42', accent2: '#f26a1b' }) },
  { key: 'ocean-coral', name: 'Ocean & Coral', tagline: 'Teal & Coral', ...wrap({ hue: 190, accent: '#ff8a65', accent2: '#ff7043' }) },
  { key: 'forest-amber', name: 'Forest & Amber', tagline: 'Emerald & Amber', ...wrap({ hue: 150, accent: '#ffc145', accent2: '#f59e0b' }) },
  { key: 'royal-gold', name: 'Royal & Gold', tagline: 'Purple & Yellow', ...wrap({ hue: 268, accent: '#ffd23f', accent2: '#f5b700' }) },
  { key: 'crimson-sand', name: 'Crimson & Sand', tagline: 'Crimson & Sand', ...wrap({ hue: 350, accent: '#f4d35e', accent2: '#e9b824' }) },
  { key: 'plum-peach', name: 'Plum & Peach', tagline: 'Berry & Peach', ...wrap({ hue: 322, accent: '#ffab7b', accent2: '#ff8a5b' }) },
  { key: 'indigo-mint', name: 'Indigo & Mint', tagline: 'Indigo & Mint', ...wrap({ hue: 245, accent: '#6ee7b7', accent2: '#34d399' }) },
  { key: 'teal-rose', name: 'Teal & Rose', tagline: 'Deep Teal & Rose Gold', ...wrap({ hue: 174, accent: '#f4a6a0', accent2: '#e58e87' }) },
  { key: 'slate-lime', name: 'Slate & Lime', tagline: 'Charcoal & Lime', ...wrap({ hue: 215, satMul: 0.2, accent: '#a3e635', accent2: '#84cc16' }) },
  { key: 'midnight-aqua', name: 'Midnight & Aqua', tagline: 'Midnight & Aqua', ...wrap({ hue: 235, accent: '#5eead4', accent2: '#2dd4bf' }) },
];

function wrap(spec) { return { colors: buildTheme(spec) }; }

/* ── Custom theme ──────────────────────────────────────────────────
   Super Admin can pick their own colors instead of a preset: a primary
   (the dark "navy" family) and an accent pair. The navy family is still
   derived from the original shades — the primary's hue and saturation
   are applied to them, and its brightness only nudges theirs within a
   clamped range — so white text and cards keep readable contrast no
   matter what color is picked. Stored as siteConfig/branding.customTheme. */
export const CUSTOM_THEME_KEY = 'custom';

export const DEFAULT_CUSTOM_COLORS = { primary: '#0a1d52', accent: '#fcbf19', accent2: '#f5a623' };

const HEX_RE = /^#[0-9a-f]{6}$/i;
export const isHexColor = (v) => typeof v === 'string' && HEX_RE.test(v);

// How far the primary's lightness may move the navy family (relative to
// the original navy). Brighter than this and white text stops reading.
const MIN_L_SHIFT = -0.08;
const MAX_L_SHIFT = 0.1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function normalizeCustomColors(custom) {
  const c = custom || {};
  return {
    primary: isHexColor(c.primary) ? c.primary.toLowerCase() : DEFAULT_CUSTOM_COLORS.primary,
    accent: isHexColor(c.accent) ? c.accent.toLowerCase() : DEFAULT_CUSTOM_COLORS.accent,
    accent2: isHexColor(c.accent2) ? c.accent2.toLowerCase() : DEFAULT_CUSTOM_COLORS.accent2,
  };
}

export function buildCustomColors(custom) {
  const { primary, accent, accent2 } = normalizeCustomColors(custom);
  const [ph, ps, pl] = rgbToHsl(hexToRgb(primary));
  const [, ns, nl] = rgbToHsl(hexToRgb(BASE.navy));
  const lShift = clamp(pl - nl, MIN_L_SHIFT, MAX_L_SHIFT);
  const colors = { gold: accent, 'gold-2': accent2 };
  Object.entries(BASE).forEach(([k, hex]) => {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    // Keep each shade's hue offset from navy, and scale its saturation by
    // how saturated the primary is compared with the original navy.
    const hue = (ph + (h - rgbToHsl(hexToRgb(BASE.navy))[0]) + 360) % 360;
    const sat = ns === 0 ? ps : clamp(s * (ps / ns), 0, 1);
    colors[k] = toHex(hslToRgb([hue, sat, clamp(l + lShift, 0.02, 0.4)]));
  });
  return colors;
}

// A slightly deeper tone of an accent, used to auto-fill "Accent (deep)".
export function deepenColor(hex) {
  if (!isHexColor(hex)) return hex;
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return toHex(hslToRgb([h, s, clamp(l - 0.08, 0, 1)]));
}

// WCAG contrast ratio between two hex colors (1–21).
export function contrastRatio(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function getTheme(key, customColors) {
  if (key === CUSTOM_THEME_KEY) {
    return { key, name: 'Custom', tagline: 'Your own colors', colors: buildCustomColors(customColors) };
  }
  return THEMES.find((t) => t.key === key) || THEMES[0];
}
