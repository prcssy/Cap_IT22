import { useState, useEffect, useCallback, useRef, useContext } from 'react';
import { FaMapMarkerAlt, FaEdit, FaTrash, FaTimes, FaPlus, FaCheck } from 'react-icons/fa';
import './VenuesManager.css';
import { getVenues, saveVenues, getAllMatchSchedules } from '../shared/services/firestoreService';
import { AuthContext } from '../shared/context/AuthContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';

const uid = () => Math.random().toString(36).slice(2, 10);
const norm = (v) => (v || '').trim().toLowerCase();

/* ── Team badge: uploaded logo if present, else a colored initial circle.
   Full name still reaches the DOM via title/alt for anyone hovering or
   using a screen reader, even though the row itself now shows the logo
   instead of the name text. ── */
function TeamBadge({ name, logo, size = 34 }) {
  const initials = (name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return logo ? (
    <img src={logo} alt={name} title={name} className="vm-team-logo" style={{ width: size, height: size }} />
  ) : (
    <div className="vm-team-logo vm-team-logo--fallback" title={name} style={{ width: size, height: size }}>
      {initials}
    </div>
  );
}

/* ── Venues (global admin section) ──
   A venue is just a name. Matches reference it by that name string, so
   this screen doubles as: (1) where the admin maintains the venue list
   that feeds the Venue dropdown on Add/Edit Match Schedule, and (2) a
   per-venue lookup of what's already booked there — click a card. */
export default function VenuesManager() {
  const { userProfile } = useContext(AuthContext);
  const LEVEL_LABELS = useContext(LevelLabelsContext);
  const [venues, setVenues] = useState([]);
  const [allSchedules, setAllSchedules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const [newVenueName, setNewVenueName] = useState('');
  const [adding, setAdding] = useState(false);

  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef(null);

  const [confirmDeleteVenue, setConfirmDeleteVenue] = useState(null);
  const [scheduleModalVenue, setScheduleModalVenue] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [v, s] = await Promise.all([getVenues(), getAllMatchSchedules()]);
      setVenues(v);
      setAllSchedules(s);
    } catch (e) {
      console.error('Failed to load venues:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const schedulesForVenue = (venue) =>
    allSchedules
      .filter(m => norm(m.location) === norm(venue.name))
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || ''));

  const handleAddVenue = async (e) => {
    e.preventDefault();
    const name = newVenueName.trim();
    if (!name) return;
    if (venues.some(v => norm(v.name) === norm(name))) {
      setToast({ text: `"${name}" is already in the venue list.` });
      return;
    }
    setAdding(true);
    try {
      const next = [...venues, { id: uid(), name }];
      await saveVenues(next, userProfile?.role);
      setVenues(next);
      setNewVenueName('');
      setToast({ text: 'Venue added.' });
    } catch (e) {
      console.error('Failed to add venue:', e);
      setToast({ text: 'Could not add venue — try again.' });
    } finally {
      setAdding(false);
    }
  };

  const startRename = (venue) => {
    setRenamingId(venue.id);
    setRenameValue(venue.name);
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };
  const confirmRename = async (venue) => {
    const name = renameValue.trim();
    if (!name || name === venue.name) { cancelRename(); return; }
    if (venues.some(v => v.id !== venue.id && norm(v.name) === norm(name))) {
      setToast({ text: `"${name}" is already in the venue list.` });
      return;
    }
    const next = venues.map(v => (v.id === venue.id ? { ...v, name } : v));
    try {
      await saveVenues(next, userProfile?.role);
      setVenues(next);
      setToast({ text: 'Venue renamed.' });
    } catch (e) {
      console.error('Failed to rename venue:', e);
      setToast({ text: 'Could not rename venue — try again.' });
    } finally {
      cancelRename();
    }
  };

  const handleDeleteVenue = async () => {
    if (!confirmDeleteVenue) return;
    const next = venues.filter(v => v.id !== confirmDeleteVenue.id);
    try {
      await saveVenues(next, userProfile?.role);
      setVenues(next);
      setToast({ text: 'Venue deleted.' });
    } catch (e) {
      console.error('Failed to delete venue:', e);
      setToast({ text: 'Could not delete venue — try again.' });
    } finally {
      setConfirmDeleteVenue(null);
    }
  };

  return (
    <div className="msf-wrap">
      <div className="msf-level-banner">
        <h2>VENUES</h2>
        <div className="msf-level-banner__bar" />
      </div>

      <div className="msf-card">
        <div className="msf-list-head">
          <div>
            <h2>Manage venues</h2>
            <p className="msf-muted">
              Shared across every school level — click a venue to see what's booked there.
            </p>
          </div>
          <form className="vm-add-form" onSubmit={handleAddVenue}>
            <input
              type="text"
              placeholder="e.g. Main Gym"
              value={newVenueName}
              onChange={e => setNewVenueName(e.target.value)}
            />
            <button className="msf-btn-primary" type="submit" disabled={adding || !newVenueName.trim()}>
              <FaPlus /> Add Venue
            </button>
          </form>
        </div>

        {loading ? (
          <p className="msf-empty">Loading venues…</p>
        ) : venues.length === 0 ? (
          <p className="msf-empty">No venues yet. Add one above — it'll then show up as a dropdown option when scheduling matches.</p>
        ) : (
          <div className="vm-grid">
            {venues.map(v => {
              const count = schedulesForVenue(v).length;
              const isRenaming = renamingId === v.id;
              return (
                <div
                  key={v.id}
                  className="vm-card"
                  onClick={() => !isRenaming && setScheduleModalVenue(v)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="vm-card__icon"><FaMapMarkerAlt /></div>

                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="vm-card__rename-input"
                      value={renameValue}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') confirmRename(v);
                        if (e.key === 'Escape') cancelRename();
                      }}
                      onBlur={() => confirmRename(v)}
                    />
                  ) : (
                    <div className="vm-card__name">{v.name}</div>
                  )}

                  <div className="vm-card__count">
                    {count} scheduled match{count === 1 ? '' : 'es'}
                  </div>

                  <div className="vm-card__actions" onClick={e => e.stopPropagation()}>
                    <button className="msf-icon-edit" title="Rename" onClick={() => startRename(v)}>
                      <FaEdit />
                    </button>
                    <button className="vm-icon-delete" title="Delete" onClick={() => setConfirmDeleteVenue(v)}>
                      <FaTrash />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Venue's booked schedules ── */}
      {scheduleModalVenue && (() => {
        const bookedMatches = schedulesForVenue(scheduleModalVenue);
        return (
          <div className="msf-overlay" onClick={() => setScheduleModalVenue(null)}>
            <div className="vm-schedule-modal" onClick={e => e.stopPropagation()}>
              <div className="vm-schedule-modal__head">
                <div className="vm-schedule-modal__title">
                  <div className="vm-schedule-modal__icon"><FaMapMarkerAlt /></div>
                  <div>
                    <h3>{scheduleModalVenue.name}</h3>
                    <p className="vm-schedule-modal__subtitle">
                      {bookedMatches.length} scheduled match{bookedMatches.length === 1 ? '' : 'es'}
                    </p>
                  </div>
                </div>
                <button
                  className="vm-schedule-modal__close"
                  title="Close"
                  onClick={() => setScheduleModalVenue(null)}
                >
                  <FaTimes />
                </button>
              </div>

              <div className="vm-schedule-modal__body">
                {bookedMatches.length === 0 ? (
                  <p className="msf-empty">No matches booked at this venue yet.</p>
                ) : (
                  <div className="vm-schedule-list">
                    {bookedMatches.map(m => (
                      <div key={`${m.level}-${m.id}`} className="vm-matchcard">
                        <div className="vm-matchcard__top">
                          <span className="vm-matchcard__date">
                            {m.date ? `${m.date}${m.time ? ` · ${m.time}` : ''}` : 'Date TBD'}
                          </span>
                          <div className="vm-matchcard__pills">
                            <span className="msf-pill-sport">{m.sport}</span>
                            <span className="vm-pill-level">{LEVEL_LABELS[m.level] || m.level}</span>
                          </div>
                        </div>
                        <div className="vm-teams vm-matchcard__teams">
                          <TeamBadge name={m.teamA} logo={m.teamALogo} />
                          <span className="vm-teams__vs">vs</span>
                          <TeamBadge name={m.teamB} logo={m.teamBLogo} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Delete venue confirmation ── */}
      {confirmDeleteVenue && (
        <div className="msf-overlay msf-overlay--nested" onClick={() => setConfirmDeleteVenue(null)}>
          <div className="msf-confirm-delete" onClick={e => e.stopPropagation()}>
            <h3>Delete this venue?</h3>
            <p>
              This removes <b>{confirmDeleteVenue.name}</b> from the venue list — it won't be
              offered as a dropdown option for new schedules anymore. Matches already booked
              there keep showing it, unaffected.
            </p>
            <div className="msf-confirm-delete__actions">
              <button className="msf-btn-ghost" onClick={() => setConfirmDeleteVenue(null)}>Cancel</button>
              <button className="msf-btn-danger" onClick={handleDeleteVenue}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="msf-toast"><FaCheck /> {toast.text}</div>}
    </div>
  );
}
