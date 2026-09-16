import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { FaSearch, FaTimes, FaUserGraduate, FaCheck } from 'react-icons/fa';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { getEventKey, getEventLabel, updateRegistrationStatus } from '../services/firestoreService';
import { BrandingContext } from '../components/BrandingContext';
import { AuthContext } from '../components/AuthContext';
import './AdminSchedulePage.css';

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

export default function StudentRegistrationDetails() {
  const { events } = useContext(BrandingContext);
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
      const regSnap = await getDocs(collection(db, 'registrations'));
      const registrations = regSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      const userSnap = await getDocs(collection(db, 'users'));
      const users = userSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // This table is the STUDENT registration tabulation — staff accounts
      // (admin / moderator / super admin) manage it, they don't belong as
      // rows in it.
      const studentUsers = users.filter(
        u => (u.role || 'student').toLowerCase() === 'student'
      );
      const studentUids = new Set(studentUsers.map(u => u.id));
      const studentRegistrations = registrations.filter(r => studentUids.has(r.uid));

      // One row per STUDENT ACCOUNT (keyed by uid) — never collapsed or
      // matched by name, since two different accounts can legitimately
      // share the same name.
      const merged = studentUsers.map(user => {
        const registration = studentRegistrations.find(r => r.uid === user.id);

        return {
          ...user,
          ...(registration || {}),
          id: user.id,
          uid: user.id,
          // The registration doc's own id, distinct from the user id above —
          // this is what approve/reject writes back to. Null when the
          // student hasn't registered at all (an audience-only account).
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
      }).sort((a, b) =>
        (a.fullName || '').localeCompare(b.fullName || '', undefined, { sensitivity: 'base' })
      );

      setAllRegistrations(merged);
    } catch (err) {
      console.error(err);
      setError('Failed to load registration data.');
    } finally {
      setLoading(false);
    }
  }, [events]);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  const handleDecision = useCallback(async (reg, status) => {
    if (!reg.regId) return;
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
    } catch (err) {
      console.error(err);
      setDecisionError(`Failed to ${status === 'approved' ? 'approve' : 'reject'} ${reg.fullName || 'this registration'}.`);
    } finally {
      setDecidingId(null);
    }
  }, [userProfile]);

  const uniqueSections = [...new Set(allRegistrations.map(r => r.section).filter(Boolean))].sort();
  const uniqueSports   = [...new Set(allRegistrations.map(r => r.sport).filter(Boolean))].sort();

  const filteredStudents = allRegistrations.filter(r => {
    const q = searchQuery.toLowerCase();
    return (
      (!q             || (r.fullName || '').toLowerCase().includes(q)) &&
      (!filterLevel   || getSchoolLevel(r.gradeLevel) === filterLevel) &&
      (!filterGrade   || r.gradeLevel === filterGrade) &&
      (!filterSection || r.section    === filterSection) &&
      (!filterSport   || r.sport      === filterSport) &&
      (!filterGender  || (r.gender || '').toLowerCase() === filterGender.toLowerCase()) &&
      (!filterEvent   || getEventBucket(r, events) === filterEvent)
    );
  });

  const hasFilters = searchQuery || filterLevel || filterGrade || filterSection || filterSport || filterGender || filterEvent;
  const clearFilters = () => { setSearchQuery(''); setFilterLevel(''); setFilterGrade(''); setFilterSection(''); setFilterSport(''); setFilterGender(''); setFilterEvent(''); };

  return (
    <>
      <div className="asp-card">
        <div className="asp-card__toprow">
          <div className="asp-card__heading">
            <FaUserGraduate className="asp-card__icon" />
            <span>STUDENT REGISTRATION DETAILS</span>
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
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                        <button className="asp-btn-view" onClick={() => setSelectedStudent(reg)}>View</button>
                        {reg.regId && reg.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              className="asp-btn-approve"
                              disabled={decidingId === reg.regId}
                              onClick={() => handleDecision(reg, 'approved')}
                            >
                              <FaCheck /> Approve
                            </button>
                            <button
                              type="button"
                              className="asp-btn-reject"
                              disabled={decidingId === reg.regId}
                              onClick={() => handleDecision(reg, 'rejected')}
                            >
                              <FaTimes /> Reject
                            </button>
                          </>
                        )}
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
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Full Name</label>
                  <p>{selectedStudent.fullName || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Gender</label>
                  <p>{selectedStudent.gender || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Grade / Year Level</label>
                  <p>{selectedStudent.gradeLevel || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Section</label>
                  <p>{selectedStudent.section || '—'}</p>
                </div>
              </div>
              <div className="asp-form-group">
                <label>Level</label>
                <p>{LEVEL_LABELS[getSchoolLevel(selectedStudent.gradeLevel)] || '—'}</p>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Date of Birth</label>
                  <p>{selectedStudent.dob || '—'}</p>
                </div>
                <div className="asp-form-group">
                  <label>Age</label>
                  <p>{selectedStudent.age || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Contact Number</label>
                  <p>{selectedStudent.contactNumber || '—'}</p>
                </div>
                <div className="asp-form-group">
                  <label>Email</label>
                  <p>{selectedStudent.email || selectedStudent.studentEmail || '—'}</p>
                </div>
              </div>
              <div className="asp-form-group">
                <label>Address</label>
                <p>{selectedStudent.address || '—'}</p>
              </div>
              <div className="asp-form-group">
                <label>Emergency Contact</label>
                <p>{selectedStudent.emergencyContact || '—'}</p>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group asp-form-group--center">
                  <label>Sport</label>
                  <p>{selectedStudent.sport || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Position</label>
                  <p>{selectedStudent.position || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group asp-form-group--center">
                  <label>Team Name</label>
                  <p>{selectedStudent.teamName || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Event</label>
                  <p>{selectedStudent.event || '—'}</p>
                </div>
              </div>
              {selectedStudent.message && (
                <div className="asp-form-group">
                  <label>Message</label>
                  <p>{selectedStudent.message}</p>
                </div>
              )}
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
              <div className="asp-form-actions">
                {selectedStudent.regId && selectedStudent.status === 'pending' && (
                  <>
                    <button
                      type="button"
                      className="asp-btn-approve"
                      disabled={decidingId === selectedStudent.regId}
                      onClick={() => handleDecision(selectedStudent, 'approved')}
                    >
                      <FaCheck /> Approve
                    </button>
                    <button
                      type="button"
                      className="asp-btn-reject"
                      disabled={decidingId === selectedStudent.regId}
                      onClick={() => handleDecision(selectedStudent, 'rejected')}
                    >
                      <FaTimes /> Reject
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
