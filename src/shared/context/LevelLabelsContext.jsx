import { createContext, useEffect, useState } from 'react';
import { subscribeLevelLabels, DEFAULT_LEVEL_LABELS } from '../services/firestoreService';

/* ════════════════════════════════════════════════════════════════════
   Display names for the 3 fixed school levels (elementary/highSchool/
   college). Backed by the siteConfig/levelLabels Firestore doc, editable
   only from Super Admin's Web Customization tab — the 3 internal keys
   themselves can never be added to, removed, or renamed, only their
   on-screen label.

   Same shape/convention as BrandingContext: a fully-populated default
   object passed to createContext (so every consumer works before the
   first Firestore snapshot arrives), a *Provider component, no separate
   hook — consumers call useContext(LevelLabelsContext) directly.
   ════════════════════════════════════════════════════════════════════ */

export const LevelLabelsContext = createContext({
  ...DEFAULT_LEVEL_LABELS,
  loading: true,
});

export function LevelLabelsProvider({ children }) {
  const [labels, setLabels] = useState(DEFAULT_LEVEL_LABELS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeLevelLabels((data) => {
      setLabels(data);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  return (
    <LevelLabelsContext.Provider value={{ ...labels, loading }}>
      {children}
    </LevelLabelsContext.Provider>
  );
}
