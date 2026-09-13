import {
  collection,
  getDocs,
  doc,
  setDoc,
  getDoc,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  increment,
  onSnapshot,
} from 'firebase/firestore';
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
} from 'firebase/storage';
import { db, auth } from '../firebase';

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
   Activity logs — a single, append-only audit trail written by every
   part of the app that performs a "named" action (login/logout, role
   changes, registrations, schedule/tournament and match-record CRUD).
   Stored at: activityLogs/{autoId}, newest first.

   `logActivity` always attributes the entry to whoever is CURRENTLY
   signed in (never a caller-supplied identity) — that's what lets the
   Firestore rule require `actorUid == request.auth.uid`, so a client
   can only ever log its own actions, not forge someone else's. A
   failed write here is swallowed (console.warn only) so a logging
   hiccup can never block the real action it's describing.
───────────────────────────────────────────── */
export async function logActivity({
  actorRole = 'student',
  type,
  details = '',
  targetType = null,
  targetId = null,
  targetLabel = null,
} = {}) {
  if (!db || !auth?.currentUser || !type) return;
  try {
    const user = auth.currentUser;
    await addDoc(collection(db, 'activityLogs'), {
      actorUid: user.uid,
      actorEmail: user.email || '',
      actorName: user.displayName || '',
      actorRole,
      type,
      details,
      targetType,
      targetId,
      targetLabel,
      timestamp: serverTimestamp(),
    });
  } catch (error) {
    console.warn(`Failed to log activity (${type}):`, error);
  }
}

/**
 * Most-recent 500 activity log entries, for the Super Admin "Roles &
 * Permissions" tab. Filtering/pagination happens client-side over this
 * batch — same convention SuperAdminPage already uses for `users` and
 * `registrations` — with a Refresh button to pull a fresh batch.
 */
export async function getActivityLogs() {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load activity logs.');
    return [];
  }
  const logsQuery = query(collection(db, 'activityLogs'), orderBy('timestamp', 'desc'), limit(500));
  const snapshot = await getDocs(logsQuery);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ─────────────────────────────────────────────
   Super Admin role management — grants/revokes the SAME
   admins/moderators/superadmins allowlist docs AuthContext reads at
   login (doc id = lowercase email). Exactly one of the three is ever
   kept for a given email: assigning a new role deletes the other two
   first, matching AuthContext's own superadmin > admin > moderator
   priority so it never has two disagreeing docs to resolve.

   `targetUser` is a { id (uid), email, name } shape — the same shape
   as a row from the `users` collection already loaded elsewhere.
   Both functions refuse to act on the CURRENTLY SIGNED IN account, so
   a Super Admin can never lock themselves out from this panel (the
   Firestore rules also refuse to let a superadmin delete their own
   `superadmins` doc, as a second layer of the same guard).
───────────────────────────────────────────── */
const STAFF_ROLE_COLLECTIONS = { admin: 'admins', moderator: 'moderators', superadmin: 'superadmins' };
const STAFF_ROLE_LABELS = { admin: 'Admin', moderator: 'Moderator', superadmin: 'Super Admin' };

export async function assignStaffRole(targetUser, role, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');
  const collectionName = STAFF_ROLE_COLLECTIONS[role];
  if (!collectionName) throw new Error(`Unknown staff role: ${role}`);
  if (targetUser.id && auth?.currentUser?.uid === targetUser.id) {
    throw new Error("You can't change your own role here.");
  }

  const email = (targetUser.email || '').trim().toLowerCase();
  if (!email) throw new Error('This user has no email on file.');

  await Promise.all(
    Object.values(STAFF_ROLE_COLLECTIONS)
      .filter((c) => c !== collectionName)
      .map((c) => deleteDoc(doc(db, c, email)))
  );
  await setDoc(doc(db, collectionName, email), { email, addedAt: serverTimestamp() });

  if (targetUser.id) {
    await setDoc(
      doc(db, 'users', targetUser.id),
      { role, isAdmin: role === 'admin' || role === 'superadmin' },
      { merge: true }
    ).catch((error) => console.warn('Could not sync role onto user profile:', error));
  }

  await logActivity({
    actorRole,
    type: 'Role Assigned',
    details: `Assigned ${STAFF_ROLE_LABELS[role]} role to ${targetUser.name || email}`,
    targetType: 'user',
    targetId: targetUser.id || email,
    targetLabel: email,
  });
}

export async function removeStaffRole(targetUser, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');
  if (targetUser.id && auth?.currentUser?.uid === targetUser.id) {
    throw new Error("You can't change your own role here.");
  }

  const email = (targetUser.email || '').trim().toLowerCase();
  if (!email) throw new Error('This user has no email on file.');

  await Promise.all(
    Object.values(STAFF_ROLE_COLLECTIONS).map((c) => deleteDoc(doc(db, c, email)))
  );

  if (targetUser.id) {
    await setDoc(
      doc(db, 'users', targetUser.id),
      { role: 'student', isAdmin: false },
      { merge: true }
    ).catch((error) => console.warn('Could not sync role onto user profile:', error));
  }

  await logActivity({
    actorRole,
    type: 'Role Removed',
    details: `Removed staff role from ${targetUser.name || email}`,
    targetType: 'user',
    targetId: targetUser.id || email,
    targetLabel: email,
  });
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
export async function createRegistration(uid, email, formData, photoFile, waiverFile, actorRole = 'student') {
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

  logActivity({
    actorRole,
    type: 'Registration Submitted',
    details: `${registrationData.fullName || email} registered for ${registrationData.event || 'an event'}${registrationData.sport ? ` (${registrationData.sport})` : ''}`,
    targetType: 'registration',
    targetId: docRef.id,
    targetLabel: registrationData.fullName || email,
  });

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

export async function saveSportsConfig(level, sports, actorRole) {
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

  logActivity({
    actorRole,
    type: 'Sports Updated',
    details: `Saved the sports list for ${level} (${sports.length} sport${sports.length === 1 ? '' : 's'})`,
    targetType: 'sportsConfig',
    targetId: level,
  });
}

export async function saveTeamsConfig(level, teams, actorRole) {
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

  logActivity({
    actorRole,
    type: 'Teams Updated',
    details: `Saved the teams roster for ${level} (${teams.length} team${teams.length === 1 ? '' : 's'})`,
    targetType: 'teamsConfig',
    targetId: level,
  });
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
 * Live-subscribes to one level's match schedules. Used anywhere a
 * schedule change made elsewhere (the admin deleting/editing a match,
 * or fulfilling a moderator's schedule request) needs to show up
 * immediately instead of waiting for the next manual reload or poll —
 * the Moderator page and the public/home dashboards both read schedules
 * this way. Returns an unsubscribe function.
 */
export function subscribeMatchSchedules(level, callback) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot subscribe to match schedules.');
    callback([]);
    return () => {};
  }
  const configRef = doc(db, 'matchSchedules', level);
  return onSnapshot(configRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().matches || []) : []);
  }, (error) => {
    console.warn('Match schedules listener failed:', error);
    callback([]);
  });
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
export async function saveGeneratedSchedule(level, matches, actorRole) {
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

  logActivity({
    actorRole,
    type: 'Schedule Created',
    details: `Generated ${matches.length} match${matches.length === 1 ? '' : 'es'} for ${sport || 'a sport'}${category ? ` (${category})` : ''}`,
    targetType: 'schedule',
    targetId: `${level}::${sport}::${category}`,
    targetLabel: sport,
  });

  return merged;
}

/**
 * Removes any Moderator-confirmed records tied (via `scheduleId`) to the
 * given schedule match ids, so deleting a fixture doesn't leave a stale
 * record behind in the "Updated Match Summary" table / Dashboard rankings.
 * Records saved without a fixture (`scheduleId: null`) are never touched.
 */
async function deleteMatchRecordsByScheduleIds(level, scheduleIds) {
  if (!scheduleIds.length) return;
  const ids = new Set(scheduleIds.map(String));
  const existing = await getMatchRecords(level);
  const remaining = existing.filter(r => !r.scheduleId || !ids.has(String(r.scheduleId)));
  if (remaining.length === existing.length) return;

  const configRef = doc(db, 'matchRecords', level);
  await setDoc(
    configRef,
    { records: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Deletes every match belonging to one generated schedule set — same
 * sport + category, at this level, regardless of format — so the admin
 * can generate a new one (with any format) in its place. Used by the
 * "Reset Schedule" confirmation in Match Schedules Format once a set
 * is locked.
 */
export async function deleteScheduleSet(level, sport, category, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchSchedules(level);
  const removed = existing.filter(m => m.sport === sport && m.category === category);
  const remaining = existing.filter(
    m => !(m.sport === sport && m.category === category)
  );

  const configRef = doc(db, 'matchSchedules', level);
  await setDoc(
    configRef,
    { matches: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );

  await deleteMatchRecordsByScheduleIds(level, removed.map(m => m.id));

  logActivity({
    actorRole,
    type: 'Schedule Deleted',
    details: `Reset the ${sport || 'schedule'}${category ? ` (${category})` : ''} schedule set (${removed.length} match${removed.length === 1 ? '' : 'es'})`,
    targetType: 'schedule',
    targetId: `${level}::${sport}::${category}`,
    targetLabel: sport,
  });

  return remaining;
}

/**
 * Adds (or updates) a single manually-entered match — the
 * "Add Schedule" / "Edit" flow, as opposed to the bulk generator.
 */
export async function upsertMatchSchedule(level, match, actorRole) {
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

  logActivity({
    actorRole,
    type: idx >= 0 ? 'Schedule Updated' : 'Schedule Created',
    details: `${idx >= 0 ? 'Updated' : 'Added'} a ${match.sport || 'match'} fixture${match.category ? ` (${match.category})` : ''}`,
    targetType: 'schedule',
    targetId: match.id,
    targetLabel: match.sport,
  });

  return merged;
}

/**
 * Removes a single match from a level's schedule by id.
 */
export async function deleteMatchSchedule(level, matchId, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchSchedules(level);
  const removed = existing.find(m => m.id === matchId);
  const remaining = existing.filter(m => m.id !== matchId);

  const configRef = doc(db, 'matchSchedules', level);
  await setDoc(
    configRef,
    { matches: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );

  await deleteMatchRecordsByScheduleIds(level, [matchId]);

  logActivity({
    actorRole,
    type: 'Schedule Deleted',
    details: `Deleted a ${removed?.sport || 'match'} fixture${removed?.category ? ` (${removed.category})` : ''}`,
    targetType: 'schedule',
    targetId: matchId,
    targetLabel: removed?.sport,
  });

  return remaining;
}

/* ─────────────────────────────────────────────
   Schedule requests — a moderator asking the admin to set up a fixture
   (sport / division / level) instead of adding it to the schedule
   themselves. Stored in ONE global doc (not per level, unlike
   matchSchedules) so the admin's pending-request badge is a single
   read/listener covering every level at once.
   Stored at: scheduleRequests/all → { requests: [...] }

   A request looks like:
   {
     id, level, sport, category, reason,
     requestedByEmail, requestedByName,
     status: 'pending' | 'scheduled' | 'declined',
     declineReason,
     createdAt, resolvedAt,
   }
───────────────────────────────────────────── */
export async function getScheduleRequests() {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load schedule requests.');
    return [];
  }
  const configRef = doc(db, 'scheduleRequests', 'all');
  const snapshot = await getDoc(configRef);
  if (!snapshot.exists()) return [];
  return snapshot.data().requests || [];
}

/**
 * Live-subscribes to every schedule request. Used for the admin's
 * pending-request notification badge (sidebar + Schedule Requests tab),
 * which has to update the moment a moderator submits or an admin
 * resolves one — not just whenever the page happens to reload.
 * Returns an unsubscribe function.
 */
export function subscribeScheduleRequests(callback) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot subscribe to schedule requests.');
    callback([]);
    return () => {};
  }
  const configRef = doc(db, 'scheduleRequests', 'all');
  return onSnapshot(configRef, (snapshot) => {
    callback(snapshot.exists() ? (snapshot.data().requests || []) : []);
  }, (error) => {
    console.warn('Schedule requests listener failed:', error);
    callback([]);
  });
}

/**
 * Files a new schedule request — the Moderator's "Request a schedule"
 * form. `doc(collection(...)).id` mints a fresh random id without
 * writing anything, the same trick Firestore's own addDoc uses under
 * the hood, so requests get real ids without ever loading a whole
 * second collection just to auto-increment something.
 */
export async function createScheduleRequest(request, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getScheduleRequests();
  const newRequest = {
    id: doc(collection(db, 'scheduleRequests')).id,
    status: 'pending',
    createdAt: Date.now(),
    ...request,
  };

  const configRef = doc(db, 'scheduleRequests', 'all');
  await setDoc(
    configRef,
    { requests: [...existing, newRequest], updatedAt: serverTimestamp() },
    { merge: true }
  );

  logActivity({
    actorRole,
    type: 'Schedule Requested',
    details: `${newRequest.requestedByName || 'A moderator'} requested a schedule for ${newRequest.sport || 'a sport'}${newRequest.category ? ` (${newRequest.category})` : ''}`,
    targetType: 'scheduleRequest',
    targetId: newRequest.id,
    targetLabel: newRequest.sport,
  });

  return newRequest;
}

/**
 * Admin resolves a request — mark it fulfilled once the actual fixture
 * has been added via the normal Add Schedule flow, or decline it with
 * a reason. `patch` merges onto the existing request (e.g. `{ status:
 * 'declined', declineReason }` or `{ status: 'scheduled' }`).
 */
export async function updateScheduleRequest(requestId, patch, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getScheduleRequests();
  const target = existing.find((r) => r.id === requestId);
  const merged = existing.map((r) => (
    r.id === requestId ? { ...r, ...patch, resolvedAt: Date.now() } : r
  ));

  const configRef = doc(db, 'scheduleRequests', 'all');
  await setDoc(
    configRef,
    { requests: merged, updatedAt: serverTimestamp() },
    { merge: true }
  );

  if (patch.status === 'scheduled' || patch.status === 'declined') {
    logActivity({
      actorRole,
      type: patch.status === 'scheduled' ? 'Schedule Request Approved' : 'Schedule Request Declined',
      details: `${patch.status === 'scheduled' ? 'Approved' : 'Declined'} ${target?.requestedByName || 'a moderator'}'s request for ${target?.sport || 'a sport'}${target?.category ? ` (${target.category})` : ''}`,
      targetType: 'scheduleRequest',
      targetId: requestId,
      targetLabel: target?.sport,
    });
  }

  return merged;
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

export async function saveVenues(venues, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');
  const configRef = doc(db, 'venuesConfig', 'global');
  await setDoc(
    configRef,
    { venues, updatedAt: serverTimestamp() },
    { merge: true }
  );

  logActivity({
    actorRole,
    type: 'Venues Updated',
    details: `Saved the venues list (${venues.length} venue${venues.length === 1 ? '' : 's'})`,
    targetType: 'venuesConfig',
    targetId: 'global',
  });

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
 * Adds (or updates) a single confirmed match record.
 */
export async function upsertMatchRecord(level, record, actorRole) {
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

  logActivity({
    actorRole,
    type: 'Match Record Saved',
    details: `Saved the ${record.sportName || 'match'} result for ${record.teamA?.name || '?'} vs ${record.teamB?.name || '?'}`,
    targetType: 'matchRecord',
    targetId: record.id,
    targetLabel: record.sportName,
  });

  return merged;
}

/**
 * Removes a single confirmed match record by id — e.g. to clear out a
 * test entry from the Moderator's "Updated match summary" table.
 */
export async function deleteMatchRecord(level, recordId, actorRole) {
  if (!db) throw new Error('Firestore not initialized.');

  const existing = await getMatchRecords(level);
  const removed = existing.find(r => r.id === recordId);
  const remaining = existing.filter(r => r.id !== recordId);

  const configRef = doc(db, 'matchRecords', level);
  await setDoc(
    configRef,
    { records: remaining, updatedAt: serverTimestamp() },
    { merge: true }
  );

  logActivity({
    actorRole,
    type: 'Match Record Deleted',
    details: `Deleted the ${removed?.sportName || 'match'} result for ${removed?.teamA?.name || '?'} vs ${removed?.teamB?.name || '?'}`,
    targetType: 'matchRecord',
    targetId: recordId,
    targetLabel: removed?.sportName,
  });

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