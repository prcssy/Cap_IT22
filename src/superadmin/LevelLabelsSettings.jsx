import { useContext, useEffect, useRef, useState } from 'react';
import { FaSync } from 'react-icons/fa';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import { updateLevelLabels } from '../shared/services/firestoreService';

function friendlyLevelLabelsError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  if (isPermission) return `${fallback} — you don't have permission for this action.`;
  return err?.message || `${fallback} — check your connection and try again.`;
}

/**
 * Super Admin → Web Customization → School Levels. One doc
 * (siteConfig/levelLabels, via LevelLabelsContext) holds the display name
 * for each of the 3 fixed school levels used throughout the app
 * (Dashboard, Registration, Rankings, Match Schedules, Team & Sports,
 * Admin, Moderator, the public landing page). Only the label is editable
 * here — the 3 levels themselves can't be added to or removed, since
 * every other config doc in Firestore is keyed by the fixed internal
 * elementary/highSchool/college ids, not by this display name.
 */
export default function LevelLabelsSettings({ actorEmail, actorRole }) {
  const levelLabels = useContext(LevelLabelsContext);
  const seededRef = useRef(false);

  const [draft, setDraft] = useState({
    elementary: levelLabels.elementary,
    highSchool: levelLabels.highSchool,
    college: levelLabels.college,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // Seed the draft exactly once, the first time real data arrives — same
  // convention as BrandingSettings, so a Firestore push (including this
  // page's own Save) can't clobber an in-progress edit.
  useEffect(() => {
    if (seededRef.current || levelLabels.loading) return;
    seededRef.current = true;
    setDraft({
      elementary: levelLabels.elementary,
      highSchool: levelLabels.highSchool,
      college: levelLabels.college,
    });
  }, [levelLabels.loading, levelLabels.elementary, levelLabels.highSchool, levelLabels.college]);

  const handleSave = async () => {
    if (!draft.elementary.trim() || !draft.highSchool.trim() || !draft.college.trim()) {
      setMsg({ tone: 'error', text: 'All 3 level names are required.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await updateLevelLabels(draft, actorEmail, actorRole);
      setMsg({ tone: 'success', text: 'School level names saved.' });
    } catch (err) {
      console.error('Failed to save school level names:', err);
      setMsg({ tone: 'error', text: friendlyLevelLabelsError(err, 'Could not save these changes') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-wrap">
      <div className="sa-panel__head">
        <div>
          <h2 className="sa-panel__title">SCHOOL LEVELS</h2>
          <p className="sa-panel__sub">Rename the 3 school levels used throughout the system. Levels can't be added or removed, only renamed.</p>
        </div>
      </div>

      <div className="ws-grid">
        <div className="ws-col">
          <div className="sa-card">
            <h3 className="ws-card-title">Level Names</h3>

            <label className="ws-field">
              <span className="ws-field__label">Level 1 *</span>
              <input
                type="text"
                value={draft.elementary}
                onChange={(e) => setDraft((p) => ({ ...p, elementary: e.target.value }))}
              />
              <span className="ws-card-hint">Shown everywhere the "Elementary" level appears.</span>
            </label>

            <label className="ws-field">
              <span className="ws-field__label">Level 2 *</span>
              <input
                type="text"
                value={draft.highSchool}
                onChange={(e) => setDraft((p) => ({ ...p, highSchool: e.target.value }))}
              />
              <span className="ws-card-hint">Shown everywhere the "High School" level appears.</span>
            </label>

            <label className="ws-field">
              <span className="ws-field__label">Level 3 *</span>
              <input
                type="text"
                value={draft.college}
                onChange={(e) => setDraft((p) => ({ ...p, college: e.target.value }))}
              />
              <span className="ws-card-hint">Shown everywhere the "College" level appears.</span>
            </label>

            <div className="ws-card-actions">
              {msg && <p className={`ws-msg ws-msg--${msg.tone}`}>{msg.text}</p>}
              <button type="button" className="sa-export" onClick={handleSave} disabled={busy}>
                {busy && <FaSync className="sa-spin" />} Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
