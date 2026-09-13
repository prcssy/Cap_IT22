# Match Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user save a match to get a Google Calendar reminder before it starts, and make `MatchSchedulesPage.jsx` update live when an admin changes the schedule — both without adding any backend or incurring any Firebase cost.

**Architecture:** Two independent, purely client-side additions on top of the existing React + Vite + Firebase SPA. Feature 1 (Save Match) calls the Google Calendar REST API directly from the browser using a token obtained via Google Identity Services (a second, separate OAuth consent from this app's own Firebase Auth), and records save state in a new Firestore collection. Feature 2 (live schedule) swaps `MatchSchedulesPage.jsx`'s one-time `getDoc` calls for Firestore `onSnapshot` listeners. No Cloud Functions, no FCM, no service worker.

**Tech Stack:** React 19 + Vite, Firebase JS SDK v11 (Auth + Firestore), Google Identity Services (`accounts.google.com/gsi/client`, loaded on demand — no npm package), Google Calendar API v3 (plain `fetch`, no client library).

**Spec:** `docs/superpowers/specs/2026-09-13-match-notifications-spec.md` (source of truth for *why* — this plan argues from it; read both).

## Global Constraints

- Zero added cost, no billing account on the Firebase project (currently Spark plan) — never introduce Cloud Functions, Cloud Scheduler, or FCM sending.
- All Firestore/Storage reads and writes go through `src/services/firestoreService.js` (CLAUDE.md convention) — pages never call the Firestore SDK directly. The Calendar API is not Firestore, so it gets its own new service file, `src/services/googleCalendar.js`.
- No automated test suite exists in this repo (per `CLAUDE.md`) — every task's verification step is `npm run lint` (+ `npm run build` where noted) plus a manual check in the running app via `npm run dev`.
- New env var: `VITE_GOOGLE_CALENDAR_CLIENT_ID` (Google Cloud OAuth 2.0 Web client ID, same GCP project as Firebase — `srccapstone`).
- "Match finished" notifications are explicitly out of scope (see spec's Rejected approaches).
- `matchSchedules/{level}`'s existing Firestore rule (`allow read: if signedIn()`) already covers `onSnapshot` listeners — no rule change needed for Feature 2.

---

## Task 1: Firestore security rules for `savedMatches`

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Produces: a `savedMatches/{docId}` collection where `docId` is `${uid}_${matchId}`, readable/writable by its owner, and readable/deletable by staff (needed by Task 2's schedule-delete cleanup, which queries across all users' docs by `matchId`).

- [ ] **Step 1: Add the `savedMatches` rule block**

In `firestore.rules`, add this new `match` block right after the `teamRankings` block (before the two closing `}` at the end of the file):

```
    // ── Saved matches (Save Match → Calendar reminder) ──────────
    // Doc id is `${uid}_${matchId}`. Owners manage their own saves.
    // Staff can also read/delete any doc — needed so deleting a match
    // from the schedule (AdminSchedulePage) can clean up every user's
    // stale savedMatches doc for that match, not just the admin's own.
    match /savedMatches/{docId} {
      allow read:          if signedIn() && (resource.data.uid == request.auth.uid || isStaff());
      allow create, update: if signedIn() && request.resource.data.uid == request.auth.uid;
      allow delete:         if signedIn() && (resource.data.uid == request.auth.uid || isStaff());
    }
```

The full file should now read (only the new block is added — everything else is unchanged):

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    function staffEmail() {
      return request.auth.token.email.lower();
    }

    function isStaff() {
      return signedIn() && (
        exists(/databases/$(database)/documents/admins/$(staffEmail())) ||
        exists(/databases/$(database)/documents/moderators/$(staffEmail())) ||
        exists(/databases/$(database)/documents/superadmins/$(staffEmail()))
      );
    }

    // ── User profiles ──────────────────────────────────────────
    match /users/{uid} {
      allow read, write: if signedIn() && request.auth.uid == uid;
      allow read: if isStaff();
    }

    // ── Staff allowlists (doc id = lowercase email) ────────────
    match /admins/{email}      { allow read: if signedIn(); }
    match /moderators/{email}  { allow read: if signedIn(); }
    match /superadmins/{email} { allow read: if signedIn(); }

    // ── Player registrations ───────────────────────────────────
    match /registrations/{regId} {
      allow create: if signedIn() && request.resource.data.uid == request.auth.uid;
      allow read, update, delete: if isStaff();
    }

    // ── Public aggregate counters ───────────────────────────────
    match /siteCounters/{docId} {
      allow read: if true;
      allow write: if signedIn();
    }

    // ── Config docs managed by staff, read by any signed-in user ─
    match /sportsTeamsConfig/{level} { allow read: if signedIn(); allow write: if isStaff(); }
    match /matchSchedules/{level}    { allow read: if signedIn(); allow write: if isStaff(); }
    match /venuesConfig/{docId}      { allow read: if signedIn(); allow write: if isStaff(); }
    match /matchRecords/{level}      { allow read: if signedIn(); allow write: if isStaff(); }

    // Team rankings are shown publicly (RankingPage), staff-managed.
    match /teamRankings/{level} {
      allow read: if true;
      allow write: if isStaff();
    }

    // ── Saved matches (Save Match → Calendar reminder) ──────────
    match /savedMatches/{docId} {
      allow read:          if signedIn() && (resource.data.uid == request.auth.uid || isStaff());
      allow create, update: if signedIn() && request.resource.data.uid == request.auth.uid;
      allow delete:         if signedIn() && (resource.data.uid == request.auth.uid || isStaff());
    }
  }
}
```

- [ ] **Step 2: Deploy the rules**

Run: `firebase deploy --only firestore:rules`

(Requires the Firebase CLI installed and logged into the account that owns the `srccapstone` project. If the CLI isn't set up, paste the same file content into Firebase Console → Firestore Database → Rules → publish instead.) Until this is deployed, every `savedMatches` read/write in later tasks will fail with `permission-denied` — do this before manually verifying Task 4.

- [ ] **Step 3: Commit**

```bash
git add firestore.rules
git commit -m "feat: add savedMatches Firestore rules for match reminders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KdHRG5Kwmq4FED38Bwehjy"
```

---

## Task 2: `savedMatches` data layer + live-schedule subscription helper

**Files:**
- Modify: `src/services/firestoreService.js`

**Interfaces:**
- Consumes: `db` from `../firebase` (existing import); `doc, setDoc, getDoc, getDocs, deleteDoc, collection, query, where, onSnapshot, serverTimestamp` from `firebase/firestore`.
- Produces (for Task 3/4/5 to consume):
  - `subscribeToMatchSchedules(level: string, onChange: (matches: Array) => void, onError?: (error) => void) => unsubscribe: () => void`
  - `getSavedMatchesForUser(uid: string) => Promise<Array<{ id, uid, level, matchId, sport, teamA, teamB, calendarEventId, createdAt }>>`
  - `saveMatchReminder(uid: string, level: string, match: { id, sport, teamA, teamB }, calendarEventId: string) => Promise<void>`
  - `deleteSavedMatch(uid: string, matchId: string) => Promise<void>`
  - `deleteMatchSchedule(level, matchId)` (existing function) now also removes any `savedMatches` docs referencing that `matchId`.

- [ ] **Step 1: Extend the Firestore imports**

In `src/services/firestoreService.js`, replace the top import block:

```js
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
```

with:

```js
import {
  collection,
  getDocs,
  doc,
  setDoc,
  getDoc,
  addDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  increment,
} from 'firebase/firestore';
```

- [ ] **Step 2: Add `subscribeToMatchSchedules`**

Add this function right after `getMatchSchedules` (after line 324, before the `saveGeneratedSchedule` JSDoc comment):

```js
/**
 * Live version of getMatchSchedules: subscribes to matchSchedules/{level}
 * and calls onChange with the current matches array every time it changes
 * (including once immediately with the current value). Returns an
 * unsubscribe function — callers must invoke it on unmount.
 *
 * On a listener error (e.g. offline, permission issue), onError is called
 * if provided, but onChange is NOT called again — the page keeps whatever
 * matches it already has in memory, matching this repo's existing pattern
 * of degrading gracefully rather than crashing when Firestore is
 * unreachable.
 */
export function subscribeToMatchSchedules(level, onChange, onError) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot subscribe to match schedules.');
    onChange([]);
    return () => {};
  }
  const configRef = doc(db, 'matchSchedules', level);
  return onSnapshot(
    configRef,
    (snapshot) => onChange(snapshot.exists() ? (snapshot.data().matches || []) : []),
    (error) => {
      console.warn(`matchSchedules/${level} listener error:`, error);
      if (onError) onError(error);
    }
  );
}
```

- [ ] **Step 3: Clean up `savedMatches` when a match is deleted from a schedule**

Replace the existing `deleteMatchSchedule` function:

```js
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
```

with:

```js
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

  // Best-effort: any user who had this match saved gets their Firestore
  // savedMatches doc cleaned up too, so the app's own "saved" state stays
  // correct. Their external Google Calendar event can't be reached from
  // here (only that user's own consented browser session can act on
  // their Calendar) and may go stale — accepted limitation, see spec.
  await deleteSavedMatchesForMatch(matchId).catch((err) => {
    console.warn(`Could not clean up savedMatches for deleted match ${matchId}:`, err);
  });

  return remaining;
}
```

- [ ] **Step 4: Add the `savedMatches` CRUD section**

Add this new section at the end of `src/services/firestoreService.js` (after the `setEventRegistrationCounts` function, which is currently the last thing in the file):

```js
/* ─────────────────────────────────────────────
   Saved matches (Save Match → Calendar reminder)
   Stored at: savedMatches/{uid}_{matchId}
   {
     uid, level, matchId, sport, teamA, teamB,
     calendarEventId,   // returned by Google Calendar's events.insert
     createdAt,
   }

   One doc per (user, match) pair, keyed so save/unsave is a direct
   set/delete by id — no query needed to check whether a single match is
   already saved. getSavedMatchesForUser loads the whole set once per
   page visit so the UI can check membership in memory instead of
   issuing one read per visible match.
───────────────────────────────────────────── */
function savedMatchDocId(uid, matchId) {
  return `${uid}_${matchId}`;
}

export async function getSavedMatchesForUser(uid) {
  if (!db) {
    console.warn('Firestore not initialized. Cannot load saved matches.');
    return [];
  }
  const savedQuery = query(collection(db, 'savedMatches'), where('uid', '==', uid));
  const snapshot = await getDocs(savedQuery);
  return snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

export async function saveMatchReminder(uid, level, match, calendarEventId) {
  if (!db) throw new Error('Firestore not initialized.');
  const ref = doc(db, 'savedMatches', savedMatchDocId(uid, match.id));
  await setDoc(ref, {
    uid,
    level,
    matchId: match.id,
    sport: match.sport || '',
    teamA: match.teamA || '',
    teamB: match.teamB || '',
    calendarEventId,
    createdAt: serverTimestamp(),
  });
}

export async function deleteSavedMatch(uid, matchId) {
  if (!db) throw new Error('Firestore not initialized.');
  await deleteDoc(doc(db, 'savedMatches', savedMatchDocId(uid, matchId)));
}

/* Internal: removes every user's savedMatches doc for one matchId.
   Used by deleteMatchSchedule above. Not exported — schedule deletion
   is the only caller. */
async function deleteSavedMatchesForMatch(matchId) {
  if (!db) return;
  const matchQuery = query(collection(db, 'savedMatches'), where('matchId', '==', matchId));
  const snapshot = await getDocs(matchQuery);
  await Promise.all(snapshot.docs.map((docSnap) => deleteDoc(docSnap.ref)));
}
```

- [ ] **Step 5: Verify**

Run: `npm run lint`
Expected: no new errors from `firestoreService.js` (pre-existing warnings elsewhere in the repo, if any, are unrelated and fine to ignore).

Run: `npm run build`
Expected: build succeeds — confirms every new import/export resolves correctly even though nothing calls these functions yet.

- [ ] **Step 6: Commit**

```bash
git add src/services/firestoreService.js
git commit -m "feat: add savedMatches data layer and live schedule subscription helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KdHRG5Kwmq4FED38Bwehjy"
```

---

## Task 3: Google Calendar service module + Google Cloud setup

**Files:**
- Create: `src/services/googleCalendar.js`
- Modify: `.env.example`
- Modify: `.env` (local only — never committed; gitignored already since it holds the existing `VITE_FIREBASE_*` secrets)

**Interfaces:**
- Consumes: `import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID`; the global `window.google.accounts.oauth2` object injected by the Google Identity Services script.
- Produces (for Task 4 to consume):
  - `getCalendarAccessToken() => Promise<string>` — resolves with an access token, rejects if the user denies/closes the consent popup or the request times out.
  - `insertCalendarEvent(match: { sport, teamA, teamB, date, time, location }, accessToken: string) => Promise<string>` — resolves with the created event's id.
  - `deleteCalendarEvent(eventId: string, accessToken: string) => Promise<void>`.

- [ ] **Step 1: Google Cloud Console setup (manual, one-time)**

Before writing any code, do this in the Google Cloud Console for the `srccapstone` project (same project backing Firebase):

1. **APIs & Services → Library** → search "Google Calendar API" → Enable. (Free API enablement — does not require Blaze/billing, per spec.)
2. **APIs & Services → OAuth consent screen** → User Type: External → fill in the required app info → add the `https://www.googleapis.com/auth/calendar.events` scope → under "Test users" (while in Testing status), add every Google account that will test this feature, since the app is capped at 100 explicitly-allowlisted test users and shows an "unverified app" warning until Google's OAuth verification process is completed. This is a real deployment blocker for a school-wide rollout — flag it back to the user before this ships beyond a pilot group.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type: Web application → add this app's dev origin (e.g. `http://localhost:5173`) and production origin(s) to "Authorized JavaScript origins" → no redirect URI needed (token-client flow, not redirect flow) → copy the generated Client ID.

- [ ] **Step 2: Add the env var**

In `.env.example`, add a new line:

```
VITE_GOOGLE_CALENDAR_CLIENT_ID=your_google_oauth_web_client_id
```

In the local `.env` file, add the real client ID obtained in Step 1:

```
VITE_GOOGLE_CALENDAR_CLIENT_ID=<the client ID from Google Cloud Console>
```

- [ ] **Step 3: Create the service module**

Create `src/services/googleCalendar.js`:

```js
/* ─────────────────────────────────────────────
   Google Calendar integration for "Save Match" reminders.

   Deliberately NOT part of firestoreService.js — this talks to the
   Google Calendar REST API directly from the browser, not Firestore.
   It's a second, separate OAuth consent from this app's own Firebase
   Auth (email/password only — no Google sign-in provider exists in
   AuthContext.jsx), obtained via Google Identity Services
   (`accounts.google.com/gsi/client`, loaded on demand below).

   No Cloud Functions / server-side credential involved: the access
   token lives only in the browser for the lifetime of this page.
───────────────────────────────────────────── */

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TOKEN_REQUEST_TIMEOUT_MS = 120000;

let gisScriptPromise = null;

function loadGisScript() {
  if (gisScriptPromise) return gisScriptPromise;
  gisScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script.'));
    document.head.appendChild(script);
  });
  return gisScriptPromise;
}

let tokenClient = null;
let pendingTokenRequest = null;

/**
 * Resolves with a short-lived Calendar access token, prompting the
 * Google OAuth consent popup on first use in a session. Concurrent
 * callers share one in-flight request instead of opening multiple
 * popups. Rejects if the user denies/closes the popup or nothing
 * happens within TOKEN_REQUEST_TIMEOUT_MS.
 */
export async function getCalendarAccessToken() {
  await loadGisScript();

  const clientId = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID;
  if (!clientId) {
    throw new Error('VITE_GOOGLE_CALENDAR_CLIENT_ID is not configured.');
  }

  if (pendingTokenRequest) return pendingTokenRequest;

  pendingTokenRequest = new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn(value);
    };
    timeoutId = setTimeout(() => {
      settle(reject, new Error('Google Calendar authorization timed out.'));
    }, TOKEN_REQUEST_TIMEOUT_MS);

    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: CALENDAR_SCOPE,
        callback: () => {},
        error_callback: () => {},
      });
    }

    tokenClient.callback = (response) => {
      if (response?.error) {
        settle(reject, new Error(response.error));
        return;
      }
      settle(resolve, response.access_token);
    };
    tokenClient.error_callback = (error) => {
      settle(reject, new Error(error?.type || 'Google Calendar authorization was cancelled.'));
    };

    tokenClient.requestAccessToken({ prompt: '' });
  }).finally(() => {
    pendingTokenRequest = null;
  });

  return pendingTokenRequest;
}

function buildEventBody(match) {
  const start = new Date(`${match.date}T${match.time}:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000); // 1-hour default duration
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    summary: `${match.sport || 'Match'}: ${match.teamA} vs ${match.teamB}`,
    location: match.location || '',
    start: { dateTime: start.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }],
    },
  };
}

/** Creates a Calendar event for a match. Resolves with the new event's id. */
export async function insertCalendarEvent(match, accessToken) {
  const res = await fetch(CALENDAR_EVENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildEventBody(match)),
  });
  if (!res.ok) {
    throw new Error(`Google Calendar insert failed: ${res.status}`);
  }
  const data = await res.json();
  return data.id;
}

/** Deletes a previously-created Calendar event. 404/410 (already gone) are treated as success. */
export async function deleteCalendarEvent(eventId, accessToken) {
  const res = await fetch(`${CALENDAR_EVENTS_URL}/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Calendar delete failed: ${res.status}`);
  }
}
```

- [ ] **Step 4: Verify**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

Do **not** commit `.env` (already gitignored — verify with `git status` that only `.env.example` shows as changed).

```bash
git add src/services/googleCalendar.js .env.example
git commit -m "feat: add Google Calendar service module for match reminders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KdHRG5Kwmq4FED38Bwehjy"
```

---

## Task 4: Save Match button (Feature 1, end to end)

**Files:**
- Create: `src/components/SaveMatchButton.jsx`
- Modify: `src/pages/MatchSchedulesPage.jsx`
- Modify: `src/pages/MatchSchedulesPage.css`

**Interfaces:**
- Consumes: `getCalendarAccessToken, insertCalendarEvent, deleteCalendarEvent` (Task 3); `saveMatchReminder, deleteSavedMatch` (Task 2); `AuthContext` (`currentUser`, existing).
- Produces: `<SaveMatchButton match={{ id, level, sport, teamA, teamB, date, time, location }} currentUser={User|null} savedInfo={{ calendarEventId: string }|null} onChange={(matchId: string, savedInfo: {calendarEventId}|null) => void} />`.

Note on scope: only the dated Schedule Tables (`ScheduleDayTable`, fed by `scheduledMatches` which already filters to `m.date && m.time`) get the Save button. The Rounds/bracket view (`RoundsView`) is unaffected — its matches don't reliably have a date/time yet, and the spec's whole point is a reminder "shortly before it starts."

- [ ] **Step 1: Create `SaveMatchButton`**

Create `src/components/SaveMatchButton.jsx`:

```jsx
import React, { useState } from 'react';
import { FaBookmark, FaRegBookmark } from 'react-icons/fa';
import { getCalendarAccessToken, insertCalendarEvent, deleteCalendarEvent } from '../services/googleCalendar';
import { saveMatchReminder, deleteSavedMatch } from '../services/firestoreService';

/* ── "Save Match" toggle: on save, gets a Google Calendar event with a
   ~10-minute-before popup reminder via a separate Google OAuth consent
   (independent of this app's own Firebase Auth). On failure to obtain
   consent, fails silently — the match just stays unsaved. ── */
export default function SaveMatchButton({ match, currentUser, savedInfo, onChange }) {
  const [busy, setBusy] = useState(false);

  if (!currentUser) return null;

  const disabled = !match.date || !match.time;

  async function handleClick() {
    if (busy || disabled) return;
    setBusy(true);
    try {
      if (savedInfo) {
        try {
          const token = await getCalendarAccessToken();
          await deleteCalendarEvent(savedInfo.calendarEventId, token);
        } catch (err) {
          console.warn('Could not remove the Google Calendar event (it may need manual cleanup):', err);
        }
        // Delete the Firestore doc regardless of the Calendar call's
        // outcome, so the app's own UI state stays consistent.
        await deleteSavedMatch(currentUser.uid, match.id);
        onChange(match.id, null);
      } else {
        const token = await getCalendarAccessToken();
        const eventId = await insertCalendarEvent(match, token);
        await saveMatchReminder(currentUser.uid, match.level, match, eventId);
        onChange(match.id, { calendarEventId: eventId });
      }
    } catch (err) {
      console.warn('Save Match failed (Google Calendar authorization may have been denied):', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`ms-save-btn ${savedInfo ? 'ms-save-btn--saved' : ''}`}
      onClick={handleClick}
      disabled={disabled || busy}
      aria-pressed={!!savedInfo}
      title={
        disabled
          ? 'This match has no confirmed date/time yet'
          : savedInfo ? 'Remove Calendar reminder' : 'Save Match — get a Calendar reminder'
      }
    >
      {savedInfo ? <FaBookmark /> : <FaRegBookmark />}
    </button>
  );
}
```

- [ ] **Step 2: Add button styling**

In `src/pages/MatchSchedulesPage.css`, add this block right after the `.ms-row` rule (after line 604, the closing `}` of `.ms-row`):

```css
.ms-row {
  position: relative;
}

/* ── Save Match button — pinned to the top-right corner of each
   schedule row so it doesn't disturb the existing 4-column grid ── */
.ms-save-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: rgba(10, 29, 82, 0.06);
  color: #0A1D52;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s ease, color 0.15s ease;
}

.ms-save-btn:hover:not(:disabled) {
  background: rgba(201, 138, 0, 0.15);
}

.ms-save-btn--saved {
  color: #C98A00;
  background: rgba(201, 138, 0, 0.12);
}

.ms-save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

(Note: `.ms-row` already appears as a bare selector only at line 597 in the current file — this adds `position: relative` to that same rule rather than duplicating the selector. If your editor's exact line numbers have drifted, just add `position: relative;` inside the existing `.ms-row { ... }` block instead of declaring it twice.)

- [ ] **Step 3: Wire it into `MatchSchedulesPage.jsx`**

Update the top imports (lines 1–6):

```jsx
import React, { useState, useEffect, useMemo, useContext } from 'react';
import './MatchSchedulesPage.css';
import Contact from '../components/Landing/Contact/Contact';
import { FaSearch, FaTrophy } from 'react-icons/fa';
import { getMatchSchedules, getMatchRecords, getSavedMatchesForUser } from '../services/firestoreService';
import LevelTabs from '../components/LevelTabs';
import SaveMatchButton from '../components/SaveMatchButton';
import { AuthContext } from '../components/AuthContext';
```

(`getMatchSchedules` stays imported for now — Task 5 replaces its usage. `subscribeToMatchSchedules` is added in Task 5, not here.)

Update `ScheduleDayTable` (currently lines 196–241) to accept and use the new props:

```jsx
/* ── Schedule table for a single day ── */
function ScheduleDayTable({ day, matches, resultFor, currentUser, savedMap, onToggleSave }) {
  return (
    <div className="ms-day-card">
      <div className="ms-day-header">{day}</div>
      <div className="ms-table-wrap" role="table">
        <div className="ms-row ms-row--head" role="row">
          <div className="ms-cell ms-cell-time" role="columnheader">TIME</div>
          <div className="ms-cell ms-cell-sport" role="columnheader">SPORTS</div>
          <div className="ms-cell ms-cell-venue" role="columnheader">VENUE</div>
          <div className="ms-cell ms-cell-team" role="columnheader">TEAM</div>
        </div>
        {matches.map((m) => (
          <div className="ms-row" role="row" key={m.id}>
            <div className="ms-cell ms-cell-time" role="cell" data-label="Time">{formatTime(m.time)}</div>
            <div className="ms-cell ms-cell-sport" role="cell" data-label="Sport">{categoryOf(m).label}</div>
            <div className="ms-cell ms-cell-venue" role="cell" data-label="Venue">{m.location || '—'}</div>
            <div className="ms-cell ms-cell-team ms-cell-team--body" role="cell">
              {(() => {
                const record = resultFor ? resultFor(m) : null;
                const winner = winnerNameOf(record);
                const bold = (team) => (winner && norm(team) === norm(winner) ? { fontWeight: 800 } : undefined);
                return (
                  <>
                    <span style={bold(m.teamA)}>{m.teamA}</span>
                    <span className="ms-team-vs">vs</span>
                    <span style={bold(m.teamB)}>{m.teamB}</span>
                    {record && (
                      <span
                        style={{
                          marginLeft: 8, fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em',
                          padding: '2px 7px', borderRadius: 20, background: '#eef1f8', color: '#46536b',
                        }}
                      >
                        {winner ? `${winner} WON` : 'DRAW'}
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
            <SaveMatchButton
              match={m}
              currentUser={currentUser}
              savedInfo={savedMap.get(m.id) || null}
              onChange={onToggleSave}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
```

Inside the `MatchSchedulesPage` component, add `currentUser` and the saved-matches state. Replace the top of the component body (currently lines 243–251):

```jsx
export default function MatchSchedulesPage() {
  const { currentUser } = useContext(AuthContext);
  const [levelKey, setLevelKey] = useState(LEVELS[0].key);
  const level = LEVELS.find(l => l.key === levelKey) || LEVELS[0];
  const [category, setCategory] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [matchesByLevel, setMatchesByLevel] = useState({ elementary: [], highSchool: [], college: [] });
  const [records, setRecords] = useState([]); // Moderator results, all levels
  const [savedMap, setSavedMap] = useState(new Map()); // matchId -> { calendarEventId }
  const contactRef = React.useRef(null);
```

Add a new effect to load the current user's saved matches once per sign-in (place this right after the closing `}, []);` of the existing data-loading `useEffect`, i.e. after current line 299):

```jsx
  /* ── Load which matches the signed-in user already saved, once per
     sign-in, so SaveMatchButton can check membership in memory ── */
  useEffect(() => {
    let cancelled = false;
    if (!currentUser) {
      setSavedMap(new Map());
      return undefined;
    }
    getSavedMatchesForUser(currentUser.uid)
      .then((docs) => {
        if (cancelled) return;
        setSavedMap(new Map(docs.map((d) => [d.matchId, { calendarEventId: d.calendarEventId }])));
      })
      .catch((err) => {
        console.warn('Failed to load saved matches:', err);
        if (!cancelled) setSavedMap(new Map());
      });
    return () => { cancelled = true; };
  }, [currentUser]);

  const handleToggleSave = (matchId, savedInfo) => {
    setSavedMap((prev) => {
      const next = new Map(prev);
      if (savedInfo) next.set(matchId, savedInfo);
      else next.delete(matchId);
      return next;
    });
  };
```

Finally, pass the new props to `ScheduleDayTable` where it's rendered (currently line 490):

```jsx
                filteredSchedule.map(day => (
                  <ScheduleDayTable
                    key={day.day}
                    day={day.day}
                    matches={day.matches}
                    resultFor={resultFor}
                    currentUser={currentUser}
                    savedMap={savedMap}
                    onToggleSave={handleToggleSave}
                  />
                ))
```

- [ ] **Step 4: Verify**

Run: `npm run lint`
Expected: no new errors.

Run: `npm run dev`, then in the browser:
1. Log in as a regular student/authenticated user and open **Game Schedules**.
2. Confirm a bookmark icon appears in the top-right corner of every row that has a confirmed date/time, and does **not** appear when logged out.
3. Click it on one match → confirm the Google OAuth consent popup appears (first time in the session) → grant access → confirm the icon fills in (saved state) and a matching event appears on that Google account's Calendar with the correct time and a 10-minute popup reminder.
4. Click it again → confirm the icon reverts to unsaved and the Calendar event disappears.
5. Deny/close the OAuth popup deliberately on a fresh match → confirm the app doesn't crash, an error is only visible in the console (not the UI), and the button stays unsaved.
6. Reload the page → confirm previously-saved matches still show as saved (persisted via `savedMatches` in Firestore, not just local state).

- [ ] **Step 5: Commit**

```bash
git add src/components/SaveMatchButton.jsx src/pages/MatchSchedulesPage.jsx src/pages/MatchSchedulesPage.css
git commit -m "feat: add Save Match button with Google Calendar reminders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KdHRG5Kwmq4FED38Bwehjy"
```

---

## Task 5: Live schedule updates (Feature 2)

**Files:**
- Modify: `src/pages/MatchSchedulesPage.jsx`

**Interfaces:**
- Consumes: `subscribeToMatchSchedules` (Task 2), `getMatchRecords` (existing).

- [ ] **Step 1: Split the one-time load into a records effect + a live-subscription effect**

Update the import line for `firestoreService` (from Task 4's version) to also pull in `subscribeToMatchSchedules`, and drop the now-unused `getMatchSchedules`:

```jsx
import { getMatchRecords, getSavedMatchesForUser, subscribeToMatchSchedules } from '../services/firestoreService';
```

Replace the whole data-loading `useEffect` block (the one starting with the `/* ── Load real data from Firestore for every level ── */` comment, currently lines 253–299):

```jsx
  /* ── Load Moderator results once per visit. Optional: if this can't
     be read, the schedule still renders, just without WIN/LOSE badges. ── */
  useEffect(() => {
    let cancelled = false;

    async function loadRecords() {
      try {
        const recordLists = await Promise.all(
          ['elementary', 'highSchool', 'college'].map(lvl => getMatchRecords(lvl).catch(() => [])),
        );
        if (!cancelled) setRecords(recordLists.flat().filter(Boolean));
      } catch (e) {
        console.error('Failed to load match records:', e);
        if (!cancelled) setRecords([]);
      }
    }

    loadRecords();
    return () => { cancelled = true; };
  }, []);

  /* ── Subscribe to schedules for every level so admin edits/additions
     appear live, without a reload. Replaces the old one-time
     getMatchSchedules() fetch with onSnapshot listeners. ── */
  useEffect(() => {
    setLoading(true);
    const levels = ['elementary', 'highSchool', 'college'];
    const loadedLevels = new Set();

    const tag = (levelKey, matches) =>
      (matches || [])
        .filter(m => m && m.teamA && m.teamB)
        .map(m => ({ ...m, level: levelKey }));

    const markLoaded = (lvl) => {
      loadedLevels.add(lvl);
      if (loadedLevels.size === levels.length) setLoading(false);
    };

    const unsubscribers = levels.map((lvl) =>
      subscribeToMatchSchedules(
        lvl,
        (matches) => {
          setMatchesByLevel((prev) => ({ ...prev, [lvl]: tag(lvl, matches) }));
          markLoaded(lvl);
        },
        () => markLoaded(lvl), // keep last-known state in memory; just stop spinning
      )
    );

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);
```

- [ ] **Step 2: Verify**

Run: `npm run lint`
Expected: no new errors (in particular, no `react-hooks/exhaustive-deps` warning on either new effect — both intentionally run once, matching the previous behavior).

Run: `npm run dev`, then:
1. Open **Game Schedules** in two browser windows/tabs side by side, one logged in as admin/staff (Schedule Manager) and one as any signed-in viewer on the Game Schedules page.
2. In the admin tab, edit a match's date/time/venue in the Schedule Manager (`/admin`) and save.
3. Confirm the viewer tab's Game Schedules page updates the row live — no reload, no re-navigation.
4. Add a brand-new scheduled match as admin → confirm it appears live in the viewer tab too.
5. Confirm WIN/LOSE badges and the champion box still render correctly (records are still a one-time fetch, unchanged).
6. Re-run the full Task 4 Save Match checklist once more end-to-end now that both features are live together, to confirm nothing regressed (a schedule edit shouldn't disturb another user's `savedMatches` state; deleting a match a user has saved should silently drop it from their saved set on next load, per the spec's accepted limitation).

- [ ] **Step 3: Commit**

```bash
git add src/pages/MatchSchedulesPage.jsx
git commit -m "feat: make match schedules update live via onSnapshot

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KdHRG5Kwmq4FED38Bwehjy"
```
