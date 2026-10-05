import { createContext, useEffect, useState } from 'react';
import { subscribeBrandingConfig, DEFAULT_BRANDING } from '../services/firestoreService';
import { DEFAULT_THEME_KEY, getTheme, themeToCssVars } from '../constants/themes';
import defaultLogo from '../img/SRCLogo.png';

/* ════════════════════════════════════════════════════════════════════
   Site branding — single source of truth for the school name, tagline,
   motto, copyright text, logo, and the list of school events (which
   double as the real Intramurals/Sportsfest/Prisaa registration event
   categories). Backed by the siteConfig/branding Firestore doc, editable
   only from Super Admin's Web Customization tab.

   Same shape/convention as AuthContext: a fully-populated default object
   passed to createContext (so every consumer works before the first
   Firestore snapshot arrives), a *Provider component, no separate hook —
   consumers call useContext(BrandingContext) directly.
   ════════════════════════════════════════════════════════════════════ */

export const BrandingContext = createContext({
  ...DEFAULT_BRANDING,
  logo: defaultLogo,
  loading: true,
});

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState(DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeBrandingConfig((data) => {
      setBranding(data);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // `logo` is always a usable image source — the bundled default asset
  // until/unless a Super Admin uploads a custom one. Every consumer uses
  // this instead of raw `logoURL` so nobody needs their own fallback.
  const logo = branding.logoURL || defaultLogo;

  // Keep the browser tab's favicon in sync with the current logo,
  // including the bundled default (index.html's own <link> pointed at a
  // file that didn't exist on disk before this feature — see
  // public/SRCLogo.png).
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]');
    if (link) link.href = logo;
  }, [logo]);

  // Keep the browser tab's title in sync with the school name (index.html's
  // <title> is only the static first-paint value). Waits for the real
  // branding doc so it doesn't flash the built-in default name first.
  useEffect(() => {
    if (loading) return;
    const name = (branding.schoolName || '').trim();
    if (name) document.title = name;
  }, [loading, branding.schoolName]);

  // Apply the chosen color theme site-wide by setting the --c-* variables
  // every stylesheet reads. Removing them (default theme) falls back to the
  // original colors baked into each var(--c-x, #fallback).
  useEffect(() => {
    const root = document.documentElement;
    const vars = themeToCssVars(getTheme(branding.themeKey, branding.customTheme).colors);
    const isDefault = !branding.themeKey || branding.themeKey === DEFAULT_THEME_KEY;
    Object.entries(vars).forEach(([name, value]) => {
      if (isDefault) root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    });
  }, [branding.themeKey, branding.customTheme]);

  return (
    <BrandingContext.Provider value={{ ...branding, logo, loading }}>
      {children}
    </BrandingContext.Provider>
  );
}
