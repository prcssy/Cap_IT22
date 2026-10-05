import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaUserTie, FaPhoneAlt, FaEnvelope, FaUsers, FaCamera, FaEdit, FaTimes, FaSearch,
  FaCheckCircle, FaHourglassHalf, FaSync, FaFirstAid, FaMapMarkerAlt,
} from 'react-icons/fa';
import { AuthContext } from '../shared/context/AuthContext';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import { getCoachRoster, updateMyCoachProfile } from '../shared/services/firestoreService';
import { resizeImageToDataUrl } from '../shared/utils/resizeImage';
import { getSchoolLevel } from '../shared/utils/schoolLevel';
import { categoryDivisionLabel } from '../shared/utils/sportCategory';
import './CoachPage.css';

const MAX_PHOTO_SOURCE_BYTES = 5 * 1024 * 1024;
const PHOTO_OPTIONS = { maxWidth: 256, maxHeight: 256, mode: 'contain', format: 'jpeg', quality: 0.85, maxBytes: 60 * 1024 };

const STATUS_LABELS = { approved: 'Approved', pending: 'Pending', rejected: 'Rejected' };
const statusOf = (r) => (STATUS_LABELS[r.status] ? r.status : 'pending');

function Avatar({ src, name, className }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const initials = (name || '?').split(' ').filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className={className}>
      {src && src !== failedSrc
        ? <img src={src} alt={name || 'Photo'} onError={() => setFailedSrc(src)} />
        : <span>{initials}</span>}
    </div>
  );
}

/* ── The coach's own profile card (view + edit their own fields) ── */
function CoachProfileCard({ coach, email, levelLabel }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', contactNumber: '', bio: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  const startEdit = () => {
    setDraft({ name: coach.name || '', contactNumber: coach.contactNumber || '', bio: coach.bio || '' });
    setMsg(null);
    setEditing(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (draft.contactNumber && !/^[+0-9 ()-]{7,20}$/.test(draft.contactNumber.trim())) {
      setMsg({ tone: 'error', text: 'Enter a valid contact number (digits, spaces, + or -).' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await updateMyCoachProfile(email, draft);
      setEditing(false);
      setMsg({ tone: 'success', text: 'Profile updated.' });
    } catch (err) {
      console.error('Failed to update coach profile:', err);
      setMsg({ tone: 'error', text: 'Could not save your profile — check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  };

  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > MAX_PHOTO_SOURCE_BYTES) {
      setMsg({ tone: 'error', text: 'Choose an image file up to 5MB.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const photoURL = await resizeImageToDataUrl(file, PHOTO_OPTIONS);
      await updateMyCoachProfile(email, { photoURL });
      setMsg({ tone: 'success', text: 'Photo updated.' });
    } catch (err) {
      console.error('Failed to update coach photo:', err);
      setMsg({ tone: 'error', text: 'Could not upload that photo — try another image.' });
    } finally {
      setBusy(false);
    }
  };

  const teams = coach.teams || [];
  const sports = coach.sports || [];

  return (
    <div className="cp-card cp-profile">
      <div className="cp-profile__photo-wrap">
        <Avatar src={coach.photoURL} name={coach.name || email} className="cp-profile__photo" />
        <button
          type="button"
          className="cp-profile__photo-btn"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Change photo"
          title="Change photo"
        >
          <FaCamera />
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handlePhoto} />
      </div>

      {editing ? (
        <form className="cp-profile__form" onSubmit={save}>
          <label>
            Name
            <input value={draft.name} maxLength={100} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>
            Contact number
            <input value={draft.contactNumber} maxLength={20} placeholder="e.g. 0917 123 4567" onChange={(e) => setDraft({ ...draft, contactNumber: e.target.value })} />
          </label>
          <label className="cp-profile__form-wide">
            About / coaching background
            <textarea rows={3} value={draft.bio} maxLength={500} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} />
          </label>
          <div className="cp-profile__form-actions">
            <button type="button" className="cp-btn-ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="cp-btn-primary" disabled={busy}>
              {busy && <FaSync className="cp-spin" />} Save
            </button>
          </div>
        </form>
      ) : (
        <div className="cp-profile__info">
          <div className="cp-profile__top">
            <div>
              <h2 className="cp-profile__name">{coach.name || email}</h2>
              <span className="cp-role-badge"><FaUserTie /> Coach · {levelLabel}</span>
            </div>
            <button type="button" className="cp-btn-ghost" onClick={startEdit}><FaEdit /> Edit Profile</button>
          </div>
          <div className="cp-profile__contacts">
            <span><FaEnvelope /> {email}</span>
            <span><FaPhoneAlt /> {coach.contactNumber || <em>No contact number yet</em>}</span>
          </div>
          {coach.bio && <p className="cp-profile__bio">{coach.bio}</p>}
          <div className="cp-profile__assign">
            <div>
              <span className="cp-label">Team{teams.length === 1 ? '' : 's'} handled</span>
              <div className="cp-chips">
                {teams.length ? teams.map((t) => <span key={t} className="cp-chip cp-chip--team">{t}</span>) : <em>None assigned yet</em>}
              </div>
            </div>
            <div>
              <span className="cp-label">Sports</span>
              <div className="cp-chips">
                {sports.length ? sports.map((s) => <span key={s} className="cp-chip">{s}</span>) : <span className="cp-chip">All of the team&apos;s sports</span>}
              </div>
            </div>
          </div>
        </div>
      )}
      {msg && <p className={`cp-msg cp-msg--${msg.tone}`}>{msg.text}</p>}
    </div>
  );
}

/* ── One player's full registration details ── */
function PlayerModal({ player, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = [
    ['Team', player.teamName],
    ['Sport', player.sport],
    ['Category / Division', categoryDivisionLabel(player)],
    ['Position', player.position],
    ['Event', player.event],
    ['Grade / Year', [player.gradeLevel, player.section].filter(Boolean).join(' · ')],
    ['Gender', player.gender],
    ['Birthday', player.dob ? `${player.dob}${player.age ? ` (age ${player.age})` : ''}` : ''],
    ['Contact number', player.contactNumber],
    ['Email', player.studentEmail || player.email],
    ['Emergency contact', player.emergencyContact],
    ['Address', player.address],
  ];

  return (
    <div className="cp-overlay" onClick={onClose}>
      <div className="cp-modal" role="dialog" aria-modal="true" aria-label={player.fullName} onClick={(e) => e.stopPropagation()}>
        <div className="cp-modal__head">
          <Avatar src={player.photoURL} name={player.fullName} className="cp-player__photo" />
          <div>
            <h3>{player.fullName}</h3>
            <span className={`cp-status cp-status--${statusOf(player)}`}>{STATUS_LABELS[statusOf(player)]}</span>
          </div>
          <button type="button" className="cp-modal__close" onClick={onClose} aria-label="Close"><FaTimes /></button>
        </div>
        <div className="cp-modal__body">
          <dl className="cp-details">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || '—'}</dd>
              </div>
            ))}
          </dl>
          {player.message && (
            <div className="cp-details__note">
              <dt>Message</dt>
              <dd>{player.message}</dd>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CoachPage() {
  const { currentUser, coachProfile } = useContext(AuthContext);
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);

  // The last finished roster load, tagged with the request it answered —
  // loading until that tag matches the current request.
  const [result, setResult] = useState({ key: null, roster: [], error: '' });
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [sportFilter, setSportFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(null);

  const email = currentUser?.email?.toLowerCase() || '';
  const level = coachProfile?.level || null;
  // Re-query only when the assignment itself changes, not on every
  // profile edit (name/photo) that also re-emits the coach doc.
  const assignmentKey = JSON.stringify([coachProfile?.teams || [], coachProfile?.sports || []]);
  const requestKey = `${assignmentKey}|${level}|${reloadKey}`;
  const loading = result.key !== requestKey;
  const { roster, error } = result;

  useEffect(() => {
    if (!coachProfile) return undefined;
    let cancelled = false;
    getCoachRoster(coachProfile)
      .then((regs) => {
        if (cancelled) return;
        // Team names are per level, so drop a same-named team's players
        // from another level (registrations don't store a level of their own).
        setResult({
          key: requestKey,
          error: '',
          roster: regs.filter((r) => {
            const regLevel = getSchoolLevel(r.gradeLevel);
            return !level || !regLevel || regLevel === level;
          }),
        });
      })
      .catch((err) => {
        console.error('Failed to load roster:', err);
        if (!cancelled) setResult({ key: requestKey, roster: [], error: 'Could not load your players — check your connection and try again.' });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const counts = useMemo(() => ({
    total: roster.length,
    approved: roster.filter((r) => statusOf(r) === 'approved').length,
    pending: roster.filter((r) => statusOf(r) === 'pending').length,
  }), [roster]);

  const teamOptions = useMemo(() => [...new Set(roster.map((r) => r.teamName).filter(Boolean))].sort(), [roster]);
  const sportOptions = useMemo(() => [...new Set(roster.map((r) => r.sport).filter(Boolean))].sort(), [roster]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster.filter((r) => (
      (!teamFilter || r.teamName === teamFilter)
      && (!sportFilter || r.sport === sportFilter)
      && (!statusFilter || statusOf(r) === statusFilter)
      && (!q || [r.fullName, r.position, r.section, r.gradeLevel].some((v) => (v || '').toLowerCase().includes(q)))
    ));
  }, [roster, search, teamFilter, sportFilter, statusFilter]);

  if (!coachProfile) {
    return (
      <div className="cp-page">
        <header className="cp-header"><h1>{schoolName}</h1></header>
        <div className="cp-body"><p className="cp-empty">Your coach access was removed. Contact an admin if this is a mistake.</p></div>
      </div>
    );
  }

  const levelLabel = levelLabels[level] || level || '';

  return (
    <div className="cp-page">
      <header className="cp-header"><h1>{schoolName}</h1></header>

      <div className="cp-intro">
        <h2>My Players</h2>
        <p>Your coach profile and the players you&apos;re in charge of</p>
      </div>

      <div className="cp-body">
        <CoachProfileCard coach={coachProfile} email={email} levelLabel={levelLabel} />

        <div className="cp-stats">
          <div className="cp-stat"><FaUsers /><strong>{counts.total}</strong><span>Players</span></div>
          <div className="cp-stat cp-stat--ok"><FaCheckCircle /><strong>{counts.approved}</strong><span>Approved</span></div>
          <div className="cp-stat cp-stat--wait"><FaHourglassHalf /><strong>{counts.pending}</strong><span>Pending review</span></div>
        </div>

        <div className="cp-card">
          <div className="cp-roster-head">
            <h3>Roster</h3>
            <button type="button" className="cp-btn-ghost" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
              <FaSync className={loading ? 'cp-spin' : ''} /> Refresh
            </button>
          </div>

          <div className="cp-filters">
            <label className="cp-search">
              <FaSearch />
              <input placeholder="Search name, position, section…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            {teamOptions.length > 1 && (
              <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Team">
                <option value="">All teams</option>
                {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            {sportOptions.length > 1 && (
              <select value={sportFilter} onChange={(e) => setSportFilter(e.target.value)} aria-label="Sport">
                <option value="">All sports</option>
                {sportOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status">
              <option value="">All statuses</option>
              <option value="approved">Approved</option>
              <option value="pending">Pending</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {(coachProfile.teams || []).length === 0 ? (
            <p className="cp-empty">You haven&apos;t been assigned to a team yet. An admin can assign you from the Admin console&apos;s Coaches tab.</p>
          ) : loading ? (
            <p className="cp-empty">Loading players…</p>
          ) : error ? (
            <p className="cp-msg cp-msg--error">{error}</p>
          ) : visible.length === 0 ? (
            <p className="cp-empty">{roster.length === 0 ? 'No players have registered for your team yet.' : 'No players match these filters.'}</p>
          ) : (
            <div className="cp-roster">
              {visible.map((p) => (
                <button type="button" key={p.id} className="cp-player" onClick={() => setSelected(p)}>
                  <Avatar src={p.photoURL} name={p.fullName} className="cp-player__photo" />
                  <div className="cp-player__main">
                    <span className="cp-player__name">{p.fullName}</span>
                    <span className="cp-player__meta">
                      {[p.position, p.sport, categoryDivisionLabel(p), p.teamName].filter(Boolean).join(' · ')}
                    </span>
                    <span className="cp-player__meta">{[p.gradeLevel, p.section].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="cp-player__contact">
                    {p.contactNumber && <span><FaPhoneAlt /> {p.contactNumber}</span>}
                    {p.emergencyContact && <span><FaFirstAid /> {p.emergencyContact}</span>}
                    {p.address && <span className="cp-player__addr"><FaMapMarkerAlt /> {p.address}</span>}
                  </div>
                  <span className={`cp-status cp-status--${statusOf(p)}`}>{STATUS_LABELS[statusOf(p)]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && <PlayerModal player={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
