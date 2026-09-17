import { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { FaSearch, FaTimes, FaUserGraduate, FaCheck, FaTrash, FaFilePdf } from 'react-icons/fa';
// jspdf/jspdf-autotable are loaded on demand (see handleDownloadPdf below),
// not imported statically here.
import { db } from '../shared/firebase';
import { getAllRegistrations, getAllUsers, getEventKey, getEventLabel, updateRegistrationStatus, deleteRegistration } from '../shared/services/firestoreService';
import { BrandingContext } from '../shared/context/BrandingContext';
import { AuthContext } from '../shared/context/AuthContext';
import '../admin/AdminSchedulePage.css';

/* ═══════════════════════════════════════════════════════════════════════
   STUDENT REGISTRATION DETAILS — Super Admin only.

   Moved here from AdminSchedulePage's Registration tab (Card 2). Reuses
   AdminSchedulePage.css's `asp-*` classes unchanged so the look is
   identical to before — only the page it lives on changed. Fetches the
   same `registrations` + `users` collections AdminSchedulePage always
   read for this table; nothing new was introduced on the backend.
   ═══════════════════════════════════════════════════════════════════════ */

const ALL_GRADES = [
  'Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6',
  'Grade 7','Grade 8','Grade 9','Grade 10','Grade 11','Grade 12',
  '1st Year','2nd Year','3rd Year','4th Year',
];

// Same grade -> school-level mapping used by AdminSchedulePage.jsx /
// SuperAdminPage.jsx / RegistrationPage.jsx — level is always derived
// from gradeLevel on the fly, never stored as its own field.
const ELEMENTARY_GRADES = new Set(['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6']);
const HIGH_SCHOOL_GRADES = new Set(['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12']);
const COLLEGE_GRADES = new Set(['1st Year', '2nd Year', '3rd Year', '4th Year']);

function getSchoolLevel(gradeLevel) {
  if (!gradeLevel) return null;
  if (ELEMENTARY_GRADES.has(gradeLevel)) return 'elementary';
  if (HIGH_SCHOOL_GRADES.has(gradeLevel)) return 'highSchool';
  if (COLLEGE_GRADES.has(gradeLevel)) return 'college';
  return null;
}

const LEVEL_LABELS = { elementary: 'Elementary', highSchool: 'High School', college: 'College' };

// Shared by every field in the Student Details modal: values the merge
// logic already fell back to ('—' for user-profile fields, 'N/A' for
// registration fields) render as a muted "Not provided" instead of a bare
// dash, so it's unambiguous that the data is missing rather than "0" or
// blank on purpose.
function DetailField({ label, value, center }) {
  const isEmpty = !value || value === '—' || value === 'N/A';
  return (
    <div className={`asp-form-group${center ? ' asp-form-group--center' : ''}`}>
      <label>{label}</label>
      <p>{isEmpty ? <span className="asp-detail-empty">Not provided</span> : value}</p>
    </div>
  );
}

/* Which event bucket a registration belongs to — same rule AdminSchedulePage
   uses for its own event filter/chips. */
function getEventBucket(r, eventList) {
  return getEventKey(r.eventKey || r.event, eventList) || 'unassigned';
}

/* Custom pill-style dropdown — replaces a native <select> so the open
   popup can be themed (native <option> lists are OS-rendered and can't
   be restyled cross-browser). */
function FilterDropdown({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const selected = options.find(o => o.value === value);

  return (
    <div className="asp-dropdown" ref={rootRef}>
      <button
        type="button"
        className={`asp-filter-pill asp-filter-pill--btn${value ? ' asp-filter-pill--active' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {selected ? selected.label : label}
      </button>
      {open && (
        <div className="asp-dropdown__menu">
          <button
            type="button"
            className={`asp-dropdown__item${!value ? ' asp-dropdown__item--active' : ''}`}
            onClick={() => { onChange(''); setOpen(false); }}
          >
            {label}
          </button>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`asp-dropdown__item${value === opt.value ? ' asp-dropdown__item--active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// scope: 'registrants' (default) — only students who actually submitted the
// registration form, used on the Admin page's Registration tab. 'allUsers' —
// every signed-up student account whether or not they registered as a
// player, used on the Super Admin page (its original, pre-fix behavior).
export default function StudentRegistrationDetails({ scope = 'registrants', onStatusChange, onDeleted }) {
  const { events, schoolName } = useContext(BrandingContext);
  const { userProfile } = useContext(AuthContext);
  const [allRegistrations, setAllRegistrations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Which registration's Approve/Reject is in flight, so its buttons can
  // disable without blocking the rest of the table.
  const [decidingId, setDecidingId] = useState(null);
  const [decisionError, setDecisionError] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [filterLevel, setFilterLevel] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterSection, setFilterSection] = useState('');
  const [filterSport, setFilterSport] = useState('');
  const [filterGender, setFilterGender] = useState('');
  const [filterEvent, setFilterEvent] = useState('');

  const [selectedStudent, setSelectedStudent] = useState(null);

  const fetchStudents = useCallback(async () => {
    if (!db) {
      setError('Firestore not connected.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // getAllRegistrations/getAllUsers share an in-flight de-dupe cache
      // with whatever fetch the page embedding this table (AdminSchedulePage
      // or SuperAdminPage) does for the same two collections on the same
      // load, so this doesn't double the network round trips.
      const [registrations, users] = await Promise.all([
        getAllRegistrations(),
        getAllUsers(),
      ]);

      // This table is the STUDENT registration tabulation — staff accounts
      // (admin / moderator / super admin) manage it, they don't belong as
      // rows in it.
      const studentUsers = users.filter(
        u => (u.role || 'student').toLowerCase() === 'student'
      );
      const studentUids = new Set(studentUsers.map(u => u.id));
      const studentRegistrations = registrations.filter(r => studentUids.has(r.uid));

      // Admin page (scope: 'registrants') — one row per REGISTRATION
      // SUBMISSION, keyed by the registration doc rather than the student
      // account. A student who only signed up for an account but never
      // filled out the registration form doesn't belong here as a player.
      //
      // Super Admin page (scope: 'allUsers') — one row per STUDENT ACCOUNT,
      // so every signed-up student shows up whether or not they've
      // registered as a player; this is the original behavior this page
      // always had, kept as-is for the Super Admin audit view.
      const merged = scope === 'allUsers'
        ? studentUsers.map(user => {
            const registration = studentRegistrations.find(r => r.uid === user.id);
            return {
              ...user,
              ...(registration || {}),
              id: user.id,
              uid: user.id,
              regId: registration?.id || null,
              status: registration ? (registration.status || 'pending') : null,
              fullName: (registration && registration.fullName) || user.name || '',
              email: (registration && registration.email) || user.email || '',
              gender: user.gender || '—',
              gradeLevel: user.gradeLevel || '—',
              section: user.section || '—',
              sport: (registration && registration.sport) || 'N/A',
              position: (registration && registration.position) || 'N/A',
              teamName: (registration && registration.teamName) || 'N/A',
              event: (registration && (getEventLabel(registration.eventKey || registration.event, events) || registration.event)) || 'N/A',
            };
          })
        : studentRegistrations.map(registration => {
            const user = studentUsers.find(u => u.id === registration.uid) || {};
            return {
              ...user,
              ...registration,
              id: registration.id,
              uid: registration.uid,
              regId: registration.id,
              status: registration.status || 'pending',
              fullName: registration.fullName || user.name || '',
              email: registration.email || user.email || '',
              gender: user.gender || '—',
              gradeLevel: user.gradeLevel || '—',
              section: user.section || '—',
              sport: registration.sport || 'N/A',
              position: registration.position || 'N/A',
              teamName: registration.teamName || 'N/A',
              event: getEventLabel(registration.eventKey || registration.event, events) || registration.event || 'N/A',
            };
          });

      merged.sort((a, b) =>
        (a.fullName || '').localeCompare(b.fullName || '', undefined, { sensitivity: 'base' })
      );

      setAllRegistrations(merged);
    } catch (err) {
      console.error(err);
      setError('Failed to load registration data.');
    } finally {
      setLoading(false);
    }
  }, [events, scope]);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  // Lock the page behind the modal so there's only ever one scrollable
  // surface on screen at a time — without this, mobile users get a
  // scrollbar on the modal body AND one on the page behind it, and it's
  // unclear which one a given swipe/scroll is acting on.
  useEffect(() => {
    if (!selectedStudent) return undefined;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; };
  }, [selectedStudent]);

  const handleDecision = useCallback(async (reg, status) => {
    if (!reg.regId || reg.status === status) return;
    // Reject still asks first since it drops the student out of the active
    // player counts, but — unlike Delete below — it's not a dead end: the
    // Approve/Reject buttons stay visible after a decision, so a wrong
    // click can be undone by picking the other one.
    if (status === 'rejected' && !window.confirm(`Reject ${reg.fullName || 'this student'}'s registration? You can re-approve it later if this was a mistake.`)) {
      return;
    }
    setDecidingId(reg.regId);
    setDecisionError('');
    try {
      await updateRegistrationStatus(reg.regId, status, userProfile?.role, reg.fullName);
      // Reflect it locally instead of a full refetch — same doc, just a
      // new status, so no need to re-hit Firestore for the whole table.
      setAllRegistrations(prev => prev.map(r => (
        r.regId === reg.regId ? { ...r, status } : r
      )));
      setSelectedStudent(prev => (prev && prev.regId === reg.regId ? { ...prev, status } : prev));
      // Let the page this table lives on (AdminSchedulePage's Total
      // Players tiles, SuperAdminPage's Total Players stat) know a status
      // just changed, so a rejection drops out of those counts right away
      // instead of only after their own next refetch.
      onStatusChange?.(reg.regId, status);
    } catch (err) {
      console.error(err);
      setDecisionError(`Failed to ${status === 'approved' ? 'approve' : 'reject'} ${reg.fullName || 'this registration'}.`);
    } finally {
      setDecidingId(null);
    }
  }, [userProfile, onStatusChange]);

  const handleDelete = useCallback(async (reg) => {
    if (!reg.regId) return;
    // Unlike Approve/Reject, Delete removes the doc outright — there's
    // nothing left to flip back, so it gets the strongest confirmation of
    // the three actions.
    if (!window.confirm(`Permanently delete ${reg.fullName || 'this student'}'s registration? This cannot be undone.`)) {
      return;
    }
    setDecidingId(reg.regId);
    setDecisionError('');
    try {
      await deleteRegistration(reg.regId, userProfile?.role, reg.fullName);
      setSelectedStudent(prev => (prev && prev.regId === reg.regId ? null : prev));
      // A plain filter-out would work for scope="registrants" (one row per
      // registration), but scope="allUsers" shows one row per STUDENT
      // ACCOUNT — deleting the registration should drop that row back to
      // "not registered yet", not remove the student entirely. Refetching
      // gets that reshaping right for both scopes without duplicating
      // fetchStudents' merge logic here.
      await fetchStudents();
      onDeleted?.(reg.regId);
    } catch (err) {
      console.error(err);
      setDecisionError(`Failed to delete ${reg.fullName || 'this registration'}.`);
    } finally {
      setDecidingId(null);
    }
  }, [userProfile, onDeleted, fetchStudents]);

  /* ── Download one student's registration as a PDF ──
     Same jsPDF + jspdf-autotable combo AdminSchedulePage already uses for
     match schedule/bracket exports (see handleDownloadPdf there) — a plain
     key/value table per section, laid out like the Student Details modal
     above. Photo/waiver aren't embedded as images: fetching a Firebase
     Storage URL into a canvas for jsPDF's addImage can fail on CORS, and a
     clickable link the reviewer can open is more reliable than a PDF
     export that silently breaks. */
  const handleDownloadPdf = async (reg) => {
    const { jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text(schoolName, pageWidth / 2, 40, { align: 'center' });
    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.text('Student Player Registration', pageWidth / 2, 58, { align: 'center' });
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`Generated ${new Date().toLocaleString()}`, pageWidth / 2, 72, { align: 'center' });
    doc.setTextColor(0);

    let cursorY = 92;
    const section = (title, rows) => {
      const body = rows.filter(([, value]) => value !== undefined);
      if (body.length === 0) return;

      autoTable(doc, {
        startY: cursorY,
        head: [[title, '']],
        body: [],
        theme: 'plain',
        styles: { fontSize: 11, fontStyle: 'bold' },
        margin: { left: 40, right: 40 },
      });
      autoTable(doc, {
        startY: doc.lastAutoTable.finalY,
        body,
        theme: 'grid',
        styles: { fontSize: 10, cellPadding: 6 },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150 } },
        margin: { left: 40, right: 40 },
      });
      cursorY = doc.lastAutoTable.finalY + 20;
    };

    const level = LEVEL_LABELS[getSchoolLevel(reg.gradeLevel)] || '—';
    const statusLabel = reg.status ? reg.status.charAt(0).toUpperCase() + reg.status.slice(1) : 'N/A';

    section('Registration Status', [
      ['Status', statusLabel],
      ['Registered For', reg.event || 'N/A'],
    ]);
    section('Basic Information', [
      ['Full Name', reg.fullName || '—'],
      ['Gender', reg.gender || '—'],
      ['Date of Birth', reg.dob || '—'],
      ['Age', reg.age || '—'],
    ]);
    section('Academic Information', [
      ['Grade / Year Level', reg.gradeLevel || '—'],
      ['Level', level],
      ['Section', reg.section || '—'],
    ]);
    section('Contact Information', [
      ['Contact Number', reg.contactNumber || '—'],
      ['Email', reg.email || reg.studentEmail || '—'],
      ['Address', reg.address || '—'],
      ['Emergency Contact', reg.emergencyContact || '—'],
    ]);
    section('Sports & Team', [
      ['Sport', reg.sport || 'N/A'],
      ['Position', reg.position || 'N/A'],
      ['Team Name', reg.teamName || 'N/A'],
    ]);
    if (reg.message) {
      section('Message', [['Message', reg.message]]);
    }

    if (reg.photoURL || reg.waiverURL) {
      doc.setFontSize(10);
      doc.setTextColor(29, 78, 216);
      if (reg.photoURL) {
        doc.textWithLink('View uploaded photo', 40, cursorY, { url: reg.photoURL });
        cursorY += 16;
      }
      if (reg.waiverURL) {
        doc.textWithLink('View uploaded waiver / consent form', 40, cursorY, { url: reg.waiverURL });
        cursorY += 16;
      }
      doc.setTextColor(0);
    }

    const safeName = (reg.fullName || 'student').trim().replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    doc.save(`registration-${safeName || 'student'}.pdf`);
  };

  const uniqueSections = useMemo(
    () => [...new Set(allRegistrations.map(r => r.section).filter(Boolean))].sort(),
    [allRegistrations]
  );
  const uniqueSports = useMemo(
    () => [...new Set(allRegistrations.map(r => r.sport).filter(Boolean))].sort(),
    [allRegistrations]
  );

  // Debounced so filtering a large registration list doesn't run on every
  // single keystroke — the input itself stays bound to `searchQuery` so
  // typing still feels instant, only the (potentially expensive) filter
  // pass waits for a short pause.
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const filteredStudents = useMemo(() => {
    const q = debouncedSearchQuery.toLowerCase();
    return allRegistrations.filter(r => (
      (!q             || (r.fullName || '').toLowerCase().includes(q)) &&
      (!filterLevel   || getSchoolLevel(r.gradeLevel) === filterLevel) &&
      (!filterGrade   || r.gradeLevel === filterGrade) &&
      (!filterSection || r.section    === filterSection) &&
      (!filterSport   || r.sport      === filterSport) &&
      (!filterGender  || (r.gender || '').toLowerCase() === filterGender.toLowerCase()) &&
      (!filterEvent   || getEventBucket(r, events) === filterEvent)
    ));
  }, [allRegistrations, debouncedSearchQuery, filterLevel, filterGrade, filterSection, filterSport, filterGender, filterEvent, events]);

  const hasFilters = searchQuery || filterLevel || filterGrade || filterSection || filterSport || filterGender || filterEvent;
  const clearFilters = () => { setSearchQuery(''); setFilterLevel(''); setFilterGrade(''); setFilterSection(''); setFilterSport(''); setFilterGender(''); setFilterEvent(''); };

  return (
    <>
      <div className="asp-card">
        <div className="asp-card__toprow">
          <div className="asp-card__heading">
            <FaUserGraduate className="asp-card__icon" />
            <span>{scope === 'allUsers' ? 'USERS REGISTRATION DETAILS' : 'STUDENT PLAYERS REGISTRATION DETAILS'}</span>
          </div>
          <div className="asp-search-wrap">
            <FaSearch className="asp-search-icon" />
            <input
              className="asp-search-input"
              type="text"
              placeholder="Search by name…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="asp-empty">{error}</p>}
        {decisionError && <div className="asp-alert asp-alert--error">{decisionError}</div>}

        {/* Filter pills */}
        <div className="asp-filters">
          <FilterDropdown
            label="Level ▾"
            value={filterLevel}
            onChange={setFilterLevel}
            options={[
              { value: 'elementary', label: 'Elementary' },
              { value: 'highSchool', label: 'High School' },
              { value: 'college', label: 'College' },
            ]}
          />
          <FilterDropdown
            label="Grade/Year ▾"
            value={filterGrade}
            onChange={setFilterGrade}
            options={ALL_GRADES.map(g => ({ value: g, label: g }))}
          />
          <FilterDropdown
            label="Section ▾"
            value={filterSection}
            onChange={setFilterSection}
            options={uniqueSections.map(s => ({ value: s, label: s }))}
          />
          <FilterDropdown
            label="Sports ▾"
            value={filterSport}
            onChange={setFilterSport}
            options={uniqueSports.map(s => ({ value: s, label: s }))}
          />
          <FilterDropdown
            label="Gender ▾"
            value={filterGender}
            onChange={setFilterGender}
            options={[
              { value: 'Male', label: 'Male' },
              { value: 'Female', label: 'Female' },
              { value: 'Others', label: 'Others' },
            ]}
          />
          <FilterDropdown
            label="Event ▾"
            value={filterEvent}
            onChange={setFilterEvent}
            options={[
              ...events.map(ev => ({ value: ev.key, label: ev.label })),
              { value: 'unassigned', label: 'No Event' },
            ]}
          />
          {hasFilters && (
            <button className="asp-clear-btn" onClick={clearFilters}>
              <FaTimes /> Clear Filter
            </button>
          )}
          <span className="asp-results-count">{filteredStudents.length} result{filteredStudents.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="asp-table-wrap" style={{ marginTop: 8 }}>
          {loading ? (
            <p className="asp-empty">Loading from Firestore…</p>
          ) : filteredStudents.length === 0 ? (
            <p className="asp-empty">{hasFilters ? 'No students match the selected filters.' : 'No registrations found.'}</p>
          ) : (
            <table className="asp-table asp-table--students">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Gender</th>
                  <th>Grade/Year</th>
                  <th>Level</th>
                  <th>Section</th>
                  <th>Sport</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((reg, idx) => (
                  <tr key={reg.id || idx}>
                    <td className="asp-td--num" data-label="#">{idx + 1}</td>
                    <td className="asp-td--name" data-label="Name">
                      <span className="asp-avatar">
                        {(reg.fullName || 'U').charAt(0).toUpperCase()}
                      </span>
                      <span className="asp-name-text">
                        {reg.fullName || <em className="asp-placeholder">Last Name, First Name, Middle Name</em>}
                      </span>
                    </td>
                    <td data-label="Gender">
                      <span className={`asp-gender-badge asp-gender--${(reg.gender || 'unknown').toLowerCase()}`}>
                        {reg.gender || '—'}
                      </span>
                    </td>
                    <td data-label="Grade/Year">{reg.gradeLevel || '—'}</td>
                    <td data-label="Level">{LEVEL_LABELS[getSchoolLevel(reg.gradeLevel)] || '—'}</td>
                    <td data-label="Section">{reg.section || '—'}</td>
                    <td className="asp-td--sport" data-label="Sport">{reg.sport || '—'}</td>
                    <td data-label="Event">{reg.event || '—'}</td>
                    <td data-label="Status">
                      {reg.status ? (
                        <span className={`asp-status-badge asp-status--${reg.status}`}>{reg.status}</span>
                      ) : '—'}
                    </td>
                    <td data-label="Action">
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
                        <button className="asp-btn-view" onClick={() => setSelectedStudent(reg)}>View</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Student Detail Modal ── */}
      {selectedStudent && (
        <div className="asp-modal-overlay" onClick={() => setSelectedStudent(null)}>
          <div className="asp-modal" onClick={e => e.stopPropagation()}>
            <div className="asp-modal__header">
              <h2>
                Student Details
                {selectedStudent.status && (
                  <span
                    className={`asp-status-badge asp-status--${selectedStudent.status}`}
                    style={{ marginLeft: 10, verticalAlign: 'middle' }}
                  >
                    {selectedStudent.status}
                  </span>
                )}
              </h2>
              <button className="asp-modal__close" onClick={() => setSelectedStudent(null)}><FaTimes /></button>
            </div>
            <div className="asp-modal__body">
              <section className="asp-modal__section-group">
                <h3 className="asp-modal__section">Basic Information</h3>
                <div className="asp-form-row">
                  <DetailField label="Full Name" value={selectedStudent.fullName} />
                  <DetailField label="Gender" value={selectedStudent.gender} center />
                </div>
                <div className="asp-form-row">
                  <DetailField label="Date of Birth" value={selectedStudent.dob} />
                  <DetailField label="Age" value={selectedStudent.age} center />
                </div>
              </section>

              <section className="asp-modal__section-group">
                <h3 className="asp-modal__section">Academic Information</h3>
                <div className="asp-form-row">
                  <DetailField label="Grade / Year Level" value={selectedStudent.gradeLevel} />
                  <DetailField label="Section" value={selectedStudent.section} center />
                </div>
                <DetailField label="Level" value={LEVEL_LABELS[getSchoolLevel(selectedStudent.gradeLevel)]} />
              </section>

              <section className="asp-modal__section-group">
                <h3 className="asp-modal__section">Contact Information</h3>
                <div className="asp-form-row">
                  <DetailField label="Contact Number" value={selectedStudent.contactNumber} />
                  <DetailField label="Email" value={selectedStudent.email || selectedStudent.studentEmail} center />
                </div>
                <DetailField label="Address" value={selectedStudent.address} />
                <DetailField label="Emergency Contact" value={selectedStudent.emergencyContact} />
              </section>

              <section className="asp-modal__section-group">
                <h3 className="asp-modal__section">Sports &amp; Team</h3>
                <div className="asp-form-row">
                  <DetailField label="Sport" value={selectedStudent.sport} />
                  <DetailField label="Position" value={selectedStudent.position} center />
                </div>
                <div className="asp-form-row">
                  <DetailField label="Team Name" value={selectedStudent.teamName} />
                  <DetailField label="Event" value={selectedStudent.event} center />
                </div>
              </section>

              {selectedStudent.message && (
                <section className="asp-modal__section-group">
                  <h3 className="asp-modal__section">Message</h3>
                  <DetailField label="Message" value={selectedStudent.message} />
                </section>
              )}

              {(selectedStudent.photoURL || selectedStudent.waiverURL) && (
                <section className="asp-modal__section-group">
                  <h3 className="asp-modal__section">Attachments</h3>
                  <div className="asp-form-row">
                    {selectedStudent.photoURL && (
                      <div className="asp-form-group">
                        <label>Photo</label>
                        <p><a href={selectedStudent.photoURL} target="_blank" rel="noreferrer">View photo</a></p>
                      </div>
                    )}
                    {selectedStudent.waiverURL && (
                      <div className="asp-form-group">
                        <label>Waiver / Consent Form</label>
                        <p><a href={selectedStudent.waiverURL} target="_blank" rel="noreferrer">View waiver</a></p>
                      </div>
                    )}
                  </div>
                </section>
              )}

              <div className="asp-form-actions">
                <button
                  type="button"
                  className="asp-btn-download"
                  onClick={() => handleDownloadPdf(selectedStudent)}
                >
                  <FaFilePdf /> Download PDF
                </button>
                {selectedStudent.regId && (
                  <>
                    <button
                      type="button"
                      className="asp-btn-approve"
                      disabled={decidingId === selectedStudent.regId || selectedStudent.status === 'approved'}
                      onClick={() => handleDecision(selectedStudent, 'approved')}
                    >
                      <FaCheck /> Approve
                    </button>
                    <button
                      type="button"
                      className="asp-btn-reject"
                      disabled={decidingId === selectedStudent.regId || selectedStudent.status === 'rejected'}
                      onClick={() => handleDecision(selectedStudent, 'rejected')}
                    >
                      <FaTimes /> Reject
                    </button>
                    <button
                      type="button"
                      className="asp-btn-delete"
                      disabled={decidingId === selectedStudent.regId}
                      onClick={() => handleDelete(selectedStudent)}
                    >
                      <FaTrash /> Delete
                    </button>
                  </>
                )}
                <button type="button" className="asp-btn-cancel" onClick={() => setSelectedStudent(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
