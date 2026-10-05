import React, { useState, useContext, useEffect } from 'react';
import './ProfilePage.css';
import Contact from '../public/Landing/Contact/Contact';
import EventsJoinedModal from '../shared/components/EventsJoinedModal/EventsJoinedModal';
import AwardsModal from '../shared/components/AwardsModal/AwardsModal';
import SubmittedRegistrationsModal from '../shared/components/SubmittedRegistrationsModal/SubmittedRegistrationsModal';
import ChangePasswordModal from '../shared/components/ChangePasswordModal/ChangePasswordModal';
import {
  FaUserCircle, FaTrophy, FaMedal, FaClipboardList, FaChevronRight,
  FaEnvelope,
  FaUserGraduate, FaUsers, FaBasketballBall, FaUserTag,
  FaKey, FaClock, FaEdit, FaUser, FaUserTie, FaPhoneAlt, FaCamera,
} from 'react-icons/fa';
import { AuthContext } from '../shared/context/AuthContext';
import { getMyRegistrations, subscribeCoaches, updateMyProfilePhoto } from '../shared/services/firestoreService';
import { resizeImageToDataUrl } from '../shared/utils/resizeImage';
import { getSchoolLevel } from '../shared/utils/schoolLevel';
import { coachHandles } from '../shared/utils/coachScope';
import { isMessengerUrl } from '../shared/utils/messengerLink';
import { FaFacebookMessenger } from 'react-icons/fa6';
import HeaderBrand from '../shared/components/HeaderBrand/HeaderBrand';

function formatRegDate(value) {
  const date = value?.toDate ? value.toDate() : (value ? new Date(value) : null);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Staff/role accounts (admin, moderator, superadmin, coach) don't join events,
// earn awards, or submit player registrations — those concepts only apply
// to student/player accounts. Anyone whose resolved role falls in here
// never sees the Events / Awards / Registrations stat cards at all.
const STAFF_ROLES = ['admin', 'moderator', 'superadmin', 'coach'];

// Shows the player's photo when we have one, otherwise a generic silhouette.
// `failedSrc` tracks a URL that errored (deleted/expired) so we drop back to
// the placeholder instead of leaving a broken-image icon in the card.
function ProfileAvatar({ src, name, onUpload, busy }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const inputRef = React.useRef(null);
  const showPhoto = src && src !== failedSrc;
  return (
    <div className="profile-avatar-wrap">
    <div className="profile-avatar" aria-label={name ? `${name}'s photo` : 'Profile photo'}>
      {showPhoto ? (
        <img
          className="profile-avatar__img"
          src={src}
          alt={name ? `${name}'s photo` : 'Profile photo'}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <FaUser className="profile-avatar__placeholder" aria-hidden="true" />
      )}
    </div>
    {/* Staff only: players' photo comes from their registration. */}
    {onUpload && (
      <>
        <button
          type="button"
          className="profile-avatar__upload"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label={src ? 'Change photo' : 'Upload photo'}
          title={src ? 'Change photo' : 'Upload photo'}
        >
          <FaCamera />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onUpload(f); }}
        />
      </>
    )}
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="profile-info-row">
      <span className="profile-info-icon"><Icon /></span>
      <span className="profile-info-label">{label}</span>
      <span className="profile-info-value">{value || '—'}</span>
    </div>
  );
}

/* "My Coach" — shown once a player's registration is approved: the coach(es)
   assigned to their team (and sport, when a coach only handles some of the
   team's sports) in the Admin console's Coaches tab. */
function CoachCard({ coaches, event, teamName, sport }) {
  return (
    <div className="profile-card profile-coach-card">
      <div className="profile-card-header">
        <span className="profile-card-title">My Coach</span>
        <span className="profile-coach-card__for">{[event, teamName, sport].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="profile-card-body">
        {coaches.length === 0 ? (
          <p className="profile-coach-card__empty">No coach has been assigned for {sport || 'this sport'} on your team yet.</p>
        ) : coaches.map((c) => (
          <div className="profile-coach" key={c.id}>
            <span className="profile-coach__avatar">
              {c.photoURL ? <img src={c.photoURL} alt={c.name || 'Coach'} /> : <FaUserTie />}
            </span>
            <div className="profile-coach__info">
              <span className="profile-coach__name">{c.name || c.id}</span>
              <div className="profile-coach__contacts">
                {c.contactNumber && (
                  <a href={`tel:${c.contactNumber.replace(/[^+0-9]/g, '')}`}><FaPhoneAlt /> {c.contactNumber}</a>
                )}
                <a href={`mailto:${c.id}`}><FaEnvelope /> {c.id}</a>
              </div>
              {c.bio && <p className="profile-coach__bio">{c.bio}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* "Sports Group Chats" — the Messenger group chats of the coaches handling
   the sports this player joined (approved registrations only; see
   groupChats in the page). Hidden when there are none. */
function GroupChatsCard({ chats }) {
  if (chats.length === 0) return null;
  return (
    <div className="profile-card profile-chats-card">
      <div className="profile-card-header">
        <span className="profile-card-title">Sports Group Chats</span>
      </div>
      <div className="profile-card-body">
        <p className="profile-chats-card__hint">Join your team&apos;s Messenger group chat for the sports you joined.</p>
        {chats.map((c) => (
          <div className="profile-chat" key={`${c.coachId}-${c.team}-${c.sport}`}>
            <span className="profile-chat__icon"><FaFacebookMessenger /></span>
            <div className="profile-chat__info">
              <span className="profile-chat__team">{c.team}</span>
              <span className="profile-chat__meta">
                {[c.sport, c.event, `Coach ${c.coachName}`].filter(Boolean).join(' · ')}
              </span>
            </div>
            <a className="profile-chat__join" href={c.url} target="_blank" rel="noopener noreferrer">Join</a>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ icon, count, label, arrow, onClick }) {
  return (
    <div
      className={`profile-stat-card ${onClick ? 'profile-stat-card--clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <div className="profile-stat-icon-wrap">{icon}</div>
      <div className="profile-stat-body">
        <span className="profile-stat-label">{label}</span>
        <span className="profile-stat-count">{count}</span>
        <span className="profile-stat-sublabel">Total {label}</span>
      </div>
      {arrow && (
        <button className="profile-stat-arrow" aria-label={`View ${label}`} tabIndex={-1}>
          <FaChevronRight />
        </button>
      )}
    </div>
  );
}

export default function ProfilePage() {
  const { currentUser, userProfile, coachProfile, updatePassword } = useContext(AuthContext);

  /* ── All modal states ── */
  const [eventsModalOpen,        setEventsModalOpen]        = useState(false);
  const [awardsModalOpen,        setAwardsModalOpen]        = useState(false);
  const [registrationsModalOpen, setRegistrationsModalOpen] = useState(false);
  const [changePassModalOpen,    setChangePassModalOpen]    = useState(false);

  const contactFooterRef = React.useRef(null);

  // `users/{uid}` never gets an eventsJoined/awards/registrations array (or
  // teamName/sport/position) written to it anywhere — those only ever live
  // on the student's own `registrations` doc(s), which this page couldn't
  // previously read at all (firestore.rules only let STAFF read
  // `registrations`). Now that a signed-in user can read back their OWN
  // registration docs (see firestore.rules + getMyRegistrations), fetch
  // them here instead of relying on profile fields nothing ever populates.
  const [myRegistrations, setMyRegistrations] = useState([]);
  useEffect(() => {
    let cancelled = false;
    if (!currentUser?.uid) { setMyRegistrations([]); return undefined; }
    getMyRegistrations(currentUser.uid)
      .then((regs) => { if (!cancelled) setMyRegistrations(regs); })
      .catch((err) => { console.warn('Could not load your registrations:', err); if (!cancelled) setMyRegistrations([]); });
    return () => { cancelled = true; };
  }, [currentUser?.uid]);

  const latestReg = myRegistrations[0] || null;

  // Coaches and group chats follow what the player actually JOINED: each
  // approved registration (one per event) is matched to the coach(es)
  // handling that exact team + sport (+ level). No coach for it → no coach
  // and no group chat for it. Pending/rejected players aren't on the team yet.
  const approvedRegs = myRegistrations.filter((r) => r.status === 'approved');
  const [coaches, setCoaches] = useState([]);
  useEffect(() => {
    if (!currentUser?.uid || approvedRegs.length === 0) return undefined;
    return subscribeCoaches(null, setCoaches, () => setCoaches([]));
  }, [currentUser?.uid, approvedRegs.length]);

  // Team names repeat across levels, so the player's level must match too.
  const coachesFor = (reg) => {
    const regLevel = getSchoolLevel(reg.gradeLevel);
    return coaches.filter((c) => coachHandles(c, reg)
      && (!regLevel || !c.level || c.level === regLevel));
  };
  const coachGroups = approvedRegs.map((reg) => ({ reg, coaches: coachesFor(reg) }));

  // Only the chats of the coaches handling the player's own team + sport.
  const seenChats = new Set();
  const groupChats = coachGroups.flatMap(({ reg, coaches: list }) => list.flatMap((c) => (c.chats || [])
    .filter((ch) => ch?.team === reg.teamName && isMessengerUrl(ch.url))
    .filter((ch) => {
      const key = `${c.id}|${ch.team}|${reg.sport}`;
      if (seenChats.has(key)) return false;
      seenChats.add(key);
      return true;
    })
    .map((ch) => ({
      coachId: c.id,
      coachName: c.name || c.id,
      team: ch.team,
      url: ch.url,
      sport: reg.sport,
      event: reg.event,
    }))));

  // `users/{uid}` docs are written with a `name` field (see AuthContext.signup /
  // firestoreService.createUserProfile). `fullName` was never actually stored
  // there, so reading it always fell through to the hardcoded placeholder
  // below — that's why every account showed "Juan Dela Cruz". Read the real
  // field first, and only fall back to values that trace back to this actual
  // account instead of fake sample data.
  const displayName   = userProfile?.name || userProfile?.fullName || currentUser?.displayName || currentUser?.email || '';
  const role          = userProfile?.role          || 'Player';
  const gradeLevel    = userProfile?.gradeLevel    || '';
  const section       = userProfile?.section       || '';
  // teamName/sport/position live on the registration a student submitted,
  // never on their profile doc — fall back to their most recent
  // registration so these rows aren't just permanently blank.
  const teamName      = userProfile?.teamName      || latestReg?.teamName || '';
  const sport         = userProfile?.sport         || latestReg?.sport    || '';
  const position      = userProfile?.position      || latestReg?.position || '';
  const email         = currentUser?.email         || '';
  const lastUpdate    = userProfile?.lastUpdate    || '';
  // The profile photo is the one the student attached to their most recent
  // registration. Staff accounts have no registration, so they get the
  // placeholder silhouette.
  // Staff upload their own photo here (users/{uid}.photoURL); `staffPhoto`
  // shows a fresh upload right away (userProfile is only read at login).
  const [staffPhoto, setStaffPhoto] = useState(undefined);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState(null);
  const photoURL      = latestReg?.photoURL || coachProfile?.photoURL
    || (staffPhoto !== undefined ? staffPhoto : userProfile?.photoURL) || '';
  const canUploadPhoto = ['admin', 'moderator', 'superadmin'].includes(userProfile?.role);

  const handlePhotoUpload = async (file) => {
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) {
      setPhotoMsg({ tone: 'error', text: 'Choose an image file (JPG, PNG or WEBP) up to 5MB.' });
      return;
    }
    setPhotoBusy(true);
    setPhotoMsg(null);
    try {
      const dataUrl = await resizeImageToDataUrl(file, {
        maxWidth: 320, maxHeight: 320, mode: 'contain', format: 'jpeg', quality: 0.85, maxBytes: 60 * 1024,
      });
      await updateMyProfilePhoto(currentUser.uid, dataUrl, userProfile.role);
      setStaffPhoto(dataUrl);
      setPhotoMsg({ tone: 'success', text: 'Profile photo updated.' });
    } catch (err) {
      console.error('Failed to update profile photo:', err);
      setPhotoMsg({ tone: 'error', text: 'Could not upload the photo — check your connection and try again.' });
    } finally {
      setPhotoBusy(false);
    }
  };

  // "Submitted Registrations" = every registration this student has ever
  // filed, regardless of decision. "Events Joined" = the subset staff has
  // actually approved. There's no awards-granting feature anywhere in the
  // admin tools yet, so Awards stays empty/hidden rather than fabricated.
  const registrations = myRegistrations.map((r) => ({
    name: r.sport ? `${r.sport} — ${r.event || 'Event'}` : (r.event || 'Registration'),
    date: formatRegDate(r.createdAt),
    submittedDate: `Submitted ${formatRegDate(r.createdAt)}`,
    status: r.status ? r.status[0].toUpperCase() + r.status.slice(1) : 'Pending',
  }));
  const eventsJoined = myRegistrations
    .filter((r) => r.status === 'approved')
    .map((r) => ({
      name: r.event || 'Event',
      date: formatRegDate(r.reviewedAt || r.createdAt),
      venue: r.teamName || r.sport || '—',
      // The modal's badge styling (ej-badge--completed/ongoing/upcoming)
      // reflects the EVENT's own lifecycle, not the registration decision —
      // "Completed" is the closest fit until this page also knows whether
      // the event itself is still running.
      status: 'Completed',
    }));
  const awards = [];

  // Staff accounts never show these cards, regardless of array contents.
  // Player/student accounts only show a given card once they actually
  // have at least one entry for it — an empty "Total: 0" card isn't
  // useful and was previously always showing "3" from the removed
  // sample data.
  const isStaffAccount   = STAFF_ROLES.includes((role || '').toLowerCase());
  const showEventsCard   = !isStaffAccount && eventsJoined.length > 0;
  const showAwardsCard   = !isStaffAccount && awards.length > 0;
  const showRegCard      = !isStaffAccount && registrations.length > 0;
  const showStatsRow     = showEventsCard || showAwardsCard || showRegCard;

  /* ── Handle password save via AuthContext ── */
  const handlePasswordSave = async (currentPassword, newPassword) => {
    if (updatePassword) {
      await updatePassword(newPassword);
    }
  };

  return (
    <div className="profile-page">

      <header className="dash-header">
        <HeaderBrand titleClassName="dash-header__title" />
      </header>

      <div className="profile-page-intro">
        <h2 className="profile-page-title">Profile</h2>
        <p className="profile-page-subtitle">Manage your account information and security settings</p>
      </div>

      <div className="profile-body">

        {/* Identity card */}
        <div className="profile-identity-card">
          <ProfileAvatar
            src={photoURL}
            name={displayName}
            onUpload={canUploadPhoto ? handlePhotoUpload : undefined}
            busy={photoBusy}
          />
          <div className="profile-identity-left">
            <h2 className="profile-full-name">{displayName.toUpperCase()}</h2>
            {photoMsg && <p className={`profile-photo-msg profile-photo-msg--${photoMsg.tone}`}>{photoMsg.text}</p>}
            <p className="profile-student-number">
              Student Name
            </p>
            <span className="profile-role-badge">
              <FaUserTag className="profile-role-icon" /> Role: {role}
            </span>
          </div>
          <div className="profile-identity-divider" />
          <div className="profile-identity-right">
            <div className="profile-identity-detail">
              <FaUserGraduate className="profile-detail-icon" />
              <span className="profile-detail-label">Grade/Year Level</span>
              <span className="profile-detail-value">{gradeLevel}</span>
            </div>
            <div className="profile-identity-detail">
              <FaUsers className="profile-detail-icon" />
              <span className="profile-detail-label">Section</span>
              <span className="profile-detail-value">{section}</span>
            </div>
            <div className="profile-identity-detail">
              <FaUsers className="profile-detail-icon" />
              <span className="profile-detail-label">Team Name</span>
              <span className="profile-detail-value">{teamName}</span>
            </div>
          </div>
        </div>

        {/* Stat cards — only rendered for player/student accounts that
            actually have at least one entry; hidden entirely for staff
            accounts (admin/moderator/superadmin) and for anyone with
            nothing to show yet. */}
        {showStatsRow && (
          <div className="profile-stats-row">
            {showEventsCard && (
              <StatCard
                icon={<FaTrophy className="stat-icon-trophy" />}
                count={eventsJoined.length}
                label="Events Joined"
                arrow
                onClick={() => setEventsModalOpen(true)}
              />
            )}
            {showAwardsCard && (
              <StatCard
                icon={<FaMedal className="stat-icon-medal" />}
                count={awards.length}
                label="Awards"
                arrow
                onClick={() => setAwardsModalOpen(true)}
              />
            )}
            {showRegCard && (
              <StatCard
                icon={<FaClipboardList className="stat-icon-reg" />}
                count={registrations.length}
                label="Submitted Registrations"
                arrow
                onClick={() => setRegistrationsModalOpen(true)}
              />
            )}
          </div>
        )}

        {coachGroups.map(({ reg, coaches: list }) => (
          <CoachCard key={reg.id} coaches={list} event={reg.event} teamName={reg.teamName} sport={reg.sport} />
        ))}

        <GroupChatsCard chats={groupChats} />

        {/* Info + Security */}
        <div className="profile-details-grid">

          <div className="profile-card">
            <div className="profile-card-header">
              <span className="profile-card-title">My Information</span>
            </div>
            <div className="profile-card-body">
              <InfoRow icon={FaUserCircle}     label="Full Name"        value={displayName} />
              <InfoRow icon={FaEnvelope}       label="Email Address"    value={email} />
              <InfoRow icon={FaUserGraduate}   label="Grade/Year Level" value={gradeLevel} />
              <InfoRow icon={FaUsers}          label="Section"          value={section} />
              <InfoRow icon={FaBasketballBall} label="Sports"           value={sport} />
              <InfoRow icon={FaEdit}           label="Position"         value={position} />
              <InfoRow icon={FaUsers}          label="Team Name"        value={teamName} />
            </div>
          </div>

          <div className="profile-card">
            <div className="profile-card-header">
              <span className="profile-card-title">Security Settings</span>
              {/* ── Change Password button now opens the modal ── */}
              <button
                className="profile-card-action profile-card-action--change"
                onClick={() => setChangePassModalOpen(true)}
              >
                Change Password
              </button>
            </div>
            <div className="profile-card-body">
              <InfoRow icon={FaKey}   label="Password"    value="••••••••••••" />
              <InfoRow icon={FaClock} label="Last Update" value={lastUpdate} />
            </div>
          </div>
        </div>

        <Contact contactFooterRef={contactFooterRef} />
      </div>

      {/* ── All modals ── */}
      <EventsJoinedModal
        isOpen={eventsModalOpen}
        onClose={() => setEventsModalOpen(false)}
        events={eventsJoined}
      />
      <AwardsModal
        isOpen={awardsModalOpen}
        onClose={() => setAwardsModalOpen(false)}
        awards={awards}
      />
      <SubmittedRegistrationsModal
        isOpen={registrationsModalOpen}
        onClose={() => setRegistrationsModalOpen(false)}
        registrations={registrations}
      />
      <ChangePasswordModal
        isOpen={changePassModalOpen}
        onClose={() => setChangePassModalOpen(false)}
        onSave={handlePasswordSave}
      />

    </div>
  );
}