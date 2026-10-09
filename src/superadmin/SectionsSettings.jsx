import { useContext, useEffect, useRef, useState } from 'react';
import { FaPlus, FaTrash, FaArrowUp, FaArrowDown, FaSync } from 'react-icons/fa';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import LevelTabs from '../shared/components/LevelTabs';
import { useSectionOptions } from '../shared/utils/sections';
import { updateSectionOptions } from '../shared/services/firestoreService';
import { GRADES_BY_LEVEL } from '../shared/utils/schoolLevel';
import { validateSection } from '../shared/utils/validation';
import './BrandingSettings.css';

const ALL_GRADES = Object.values(GRADES_BY_LEVEL).flat();
const uid = () => Math.random().toString(36).slice(2, 10);

function friendlySectionsError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  if (isPermission) return `${fallback} — you don't have permission for this action.`;
  return err?.message || `${fallback} — check your connection and try again.`;
}

function toDraft(byGrade) {
  const draft = {};
  ALL_GRADES.forEach((g) => {
    draft[g] = (byGrade[g] || []).map((name) => ({ _id: uid(), name }));
  });
  return draft;
}

/**
 * Super Admin → Web Customization → Sections. Sets the list of class
 * sections a student can pick for each grade/year level on the sign-up and
 * player registration forms (siteConfig/sections). A grade left empty keeps
 * the old free-text Section box on those forms.
 */
export default function SectionsSettings({ actorEmail, actorRole }) {
  const levelLabels = useContext(LevelLabelsContext);
  const { byGrade, loading } = useSectionOptions();
  const seededRef = useRef(false);

  const [level, setLevel] = useState('elementary');
  const [draft, setDraft] = useState(() => toDraft({}));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // Seed once, same as LevelLabelsSettings, so a live snapshot (including
  // this page's own Save) can't clobber an in-progress edit.
  useEffect(() => {
    if (seededRef.current || loading) return;
    seededRef.current = true;
    setDraft(toDraft(byGrade));
  }, [loading, byGrade]);

  const updateGrade = (grade, fn) => setDraft((prev) => ({ ...prev, [grade]: fn(prev[grade]) }));
  const addSection = (grade) => updateGrade(grade, (list) => [...list, { _id: uid(), name: '' }]);
  const renameSection = (grade, id, name) => updateGrade(grade, (list) => list.map((s) => (s._id === id ? { ...s, name } : s)));
  const removeSection = (grade, id) => updateGrade(grade, (list) => list.filter((s) => s._id !== id));
  const moveSection = (grade, i, dir) => updateGrade(grade, (list) => {
    const next = [...list];
    [next[i], next[i + dir]] = [next[i + dir], next[i]];
    return next;
  });

  const handleSave = async () => {
    // Check every name against the same rule the registration forms use, so
    // a section offered in the dropdown can never fail the student's own
    // validation (or the Firestore rules) when they submit.
    for (const grade of ALL_GRADES) {
      const seen = new Set();
      for (const { name } of draft[grade]) {
        if (!name.trim()) continue;
        const err = validateSection(name, { checkGibberish: false });
        if (err) {
          setMsg({ tone: 'error', text: `${grade} — "${name.trim()}": ${err}` });
          return;
        }
        const key = name.trim().toLowerCase();
        if (seen.has(key)) {
          setMsg({ tone: 'error', text: `${grade} has "${name.trim()}" listed twice.` });
          return;
        }
        seen.add(key);
      }
    }

    setBusy(true);
    setMsg(null);
    try {
      const payload = {};
      ALL_GRADES.forEach((g) => { payload[g] = draft[g].map((s) => s.name); });
      await updateSectionOptions(payload, actorEmail, actorRole);
      // Drop blank rows locally too, so the editor matches what was saved.
      setDraft((prev) => {
        const next = {};
        ALL_GRADES.forEach((g) => { next[g] = prev[g].filter((s) => s.name.trim()); });
        return next;
      });
      setMsg({ tone: 'success', text: 'Sections saved.' });
    } catch (err) {
      console.error('Failed to save sections:', err);
      setMsg({ tone: 'error', text: friendlySectionsError(err, 'Could not save these changes') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-wrap">
      <div className="sa-panel__head">
        <div>
          <h2 className="sa-panel__title">SECTIONS</h2>
          <p className="sa-panel__sub">
            Set the sections students can choose from when they sign up or register as a player. A grade/year with no sections listed lets students type their section instead.
          </p>
        </div>
      </div>

      <LevelTabs
        levels={[
          { key: 'elementary', label: levelLabels.elementary },
          { key: 'highSchool', label: levelLabels.highSchool },
          { key: 'college', label: levelLabels.college },
        ]}
        value={level}
        onChange={setLevel}
        containerClassName="sa-lvltabs"
        tabClassName="sa-lvltab"
        activeClassName="sa-lvltab--active"
      />

      <div className="ws-grid ws-grid--sections">
        {GRADES_BY_LEVEL[level].map((grade) => (
          <div className="sa-card" key={grade}>
            <div className="ws-card-toprow">
              <h3 className="ws-card-title">{grade}</h3>
              <button type="button" className="sa-icon-btn" onClick={() => addSection(grade)} title="Add section">
                <FaPlus />
              </button>
            </div>

            {draft[grade].length === 0 ? (
              <p className="ws-card-hint">No sections yet — students will type their section in.</p>
            ) : (
              <div className="ws-events-list">
                {draft[grade].map((s, i) => (
                  <div className="ws-event-row" key={s._id}>
                    <span className="ws-event-row__num">{i + 1}</span>
                    <input
                      type="text"
                      value={s.name}
                      placeholder="Enter Section (e.g. St. Luke)"
                      onChange={(e) => renameSection(grade, s._id, e.target.value)}
                    />
                    <button type="button" className="sa-icon-btn" disabled={i === 0} onClick={() => moveSection(grade, i, -1)} title="Move up">
                      <FaArrowUp />
                    </button>
                    <button type="button" className="sa-icon-btn" disabled={i === draft[grade].length - 1} onClick={() => moveSection(grade, i, 1)} title="Move down">
                      <FaArrowDown />
                    </button>
                    <button type="button" className="sa-icon-btn ws-icon-btn--danger" onClick={() => removeSection(grade, s._id)} title="Remove section">
                      <FaTrash />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ws-card-actions">
        {msg && <p className={`ws-msg ws-msg--${msg.tone}`}>{msg.text}</p>}
        <button type="button" className="sa-export" onClick={handleSave} disabled={busy || loading}>
          {busy && <FaSync className="sa-spin" />} Save Changes
        </button>
      </div>
    </div>
  );
}
