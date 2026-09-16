import { createContext, useEffect, useState } from 'react';
import { subscribeBrandingConfig, DEFAULT_BRANDING } from '../services/firestoreService';
import defaultLogo from './img/SRCLogo.png';

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

  return (
    <BrandingContext.Provider value={{ ...branding, logo, loading }}>
      {children}
    </BrandingContext.Provider>
  );
}
