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
