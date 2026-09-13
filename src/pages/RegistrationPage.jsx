import React, { useState, useRef, useContext, useEffect, useCallback, useMemo } from 'react';
import { AuthContext } from '../components/AuthContext';
import {
  createRegistration,
  getSportsTeamsConfig,
  getEventRegistrationCounts,
  EVENT_TYPES,
} from '../services/firestoreService';
import {
  getAllProvinces,
  getProvinceByCode,
  getMunicipalitiesByProvince,
  getMunicipalityByCode,
  getBarangaysByMunicipality,
  getBarangayByCode,
} from '@aivangogh/ph-address';
import './RegistrationPage.css';
import Contact from '../components/Landing/Contact/Contact';
import {
  FaMapMarkerAlt,
  FaPhoneAlt,
  FaEnvelope,
  FaFacebookF,
} from 'react-icons/fa';

const GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12',
  '1st Year', '2nd Year', '3rd Year', '4th Year'];

const SECTIONS = ['Section A', 'Section B', 'Section C', 'Section D', 'Section E'];

/* Sport & Team options aren't hardcoded here — they come from whatever
   the admin has configured for the student's school level in the
   "Sports & Teams" manager (see SportsTeamsManager.jsx /
   getSportsTeamsConfig). Same source, same shape, for both dropdowns. */
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

const POSITIONS = [
  'Forward', 'Guard', 'Center', 'Pitcher', 'Catcher', 'Shortstop',
  'Outfield', 'Midfielder', 'Goalkeeper', 'Sprinter', 'Other',
];

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — keep in sync with storage.rules

const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const WAIVER_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
];

function validateUpload(file, allowedTypes) {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return 'File is too large — max 5 MB.';
  }
  if (!allowedTypes.includes(file.type)) {
    return 'Unsupported file type.';
  }
  return null;
}

const INITIAL = {
  event: '',
  fullName: '', dob: '', age: '',
  gender: '',
  contactNumber: '', email: '',
  address: '', emergencyContact: '',
  gradeLevel: '', section: '',
  teamName: '', sport: '', position: '',
  message: '',
};

// Address is built from these PSGC picks (see @aivangogh/ph-address) plus a
// free-text street line, then joined into the single `form.address` string
// that Firestore/AdminSchedulePage already expect — see composedAddress below.
const ADDR_INITIAL = {
  provinceCode: '', municipalityCode: '', barangayCode: '', street: '',
};

// NCR is the one region in the PSGC dataset with no provinces — its 17
// cities (Manila, Quezon City, Makati, etc.) are filed directly under the
// region's own code. Modeled as one extra "province" entry so the whole
// country is reachable from a single Province dropdown.
const METRO_MANILA_CODE = '1300000000';
const METRO_MANILA_PSEUDO_PROVINCE = { name: 'Metro Manila', psgcCode: METRO_MANILA_CODE };

const CONTACT_ITEMS = [
  { icon: FaMapMarkerAlt, text: 'San Jose, Santa Rita Pampanga, Philippines', href: 'https://www.google.com/maps/place/Santa+Rita+College/@14.9989285,120.6178094,18.6z' },
  { icon: FaPhoneAlt,     text: '(045) 900 0557',                href: 'tel:+0459000557' },
  { icon: FaEnvelope,     text: 'src_educ_ph@yahoo.com',         href: 'mailto:src_educ_ph@yahoo.com' },
  { icon: FaFacebookF,    text: 'facebook.com/santaritacollege', href: 'https://facebook.com/santaritacollege' },
];

export default function RegistrationPage() {

  const { currentUser } = useContext(AuthContext);
  const [form, setForm] = useState(INITIAL);
  const [addr, setAddr] = useState(ADDR_INITIAL);
  const [photo, setPhoto]         = useState(null);
  const [waiver, setWaiver]       = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors]       = useState({});
  const [showNotice, setShowNotice] = useState(false);

  // Sport / Team options, sourced live from the admin's Sports & Teams
  // config for whichever school level the selected Grade/Year falls in.
  const [sportOptions, setSportOptions] = useState([]);
  const [teamOptions, setTeamOptions]   = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);

  // How many players have registered per event so far. Read from the
  // public siteCounters doc — students can't read the registrations
  // collection itself, so the count is published there instead.
  const [eventCounts, setEventCounts]     = useState({});
  const [countsLoading, setCountsLoading] = useState(true);

  // `minimums` guards the moment right after a submit: the counter is
  // bumped in the background, so a refresh that lands first would show
  // the pre-registration number and make the count appear to jump back.
  const loadEventCounts = useCallback((minimums) => {
    setCountsLoading(true);
    return getEventRegistrationCounts()
      .then((counts) => {
        const merged = { ...counts };
        Object.entries(minimums || {}).forEach(([key, value]) => {
          merged[key] = Math.max(Number(merged[key]) || 0, Number(value) || 0);
        });
        setEventCounts(merged);
      })
      .catch((error) => {
        console.error('Failed to load event registration counts:', error);
        setEventCounts({});
      })
      .finally(() => setCountsLoading(false));
  }, []);

  useEffect(() => { loadEventCounts(); }, [loadEventCounts]);

  const photoRef         = useRef(null);
  const waiverRef        = useRef(null);
  const contactFooterRef = useRef(null);
  const cardRef          = useRef(null);

  const set = (k) => (e) => {
    setForm(prev => ({ ...prev, [k]: e.target.value }));
    setErrors(prev => {
      if (!prev[k]) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });
  };

  // ── Address: cascading PSGC province -> city/municipality -> barangay,
  // plus a free-text street line. All lookups are synchronous and in-memory
  // (no network/loading state needed, unlike the sport/team config fetch
  // below).
  const provinceOptions = useMemo(() => {
    return [...getAllProvinces(), METRO_MANILA_PSEUDO_PROVINCE]
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const municipalityOptions = useMemo(
    () => (addr.provinceCode ? getMunicipalitiesByProvince(addr.provinceCode) : []),
    [addr.provinceCode]
  );

  const barangayOptions = useMemo(
    () => (addr.municipalityCode ? getBarangaysByMunicipality(addr.municipalityCode) : []),
    [addr.municipalityCode]
  );

  // The City of Manila itself carries no barangays directly in PSGC — its
  // districts (Binondo, Ermita, etc.) do, one level further down, which this
  // form doesn't model. Rather than block submission for that one city,
  // treat "no barangays for this municipality" as N/A, same as the old
  // province fallback.
  const noBarangaysForMunicipality = Boolean(addr.municipalityCode) && barangayOptions.length === 0;

  const composedAddress = useMemo(() => {
    const province = addr.provinceCode === METRO_MANILA_CODE
      ? METRO_MANILA_PSEUDO_PROVINCE
      : (addr.provinceCode ? getProvinceByCode(addr.provinceCode) : null);
    const municipality = addr.municipalityCode ? getMunicipalityByCode(addr.municipalityCode) : null;
    const barangay      = addr.barangayCode ? getBarangayByCode(addr.barangayCode) : null;

    return [
      addr.street.trim(),
      barangay ? `Brgy. ${barangay.name}` : '',
      municipality ? municipality.name : '',
      province ? province.name : '',
    ].filter(Boolean).join(', ');
  }, [addr]);

  // Keep form.address (what actually gets saved) in sync with the picks
  // above — createRegistration/firestoreService only know about a single
  // `address` string, same as before this feature existed.
  useEffect(() => {
    setForm(prev => (prev.address === composedAddress ? prev : { ...prev, address: composedAddress }));
  }, [composedAddress]);

  const clearAddrError = (key) => setErrors(prev => {
    if (!prev[key]) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });

  const onProvinceChange = (e) => {
    setAddr(prev => ({ ...prev, provinceCode: e.target.value, municipalityCode: '', barangayCode: '' }));
    clearAddrError('province');
  };
  const onMunicipalityChange = (e) => {
    setAddr(prev => ({ ...prev, municipalityCode: e.target.value, barangayCode: '' }));
    clearAddrError('municipality');
  };
  const onBarangayChange = (e) => {
    setAddr(prev => ({ ...prev, barangayCode: e.target.value }));
    clearAddrError('barangay');
  };
  const onStreetChange = (e) => setAddr(prev => ({ ...prev, street: e.target.value }));

  const schoolLevel = getSchoolLevel(form.gradeLevel);

  useEffect(() => {
    let cancelled = false;

    if (!schoolLevel) {
      setSportOptions([]);
      setTeamOptions([]);
      return;
    }

    setLoadingOptions(true);
    getSportsTeamsConfig(schoolLevel)
      .then(({ sports, teams }) => {
        if (cancelled) return;
        const sportNames = [...new Set((sports || []).map(s => s.name).filter(Boolean))].sort();
        const teamNames  = [...new Set((teams  || []).map(t => t.name).filter(Boolean))].sort();
        setSportOptions(sportNames);
        setTeamOptions(teamNames);
      })
      .catch((error) => {
        console.error('Failed to load sports/teams config:', error);
        if (!cancelled) { setSportOptions([]); setTeamOptions([]); }
      })
      .finally(() => { if (!cancelled) setLoadingOptions(false); });

    return () => { cancelled = true; };
  }, [schoolLevel]);

  // Selected grade level changed school levels — clear any team/sport
  // pick that no longer belongs to the newly loaded options.
  useEffect(() => {
    setForm(prev => ({ ...prev, teamName: '', sport: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolLevel]);

  const handleFile = (setter, key, allowedTypes) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validationError = validateUpload(file, allowedTypes);
    if (validationError) {
      setter(null);
      e.target.value = ''; // let the user re-pick the same filename after fixing it
      setErrors(prev => ({ ...prev, [key]: validationError }));
      return;
    }

    setter(file);
    setErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleReset = () => {
    setForm(INITIAL);
    setAddr(ADDR_INITIAL);
    setPhoto(null);
    setWaiver(null);
    setSubmitted(false);
    setErrors({});
    setShowNotice(false);
    if (photoRef.current)  photoRef.current.value  = '';
    if (waiverRef.current) waiverRef.current.value = '';
  };

  const validate = () => {
    const errs = {};
    if (!form.event)                  errs.event            = 'Please select an event to register for';
    if (!form.fullName.trim())        errs.fullName        = 'Full name is required';
    if (!form.dob)                    errs.dob              = 'Date of birth is required';
    if (!form.age)                    errs.age              = 'Age is required';
    else if (Number(form.age) <= 0)   errs.age              = 'Enter a valid age';
    if (!form.gender)                 errs.gender           = 'Please select a gender';
    if (!form.contactNumber.trim())   errs.contactNumber    = 'Contact number is required';
    if (!addr.provinceCode)           errs.province         = 'Please select a province';
    if (!addr.municipalityCode)       errs.municipality     = 'Please select a city / municipality';
    if (!noBarangaysForMunicipality && !addr.barangayCode)
                                       errs.barangay         = 'Please select a barangay';
    if (!form.emergencyContact.trim())errs.emergencyContact = 'Emergency contact is required';
    if (!form.gradeLevel)             errs.gradeLevel       = 'Please select a grade / year level';
    if (!form.section)                errs.section          = 'Please select a section';
    if (!form.teamName)               errs.teamName         = 'Please select a team';
    if (!form.sport)                  errs.sport            = 'Please select a sport / event';
    if (!form.position)               errs.position         = 'Please select a position';
    // Waiver upload is temporarily optional: Firebase Storage isn't
    // provisioned on the project yet (requires the Blaze plan), so there's
    // nowhere to save the file. Re-add this check once Storage is enabled.
    return errs;
  };

 const handleSave = async (e) => {
    e.preventDefault();

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setShowNotice(true);
      if (cardRef.current) {
        cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    setShowNotice(false);

    try {

        if (!currentUser) {
            alert("Please login first.");
            return;
        }

        await createRegistration(
            currentUser.uid,
            currentUser.email,
            form,
            photo,
            waiver
        );

        setSubmitted(true);

        // Show the new number straight away, then re-sync with the
        // server so the displayed count matches what was actually saved.
        const chosenKey = (EVENT_TYPES.find(ev => ev.label === form.event) || {}).key;
        if (chosenKey) {
          const next = (Number(eventCounts[chosenKey]) || 0) + 1;
          setEventCounts(prev => ({ ...prev, [chosenKey]: next }));
          loadEventCounts({ [chosenKey]: next });
        } else {
          loadEventCounts();
        }

    } catch (error) {
        console.error(error);
        alert(error.message);
    }
};

  if (submitted) {
    return (
      <div className="reg-page">
        <header className="reg-dash-header">
          <h1 className="reg-dash-header__title">SANTA RITA COLLEGE OF PAMPANGA, INC</h1>
        </header>
        <div className="reg-page-intro">
          <h2 className="reg-page-title">Player Registration</h2>
          <p className="reg-page-subtitle">Submit your player details to join a team and sport event</p>
        </div>
        <div className="reg-body">
          <div className="reg-card" style={{ textAlign: 'center', padding: '48px 28px' }}>
            <div style={{ fontSize: 52, marginBottom: 12 }}>✅</div>
            <h2 style={{ fontFamily: 'Lalezar, sans-serif', fontSize: 22, margin: '0 0 8px', color: '#001529' }}>
              Registration Submitted!
            </h2>
            <p style={{ fontSize: 13, color: '#5a6a7a', margin: '0 0 18px' }}>
              Your registration for <strong style={{ color: '#001529' }}>{form.event || 'the event'}</strong> has
              been received. You'll be notified once it's reviewed.
            </p>
            <div className="reg-event-counts reg-event-counts--center">
              <span className="reg-event-counts__title">Players Registered per Event</span>
              <div className="reg-event-counts__chips">
                {EVENT_TYPES.map(ev => (
                  <div
                    key={ev.key}
                    className={`reg-event-chip${form.event === ev.label ? ' reg-event-chip--active' : ''}`}
                  >
                    <span className="reg-event-chip__num">
                      {countsLoading ? '…' : (Number(eventCounts[ev.key]) || 0)}
                    </span>
                    <span className="reg-event-chip__label">{ev.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <button className="reg-btn-save" onClick={handleReset} style={{ margin: '0 auto' }}>
              Register Another Player
            </button>
          </div>
          <Contact items={CONTACT_ITEMS} contactFooterRef={contactFooterRef} />
        </div>
      </div>
    );
  }

  return (
    <div className="reg-page">
      <header className="reg-dash-header">
        <h1 className="reg-dash-header__title">SANTA RITA COLLEGE OF PAMPANGA, INC</h1>
      </header>

      <div className="reg-page-intro">
        <h2 className="reg-page-title">Player Registration</h2>
        <p className="reg-page-subtitle">Submit your player details to join a team and sport event</p>
      </div>

      <div className="reg-body">
        <div className="reg-card" ref={cardRef}>
          <div className="reg-card__head">
            <div className="reg-card__icon">
              <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
            </div>
            <h2 className="reg-card__title">Player Registration</h2>
          </div>

          {showNotice && Object.keys(errors).length > 0 && (
            <div className="reg-notice" role="alert">
              <svg className="reg-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 1 21h22L12 2zm0 5.5 6.9 12H5.1L12 7.5zM11 10v5h2v-5h-2zm0 6.5V18h2v-1.5h-2z"/>
              </svg>
              <span>Please fill in all required fields marked with <strong>*</strong> before submitting.</span>
            </div>
          )}

          <form className="reg-form" onSubmit={handleSave} noValidate>

            {/* Row 0: Which event is this registration for?
                Intramurals, Sportsfest and Prisaa all use this exact
                same form — the dropdown just tags the registration. */}
            <div className="reg-event-block">
              <div className="reg-event-block__grid">
                <Field label="Register For Event" required error={errors.event}>
                  <select className="reg-select" value={form.event} onChange={set('event')} required>
                    <option value="">Select Event</option>
                    {EVENT_TYPES.map(ev => (
                      <option key={ev.key} value={ev.label}>{ev.label}</option>
                    ))}
                  </select>
                  <span className="reg-event-hint">
                    All events use this same registration form — pick the one you're joining.
                  </span>
                </Field>

                <div className="reg-event-counts">
                  <span className="reg-event-counts__title">Players Registered per Event</span>
                  <div className="reg-event-counts__chips">
                    {EVENT_TYPES.map(ev => (
                      <div
                        key={ev.key}
                        className={`reg-event-chip${form.event === ev.label ? ' reg-event-chip--active' : ''}`}
                      >
                        <span className="reg-event-chip__num">
                          {countsLoading ? '…' : (Number(eventCounts[ev.key]) || 0)}
                        </span>
                        <span className="reg-event-chip__label">{ev.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Row 1: Full Name / DOB / Age */}
            <div className="reg-row reg-row--3">
              <Field label="Full Name" required error={errors.fullName}>
                <input className="reg-input" placeholder="Last Name, First Name, Middle Name"
                  value={form.fullName} onChange={set('fullName')} required />
              </Field>
              <Field label="Date of Birth" required error={errors.dob}>
                <input className="reg-input" type="date"
                  value={form.dob} onChange={set('dob')} required />
              </Field>
              <Field label="Age" required error={errors.age}>
                <input className="reg-input" type="number" placeholder="Enter Age" min={5} max={40}
                  value={form.age} onChange={set('age')} required />
              </Field>
            </div>

            {/* Row 2: Gender / Contact Number / Emergency Contact / Email —
                every "how to reach the student or family" field in one row. */}
            <div className="reg-row reg-row--4">
              <Field label="Gender" required error={errors.gender}>
                <div className="reg-radio-group">
                  {['Male', 'Female', 'Others'].map(g => (
                    <label className="reg-radio-label" key={g}>
                      <input type="radio" name="gender" value={g}
                        checked={form.gender === g} onChange={set('gender')} />
                      {g}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Contact Number" required error={errors.contactNumber}>
                <input className="reg-input" placeholder="63+**********"
                  value={form.contactNumber} onChange={set('contactNumber')} required />
              </Field>
              <Field label="Emergency Contact" required error={errors.emergencyContact}>
                <input className="reg-input" placeholder="Name-63+**********"
                  value={form.emergencyContact} onChange={set('emergencyContact')} required />
              </Field>
              <Field label="Email Address">
                <input className="reg-input" type="email" placeholder="@src.edu.ph"
                  value={form.email} onChange={set('email')} />
              </Field>
            </div>

            {/* Row 3: Address — Province / City-Municipality / Barangay / Street,
                kept together as one self-contained row. */}
            <div className="reg-row reg-row--4">
              <Field label="Province" required error={errors.province}>
                <select className="reg-select" value={addr.provinceCode} onChange={onProvinceChange} required>
                  <option value="">Select Province</option>
                  {provinceOptions.map(p => (
                    <option key={p.psgcCode} value={p.psgcCode}>{p.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="City / Municipality" required error={errors.municipality}>
                <select
                  className="reg-select"
                  value={addr.municipalityCode}
                  onChange={onMunicipalityChange}
                  disabled={!addr.provinceCode}
                  required
                >
                  <option value="">
                    {!addr.provinceCode ? 'Select Province first' : 'Select City / Municipality'}
                  </option>
                  {municipalityOptions.map(m => (
                    <option key={m.psgcCode} value={m.psgcCode}>{m.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Barangay" required={!noBarangaysForMunicipality} error={errors.barangay}>
                <select
                  className="reg-select"
                  value={noBarangaysForMunicipality ? '' : addr.barangayCode}
                  onChange={onBarangayChange}
                  disabled={!addr.municipalityCode || noBarangaysForMunicipality}
                  required={!noBarangaysForMunicipality}
                >
                  <option value="">
                    {!addr.municipalityCode
                      ? 'Select City / Municipality first'
                      : noBarangaysForMunicipality
                        ? 'N/A for this city'
                        : 'Select Barangay'}
                  </option>
                  {barangayOptions.map(b => (
                    <option key={b.psgcCode} value={b.psgcCode}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="House No. / Street / Unit">
                <input className="reg-input" placeholder="e.g. 123 Rizal St., Purok 2 (optional)"
                  value={addr.street} onChange={onStreetChange} />
              </Field>
            </div>

            {/* Row 4: Grade / Section */}
            <div className="reg-row reg-row--2">
              <Field label="Grade / Year Level" required error={errors.gradeLevel}>
                <select className="reg-select" value={form.gradeLevel} onChange={set('gradeLevel')} required>
                  <option value="">Select Grade / Year Level</option>
                  {GRADE_LEVELS.map(g => <option key={g}>{g}</option>)}
                </select>
              </Field>
              <Field label="Section" required error={errors.section}>
                <select className="reg-select" value={form.section} onChange={set('section')} required>
                  <option value="">Select Section</option>
                  {SECTIONS.map(s => <option key={s}>{s}</option>)}
                </select>
              </Field>
            </div>

            {/* Row 5: Team / Sport / Position */}
            <div className="reg-row reg-row--3eq">
              <Field label="Team Name" required error={errors.teamName}>
                <select
                  className="reg-select"
                  value={form.teamName}
                  onChange={set('teamName')}
                  disabled={!schoolLevel || loadingOptions}
                  required
                >
                  <option value="">
                    {!schoolLevel
                      ? 'Select Grade / Year Level first'
                      : loadingOptions
                        ? 'Loading teams…'
                        : teamOptions.length === 0
                          ? 'No teams configured yet'
                          : 'Select Team'}
                  </option>
                  {teamOptions.map(t => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Sport / Event" required error={errors.sport}>
                <select
                  className="reg-select"
                  value={form.sport}
                  onChange={set('sport')}
                  disabled={!schoolLevel || loadingOptions}
                  required
                >
                  <option value="">
                    {!schoolLevel
                      ? 'Select Grade / Year Level first'
                      : loadingOptions
                        ? 'Loading sports…'
                        : sportOptions.length === 0
                          ? 'No sports configured yet'
                          : 'Select Sport / Event'}
                  </option>
                  {sportOptions.map(s => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Position" required error={errors.position}>
                <select className="reg-select" value={form.position} onChange={set('position')} required>
                  <option value="">Select Position</option>
                  {POSITIONS.map(p => <option key={p}>{p}</option>)}
                </select>
              </Field>
            </div>

            {/* Row 6: Uploads + Message */}
            <div className="reg-uploads-row">
              <Field label="Upload Photo" error={errors.photo}>
                <label className="reg-upload-box">
                  <input type="file" accept="image/*" ref={photoRef} onChange={handleFile(setPhoto, 'photo', PHOTO_MIME_TYPES)} />
                  <div className="reg-upload-icon">👤</div>
                  <span className="reg-upload-caption">Click to upload photo</span>
                  {photo
                    ? <span className="reg-upload-preview">{photo.name}</span>
                    : <span className="reg-upload-sub">JPG, PNG, max 5 MB</span>
                  }
                </label>
              </Field>

              <Field label="Upload Waiver / Consent Form" error={errors.waiver}>
                <label className="reg-upload-box">
                  <input type="file" accept=".pdf,.doc,.docx,image/*" ref={waiverRef} onChange={handleFile(setWaiver, 'waiver', WAIVER_MIME_TYPES)} />
                  <div className="reg-upload-icon">📄</div>
                  <span className="reg-upload-caption">Click to upload waiver</span>
                  {waiver
                    ? <span className="reg-upload-preview">{waiver.name}</span>
                    : <span className="reg-upload-sub">PDF, DOC, max 5 MB (optional for now)</span>
                  }
                </label>
              </Field>

              <Field label="Message">
                <textarea className="reg-textarea"
                  placeholder="Any additional information (optional)"
                  value={form.message} onChange={set('message')}
                  rows={4} />
              </Field>
            </div>

            <div className="reg-divider" />

            <div className="reg-footer">
              <span className="reg-footer__note">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#5a6a7a"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                Fields marked with <strong style={{ color: '#C0392B' }}>*</strong> are required
              </span>
              <div className="reg-footer__actions">
                <button type="button" className="reg-btn-reset" onClick={handleReset}>
                  Reset ↺
                </button>
                <button type="submit" className="reg-btn-save">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
                  Save Registration
                </button>
              </div>
            </div>

          </form>
        </div>

        <Contact items={CONTACT_ITEMS} contactFooterRef={contactFooterRef} />

      </div>
    </div>
  );
}



function Field({ label, required, error, children }) {
  return (
    <div className={`reg-field${error ? ' reg-field--error' : ''}`}>
      <label className="reg-label">
        {label}{required && <span>*</span>}
      </label>
      {children}
      {error && <span className="reg-field__error">{error}</span>}
    </div>
  );
}