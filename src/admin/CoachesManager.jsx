import { useContext, useEffect, useMemo, useState } from 'react';
import { FaUserTie, FaEdit, FaTrash, FaPlus, FaCheck, FaPhoneAlt, FaEnvelope, FaSync, FaCopy, FaKey } from 'react-icons/fa';
import { AuthContext } from '../shared/context/AuthContext';
import {
  subscribeCoaches, subscribeSportsTeamsConfig, saveCoach, deleteCoach, getAllRegistrations, normalizeCoachEmail,
  removeCoachAndAccount,
  ensureCoachAccount,
} from '../shared/services/firestoreService';
import { validatePassword } from '../shared/utils/validation';
import { coachDivisionOptions, coachHandles } from '../shared/utils/coachScope';
import './CoachesManager.css';

const EMPTY_FORM = { email: '', name: '', contactNumber: '', bio: '', teams: [], sports: [], divisions: [], password: '' };
const normName = (v) => String(v || '').trim().toLowerCase();
const toggle = (list, value) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function friendlyCoachError(err) {
  // Cloud Function errors (ensureCoachAccount) already carry a readable message.
  if (String(err?.code || '').startsWith('functions/') && err.message) return err.message;
  if (err?.code === 'permission-denied' || /permission/i.test(err?.message || '')) {
    return 'Not allowed — this email may already be a coach on another school level.';
  }
  return err?.message || 'Could not save — check your connection and try again.';
}

/* ── Coaches (per school level) ──
   A coach is a regular signed-up account whose email is listed in
   coaches/{email}. Assigning them here to teams (and optionally only some
   of those teams' sports) gives them a "My Players" page with the profile
   and contact details of every player registered under those teams. */
export default function CoachesManager({ level, levelLabel }) {
  const { userProfile } = useContext(AuthContext);
  const [coaches, setCoaches] = useState([]);
  const [teams, setTeams] = useState([]);
  const [sportsCfg, setSportsCfg] = useState([]);
  const [registrations, setRegistrations] = useState([]);
  // Which level's coach list has arrived — loading until it matches `level`.
  const [loadedLevel, setLoadedLevel] = useState(null);
  const loading = loadedLevel !== level;
  const [toast, setToast] = useState(null);

  const [editing, setEditing] = useState(null); // null | 'new' | coach object
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Login details to hand the coach after a save created their account.
  const [newAccount, setNewAccount] = useState(null); // { email, password, generated }
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsubCoaches = subscribeCoaches(level, (list) => { setCoaches(list); setLoadedLevel(level); });
    const unsubTeams = subscribeSportsTeamsConfig(level, (cfg) => {
      setTeams((cfg.teams || []).filter((t) => t?.name?.trim()).sort((a, b) => a.name.localeCompare(b.name)));
      setSportsCfg(cfg.sports || []);
    });
    return () => { unsubCoaches(); unsubTeams(); };
  }, [level]);

  useEffect(() => {
    getAllRegistrations().then(setRegistrations).catch((e) => console.warn('Could not load registrations for player counts:', e));
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const teamNames = useMemo(() => new Set(teams.map((t) => t.name)), [teams]);

  // Category/division checkboxes per sport (from Sports & Teams).
  const divisionOptionsBySport = useMemo(() => {
    const map = new Map();
    sportsCfg.forEach((sp) => map.set(normName(sp.name), coachDivisionOptions(sp)));
    return map;
  }, [sportsCfg]);
  const divisionOptionsFor = (sportName) => divisionOptionsBySport.get(normName(sportName)) || [];
  const divisionLabelByKey = useMemo(() => {
    const map = new Map();
    divisionOptionsBySport.forEach((opts) => opts.forEach((o) => map.set(o.key, o.label)));
    return map;
  }, [divisionOptionsBySport]);
  const allDivisionKeys = (sportNames) => sportNames.flatMap((sp) => divisionOptionsFor(sp).map((o) => o.key));

  // Ticking a sport ticks all its categories/divisions; unticking clears them.
  const toggleSport = (sport) => setForm((f) => {
    const on = !f.sports.includes(sport);
    const keys = divisionOptionsFor(sport).map((o) => o.key);
    return {
      ...f,
      sports: toggle(f.sports, sport),
      divisions: on ? [...new Set([...f.divisions, ...keys])] : f.divisions.filter((k) => !keys.includes(k)),
    };
  });

  // Sports offered in the form = every sport played by the selected teams.
  const sportChoices = useMemo(() => {
    const picked = teams.filter((t) => form.teams.includes(t.name));
    return [...new Set(picked.flatMap((t) => t.sportIds || []))].sort();
  }, [teams, form.teams]);

  const playerCount = (coach) => registrations.filter((r) => (
    coachHandles(coach, r) && r.status !== 'rejected'
  )).length;

  const openNew = () => {
    setForm(EMPTY_FORM);
    setFormError('');
    setEditing('new');
  };

  const openEdit = (coach) => {
    setForm({
      email: coach.email || coach.id,
      name: coach.name || '',
      contactNumber: coach.contactNumber || '',
      bio: coach.bio || '',
      teams: coach.teams || [],
      sports: coach.sports || [],
      // No saved divisions = the whole of each sport → show them all ticked.
      divisions: (coach.divisions || []).length ? coach.divisions : allDivisionKeys(coach.sports || []),
      password: '',
    });
    setFormError('');
    setEditing(coach);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const isNew = editing === 'new';
    const email = normalizeCoachEmail(form.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError('Enter the coach\'s account email.');
      return;
    }
    if (isNew && coaches.some((c) => c.id === email)) {
      setFormError('This email is already a coach — edit the existing entry instead.');
      return;
    }
    if (form.teams.length === 0) {
      setFormError('Pick at least one team this coach handles.');
      return;
    }
    if (form.contactNumber && !/^[+0-9 ()-]{7,20}$/.test(form.contactNumber.trim())) {
      setFormError('Enter a valid contact number (digits, spaces, + or -).');
      return;
    }
    const sportMissingDivision = form.sports.find((sp) => sportChoices.includes(sp)
      && divisionOptionsFor(sp).length > 0
      && !divisionOptionsFor(sp).some((o) => form.divisions.includes(o.key)));
    if (sportMissingDivision) {
      setFormError(`Pick at least one category/division for ${sportMissingDivision}, or untick the sport.`);
      return;
    }
    const passwordError = form.password ? validatePassword(form.password) : null;
    if (passwordError) {
      setFormError(passwordError);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      // Drop sports no selected team plays (e.g. after unticking a team).
      const sports = form.sports.filter((s) => sportChoices.includes(s));
      // Keep only the picked sports' divisions; everything ticked = save []
      // ("all"), so divisions added to those sports later are included too.
      const validKeys = allDivisionKeys(sports);
      const picked = form.divisions.filter((k) => validKeys.includes(k));
      const divisions = picked.length === validKeys.length ? [] : picked;
      // Make sure the coach can actually log in BEFORE granting coach
      // access — runs on edits too, so a coach saved before this check
      // existed (with no account behind the email) gets one on next save.
      const account = await ensureCoachAccount({ email, name: form.name.trim(), level, password: form.password });
      await saveCoach({ ...form, email, sports, divisions, level }, userProfile?.role, { isNew });
      setEditing(null);
      if (account.created) {
        setCopied(false);
        setNewAccount({ email, password: account.tempPassword || form.password, generated: !!account.tempPassword });
      } else {
        setToast(form.password
          ? `${isNew ? 'Coach added' : 'Coach updated'} — ${email} already had an account, so its password was not changed.`
          : (isNew ? 'Coach added.' : 'Coach updated.'));
      }
    } catch (err) {
      console.error('Failed to save coach:', err);
      setFormError(friendlyCoachError(err));
    } finally {
      setSaving(false);
    }
  };

  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  // withAccount: also delete their login (server side, removeCoach). The
  // server keeps the login when it's also a staff/player account.
  const handleDelete = async (withAccount) => {
    const coach = confirmDelete;
    const label = coach.name || coach.id;
    setRemoving(true);
    setRemoveError('');
    try {
      if (withAccount) {
        const { accountDeleted, keptReason } = await removeCoachAndAccount(coach.id);
        setToast(accountDeleted
          ? `${label} removed and their account deleted.`
          : keptReason === 'staff'
            ? `${label} removed as coach. Their login was kept because it's also a staff account.`
            : keptReason === 'player'
              ? `${label} removed as coach. Their login was kept because it also has a player registration.`
              : `${label} removed as coach (they had no login account).`);
      } else {
        await deleteCoach(coach.id, userProfile?.role, label);
        setToast(`${label} removed as coach. Their account was kept.`);
      }
      setConfirmDelete(null);
    } catch (err) {
      console.error('Failed to remove coach:', err);
      setRemoveError(friendlyCoachError(err));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="msf-wrap">
      <div className="msf-card">
        <div className="msf-list-head">
          <div>
            <h2>Coaches · {levelLabel}</h2>
            <p className="msf-muted">
              Coaches log in with their own account and see the profiles and contact details of the players on the teams you assign them.
            </p>
          </div>
          <button type="button" className="msf-btn-primary" onClick={openNew}>
            <FaPlus /> Add Coach
          </button>
        </div>

        {loading ? (
          <p className="msf-empty">Loading coaches…</p>
        ) : coaches.length === 0 ? (
          <p className="msf-empty">No coaches yet for {levelLabel}. Add one above.</p>
        ) : (
          <div className="cm-grid">
            {coaches.map((c) => (
              <div key={c.id} className="cm-card">
                <div className="cm-card__top">
                  <div className="cm-avatar">
                    {c.photoURL ? <img src={c.photoURL} alt={c.name || c.id} /> : <FaUserTie />}
                  </div>
                  <div className="cm-card__id">
                    <div className="cm-card__name">{c.name || c.id}</div>
                    <div className="cm-card__line"><FaEnvelope /> {c.id}</div>
                    {c.contactNumber && <div className="cm-card__line"><FaPhoneAlt /> {c.contactNumber}</div>}
                  </div>
                  <div className="cm-card__actions">
                    <button type="button" className="msf-icon-edit" title="Edit" onClick={() => openEdit(c)}><FaEdit /></button>
                    <button type="button" className="cm-icon-delete" title="Remove" onClick={() => setConfirmDelete(c)}><FaTrash /></button>
                  </div>
                </div>
                <div className="cm-chips">
                  {(c.teams || []).map((t) => (
                    <span key={t} className={`cm-chip cm-chip--team${teamNames.has(t) ? '' : ' cm-chip--stale'}`} title={teamNames.has(t) ? '' : 'This team no longer exists — edit the coach to fix it.'}>
                      {t}
                    </span>
                  ))}
                  {(c.sports || []).length
                    ? c.sports.flatMap((s) => {
                        // Narrowed to some divisions → one chip each ("Archery · Women · 30 Meters").
                        const keys = (c.divisions || []).filter((k) => k.startsWith(`${normName(s)}::`));
                        return keys.length
                          ? keys.map((k) => <span key={k} className="cm-chip">{s} · {divisionLabelByKey.get(k) || '(removed)'}</span>)
                          : [<span key={s} className="cm-chip">{s}</span>];
                      })
                    : <span className="cm-chip">All sports</span>}
                </div>
                <div className="cm-card__count">{playerCount(c)} player{playerCount(c) === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Add / Edit coach ── */}
      {editing && (
        <div className="msf-overlay" onClick={() => !saving && setEditing(null)}>
          <form className="cm-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSave}>
            <div className="cm-modal__head">
              <h3>{editing === 'new' ? 'Add Coach' : 'Edit Coach'}</h3>
            </div>
            <div className="cm-modal__body">
              <div className="msf-form-group">
                <label htmlFor="cm-email">Account email</label>
                <input
                  id="cm-email"
                  type="email"
                  value={form.email}
                  disabled={editing !== 'new'}
                  placeholder="coach@gmail.com"
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
                <p className="cm-hint">The coach signs up (or logs in) with this email to get coach access.</p>
              </div>
              <div className="msf-form-row">
                <div className="msf-form-group">
                  <label htmlFor="cm-name">Name</label>
                  <input id="cm-name" value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="msf-form-group">
                  <label htmlFor="cm-contact">Contact number</label>
                  <input id="cm-contact" value={form.contactNumber} maxLength={20} onChange={(e) => setForm({ ...form, contactNumber: e.target.value })} />
                </div>
              </div>

              <div className="msf-form-group">
                <label>Teams handled</label>
                {teams.length === 0 ? (
                  <p className="cm-hint">No teams for this level yet — add them in Sports &amp; Teams first.</p>
                ) : (
                  <div className="cm-pickgrid">
                    {teams.map((t) => (
                      <label key={t.id || t.name} className="msf-checkbox">
                        <input type="checkbox" checked={form.teams.includes(t.name)} onChange={() => setForm({ ...form, teams: toggle(form.teams, t.name) })} />
                        {t.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {sportChoices.length > 0 && (
                <div className="msf-form-group">
                  <label>Sports</label>
                  <p className="cm-hint">Leave all unticked if this coach handles every sport of the selected team(s).</p>
                  <div className="cm-pickgrid">
                    {sportChoices.map((s) => (
                      <label key={s} className="msf-checkbox">
                        <input type="checkbox" checked={form.sports.includes(s)} onChange={() => toggleSport(s)} />
                        {s}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {form.sports.filter((s) => sportChoices.includes(s) && divisionOptionsFor(s).length > 0).length > 0 && (
                <div className="msf-form-group">
                  <label>Categories &amp; divisions</label>
                  <p className="cm-hint">Which categories/divisions of each sport this coach handles.</p>
                  {form.sports.filter((s) => sportChoices.includes(s)).map((s) => {
                    const opts = divisionOptionsFor(s);
                    if (!opts.length) return null;
                    return (
                      <div key={s} className="cm-divgroup">
                        <span className="cm-divgroup__sport">{s}</span>
                        <div className="cm-pickgrid">
                          {opts.map((o) => (
                            <label key={o.key} className="msf-checkbox">
                              <input
                                type="checkbox"
                                checked={form.divisions.includes(o.key)}
                                onChange={() => setForm((f) => ({ ...f, divisions: toggle(f.divisions, o.key) }))}
                              />
                              {o.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="msf-form-group">
                <label htmlFor="cm-bio">About (optional)</label>
                <textarea id="cm-bio" rows={2} maxLength={500} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
              </div>

              <div className="msf-form-group">
                <label htmlFor="cm-password">Password</label>
                <input
                  id="cm-password"
                  type="text"
                  autoComplete="new-password"
                  value={form.password}
                  placeholder="Leave blank to generate one"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                <p className="cm-hint">
                  Used only if this email doesn&apos;t have an account yet — one is created on save. At least 8 characters
                  with an uppercase letter, a lowercase letter and a number. An existing account&apos;s password is never changed.
                </p>
              </div>

              {formError && <p className="cm-error">{formError}</p>}

              <div className="msf-form-actions">
                <button type="button" className="msf-btn-ghost" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
                <button type="submit" className="msf-btn-primary" disabled={saving}>
                  {saving && <FaSync className="cm-spin" />} Save
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* ── Remove confirmation ── */}
      {confirmDelete && (
        <div className="msf-overlay msf-overlay--nested" onClick={() => !removing && (setConfirmDelete(null), setRemoveError(''))}>
          <div className="msf-confirm-delete cm-remove" onClick={(e) => e.stopPropagation()}>
            <h3>Remove this coach?</h3>
            <p>
              <b>{confirmDelete.name || confirmDelete.id}</b> loses coach access and can no longer see their players.
            </p>
            <ul className="cm-remove__options">
              <li><b>Remove access only</b> — they keep their login and can still sign in as a regular account.</li>
              <li><b>Remove and delete account</b> — their login is deleted and can no longer be opened. This can&apos;t be undone.</li>
            </ul>
            {removeError && <p className="cm-error">{removeError}</p>}
            <div className="cm-remove__actions">
              <button type="button" className="msf-btn-danger" onClick={() => handleDelete(true)} disabled={removing}>
                {removing && <FaSync className="cm-spin" />} Remove and delete account
              </button>
              <button type="button" className="msf-btn-ghost" onClick={() => handleDelete(false)} disabled={removing}>
                Remove access only
              </button>
              <button type="button" className="msf-btn-ghost" onClick={() => { setConfirmDelete(null); setRemoveError(''); }} disabled={removing}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Login details for a newly created coach account ── */}
      {newAccount && (
        <div className="msf-overlay msf-overlay--nested" onClick={() => setNewAccount(null)}>
          <div className="msf-confirm-delete cm-account" onClick={(e) => e.stopPropagation()}>
            <h3><FaKey /> Coach account created</h3>
            <p>
              <b>{newAccount.email}</b> had no account, so one was created. Give the coach these login details
              privately — they can change the password after logging in via Profile → Change Password.
            </p>
            <div className="cm-account__row">
              <span className="cm-account__label">Email</span>
              <code>{newAccount.email}</code>
            </div>
            <div className="cm-account__row">
              <span className="cm-account__label">{newAccount.generated ? 'Temporary password' : 'Password'}</span>
              <code>{newAccount.password}</code>
              <button
                type="button"
                className="msf-icon-edit"
                title="Copy password"
                onClick={() => navigator.clipboard?.writeText(newAccount.password).then(() => setCopied(true)).catch(() => {})}
              >
                <FaCopy />
              </button>
            </div>
            {copied && <p className="cm-hint">Copied.</p>}
            <p className="cm-hint">This password won&apos;t be shown again.</p>
            <div className="msf-confirm-delete__actions">
              <button type="button" className="msf-btn-primary" onClick={() => setNewAccount(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="msf-toast"><FaCheck /> {toast}</div>}
    </div>
  );
}
