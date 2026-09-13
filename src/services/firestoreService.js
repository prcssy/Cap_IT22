import {
  collection,
  getDocs,
  doc,
  setDoc,
  getDoc,
  addDoc,
  query,
  orderBy,
  serverTimestamp,
  increment,
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
} from 'firebase/storage';
import { db } from '../firebase';
import { resolveScheduleRecords } from '../utils/matchRecords';

/* ─────────────────────────────────────────────
   Registration events

   Intramurals, Sportsfest and PRISAA all use the exact same player
   registration form — the only difference is which event the student
   is signing up for. That choice is stored on the registration itself
   (`event` for display, `eventKey` for grouping/counting), so any
   screen can break the numbers down per event.

   Single source of truth: RegistrationPage builds its dropdown from
   this list, and AdminSchedulePage builds its filter from it too. Add
   a future event here once and both screens pick it up.
───────────────────────────────────────────── */
export const EVENT_TYPES = [
  { key: 'intramurals', label: 'Intramurals' },
  { key: 'sportsfest',  label: 'Sportsfest'  },
  { key: 'prisaa',      label: 'Prisaa'      },
];

/* Accepts either the stored key ('prisaa') or the display label
   ('Prisaa'), so old records and new ones both resolve. */
export function getEventKey(value) {
  if (!value) return '';
  const needle = String(value).trim().toLowerCase();
  const match  = EVENT_TYPES.find(
    (e) => e.key === needle || e.label.toLowerCase() === needle,
  );
  return match ? match.key : '';
}

export function getEventLabel(value) {
  const match = EVENT_TYPES.find((e) => e.key === getEventKey(value));
  return match ? match.label : '';
}

/* ─────────────────────────────────────────────
   Generic collection fetcher
───────────────────────────────────────────── */
export async function fetchCollectionData(collectionName, orderByField) {
  if (!db) {
    console.warn(`Firestore not initialized. Cannot fetch ${collectionName}.`);
    return [];
  }
  const collectionRef   = collection(db, collectionName);
  const collectionQuery = orderByField
    ? query(collectionRef, orderBy(orderByField, 'asc'))
    : collectionRef;
  const snapshot = await getDocs(collectionQuery);
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

/* ─────────────────────────────────────────────
   User profile helpers
───────────────────────────────────────────── */
export async function createUserProfile(uid, profile) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot create user profile.');
    return;
  }
  const profileDoc = doc(db, 'users', uid);
  await setDoc(profileDoc, {
    ...profile,
    createdAt: serverTimestamp(),
  });
}

export async function getUserProfile(uid) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot fetch user profile.');
    return null;
  }
  const profileDoc = doc(db, 'users', uid);
  const snapshot   = await getDoc(profileDoc);
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

/* ─────────────────────────────────────────────
   Staff allowlist lookup.

   Used by the sign-up form's "Admin / Moderator / Super Admin"
   path: staff don't fill out the full student form, they just
   enter the gmail they were pre-registered with + a password.
   We look that email up in the SAME collections AuthContext uses
   to resolve roles (`admins` / `moderators` / `superadmins`, doc id
   = lowercase email) — this is the one place staff emails are
   managed (Firebase Console → Firestore → admins/moderators/superadmins),
   so sign-up and login always agree on who's authorized.

   Expected doc shape (doc id = lowercase email):
     { email: 'someone@gmail.com' }  — additional fields like name are optional.

   @param {string} email
   @param {string} role  one of 'admin' | 'moderator' | 'superadmin'
   @returns {object|null} the matching doc if the email is cleared for that role, else null
───────────────────────────────────────────── */
const ROLE_TO_COLLECTION = {
  admin: 'admins',
  moderator: 'moderators',
  superadmin: 'superadmins',
};

export async function findStaffAllowlistEntry(email, role) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot verify staff email.');
    return null;
  }
  const collectionName = ROLE_TO_COLLECTION[role];
  if (!collectionName) return null;

  const normalizedEmail = email.trim().toLowerCase();
  const snapshot = await getDoc(doc(db, collectionName, normalizedEmail));
  if (!snapshot.exists()) return null;
  return { id: snapshot.id, ...snapshot.data() };
}

/* ─────────────────────────────────────────────
   Upload a single file to Firebase Storage.
   Returns the public download URL.
   Returns null silently if no file provided
   (uploads are optional for the student).

   Cloud Storage isn't provisioned on the Firebase project yet (it
   requires the Blaze billing plan), so an upload attempt right now
   would throw and take the whole registration down with it. Catch
   that and store null instead — once Storage is turned on, uploads
   will start succeeding here with no code changes needed.
───────────────────────────────────────────── */
async function uploadFile(file, storagePath) {
  if (!file) return null;
  try {
    const storage = getStorage();
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, file);
    return await getDownloadURL(fileRef);
  } catch (error) {
    console.warn(`File upload skipped (Firebase Storage not set up yet): ${storagePath}`, error);
    return null;
  }
}

/* ─────────────────────────────────────────────
   Create a player registration document.

   @param {string}    uid        Firebase Auth UID
   @param {string}    email      Firebase Auth email
   @param {object}    formData   All form fields
   @param {File|null} photoFile  Optional photo upload
   @param {File|null} waiverFile Optional waiver upload

   Files are uploaded to Firebase Storage under
   registrations/{uid}/{timestamp}_photo|waiver.
   URLs (or null) are saved in the Firestore doc.
───────────────────────────────────────────── */
export async function createRegistration(uid, email, formData, photoFile, waiverFile) {
  if (!db) throw new Error('Firestore not initialized.');

  // Upload both files in parallel — either can be null (optional)
  const timestamp = Date.now();
  const [photoURL, waiverURL] = await Promise.all([
    uploadFile(photoFile,  `registrations/${uid}/${timestamp}_photo`),
    uploadFile(waiverFile, `registrations/${uid}/${timestamp}_waiver`),
  ]);

  const registrationData = {
    // Auth info
    uid,
    email,

    // Personal info
    fullName:         formData.fullName         || '',
    dob:              formData.dob              || '',
    age:              formData.age              || '',
    gender:           formData.gender           || '',
    contactNumber:    formData.contactNumber    || '',
    studentEmail:     formData.email            || '',
    address:          formData.address          || '',
    emergencyContact: formData.emergencyContact || '',

    // Academic info
    gradeLevel: formData.gradeLevel || '',
    section:    formData.section    || '',

    // Event the student is registering for
    // (Intramurals / Sportsfest / Prisaa — all share this same form)
    event:    getEventLabel(formData.event),
    eventKey: getEventKey(formData.event),

    // Sport info
    teamName: formData.teamName || '',
    sport:    formData.sport    || '',
    position: formData.position || '',

    // Extra
    message: formData.message || '',

    // File URLs — null if student skipped the upload
    photoURL,
    waiverURL,

    // Metadata
    status:    'pending',
    createdAt: serverTimestamp(),
  };

  const docRef = await addDoc(collection(db, 'registrations'), registrationData);

  // Bump the public per-event counter so the registration form can show
  // live "how many have registered for this event" numbers without
  // students ever reading the registrations collection itself (it holds
  // addresses and emergency contacts — staff only).
  //
  // Fire-and-forget on purpose: the registration is already saved, so a
  // denied or failed counter write must never surface as a failed
  // registration. AdminSchedulePage recomputes the exact numbers from
  // the real documents every time it loads and overwrites this counter,
  // so any drift self-corrects.
  if (registrationData.eventKey) {
    bumpEventRegistrationCount(registrationData.eventKey).catch((err) => {
      console.warn('Could not update the public event counter:', err);
    });
  }

  return docRef;
}

/* ─────────────────────────────────────────────
   Sports & Teams management (per school level)
   Stored at: sportsTeamsConfig/{level}
   level: 'elementary' | 'highSchool' | 'college'
───────────────────────────────────────────── */
export async function getSportsTeamsConfig(level) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load sports/teams config.');
    return { sports: [], teams: [] };
  }

  const configRef = doc(db, 'sportsTeamsConfig', level);
  const snapshot = await getDoc(configRef);

  if (!snapshot.exists()) {
    return { sports: [], teams: [] };
  }

  const data = snapshot.data();

  return {
    sports: data.sports || [],
    teams: data.teams || [],
  };
}

export async function saveSportsConfig(level, sports) {
  if (!db) throw new Error('Firestore not initialized.');

  const configRef = doc(db, 'sportsTeamsConfig', level);

  await setDoc(
    configRef,
    {
      sports,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function saveTeamsConfig(level, teams) {
  if (!db) throw new Error('Firestore not initialized.');

  const configRef = doc(db, 'sportsTeamsConfig', level);

  await setDoc(
    configRef,
    {
      teams,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

/* ─────────────────────────────────────────────
   Match schedules (per school level)
   Stored at: matchSchedules/{level} → { matches: [...] }

   A "match" produced by MatchSchedulesFormatPanel's generator looks like:
   {
     id, sport, category, format, round,
     teamA, teamB,           // team names
     teamALogo, teamBLogo,   // base64 or URL, copied from Sports & Teams
     date, time, location,   // filled in later via Edit / Add Schedule
     status: 'scheduled',
   }
───────────────────────────────────────────── */
export async function getMatchSchedules(level) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load match schedules.');
    return [];
  }
  const configRef = doc(db, 'matchSchedules', level);
  const snapshot  = await getDoc(configRef);
  if (!snapshot.exists()) return [];
  return snapshot.data().matches || [];
}

/**
 * Persists a freshly generated round-robin / bracket schedule.
 * Called when the admin clicks "Save Generated Schedule".
 * Merges with (rather than replaces) any existing matches for other
 * sport/category combinations at this level. The UI blocks generation
 * once a (sport, category) set already has saved matches — regardless
 * of which format they were generated with — see
 * MatchScheduleFormatSection's `isLocked` — so this only ever collides
 * with itself when called twice for the exact same set.
 */
export async function saveGeneratedSchedule(level, matches) {
  if (!db) throw new Error('Firestore not initialized.');

  const configRef = doc(db, 'matchSchedules', level);
  const existing  = await getMatchSchedules(level);
  const sport      = matches[0]?.sport;
  const category   = matches[0]?.category;

  const merged = [
    ...existing.filter(m => !(m.sport === sport && m.category === category)),
    ...matches,
  ];

  await setDoc(
    configRef,
    { matches: merged, updatedAt: serverTimestamp() },
    { merge: true }
  );

  return merged;
}

/**
 * Deletes every match belonging to one generated schedule set — same
 * sport + category, at this level, regardless of format — so the admin
 * can generate a new one (with any format) in its place. Used by the
 * "Reset Schedule" confirmation in Match Schedules Format once a set
 * is locked.
 */
export async function deleteScheduleSet(level, sport, category) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchSchedules(level);
  const remaining = existing.filter(
    m => !(m.sport === sport && m.category === category)
  );

  const configRef = doc(db, 'matchSchedules', level);
  await setDoc(
    configRef,
    { matches: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );

  return remaining;
}

/**
 * Adds (or updates) a single manually-entered match — the
 * "Add Schedule" / "Edit" flow, as opposed to the bulk generator.
 */
export async function upsertMatchSchedule(level, match) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchSchedules(level);
  const idx = existing.findIndex(m => m.id === match.id);
  const merged = idx >= 0
    ? existing.map(m => (m.id === match.id ? match : m))
    : [...existing, match];

  const configRef = doc(db, 'matchSchedules', level);
  await setDoc(
    configRef,
    { matches: merged, updatedAt: serverTimestamp() },
    { merge: true }
  );

  return merged;
}

/**
 * Removes a single match from a level's schedule by id.
 */
export async function deleteMatchSchedule(level, matchId) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchSchedules(level);
  const remaining = existing.filter(m => m.id !== matchId);

  const configRef = doc(db, 'matchSchedules', level);
  await setDoc(
    configRef,
    { matches: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );

  return remaining;
}

/* ─────────────────────────────────────────────
   Venues — GLOBAL, shared across every school level.
   Stored at: venuesConfig/global → { venues: [{ id, name }] }

   Unlike Sports & Teams / match schedules, venues aren't split per level:
   a physical space (e.g. "Main Gym") is the same place regardless of
   which level is playing there, so there's only ever one list.

   Matches reference a venue by its plain name string on `location`
   (same convention as team/sport names elsewhere) rather than by id —
   renaming or deleting a venue here only changes what's offered next
   time someone picks one; it never rewrites existing matches.
───────────────────────────────────────────── */
export async function getVenues() {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load venues.');
    return [];
  }
  const configRef = doc(db, 'venuesConfig', 'global');
  const snapshot = await getDoc(configRef);
  if (!snapshot.exists()) return [];
  return snapshot.data().venues || [];
}

export async function saveVenues(venues) {
  if (!db) throw new Error('Firestore not initialized.');
  const configRef = doc(db, 'venuesConfig', 'global');
  await setDoc(
    configRef,
    { venues, updatedAt: serverTimestamp() },
    { merge: true }
  );
  return venues;
}

/* All matches across every school level, each tagged with its level —
   used to check whether a venue is already booked at a given date/time
   (a physical venue can just as easily be double-booked across levels
   as within one) and to list what's booked at a venue. */
const SCHOOL_LEVELS = ['elementary', 'highSchool', 'college'];

export async function getAllMatchSchedules() {
  const perLevel = await Promise.all(
    SCHOOL_LEVELS.map(async (level) => {
      const matches = await getMatchSchedules(level);
      return matches.map((m) => ({ ...m, level }));
    })
  );
  return perLevel.flat();
}

/* ─────────────────────────────────────────────
   Match records (moderator "Update Match Records" screen)
   Stored at: matchRecords/{level} → { records: [...] }

   Shared between Moderator and Admin: both read/write the
   same document per school level, so anything a moderator
   confirms shows up for admins (and vice-versa) automatically.

   A "record" looks like:
   {
     id, sport, category, gameFormat,
     teamA: { name, logo }, teamB: { name, logo },
     timeA, timeB,                 // "HH:MM:SS"
     violationsA: [{type, count}], violationsB: [...],
     totalViolationsA, totalViolationsB,
     comebackA, comebackB,         // boolean|null
     winner: 'A' | 'B',
     prevPointsA, prevPointsB,
     gainedA, gainedB,             // computed score change
     finalPointsA, finalPointsB,
     createdAt, updatedAt,
   }
───────────────────────────────────────────── */
export async function getMatchRecords(level) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load match records.');
    return [];
  }
  const configRef = doc(db, 'matchRecords', level);
  const snapshot = await getDoc(configRef);
  if (!snapshot.exists()) return [];
  return snapshot.data().records || [];
}

/**
 * matchRecords/{level} is signed-in-only (it's staff working data), but the
 * public landing page still needs to tell an ongoing match apart from a
 * finished one. Rather than loosening that read rule, this mirrors just a
 * `recorded: true/false` flag per fixture onto matchSchedules/{level} —
 * already public — using the same schedule↔record matching Dashboard uses.
 * Called after every record write below, so the flag never lags behind.
 * Only writes back when something actually changed, so calling it
 * speculatively (e.g. from a staff page's own load effect, to self-heal
 * any pre-existing mismatch) doesn't spam the doc on every read.
 */
export async function syncRecordedFlags(level, records, schedules) {
  if (!db) return schedules || [];
  const list = schedules || await getMatchSchedules(level);
  if (!list.length) return list;
  const recs = records || await getMatchRecords(level);
  const { recordedIds } = resolveScheduleRecords(list, recs);
  const changed = list.some(m => !!m.recorded !== recordedIds.has(m.id));
  if (!changed) return list;

  const updated = list.map(m => ({ ...m, recorded: recordedIds.has(m.id) }));
  const configRef = doc(db, 'matchSchedules', level);
  await setDoc(
    configRef,
    { matches: updated, updatedAt: serverTimestamp() },
    { merge: true }
  );
  return updated;
}

/**
 * Adds (or updates) a single confirmed match record.
 */
export async function upsertMatchRecord(level, record) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchRecords(level);
  const idx = existing.findIndex(r => r.id === record.id);
  const merged = idx >= 0
    ? existing.map(r => (r.id === record.id ? record : r))
    : [...existing, record];

  const configRef = doc(db, 'matchRecords', level);
  await setDoc(
    configRef,
    { records: merged, updatedAt: serverTimestamp() },
    { merge: true }
  );

  await syncRecordedFlags(level, merged);

  return merged;
}

/**
 * Removes a single confirmed match record by id — e.g. to clear out a
 * test entry from the Moderator's "Updated match summary" table.
 */
export async function deleteMatchRecord(level, recordId) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchRecords(level);
  const remaining = existing.filter(r => r.id !== recordId);

  const configRef = doc(db, 'matchRecords', level);
  await setDoc(
    configRef,
    { records: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );

  await syncRecordedFlags(level, remaining);

  return remaining;
}

/* ─────────────────────────────────────────────
   Team point rankings (per school level)
   Stored at: teamRankings/{level} → { points: { [teamName]: number } }

   Read by Moderator (as "previous points" before a match)
   and written back after every confirmed match record, so
   Admin's Ranking page can eventually read the same source.
───────────────────────────────────────────── */
export async function getTeamRankings(level) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load team rankings.');
    return {};
  }
  const configRef = doc(db, 'teamRankings', level);
  const snapshot = await getDoc(configRef);
  if (!snapshot.exists()) return {};
  return snapshot.data().points || {};
}

export async function saveTeamRankings(level, points) {
  if (!db) throw new Error('Firestore not initialized.');

  const configRef = doc(db, 'teamRankings', level);
  await setDoc(
    configRef,
    { points, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/* ─────────────────────────────────────────────
   Live player-count counter for the public landing page.
   Stored at: siteCounters/liveCounters → { players: number, updatedAt }

   Deliberately its OWN collection, not a document inside `stats` — the
   landing page fetches the entire `stats` collection wholesale to build
   its icon/value/label cards, so a counter doc living there (with no
   label/icon/value) got swept into that same fetch and crashed the page
   trying to render it as a stat card. Keeping this in a separate
   collection means it can never collide with that fetch again.

   This exists only because the real player count lives in
   `registrations`, which is staff-only for privacy reasons (addresses,
   phone numbers, emergency contacts). Firestore can't expose "just a
   count" from a collection without also exposing its documents to the
   same query, so instead: AdminSchedulePage (already
   staff-authenticated, already reading `registrations` to build the
   roster table) recomputes the total and writes ONLY that number here
   via setLivePlayerCount whenever it loads. The landing page then reads
   this single public counter via getLiveStatsCounters — never the
   registrations collection itself.
───────────────────────────────────────────── */
export async function getLiveStatsCounters() {
  if (!db) return {};
  const ref = doc(db, 'siteCounters', 'liveCounters');
  const snapshot = await getDoc(ref);
  return snapshot.exists() ? snapshot.data() : {};
}

export async function setLivePlayerCount(count) {
  if (!db) throw new Error('Firestore not initialized.');
  const ref = doc(db, 'siteCounters', 'liveCounters');
  await setDoc(ref, { players: count, updatedAt: serverTimestamp() }, { merge: true });
}

/* ─────────────────────────────────────────────
   Per-event registration counters
   Stored alongside the player count, at:
   siteCounters/liveCounters → { eventCounts: { intramurals, sportsfest, prisaa } }

   Same reasoning as the player counter above: `registrations` is
   staff-only, so students can't count it themselves. Instead the count
   is nudged up by one when a registration is submitted
   (bumpEventRegistrationCount) and re-derived from scratch whenever an
   admin opens the Registration tab (setEventRegistrationCounts), which
   keeps the public number honest even if a bump was ever missed.
───────────────────────────────────────────── */
export async function getEventRegistrationCounts() {
  const data = await getLiveStatsCounters();
  const raw = data.eventCounts || {};
  const counts = {};
  EVENT_TYPES.forEach(({ key }) => { counts[key] = Number(raw[key]) || 0; });
  return counts;
}

export async function bumpEventRegistrationCount(eventKey, by = 1) {
  if (!db) throw new Error('Firestore not initialized.');
  const key = getEventKey(eventKey);
  if (!key) return;
  const ref = doc(db, 'siteCounters', 'liveCounters');
  await setDoc(
    ref,
    { eventCounts: { [key]: increment(by) }, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

/* Overwrite the counters with freshly computed totals (admin reconcile). */
export async function setEventRegistrationCounts(counts) {
  if (!db) throw new Error('Firestore not initialized.');
  const clean = {};
  EVENT_TYPES.forEach(({ key }) => { clean[key] = Number(counts?.[key]) || 0; });
  const ref = doc(db, 'siteCounters', 'liveCounters');
  await setDoc(ref, { eventCounts: clean, updatedAt: serverTimestamp() }, { merge: true });
}