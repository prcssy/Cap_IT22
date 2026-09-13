import React, { useState, useEffect, useCallback } from 'react';
import { FaSearch, FaTimes, FaUserGraduate } from 'react-icons/fa';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { getEventKey, getEventLabel, EVENT_TYPES } from '../services/firestoreService';
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

/* Which event bucket a registration belongs to — same rule AdminSchedulePage
   uses for its own event filter/chips. */
function getEventBucket(r) {
  return getEventKey(r.eventKey || r.event) || 'unassigned';
}

export default function StudentRegistrationDetails() {
  const [allRegistrations, setAllRegistrations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
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
          fullName: (registration && registration.fullName) || user.name || '',
          email: (registration && registration.email) || user.email || '',
          gender: user.gender || '—',
          gradeLevel: user.gradeLevel || '—',
          section: user.section || '—',
          sport: (registration && registration.sport) || 'N/A',
          position: (registration && registration.position) || 'N/A',
          teamName: (registration && registration.teamName) || 'N/A',
          event: (registration && (getEventLabel(registration.eventKey || registration.event) || registration.event)) || 'N/A',
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
  }, []);

  useEffect(() => { fetchStudents(); }, [fetchStudents]);

  const uniqueSections = [...new Set(allRegistrations.map(r => r.section).filter(Boolean))].sort();
  const uniqueSports   = [...new Set(allRegistrations.map(r => r.sport).filter(Boolean))].sort();

  const filteredStudents = allRegistrations.filter(r => {
    const q = searchQuery.toLowerCase();
    return (
      (!q             || (r.fullName || '').toLowerCase().includes(q)) &&
      (!filterGrade   || r.gradeLevel === filterGrade) &&
      (!filterSection || r.section    === filterSection) &&
      (!filterSport   || r.sport      === filterSport) &&
      (!filterGender  || (r.gender || '').toLowerCase() === filterGender.toLowerCase()) &&
      (!filterEvent   || getEventBucket(r) === filterEvent)
    );
  });

  const hasFilters = searchQuery || filterGrade || filterSection || filterSport || filterGender || filterEvent;
  const clearFilters = () => { setSearchQuery(''); setFilterGrade(''); setFilterSection(''); setFilterSport(''); setFilterGender(''); setFilterEvent(''); };

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

        {/* Filter pills */}
        <div className="asp-filters">
          <select className="asp-filter-pill" value={filterGrade} onChange={e => setFilterGrade(e.target.value)}>
            <option value="">Grade/Year ▾</option>
            {ALL_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select className="asp-filter-pill" value={filterSection} onChange={e => setFilterSection(e.target.value)}>
            <option value="">Section ▾</option>
            {uniqueSections.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="asp-filter-pill" value={filterSport} onChange={e => setFilterSport(e.target.value)}>
            <option value="">Sports ▾</option>
            {uniqueSports.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="asp-filter-pill" value={filterGender} onChange={e => setFilterGender(e.target.value)}>
            <option value="">Gender ▾</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Others">Others</option>
          </select>
          <select className="asp-filter-pill" value={filterEvent} onChange={e => setFilterEvent(e.target.value)}>
            <option value="">Event ▾</option>
            {EVENT_TYPES.map(ev => <option key={ev.key} value={ev.key}>{ev.label}</option>)}
            <option value="unassigned">No Event</option>
          </select>
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
                  <th>Section</th>
                  <th>Sport</th>
                  <th>Event</th>
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
                    <td data-label="Section">{reg.section || '—'}</td>
                    <td className="asp-td--sport" data-label="Sport">{reg.sport || '—'}</td>
                    <td data-label="Event">{reg.event || '—'}</td>
                    <td data-label="Action">
                      <button className="asp-btn-view" onClick={() => setSelectedStudent(reg)}>View</button>
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
              <h2>Student Details</h2>
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
                <div className="asp-form-group asp-form-group--center">
                  <label>Grade / Year Level</label>
                  <p>{selectedStudent.gradeLevel || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Section</label>
                  <p>{selectedStudent.section || '—'}</p>
                </div>
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
                <button type="button" className="asp-btn-cancel" onClick={() => setSelectedStudent(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
