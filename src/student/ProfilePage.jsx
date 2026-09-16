import React, { useState, useContext, useEffect } from 'react';
import './ProfilePage.css';
import Contact from '../public/Landing/Contact/Contact';
import { BrandingContext } from '../shared/context/BrandingContext';
import EventsJoinedModal from '../shared/components/EventsJoinedModal/EventsJoinedModal';
import AwardsModal from '../shared/components/AwardsModal/AwardsModal';
import SubmittedRegistrationsModal from '../shared/components/SubmittedRegistrationsModal/SubmittedRegistrationsModal';
import ChangePasswordModal from '../shared/components/ChangePasswordModal/ChangePasswordModal';
import {
  FaUserCircle, FaTrophy, FaMedal, FaClipboardList, FaChevronRight,
  FaEnvelope,
  FaUserGraduate, FaUsers, FaBasketballBall, FaUserTag,
  FaKey, FaClock, FaHashtag, FaEdit,
} from 'react-icons/fa';
import { AuthContext } from '../shared/context/AuthContext';
import { getMyRegistrations } from '../shared/services/firestoreService';

function formatRegDate(value) {
  const date = value?.toDate ? value.toDate() : (value ? new Date(value) : null);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Staff/role accounts (admin, moderator, superadmin) don't join events,
// earn awards, or submit player registrations — those concepts only apply
// to student/player accounts. Anyone whose resolved role falls in here
// never sees the Events / Awards / Registrations stat cards at all.
const STAFF_ROLES = ['admin', 'moderator', 'superadmin'];

function InfoRow({ icon: Icon, label, value }) {
  return (
    <div className="profile-info-row">
      <span className="profile-info-icon"><Icon /></span>
      <span className="profile-info-label">{label}</span>
      <span className="profile-info-value">{value || '—'}</span>
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
  const { currentUser, userProfile, updatePassword } = useContext(AuthContext);
  const { schoolName } = useContext(BrandingContext);

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

  // `users/{uid}` docs are written with a `name` field (see AuthContext.signup /
  // firestoreService.createUserProfile). `fullName` was never actually stored
  // there, so reading it always fell through to the hardcoded placeholder
  // below — that's why every account showed "Juan Dela Cruz". Read the real
  // field first, and only fall back to values that trace back to this actual
  // account instead of fake sample data.
  const displayName   = userProfile?.name || userProfile?.fullName || currentUser?.displayName || currentUser?.email || '';
  const studentNumber = userProfile?.studentNumber || '';
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
        <h1 className="dash-header__title">{schoolName}</h1>
      </header>

      <div className="profile-page-intro">
        <h2 className="profile-page-title">Profile</h2>
        <p className="profile-page-subtitle">Manage your account information and security settings</p>
      </div>

      <div className="profile-body">

        {/* Identity card */}
        <div className="profile-identity-card">
          <div className="profile-identity-left">
            <h2 className="profile-full-name">{displayName.toUpperCase()}</h2>
            <p className="profile-student-number">
              Student Number &nbsp;<span className="profile-dots">{studentNumber}</span>
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

        {/* Info + Security */}
        <div className="profile-details-grid">

          <div className="profile-card">
            <div className="profile-card-header">
              <span className="profile-card-title">My Information</span>
            </div>
            <div className="profile-card-body">
              <InfoRow icon={FaHashtag}       label="Student Number"   value={studentNumber} />
              <InfoRow icon={FaUserCircle}     label="Full Name"        value={displayName} />
              <InfoRow icon={FaEnvelope}       label="Email Address"    value={email} />
              <InfoRow icon={FaUserGraduate}   label="Grade/Year Level" value={gradeLevel} />
              <InfoRow icon={FaUsers}          label="Section"          value={section} />
              <InfoRow icon={FaBasketballBall} label="Sports"           value={sport} />
              <InfoRow icon={FaUserTag}        label="Role"             value={position} />
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