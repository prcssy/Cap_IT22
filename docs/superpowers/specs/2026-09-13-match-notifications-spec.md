# Match Notifications (Save Match reminder + live schedule updates)

Status: approved design, ready for implementation plan
Date: 2026-09-13

## Background

`MatchSchedulesPage.jsx` and `ModeratorPage.jsx` are pull-only today: schedule
data is fetched once on page load via one-time `getDoc`/`getDocs` calls in
`firestoreService.js` (confirmed — there is no `onSnapshot` anywhere in this
codebase). A user only sees a reschedule or a new match if they reload or
re-navigate to the page.

This spec covers closing that gap for two specific cases, chosen after ruling
out several alternatives (see "Rejected approaches" below):

1. A user can save a match they care about and get a reminder shortly before
   it starts, even if they aren't on the site at the time.
2. Anyone with the schedule page open sees schedule changes (date/time/venue
   edits, newly added matches) appear live, without reloading.

**Explicitly out of scope:** a "match finished, here's the score/winner"
notification. This was discussed and deliberately dropped to keep the whole
feature deliverable at zero cost (see "Rejected approaches").

## Hard constraint driving this design

The project must not incur any cost and must not have a billing account
linked to the Firebase project. It was confirmed live that the project is
currently on the **Spark (free) plan** with no billing account attached, and
that this must remain true.

This constraint rules out **Cloud Functions and Cloud Scheduler entirely**,
because:
- Cloud Functions require the Blaze plan, which requires a linked billing
  account, even if actual usage stays inside the free tier.
- Enabling Blaze is not risk-free even at "$0 expected" usage: there is no
  automatic hard spending cap, only advisory budget-alert emails. A bug (most
  commonly an infinite Firestore-trigger loop, where a function's own write
  re-triggers itself) can generate real, unbounded charges.

It also rules out sending via Firebase Cloud Messaging (FCM) for any of the
three original notification types, because FCM sending requires a trusted
server-side credential (the Admin SDK service account) that must never be
embedded in client-side code — and without Cloud Functions, this project has
no server-side compute of any kind to hold that credential safely.

## Rejected approaches (for context — do not re-propose these without a reason this constraint has changed)

- **FCM push for all three notification types via Cloud Functions.** The
  original idea. Rejected once the no-billing-account constraint was made
  explicit — Cloud Functions require Blaze.
- **Cloud Scheduler polling every 1–2 minutes + Cloud Functions** for the
  "starts in 10 minutes" reminder. Same reason.
- **Hosting the trigger logic on a second free-tier platform** (GitHub
  Actions scheduled workflow, Cloudflare Workers) to keep true background
  push for all three notification types without touching Firebase billing.
  Considered and explicitly declined in favor of simplicity — the user chose
  the in-app-only fallback over taking on a second hosting platform.
- **"Match finished" notification** via either of the above mechanisms.
  Dropped from scope entirely once Cloud Functions were ruled out — there is
  no zero-cost way to notify a user "even if the app is closed" purely off a
  Firestore write with no server-side compute available.

## Architecture

Two independent, purely client-side features. No new backend, no service
worker, no Cloud Functions, no FCM.

```
Save Match button (MatchSchedulesPage)
        │
        ▼
Google Identity Services OAuth popup (calendar.events scope)
        │
        ▼
Browser calls Google Calendar API directly (events.insert / events.delete)
        │
        ▼
Google Calendar delivers its own native reminder ~10 min before match time
        (works even with this site fully closed — it's Google's
         infrastructure handling delivery, not ours)

Firestore savedMatches/{uid}_{matchId} doc tracks save state +
the returned Calendar eventId, so unsaving can delete the right event.

---

MatchSchedulesPage.jsx
        │
        ▼
Firestore onSnapshot on matchSchedules/{elementary|highSchool|college}
        │
        ▼
Page re-renders live when an admin edits/adds a schedule entry
        (only while the page is open in a tab — no notification of any
         kind if the tab/app is closed)
```

## Feature 1: Save Match → Calendar reminder

### Data model

New top-level collection, one document per (user, match) pair:

```
savedMatches/{uid}_{matchId}
{
  uid: string,
  level: 'elementary' | 'highSchool' | 'college',
  matchId: string,        // matches the id inside matchSchedules/{level}.matches
  sport: string,
  teamA: string,
  teamB: string,
  calendarEventId: string,   // returned by Google Calendar's events.insert
  createdAt: Timestamp,
}
```

Doc ID is `${uid}_${matchId}` so save/unsave is a direct set/delete by ID —
no query needed to check whether a match is already saved by this user (the
frontend can read `savedMatches/{uid}_{matchId}` directly, or load the
current user's saved set once per page visit and check membership in
memory).

### Google Calendar API integration

- Requires a **Google Cloud OAuth 2.0 Client ID** (Web application type)
  configured in the same GCP project backing Firebase (`srccapstone`), with
  the app's dev and production origins registered as authorized JavaScript
  origins. New env var: `VITE_GOOGLE_CALENDAR_CLIENT_ID`.
- The **Google Calendar API** must be enabled for the project. This is a
  free API enablement — it does not require Blaze/billing. Calendar API
  usage has its own generous free quota unrelated to Firebase billing.
- **OAuth consent screen** must be configured (type: External, since student
  accounts are not Google Workspace accounts tied to this project).
  `https://www.googleapis.com/auth/calendar.events` is a Google "sensitive"
  scope. While the app is in **Testing** publishing status, Google caps
  usage to 100 explicitly-allowlisted test users and shows an "unverified
  app" warning to every user. To lift the 100-user cap and remove that
  warning, the app must go through Google's OAuth verification process
  (free, but takes real calendar time — plan for it separately from
  development). **This is a real deployment blocker to flag now**: if this
  ships to the whole school, either the school's total user base must stay
  under 100 during a testing/pilot phase, or verification must be completed
  before wider rollout.
- Client library: Google Identity Services (`accounts.google.com/gsi/client`
  script, loaded on demand), using `google.accounts.oauth2.initTokenClient`
  to obtain a short-lived access token for the `calendar.events` scope. This
  is fully independent of this app's Firebase Auth (email/password only,
  confirmed no Google sign-in provider exists in `AuthContext.jsx`) — a
  student's St. Rita's login is not necessarily a Google account, so this is
  always a separate consent step.
- Calls made directly from the browser to
  `https://www.googleapis.com/calendar/v3/calendars/primary/events` using
  the obtained access token — `events.insert` on save (with a `reminders`
  override for a popup ~10 minutes before `start.dateTime`), `events.delete`
  on unsave.

### UI changes

- New "Save Match" toggle button on each match row/card in
  `MatchSchedulesPage.jsx`. Visible only to authenticated users. Disabled
  (or hidden) for matches without both `date` and `time` set, since there is
  no meaningful reminder time to schedule.
- First save for a session prompts the Google OAuth popup. If the user
  denies/closes it, the save silently fails — no `savedMatches` doc is
  created, no error thrown to the console beyond a caught rejection, and the
  button stays in its unsaved state.
- Unsaving calls `events.delete` with the stored `calendarEventId`, then
  deletes the `savedMatches/{uid}_{matchId}` doc. If the Calendar delete call
  fails (e.g., token expired, event already removed by the user manually in
  their own Calendar), the Firestore doc is still deleted so the app's UI
  stays consistent — the calendar event may need manual cleanup in that rare
  case.

### Known limitation (explicitly accepted)

If an admin edits or deletes a match that another user has already saved,
there is no mechanism to reach into that other user's Google Calendar and
update/remove their event — only a user's own active, consented browser
session can act on their own Calendar. The corresponding `savedMatches`
Firestore doc **should** be cleaned up when a match is deleted from a
schedule (so the app's own "saved" state stays correct), but the external
Calendar event itself may go stale (wrong time, or referencing a
since-removed match) in that edge case. This is accepted as a tradeoff of
having zero server-side compute.

## Feature 2: Live schedule updates

- In `MatchSchedulesPage.jsx`, the `useEffect` at line 254 currently does:
  ```js
  const [elementary, highSchool, college] = await Promise.all([
    getMatchSchedules('elementary'),
    getMatchSchedules('highSchool'),
    getMatchSchedules('college'),
  ]);
  ```
  This one-time fetch is replaced with three `onSnapshot` listeners (one per
  level) on the `matchSchedules/{level}` document, updating
  `matchesByLevel` state directly in each listener's callback instead of via
  a single `Promise.all` resolution. Listeners are cleaned up on unmount.
- `getMatchRecords` loading (used for WIN/LOSE badges and champion
  detection) is **not** changed — it stays a one-time fetch, since the
  "match finished" live-notification feature was dropped from scope. Making
  records live too would be a small additional change but is not part of
  this spec; call it out separately if wanted later.
- No changes to `firestoreService.js`'s existing `getMatchSchedules` /
  `upsertMatchSchedule` functions — this is purely a change to *how*
  `MatchSchedulesPage.jsx` subscribes to the same data, using the Firestore
  SDK's `onSnapshot` instead of `getDoc` under the hood.
- Firestore security rules must permit reads on `matchSchedules/{level}` for
  any authenticated user via a listener the same way they already do for a
  one-time `getDoc` — this should already be the case since the page reads
  this data today, but must be verified during implementation, not assumed.

## Error handling summary

| Scenario | Behavior |
|---|---|
| Notification/Calendar OAuth popup blocked or denied | Save fails silently; button stays unsaved; no crash |
| Google access token expired on unsave | Firestore `savedMatches` doc is deleted regardless, to keep app UI consistent; Calendar event may need manual cleanup |
| Match has no date/time | "Save Match" is disabled for that match |
| `onSnapshot` listener error (permissions/offline) | Falls back to last-known state already in memory; matches this repo's existing pattern of degrading gracefully rather than crashing when Firestore is unreachable |
| Match deleted from schedule while saved by others | That user's `savedMatches` doc is cleaned up client-side, wherever the deletion is performed; their external Calendar event is not reachable and may go stale (accepted limitation above) |

## Testing plan

No automated test suite exists in this repo (per `CLAUDE.md`). Verification
will be manual:
- Two browser sessions on `MatchSchedulesPage`: edit a schedule as admin in
  one, confirm the other updates live without a reload.
- A real Google account: save a match, confirm the OAuth popup, confirm the
  event appears on that Google Calendar with the correct time and a ~10
  minute reminder, confirm the reminder actually fires near match time.
  Unsave, confirm the event disappears from Calendar and the button reverts.
- Deny the OAuth popup deliberately, confirm the app doesn't crash and the
  match stays in an unsaved state.
- A match with no date/time set: confirm "Save Match" is disabled/hidden for
  it.
