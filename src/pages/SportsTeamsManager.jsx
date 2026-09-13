import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FaRunning, FaUsers, FaPlus, FaTimes,
  FaEdit, FaCheck, FaSync,
} from 'react-icons/fa';
import './SportsTeamsManager.css';
import { getSportsTeamsConfig, saveSportsConfig, saveTeamsConfig } from '../services/firestoreService';

/* ═══════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════ */
const FORMAT_OPTIONS = [
  { id: 'single-time',  label: '1 vs 1 (Time Basis)',  sub: 'ex. Chess and Swimming' },
  { id: 'single-solo',  label: '1 vs 1 (Point Basis)',  sub: 'ex. Taekwondo, Basketball, Badminton, Volleyball, and Tennis' },
  { id: 'single-group', label: '1 vs Many (Time Basis)', sub: 'ex. Swimming and Athletics' },
  { id: 'team-play',    label: '1 vs Many (Point Basis)', sub: 'ex. Archery' },
];

const TEAM_COLORS = ['#b45309','#dc2626','#15803d','#6d28d9','#92400e','#9f1239','#374151','#ea580c'];

const uid = () => Math.random().toString(36).slice(2, 10);
const norm = (v) => (v || '').trim().toLowerCase();
const ensureId = (obj) => obj?.id ? obj : { ...obj, id: uid() };

/* ═══════════════════════════════════════════
   LOGO UPLOAD
   Resizes to 80×80 before storing as base64
═══════════════════════════════════════════ */
function LogoUpload({ logo, onUpload, onClear, showClearButton = false }) {
  const inputRef = useRef(null);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const SIZE = 80;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#001529';
      ctx.fillRect(0, 0, SIZE, SIZE);
      const scale = Math.min(SIZE / img.width, SIZE / img.height);
      const x = (SIZE - img.width * scale) / 2;
      const y = (SIZE - img.height * scale) / 2;
      ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
      onUpload(canvas.toDataURL('image/jpeg', 0.75));
      URL.revokeObjectURL(url);
    };
    img.src = url;
    // allow re-selecting the same file after a clear
    e.target.value = '';
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onClear ? onClear() : onUpload(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="stm-logo-upload-wrap">
      <div className="stm-logo-upload" onClick={() => inputRef.current?.click()} title="Click to upload">
        {logo
          ? <img src={logo} alt="logo" className="stm-logo-img" />
          : <span className="stm-logo-placeholder">Upload Image</span>
        }
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
      </div>
      {showClearButton && logo && (
        <button
          type="button"
          className="stm-logo-clear-btn"
          onClick={handleClear}
          title="Clear image"
        >
          Clear image
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   CHOOSE SPORT FORMAT MODAL
═══════════════════════════════════════════ */
function FormatModal({ initial, onDone, onClose }) {
  const [picked, setPicked] = useState(initial || '');

  return (
    <div className="stm-overlay stm-overlay--top" onClick={onClose}>
      <div className="stm-modal stm-modal--format" onClick={e => e.stopPropagation()}>
        <div className="stm-modal__head">
          <div>
            <h3>Choose Sport Format</h3>
            <p>Set the scoring format basis for your sports</p>
          </div>
          <button className="stm-icon-btn" onClick={onClose}><FaTimes /></button>
        </div>
        <div className="stm-format-list">
          {FORMAT_OPTIONS.map(opt => (
            <label
              key={opt.id}
              className={`stm-format-row ${picked === opt.id ? 'stm-format-row--active' : ''}`}
              onClick={() => setPicked(opt.id)}
            >
              <div>
                <span className="stm-format-label">{opt.label}</span>
                <span className="stm-format-sub">{opt.sub}</span>
              </div>
              <span className={`stm-format-check ${picked === opt.id ? 'stm-format-check--on' : ''}`}>
                {picked === opt.id && <FaCheck />}
              </span>
            </label>
          ))}
        </div>
        <button className="stm-btn-primary stm-btn-block" disabled={!picked} onClick={() => onDone(picked)}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   CATEGORY / DIVISION MODAL  (image 4 design)
   Groups (Female/Male/etc) each with divisions
═══════════════════════════════════════════ */
function CategoryModal({ sport, onClose, onSave }) {
  const initGroups = () => {
    if (sport.categoryGroups?.length) return sport.categoryGroups.map(g => ({
      ...ensureId(g),
      divisions: (g.divisions || []).map(ensureId),
    }));
    return [];
  };

  const [groups, setGroups] = useState(initGroups);
  const [fmtTarget, setFmtTarget] = useState(null); // { gid, did }

  /* Stepper: controls number of groups */
  const setGroupCount = (n) => {
    setGroups(prev => {
      const next = [...prev];
      while (next.length < n) {
        next.push({ id: uid(), label: '', divisions: [{ id: uid(), name: '', format: '' }] });
      }
      while (next.length > n) next.pop();
      return next;
    });
  };

  const updateLabel = (gid, label) =>
    setGroups(prev => prev.map(g => g.id === gid ? { ...g, label } : g));

  const addDivision = (gid) =>
    setGroups(prev => prev.map(g => g.id === gid
      ? { ...g, divisions: [...g.divisions, { id: uid(), name: '', format: '' }] }
      : g));

  const removeDivision = (gid, did) =>
    setGroups(prev => prev.map(g => g.id === gid
      ? { ...g, divisions: g.divisions.filter(d => d.id !== did) }
      : g));

  const updateDiv = (gid, did, patch) =>
    setGroups(prev => prev.map(g => g.id === gid
      ? { ...g, divisions: g.divisions.map(d => d.id === did ? { ...d, ...patch } : d) }
      : g));

  const handleReset = () => setGroups(initGroups());

  const handleSubmit = () => {
    const cleaned = groups
      .filter(g => g.label.trim())
      .map(g => {
        // Keep a division if it has a name OR a format selected
        const filledDivs = g.divisions.filter(d => d.name.trim() || d.format);
        // If no filled divisions at all, represent the category itself as one entry
        // so "FEMALE" still appears in the preview even without sub-events
        const divisions = filledDivs.length > 0
          ? filledDivs.map(d => ({ ...d, name: d.name.trim() || g.label }))
          : [{ id: g.id + '_auto', name: g.label, format: g.divisions[0]?.format || '' }];
        return { ...g, divisions };
      });
    onSave(cleaned);
  };

  const fmtObj = (id) => FORMAT_OPTIONS.find(f => f.id === id);

  return (
    <>
      <div className="stm-overlay" onClick={onClose}>
        <div className="stm-modal stm-modal--category" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="stm-catmod-head">
          <button className="stm-icon-btn stm-catmod-close" onClick={onClose}><FaTimes /></button>
          <h3>CATEGORY / DIVISION</h3>
          <p>Set the categories, divisions, and formats for your sports</p>
          {/* Stepper: [+  N  -] matching image 4 */}
          <div className="stm-catmod-stepper">
            <button type="button" onClick={() => setGroupCount(groups.length + 1)}>+</button>
            <span>{groups.length}</span>
            <button type="button" onClick={() => setGroupCount(Math.max(0, groups.length - 1))}>−</button>
          </div>
        </div>

        {/* Groups */}
        <div className="stm-cat-groups">
          {groups.length === 0 && (
            <p className="stm-cat-groups__empty">
              Use the <strong>+</strong> above to add your first category.
            </p>
          )}
          {groups.map((group, gi) => (
            <div key={group.id} className="stm-cat-group">
              <div className="stm-cat-group__hdr">
                <input
                  className="stm-cat-group__label"
                  placeholder="Enter Category (ex. Male, Female, or Mixed)"
                  value={group.label}
                  onChange={e => updateLabel(group.id, e.target.value.toUpperCase())}
                />
                <span className="stm-cat-group__num">{gi + 1}</span>
              </div>

              {group.divisions.map(div => {
                const fmt = fmtObj(div.format);
                return (
                  <div key={div.id} className="stm-div-row">
                    <input
                      className="stm-div-input"
                      placeholder="e.g. Mixed Relay 4×4 (400m)"
                      value={div.name}
                      onChange={e => updateDiv(group.id, div.id, { name: e.target.value })}
                    />
                    {fmt ? (
                      <button
                        type="button"
                        className="stm-div-fmt-chip"
                        onClick={() => setFmtTarget({ gid: group.id, did: div.id })}
                        title="Click to change format"
                      >
                        <span className="stm-div-fmt-chip__label">{fmt.label}</span>
                        <span className="stm-div-fmt-chip__sub">{fmt.sub}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="stm-div-choose-btn"
                        onClick={() => setFmtTarget({ gid: group.id, did: div.id })}
                      >
                        Choose sport format
                      </button>
                    )}
                    <button
                      type="button"
                      className="stm-icon-btn"
                      onClick={() => removeDivision(group.id, div.id)}
                    >
                      <FaTimes />
                    </button>
                  </div>
                );
              })}

              <button
                type="button"
                className="stm-add-div-btn"
                onClick={() => addDivision(group.id)}
              >
                <FaPlus /> Add Division
              </button>
            </div>
          ))}
        </div>

        {/* Bottom actions */}
        <div className="stm-catmod-actions">
          <button type="button" className="stm-btn-ghost" onClick={handleReset}>
            <FaSync style={{ marginRight: 6, fontSize: '0.7rem' }} /> Reset
          </button>
          <button type="button" className="stm-btn-primary" onClick={handleSubmit}>Submit</button>
        </div>
      </div>
    </div>

    {/* FormatModal is a sibling overlay — not a child — so z-index stacks correctly */}
    {fmtTarget && (
      <FormatModal
        initial={groups.find(g => g.id === fmtTarget.gid)?.divisions.find(d => d.id === fmtTarget.did)?.format}
        onClose={() => setFmtTarget(null)}
        onDone={(fmtId) => {
          updateDiv(fmtTarget.gid, fmtTarget.did, { format: fmtId });
          setFmtTarget(null);
        }}
      />
    )}
    </>
  );
}

/* ═══════════════════════════════════════════
   VIOLATIONS MODAL (admin side)
   Defines the violation types moderators may log
   for this sport — exclusive to this sport only.
═══════════════════════════════════════════ */
function ViolationsAdminModal({ sport, onClose, onSave }) {
  const initRows = () => (sport.violations?.length ? sport.violations.map(ensureId) : []);

  const [rows, setRows] = useState(initRows);

  const addRow = () => setRows(prev => [...prev, { id: uid(), name: '' }]);
  const updateRow = (id, name) => setRows(prev => prev.map(r => r.id === id ? { ...r, name } : r));
  const removeRow = (id) => setRows(prev => prev.filter(r => r.id !== id));
  const handleReset = () => setRows(initRows());

  const handleSubmit = () => {
    const cleaned = rows.filter(r => r.name.trim()).map(r => ({ ...r, name: r.name.trim() }));
    onSave(cleaned);
  };

  return (
    <div className="stm-overlay" onClick={onClose}>
      <div className="stm-modal stm-modal--category" onClick={e => e.stopPropagation()}>

        <div className="stm-catmod-head">
          <button className="stm-icon-btn stm-catmod-close" onClick={onClose}><FaTimes /></button>
          <h3>VIOLATIONS</h3>
          <p>
            Set the violation types moderators can log for <strong>{sport.name || 'this sport'}</strong>.
            These will only be available when scoring {sport.name || 'this sport'}.
          </p>
        </div>

        <div className="stm-cat-groups">
          <div className="stm-cat-group">
            {rows.length === 0 ? (
              <p className="stm-cat-groups__empty">
                Use <strong>Add Violation</strong> below to define this sport's violation types (e.g. Foul, Yellow Card).
              </p>
            ) : rows.map(row => (
              <div key={row.id} className="stm-div-row">
                <input
                  className="stm-div-input"
                  placeholder="e.g. Foul"
                  value={row.name}
                  onChange={e => updateRow(row.id, e.target.value)}
                />
                <button type="button" className="stm-icon-btn" onClick={() => removeRow(row.id)}>
                  <FaTimes />
                </button>
              </div>
            ))}

            <button type="button" className="stm-add-div-btn" onClick={addRow}>
              <FaPlus /> Add Violation
            </button>
          </div>
        </div>

        <div className="stm-catmod-actions">
          <button type="button" className="stm-btn-ghost" onClick={handleReset}>
            <FaSync style={{ marginRight: 6, fontSize: '0.7rem' }} /> Reset
          </button>
          <button type="button" className="stm-btn-primary" onClick={handleSubmit}>Submit</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   POSITION TYPES MODAL
   A sport's own list of player positions — what Registration's
   "Position" dropdown offers once this sport is selected there.
   Flat list, no groups/format needed (unlike categories/divisions).
═══════════════════════════════════════════ */
function PositionsModal({ sport, onClose, onSave }) {
  const [positions, setPositions] = useState(sport.positions?.length ? [...sport.positions] : ['']);

  const updateAt = (i, value) => setPositions(prev => prev.map((p, idx) => idx === i ? value : p));
  const addRow = () => setPositions(prev => [...prev, '']);
  const removeAt = (i) => setPositions(prev => prev.filter((_, idx) => idx !== i));

  const handleSubmit = () => {
    const cleaned = [...new Set(positions.map(p => p.trim()).filter(Boolean))];
    onSave(cleaned);
  };

  return (
    <div className="stm-overlay" onClick={onClose}>
      <div className="stm-modal stm-modal--category" onClick={e => e.stopPropagation()}>

        <div className="stm-catmod-head">
          <button className="stm-icon-btn stm-catmod-close" onClick={onClose}><FaTimes /></button>
          <h3>POSITION TYPES</h3>
          <p>Set the player positions available for {sport.name || 'this sport'}. These are what students pick from on the registration form.</p>
        </div>

        <div className="stm-cat-groups">
          {positions.length === 0 && (
            <p className="stm-cat-groups__empty">
              Use <strong>Add Position</strong> below to add the first one.
            </p>
          )}
          {positions.map((p, i) => (
            <div key={i} className="stm-div-row">
              <input
                className="stm-div-input"
                placeholder="e.g. Forward, Goalkeeper, Pitcher"
                value={p}
                onChange={e => updateAt(i, e.target.value)}
              />
              <button type="button" className="stm-icon-btn" onClick={() => removeAt(i)}>
                <FaTimes />
              </button>
            </div>
          ))}
          <button type="button" className="stm-add-div-btn" onClick={addRow}>
            <FaPlus /> Add Position
          </button>
        </div>

        <div className="stm-catmod-actions">
          <button type="button" className="stm-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="stm-btn-primary" onClick={handleSubmit}>Submit</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   EDIT SPORT MODAL
   Popup for editing a single saved sport's name,
   logo, categories/divisions, and violations.
═══════════════════════════════════════════ */
function EditSportModal({ sport, saving, onClose, onSave }) {
  const [name,           setName]           = useState(sport.name || '');
  const [logo,           setLogo]           = useState(sport.logo || null);
  const [categoryGroups, setCategoryGroups] = useState(sport.categoryGroups || []);
  const [violations,     setViolations]     = useState(sport.violations || []);
  const [positions,      setPositions]      = useState(sport.positions || []);
  const [showCatModal,   setShowCatModal]   = useState(false);
  const [showViolModal,  setShowViolModal]  = useState(false);
  const [showPosModal,   setShowPosModal]   = useState(false);

  const divisions = (categoryGroups || []).flatMap(g => {
    const divs = g.divisions || [];
    if (divs.length === 0) return [{ id: g.id + '_lbl', name: g.label, format: '' }];
    return divs.map(d => ({ ...d, name: d.name || g.label }));
  });

  return (
    <>
      <div className="stm-overlay" onClick={onClose}>
        <div className="stm-modal stm-modal--edit-sport" onClick={e => e.stopPropagation()}>

          <div className="stm-catmod-head">
            <button className="stm-icon-btn stm-catmod-close" onClick={onClose}><FaTimes /></button>
            <h3>EDIT SPORT</h3>
            <p>Update this sport's name, logo, categories, and format.</p>
          </div>

          <div className="stm-edit-sport-body">
            <div className="stm-edit-sport-row">
              <LogoUpload logo={logo} onUpload={setLogo} onClear={() => setLogo(null)} showClearButton />
              <input
                className="stm-row-input stm-edit-sport-name"
                placeholder="Sport name"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>

            <div className="stm-edit-sport-cats">
              <div className="stm-edit-sport-cats__head">
                <span className="stm-preview-label">CATEGORIES/ DIVISIONS</span>
                <button type="button" className="stm-link-btn" onClick={() => setShowCatModal(true)}>
                  <FaEdit /> Edit categories
                </button>
              </div>
              {divisions.length === 0 ? (
                <p className="stm-empty-note">No categories set.</p>
              ) : (
                <ul className="stm-preview-list">
                  {divisions.map((d, i) => {
                    const f = FORMAT_OPTIONS.find(o => o.id === d.format);
                    return <li key={d.id || i}>{d.name}{f ? ` — ${f.label}` : ''}</li>;
                  })}
                </ul>
              )}
            </div>

            <div className="stm-edit-sport-cats">
              <div className="stm-edit-sport-cats__head">
                <span className="stm-preview-label">VIOLATIONS</span>
                <button type="button" className="stm-link-btn" onClick={() => setShowViolModal(true)}>
                  <FaEdit /> Edit violations
                </button>
              </div>
              {violations.length === 0 ? (
                <p className="stm-empty-note">No violations set.</p>
              ) : (
                <ul className="stm-preview-list">
                  {violations.map((v, i) => <li key={v.id || i}>{v.name}</li>)}
                </ul>
              )}
            </div>

            <div className="stm-edit-sport-cats">
              <div className="stm-edit-sport-cats__head">
                <span className="stm-preview-label">POSITION TYPES</span>
                <button type="button" className="stm-link-btn" onClick={() => setShowPosModal(true)}>
                  <FaEdit /> Edit positions
                </button>
              </div>
              {positions.length === 0 ? (
                <p className="stm-empty-note">No positions set — Registration falls back to a default list for this sport.</p>
              ) : (
                <ul className="stm-preview-list">
                  {positions.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )}
            </div>
          </div>

          <div className="stm-catmod-actions">
            <button type="button" className="stm-btn-ghost" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="stm-btn-primary"
              disabled={saving || !name.trim()}
              onClick={() => onSave({ ...sport, name: name.trim(), logo, categoryGroups, violations, positions })}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>

        </div>
      </div>

      {showCatModal && (
        <CategoryModal
          sport={{ ...sport, categoryGroups }}
          onClose={() => setShowCatModal(false)}
          onSave={(groups) => { setCategoryGroups(groups); setShowCatModal(false); }}
        />
      )}

      {showViolModal && (
        <ViolationsAdminModal
          sport={{ ...sport, violations }}
          onClose={() => setShowViolModal(false)}
          onSave={(v) => { setViolations(v); setShowViolModal(false); }}
        />
      )}

      {showPosModal && (
        <PositionsModal
          sport={{ ...sport, positions }}
          onClose={() => setShowPosModal(false)}
          onSave={(list) => { setPositions(list); setShowPosModal(false); }}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   EDIT TEAM MODAL
   Saved teams could only be deleted before, so fixing a typo meant
   deleting the team and adding it again — which silently orphaned every
   schedule and saved result that referenced it by name.
═══════════════════════════════════════════ */
function EditTeamModal({ team, sportsList, saving, onClose, onSave }) {
  const [name,     setName]     = useState(team.name || '');
  const [logo,     setLogo]     = useState(team.logo || null);
  const [sportIds, setSportIds] = useState(team.sportIds || []);
  const [showPicker, setShowPicker] = useState(false);

  const renamed = !!name.trim() && norm(name) !== norm(team.name);

  return (
    <>
      <div className="stm-overlay" onClick={onClose}>
        <div className="stm-modal stm-modal--edit-sport" onClick={e => e.stopPropagation()}>

          <div className="stm-catmod-head">
            <button className="stm-icon-btn stm-catmod-close" onClick={onClose}><FaTimes /></button>
            <h3>EDIT TEAM</h3>
            <p>Update this team's name, logo, and the sports it plays.</p>
          </div>

          <div className="stm-edit-sport-body">
            <div className="stm-edit-sport-row">
              <LogoUpload logo={logo} onUpload={setLogo} onClear={() => setLogo(null)} showClearButton />
              <input
                className="stm-row-input stm-edit-sport-name"
                placeholder="Team name"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>

            {renamed && (
              <p className="stm-empty-note" style={{ color: '#a83218', fontWeight: 700 }}>
                Heads up: match schedules and saved results store this team by name. Renaming it here
                does not rename it there, so older fixtures and results will still say
                "{team.name}".
              </p>
            )}

            <div className="stm-edit-sport-cats">
              <div className="stm-edit-sport-cats__head">
                <span className="stm-preview-label">SPORTS</span>
                <button type="button" className="stm-link-btn" onClick={() => setShowPicker(true)}>
                  <FaEdit /> Edit sports
                </button>
              </div>
              {sportIds.length === 0 ? (
                <p className="stm-empty-note">No sports assigned yet.</p>
              ) : (
                <ul className="stm-preview-list stm-preview-list--cols">
                  {sportIds.map(sport => <li key={sport}>{sport}</li>)}
                </ul>
              )}
            </div>
          </div>

          <div className="stm-catmod-actions">
            <button type="button" className="stm-btn-ghost" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="stm-btn-primary"
              disabled={saving || !name.trim()}
              onClick={() => onSave({ ...team, name: name.trim(), logo, sportIds })}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>

        </div>
      </div>

      {showPicker && (
        <TeamSportsPickerModal
          team={{ ...team, sportIds }}
          sportsList={sportsList}
          onClose={() => setShowPicker(false)}
          onSave={(ids) => { setSportIds(ids); setShowPicker(false); }}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════
   SPORTS CONFIRMATION MODAL  (image 5 design)
   Sports | Division/Categories | Sports Format | Logo
═══════════════════════════════════════════ */
function SportsConfirmModal({ sports, saving, onClose, onSave }) {
  /* Flatten: one row per division across all groups */
  const rows = sports.flatMap(sport => {
    const flat = sport.categoryGroups?.flatMap(g =>
      g.divisions.map(d => ({ div: d, groupLabel: g.label }))
    ) || [];
    if (flat.length === 0) return [{ sport, div: null, groupLabel: '' }];
    return flat.map((item, i) => ({ sport: i === 0 ? sport : null, ...item }));
  });

  return (
    <div className="stm-overlay" onClick={onClose}>
      <div className="stm-modal stm-modal--confirm" onClick={e => e.stopPropagation()}>
        <h3 className="stm-confirm-title">CONFIRMATION</h3>
        <div className="stm-confirm-grid stm-confirm-grid--sports">
          {/* SPORTS col */}
          <div className="stm-confirm-col">
            <h4>SPORTS</h4>
            {rows.map((r, i) => (
              <div key={i} className="stm-confirm-cell">
                {r.sport ? (
                  <span className="stm-confirm-sport-name">
                    {r.sport.name}
                    <span className="stm-confirm-edit-icon"><FaEdit /></span>
                  </span>
                ) : <span />}
              </div>
            ))}
          </div>

          {/* DIVISION/CATEGORIES col */}
          <div className="stm-confirm-col">
            <h4>DIVISION/ CATEGORIES</h4>
            {rows.map((r, i) => (
              <div key={i} className="stm-confirm-cell">
                {r.div ? r.div.name || r.groupLabel : '—'}
              </div>
            ))}
          </div>

          {/* SPORTS FORMAT col */}
          <div className="stm-confirm-col">
            <h4>SPORTS FORMAT</h4>
            {rows.map((r, i) => {
              const fmt = FORMAT_OPTIONS.find(f => f.id === r.div?.format);
              return (
                <div key={i} className="stm-confirm-cell">
                  {fmt ? fmt.label : '—'}
                </div>
              );
            })}
          </div>

          {/* SPORTS LOGO col */}
          <div className="stm-confirm-col">
            <h4>SPORTS LOGO</h4>
            {sports.map(s => (
              <div key={s.id} className="stm-confirm-cell stm-confirm-cell--logo">
                {s.logo
                  ? <img src={s.logo} alt="logo" className="stm-confirm-logo-img" />
                  : <span className="stm-confirm-logo-placeholder"><FaRunning /></span>
                }
              </div>
            ))}
          </div>
        </div>

        <div className="stm-confirm-actions">
          <button className="stm-btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="stm-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   TEAM SPORTS PICKER MODAL
═══════════════════════════════════════════ */
function TeamSportsPickerModal({ team, sportsList, onClose, onSave }) {
  const [selected, setSelected] = useState(new Set(team.sportIds || []));

  const toggle = (name) => setSelected(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  return (
    <div className="stm-overlay" onClick={onClose}>
      <div className="stm-modal stm-modal--picker" onClick={e => e.stopPropagation()}>
        <div className="stm-modal__head">
          <div>
            <h3>Sports</h3>
            <p>Select sports for <strong>{team.name || 'this team'}</strong></p>
          </div>
          <button className="stm-icon-btn" onClick={onClose}><FaTimes /></button>
        </div>

        {sportsList.length === 0 ? (
          <p className="stm-empty-note" style={{ padding: '20px 0' }}>No sports added yet.</p>
        ) : (
          <div className="stm-picker-list">
            {sportsList.map(s => (
              <button
                key={s.id}
                type="button"
                className={`stm-picker-item ${selected.has(s.name) ? 'stm-picker-item--on' : ''}`}
                onClick={() => toggle(s.name)}
              >
                {s.logo
                  ? <img src={s.logo} alt="" className="stm-picker-logo" />
                  : <span className="stm-picker-logo stm-picker-logo--icon"><FaRunning /></span>
                }
                <span>{s.name}</span>
                <span className="stm-picker-check">{selected.has(s.name) && <FaCheck />}</span>
              </button>
            ))}
          </div>
        )}

        <button className="stm-btn-primary stm-btn-block" onClick={() => onSave([...selected])}>
          Submit
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   TEAMS CONFIRMATION MODAL
═══════════════════════════════════════════ */
function TeamsConfirmModal({ teams, saving, onClose, onSave }) {
  const [activeId, setActiveId] = useState(teams[0]?.id);
  const activeTeam = teams.find(t => t.id === activeId) || teams[0];

  return (
    <div className="stm-overlay" onClick={onClose}>
      <div className="stm-modal stm-modal--confirm stm-modal--teams-confirm" onClick={e => e.stopPropagation()}>
        <h3 className="stm-confirm-title">CONFIRMATION</h3>
        <div className="stm-confirm-grid stm-confirm-grid--teams">
          <div className="stm-confirm-col">
            <h4>TEAMS</h4>
            {teams.map((t, i) => (
              <button
                key={t.id}
                type="button"
                className={`stm-team-conf-row ${activeTeam?.id === t.id ? 'stm-team-conf-row--active' : ''}`}
                onClick={() => setActiveId(t.id)}
              >
                <span className="stm-team-conf-row__num">{i + 1}</span>
                {t.logo
                  ? <img src={t.logo} alt="" className="stm-team-conf-row__logo-img" />
                  : <span className="stm-team-conf-row__dot" style={{ background: t.color }} />
                }
                <span className="stm-team-conf-row__name">{t.name}</span>
                <span className="stm-team-conf-row__badge">{t.sportIds.length}</span>
              </button>
            ))}
          </div>
          <div className="stm-confirm-col">
            <h4>{activeTeam?.name?.toUpperCase() || 'TEAM'}</h4>
            {(activeTeam?.sportIds || []).length === 0
              ? <p className="stm-empty-note">No sports selected.</p>
              : (activeTeam?.sportIds || []).map(s => (
                <div key={s} className="stm-confirm-cell">{s}</div>
              ))
            }
          </div>
        </div>
        <div className="stm-confirm-actions">
          <button className="stm-btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="stm-btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════ */
export default function SportsTeamsManager({ level }) {
  const [sportsRows,  setSportsRows]  = useState([]);
  const [teamsRows,   setTeamsRows]   = useState([]);
  const [sportsList,  setSportsList]  = useState([]);
  const [teamsList,   setTeamsList]   = useState([]);

  const [catTarget,         setCatTarget]         = useState(null); // sport row id
  const [violTarget,        setViolTarget]        = useState(null); // sport row id
  const [posTarget,         setPosTarget]         = useState(null); // sport row id
  const [pickerTarget,      setPickerTarget]      = useState(null); // team row id
  const [showSportsConfirm, setShowSportsConfirm] = useState(false);
  const [showTeamsConfirm,  setShowTeamsConfirm]  = useState(false);
  const [deleteSportTarget, setDeleteSportTarget] = useState(null); // sport object pending delete
  const [deletingSport,     setDeletingSport]     = useState(false);
  const [deleteTeamTarget,  setDeleteTeamTarget]  = useState(null); // team object pending delete
  const [deletingTeam,      setDeletingTeam]      = useState(false);
  const [editSportTarget,   setEditSportTarget]   = useState(null); // sport object being edited in popup
  const [savingEditSport,   setSavingEditSport]   = useState(false);
  const [editTeamTarget,    setEditTeamTarget]    = useState(null); // saved team being edited in popup
  const [savingEditTeam,    setSavingEditTeam]    = useState(false);

  const [saving,  setSaving]  = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast,   setToast]   = useState('');

  /* ── Load from Firestore ── */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getSportsTeamsConfig(level);
      const sports = (cfg.sports || []).map(s => ({
        ...ensureId(s),
        logo: s.logo || null,
        categoryGroups: (s.categoryGroups || (s.categories
          ? [{ id: uid(), label: 'DIVISION', divisions: s.categories.map(ensureId) }]
          : [])).map(g => ({ ...ensureId(g), divisions: (g.divisions || []).map(ensureId) })),
        violations: (s.violations || []).map(ensureId),
        positions: s.positions || [],
      }));
      const teams = (cfg.teams || []).map(t => ({
        ...ensureId(t),
        logo: t.logo || null,
        sportIds: t.sportIds || [],
        color: t.color || TEAM_COLORS[0],
      }));
      setSportsList(sports);
      setTeamsList(teams);
      setSportsRows([]);
      setTeamsRows([]);
    } catch (e) {
      console.error('Load error:', e);
    } finally {
      setLoading(false);
    }
  }, [level]);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2800); };

  /* ── Sport row helpers ── */
  const setSportsCount = (n) => setSportsRows(prev => {
    const next = [...prev];
    while (next.length < n) next.push({ id: uid(), name: '', logo: null, categoryGroups: [], violations: [], positions: [] });
    while (next.length > n) next.pop();
    return next;
  });
  const updateSportRow = (id, patch) =>
    setSportsRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  const removeSportRow = (id) =>
    setSportsRows(prev => prev.filter(r => r.id !== id));
  const resetSportsForm = () => setSportsRows([]);

  const submitSports = () => {
    if (!sportsRows.some(r => r.name.trim())) { flash('Enter at least one sport name.'); return; }
    setShowSportsConfirm(true);
  };

  /* ── Edit a saved sport via popup ── */
  const saveEditedSport = async (updatedSport) => {
    const previous = sportsList.find(s => s.id === updatedSport.id);
    const merged = sportsList.map(s => s.id === updatedSport.id ? updatedSport : s);
    setSportsList(merged);
    setSavingEditSport(true);

    /* A team stores the sport NAME in sportIds, so renaming a sport used to
       leave every team pointing at a sport that no longer exists — they
       silently vanished from that sport's team pool in the schedule
       generator. Follow the rename through to the teams. */
    const renamed = previous && norm(previous.name) !== norm(updatedSport.name);
    const retargetedTeams = renamed
      ? teamsList.map(t => ({
          ...t,
          sportIds: (t.sportIds || []).map(sportName =>
            norm(sportName) === norm(previous.name) ? updatedSport.name : sportName),
        }))
      : null;
    if (retargetedTeams) setTeamsList(retargetedTeams);

    try {
      await saveSportsConfig(level, merged);
      if (retargetedTeams) await saveTeamsConfig(level, retargetedTeams);
      flash(`✓ "${updatedSport.name}" updated.`);
      setEditSportTarget(null);
    } catch (e) {
      console.error(e);
      flash('Saved locally — Firestore sync failed.');
      setEditSportTarget(null);
    } finally {
      setSavingEditSport(false);
    }
  };

  /* ── Edit a saved team via popup ── */
  const saveEditedTeam = async (updatedTeam) => {
    const merged = teamsList.map(t => t.id === updatedTeam.id ? updatedTeam : t);
    setTeamsList(merged);
    setSavingEditTeam(true);
    try {
      await saveTeamsConfig(level, merged);
      flash(`✓ "${updatedTeam.name}" updated.`);
      setEditTeamTarget(null);
    } catch (e) {
      console.error(e);
      flash('Saved locally — Firestore sync failed.');
      setEditTeamTarget(null);
    } finally {
      setSavingEditTeam(false);
    }
  };

  /* ── Delete a saved sport ── */
  const deleteSport = async (sport) => {
    const remaining = sportsList.filter(s => s.id !== sport.id);
    setSportsList(remaining);
    setDeleteSportTarget(null);
    setDeletingSport(true);
    try {
      await saveSportsConfig(level, remaining);
      flash(`✓ "${sport.name}" deleted.`);
    } catch (e) {
      console.error(e);
      flash('Deleted locally — Firestore sync failed.');
    } finally {
      setDeletingSport(false);
    }
  };
  const saveSports = async () => {
    const cleaned = sportsRows.filter(r => r.name.trim());
    /* Re-submitting a name that is already saved updates that entry and
       KEEPS ITS ID. The old exact-string compare let "basketball" through
       as a second row next to "Basketball", and even an exact match got a
       brand-new id, which broke anything already pointing at the old one. */
    const merged = [
      ...sportsList.map(s => {
        const replacement = cleaned.find(c => norm(c.name) === norm(s.name));
        return replacement ? { ...replacement, id: s.id } : s;
      }),
      ...cleaned.filter(c => !sportsList.some(s => norm(s.name) === norm(c.name))),
    ];
    // Update local state immediately so preview reflects changes right away
    setSportsList(merged);
    setSportsRows([]);
    setShowSportsConfirm(false);
    // Then persist to Firestore in background
    setSaving(true);
    try {
      await saveSportsConfig(level, merged);
      flash('✓ Sports saved!');
    } catch (e) {
      console.error(e);
      flash('Saved locally — Firestore sync failed.');
    } finally {
      setSaving(false);
    }
  };

  /* ── Team row helpers ── */
  const addTeamRow = () => setTeamsRows(prev => [
    ...prev,
    { id: uid(), name: '', logo: null, sportIds: [], color: TEAM_COLORS[prev.length % TEAM_COLORS.length] },
  ]);
  const updateTeamRow = (id, patch) =>
    setTeamsRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  const removeTeamRow = (id) =>
    setTeamsRows(prev => prev.filter(r => r.id !== id));

  const submitTeams = () => {
    if (!teamsRows.some(r => r.name.trim())) { flash('Enter at least one team name.'); return; }
    setShowTeamsConfirm(true);
  };

  const saveTeams = async () => {
    const cleaned = teamsRows.filter(r => r.name.trim());
    const merged = [
      ...teamsList.map(t => {
        const replacement = cleaned.find(c => norm(c.name) === norm(t.name));
        return replacement ? { ...replacement, id: t.id } : t;
      }),
      ...cleaned.filter(c => !teamsList.some(t => norm(t.name) === norm(c.name))),
    ];
    // Update local state immediately so preview reflects changes right away
    setTeamsList(merged);
    setTeamsRows([]);
    setShowTeamsConfirm(false);
    // Then persist to Firestore in background
    setSaving(true);
    try {
      await saveTeamsConfig(level, merged);
      flash('✓ Teams saved!');
    } catch (e) {
      console.error(e);
      flash('Saved locally — Firestore sync failed.');
    } finally {
      setSaving(false);
    }
  };

  const resetTeamsForm = () => {
    setTeamsRows([]);
  };

  /* ── Delete a saved team ── */
  const deleteTeam = async (team) => {
    const remaining = teamsList.filter(t => t.id !== team.id);
    setTeamsList(remaining);
    setDeleteTeamTarget(null);
    setDeletingTeam(true);
    try {
      await saveTeamsConfig(level, remaining);
      flash(`✓ "${team.name}" deleted.`);
    } catch (e) {
      console.error(e);
      flash('Deleted locally — Firestore sync failed.');
    } finally {
      setDeletingTeam(false);
    }
  };

  /* ── Derived ── */
  const catSportRow  = sportsRows.find(r => r.id === catTarget)     || null;
  const violSportRow = sportsRows.find(r => r.id === violTarget)    || null;
  const posSportRow  = sportsRows.find(r => r.id === posTarget)     || null;
  const pickerTeam   = teamsRows.find(r => r.id === pickerTarget)   || null;

  const flatDivisions = (sport) =>
    (sport?.categoryGroups || []).flatMap(g => {
      const divs = g.divisions || [];
      if (divs.length === 0) {
        // No sub-divisions: represent the category group itself
        return [{ id: g.id + '_lbl', name: g.label, format: '', groupLabel: g.label }];
      }
      return divs.map(d => ({
        ...d,
        name: d.name || g.label, // fall back to group label if division name is blank
        groupLabel: g.label,
      }));
    });

  const totalDivisions = (sport) => flatDivisions(sport).length;

  return (
    <div className="stm-wrap">
      {toast   && <div className="stm-toast">{toast}</div>}
      {loading && <div className="stm-loading">Loading…</div>}

      {/* ════════ SPORTS FORM ════════ */}
      <div className="stm-card">
        <div className="stm-card__head">
          <FaRunning className="stm-card__icon" />
          <div>
            <h3>SPORTS</h3>
            <p>Add sport that will be part of the event.</p>
          </div>
        </div>

        <div className="stm-form-toprow">
          <button type="button" className="stm-link-btn" onClick={() => setSportsCount(sportsRows.length + 1)}>
            <FaPlus /> Add Row for Sports
          </button>
        </div>

        {sportsRows.length > 0 && (
          <div className="stm-table-wrap">
            <table className="stm-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Sports Name</th>
                  <th>Logo</th>
                  <th>Categories</th>
                  <th>Division</th>
                  <th>Violations</th>
                  <th>Positions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sportsRows.map((row, i) => (
                  <tr key={row.id}>
                    <td><span className="stm-num-badge">{i + 1}</span></td>
                    <td>
                      <input
                        className="stm-row-input"
                        placeholder="Sport name"
                        value={row.name}
                        onChange={e => updateSportRow(row.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <LogoUpload
                        logo={row.logo}
                        onUpload={(b64) => updateSportRow(row.id, { logo: b64 })}
                        onClear={() => updateSportRow(row.id, { logo: null })}
                        showClearButton
                      />
                    </td>
                    <td className="stm-td-center">
                      {row.categoryGroups.length > 0 ? row.categoryGroups.length : '—'}
                    </td>
                    <td>
                      <div className="stm-cat-count-cell">
                        <span className="stm-cat-badge">{totalDivisions(row) || '—'}</span>
                        <button
                          type="button"
                          className="stm-plus-btn"
                          title="Set categories & divisions"
                          onClick={() => setCatTarget(row.id)}
                        >
                          <FaPlus />
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="stm-cat-count-cell">
                        <span className="stm-cat-badge">{row.violations.length || '—'}</span>
                        <button
                          type="button"
                          className="stm-plus-btn"
                          title="Set violation types"
                          onClick={() => setViolTarget(row.id)}
                        >
                          <FaPlus />
                        </button>
                      </div>
                    </td>
                    <td>
                      <div className="stm-cat-count-cell">
                        <span className="stm-cat-badge">{(row.positions || []).length || '—'}</span>
                        <button
                          type="button"
                          className="stm-plus-btn"
                          title="Set player positions"
                          onClick={() => setPosTarget(row.id)}
                        >
                          <FaPlus />
                        </button>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="stm-dots-btn"
                        onClick={() => removeSportRow(row.id)}
                        title="Remove"
                      >
                        <FaTimes />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="stm-form-actions">
          <button type="button" className="stm-btn-ghost" onClick={resetSportsForm}>
            <FaSync style={{ marginRight: 5, fontSize: '0.7rem' }} /> Reset
          </button>
          <button type="button" className="stm-btn-primary" onClick={submitSports} disabled={saving}>Submit</button>
        </div>
      </div>

      {/* ════════ SPORTS PREVIEW ════════ */}
      <div className="stm-card stm-card--preview">
        <h4 className="stm-preview-title">
          SPORTS PREVIEW
          {sportsList.length > 0 && <span className="stm-preview-count">{sportsList.length} saved</span>}
        </h4>
        <p className="stm-preview-sub">
          Every sport already saved for this level, with its categories, divisions, and format. Edit or delete any row.
        </p>

        {sportsList.length === 0 ? (
          <p className="stm-empty-note">No sports saved yet.</p>
        ) : (
          <div className="stm-table-wrap stm-table-wrap--sports-preview">
            <table className="stm-table stm-preview-table">
              <thead>
                <tr>
                  <th>Sports</th>
                  <th>Category</th>
                  <th>Division</th>
                  <th>Sports Format</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {[...sportsList]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .flatMap(sport => {
                    const divisions = flatDivisions(sport);

                    const EditDeleteActions = (
                      <div className="stm-preview-table__actions">
                        <button
                          type="button"
                          className="stm-preview-edit-btn"
                          title="Edit sport"
                          onClick={() => setEditSportTarget(sport)}
                        >
                          <FaEdit />
                        </button>
                        <button
                          type="button"
                          className="stm-preview-delete-btn"
                          title="Delete sport"
                          onClick={() => setDeleteSportTarget(sport)}
                        >
                          <FaTimes />
                        </button>
                      </div>
                    );

                    if (divisions.length === 0) {
                      return [(
                        <tr key={sport.id} className="stm-preview-table__sport-group">
                          <td className="stm-preview-table__sport">{sport.name.toUpperCase()}</td>
                          <td><span className="stm-empty-note">—</span></td>
                          <td><span className="stm-empty-note">No categories set.</span></td>
                          <td><span className="stm-empty-note">—</span></td>
                          <td>{EditDeleteActions}</td>
                        </tr>
                      )];
                    }

                    return divisions.map((d, i) => {
                      const isFirstOfSport = i === 0;
                      const isFirstOfCategory = i === 0 || divisions[i - 1].groupLabel !== d.groupLabel;

                      // Count how many contiguous rows share this category label
                      let span = 0;
                      if (isFirstOfCategory) {
                        for (let k = i; k < divisions.length && divisions[k].groupLabel === d.groupLabel; k++) span++;
                      }

                      const f = FORMAT_OPTIONS.find(o => o.id === d.format);
                      return (
                        <tr
                          key={d.id || i}
                          className={isFirstOfSport ? 'stm-preview-table__sport-group' : ''}
                        >
                          {isFirstOfSport && (
                            <td className="stm-preview-table__sport" rowSpan={divisions.length}>
                              {sport.name.toUpperCase()}
                            </td>
                          )}
                          {isFirstOfCategory && (
                            <td className="stm-preview-table__category" rowSpan={span}>
                              {d.groupLabel}
                            </td>
                          )}
                          <td>{d.name.toUpperCase()}</td>
                          <td>{f ? f.label : '—'}</td>
                          {isFirstOfSport && (
                            <td rowSpan={divisions.length}>{EditDeleteActions}</td>
                          )}
                        </tr>
                      );
                    });
                  })}
              </tbody>
            </table>
          </div>
        )}

        {/* Mobile-only card view — the table above uses rowSpan to merge
            the Sport/Category/Action cells across their divisions, which
            has no equivalent once a row becomes its own stacked card (a
            div-per-<tr> transform would just drop those cells from every
            row after the first). Rendered from the same sportsList, shown
            instead of the table below stm-preview-mobile-breakpoint. */}
        {sportsList.length > 0 && (
          <div className="stm-preview-cards">
            {[...sportsList]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(sport => {
                const divisions = flatDivisions(sport);
                const categories = [];
                divisions.forEach(d => {
                  let group = categories.find(c => c.label === d.groupLabel);
                  if (!group) { group = { label: d.groupLabel, items: [] }; categories.push(group); }
                  group.items.push(d);
                });
                return (
                  <div className="stm-preview-card" key={sport.id}>
                    <div className="stm-preview-card__head">
                      <span className="stm-preview-card__title">{sport.name.toUpperCase()}</span>
                      <div className="stm-preview-table__actions">
                        <button type="button" className="stm-preview-edit-btn" title="Edit sport" onClick={() => setEditSportTarget(sport)}>
                          <FaEdit />
                        </button>
                        <button type="button" className="stm-preview-delete-btn" title="Delete sport" onClick={() => setDeleteSportTarget(sport)}>
                          <FaTimes />
                        </button>
                      </div>
                    </div>
                    {divisions.length === 0 ? (
                      <p className="stm-empty-note">No categories set.</p>
                    ) : (
                      categories.map(group => (
                        <div className="stm-preview-card__group" key={group.label}>
                          <span className="stm-preview-card__group-label">{group.label}</span>
                          {group.items.map((d, i) => {
                            const f = FORMAT_OPTIONS.find(o => o.id === d.format);
                            return (
                              <div className="stm-preview-card__row" key={d.id || i}>
                                <span>{d.name.toUpperCase()}</span>
                                <span className="stm-preview-card__format">{f ? f.label : '—'}</span>
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* ════════ TEAMS FORM ════════ */}
      <div className="stm-card">
        <div className="stm-card__head">
          <FaUsers className="stm-card__icon" />
          <div>
            <h3>TEAMS</h3>
            <p>Add teams that will participate in the selected sports.</p>
          </div>
        </div>

        <div className="stm-form-toprow">
          <button type="button" className="stm-link-btn" onClick={addTeamRow}>
            <FaPlus /> Add row for Teams
          </button>
        </div>

        {teamsRows.length > 0 && (
          <div className="stm-table-wrap">
            <table className="stm-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team Name</th>
                  <th>Logo</th>
                  <th>Sports</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {teamsRows.map((row, i) => (
                  <tr key={row.id}>
                    <td><span className="stm-num-badge">{i + 1}</span></td>
                    <td>
                      <input
                        className="stm-row-input"
                        placeholder="Team name"
                        value={row.name}
                        onChange={e => updateTeamRow(row.id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <LogoUpload
                        logo={row.logo}
                        onUpload={(b64) => updateTeamRow(row.id, { logo: b64 })}
                        onClear={() => updateTeamRow(row.id, { logo: null })}
                        showClearButton
                      />
                    </td>
                    <td>
                      <div className="stm-cat-count-cell">
                        <span className="stm-cat-badge">{row.sportIds.length || '—'}</span>
                        <button
                          type="button"
                          className="stm-plus-btn"
                          title="Select sports"
                          onClick={() => setPickerTarget(row.id)}
                        >
                          <FaPlus />
                        </button>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="stm-dots-btn"
                        onClick={() => removeTeamRow(row.id)}
                        title="Remove"
                      >
                        <FaTimes />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="stm-form-actions">
          <button type="button" className="stm-btn-ghost" onClick={resetTeamsForm}>
            <FaSync style={{ marginRight: 5, fontSize: '0.7rem' }} /> Reset
          </button>
          <button type="button" className="stm-btn-primary" onClick={submitTeams} disabled={saving}>Submit</button>
        </div>
      </div>

      {/* ════════ TEAMS PREVIEW ════════ */}
      <div className="stm-card stm-card--preview">
        <h4 className="stm-preview-title">
          TEAMS PREVIEW
          {teamsList.length > 0 && <span className="stm-preview-count">{teamsList.length} saved</span>}
        </h4>
        <p className="stm-preview-sub">
          Every team already saved for this level, with the sports it plays. Edit or delete any row.
        </p>

        {/* The dropdown here only ever showed one team at a time, and offered
            no way to edit — you had to delete and re-add. Everything saved is
            listed instead, each row editable in place. */}
        {teamsList.length === 0 ? (
          <p className="stm-empty-note">No teams saved yet. Add and submit teams above.</p>
        ) : (
          <div className="stm-table-wrap">
            <table className="stm-table stm-preview-table">
              <thead>
                <tr>
                  <th>Logo</th>
                  <th>Team</th>
                  <th>Sports</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {[...teamsList]
                  .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                  .map(team => (
                    <tr key={team.id}>
                      <td data-label="Logo">
                        {team.logo
                          ? <img src={team.logo} alt="" className="stm-preview-team-logo" />
                          : (
                            <span className="stm-preview-team-initials" style={{ background: team.color || TEAM_COLORS[0] }}>
                              {(team.name || '?').slice(0, 2).toUpperCase()}
                            </span>
                          )}
                      </td>
                      <td className="stm-preview-table__sport" data-label="Team">{(team.name || '').toUpperCase()}</td>
                      <td data-label="Sports">
                        {(team.sportIds || []).length === 0 ? (
                          <span className="stm-empty-note">No sports assigned.</span>
                        ) : (
                          <ul className="stm-preview-list stm-preview-list--cols">
                            {team.sportIds.map(sport => <li key={sport}>{sport}</li>)}
                          </ul>
                        )}
                      </td>
                      <td data-label="Action">
                        <div className="stm-preview-table__actions">
                          <button
                            type="button"
                            className="stm-preview-edit-btn"
                            title="Edit team"
                            onClick={() => setEditTeamTarget(team)}
                          >
                            <FaEdit />
                          </button>
                          <button
                            type="button"
                            className="stm-preview-delete-btn"
                            title="Delete team"
                            onClick={() => setDeleteTeamTarget(team)}
                          >
                            <FaTimes />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ════════ MODALS ════════ */}
      {catSportRow && (
        <CategoryModal
          sport={catSportRow}
          onClose={() => setCatTarget(null)}
          onSave={(groups) => {
            updateSportRow(catSportRow.id, { categoryGroups: groups });
            setCatTarget(null);
          }}
        />
      )}

      {violSportRow && (
        <ViolationsAdminModal
          sport={violSportRow}
          onClose={() => setViolTarget(null)}
          onSave={(violations) => {
            updateSportRow(violSportRow.id, { violations });
            setViolTarget(null);
          }}
        />
      )}

      {posSportRow && (
        <PositionsModal
          sport={posSportRow}
          onClose={() => setPosTarget(null)}
          onSave={(list) => {
            updateSportRow(posSportRow.id, { positions: list });
            setPosTarget(null);
          }}
        />
      )}

      {showSportsConfirm && (
        <SportsConfirmModal
          sports={sportsRows.filter(r => r.name.trim())}
          saving={saving}
          onClose={() => setShowSportsConfirm(false)}
          onSave={saveSports}
        />
      )}

      {editSportTarget && (
        <EditSportModal
          sport={editSportTarget}
          saving={savingEditSport}
          onClose={() => setEditSportTarget(null)}
          onSave={saveEditedSport}
        />
      )}

      {deleteSportTarget && (
        <div className="stm-overlay" onClick={() => setDeleteSportTarget(null)}>
          <div className="stm-modal stm-modal--delete" onClick={e => e.stopPropagation()}>
            <h3 className="stm-confirm-title">DELETE SPORT?</h3>
            <p className="stm-delete-msg">
              Are you sure you want to delete <b>{deleteSportTarget.name.toUpperCase()}</b>?
              This will remove it and its categories/divisions from {level === 'highSchool' ? 'High School' : level.charAt(0).toUpperCase() + level.slice(1)}.
            </p>
            <div className="stm-delete-actions">
              <button type="button" className="stm-btn-ghost" onClick={() => setDeleteSportTarget(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="stm-btn-danger"
                disabled={deletingSport}
                onClick={() => deleteSport(deleteSportTarget)}
              >
                {deletingSport ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTeamTarget && (
        <div className="stm-overlay" onClick={() => setDeleteTeamTarget(null)}>
          <div className="stm-modal stm-modal--delete" onClick={e => e.stopPropagation()}>
            <h3 className="stm-confirm-title">DELETE TEAM?</h3>
            <p className="stm-delete-msg">
              Are you sure you want to delete <b>{deleteTeamTarget.name.toUpperCase()}</b>?
              This will remove it from {level === 'highSchool' ? 'High School' : level.charAt(0).toUpperCase() + level.slice(1)} and unassign it from any sports.
            </p>
            <div className="stm-delete-actions">
              <button type="button" className="stm-btn-ghost" onClick={() => setDeleteTeamTarget(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="stm-btn-danger"
                disabled={deletingTeam}
                onClick={() => deleteTeam(deleteTeamTarget)}
              >
                {deletingTeam ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pickerTeam && (
        <TeamSportsPickerModal
          team={pickerTeam}
          sportsList={sportsList.length ? sportsList : sportsRows.filter(r => r.name.trim())}
          onClose={() => setPickerTarget(null)}
          onSave={(ids) => {
            updateTeamRow(pickerTeam.id, { sportIds: ids });
            setPickerTarget(null);
          }}
        />
      )}

      {editTeamTarget && (
        <EditTeamModal
          team={editTeamTarget}
          sportsList={sportsList}
          saving={savingEditTeam}
          onClose={() => setEditTeamTarget(null)}
          onSave={saveEditedTeam}
        />
      )}

      {showTeamsConfirm && (
        <TeamsConfirmModal
          teams={teamsRows.filter(r => r.name.trim())}
          saving={saving}
          onClose={() => setShowTeamsConfirm(false)}
          onSave={saveTeams}
        />
      )}
    </div>
  );
}