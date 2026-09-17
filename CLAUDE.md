# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A React + Vite SPA for St. Rita's College's intramurals/sportsfest/PRISAA event management: student registration, sports & team configuration, match scheduling, match record-keeping, and team rankings. Firebase (Auth + Firestore + Storage) is the entire backend — there is no custom server.

## Commands

```
npm run dev       # start Vite dev server (also aliased as `npm start`)
npm run build     # production build
npm run preview   # preview the production build
npm run lint      # eslint .
```

There is no test suite configured in this repo.

Firebase config comes from `.env` (see `.env.example` for the required `VITE_FIREBASE_*` keys). Without it, `src/firebase.js` logs a warning and `auth`/`db`/`storage` are left undefined — most of the app degrades gracefully (empty lists) rather than crashing, since every Firestore helper in `src/services/firestoreService.js` checks `if (!db)` first.

`vite.config.js` sets `server.host: true`, so the dev server is reachable from other devices on the local network by default.

## Architecture

**Routing** (`src/App.jsx`): `/` is the public landing page (`PublicLayout`). Everything else sits under `AuthenticatedLayout` (sidebar + page transition wrapper) and is wrapped in `ProtectedRoute`, which redirects unauthenticated users to `/` and role-mismatched users to `/dashboard`. `/schedule-admin` is a legacy alias of `/admin`.

**Auth & roles** (`src/components/AuthContext.jsx`): Firebase Auth handles login/signup, but *authorization* is entirely Firestore-driven — there is no role field the client can set on itself. On every auth state change, the user's email (lowercased) is looked up across three collections in order: `superadmins` → `admins` → `moderators`; the first match wins, otherwise the role falls back to whatever `users/{uid}.role` says (default `student`). To grant staff access, add a doc to the relevant collection in Firebase Console with the email as the document ID — there's no UI for this. Email verification is enforced at login (`login()` signs the user back out and throws if `emailVerified` is false); `signup()` sends the verification email, writes the `users/{uid}` profile, then immediately signs the user back out.

**Data layer** (`src/services/firestoreService.js`): all Firestore/Storage reads and writes go through this one file — pages never call the Firestore SDK directly. Key conventions to preserve when extending it:
- Config-style data (sports/teams, match schedules, match records, team rankings) is stored one doc per school level at `<collection>/{level}` where `level` is `'elementary' | 'highSchool' | 'college'`, with the actual list nested inside (e.g. `matchSchedules/{level}.matches`). Nearly every page/admin screen is scoped by this level and lets the user switch between the three.
- List-valued docs are read-modify-written wholesale (read the array, splice/map/filter, `setDoc(..., { merge: true })`) rather than using Firestore array operators — see `upsertMatchSchedule`, `deleteMatchRecord`, etc. Follow this pattern for new list fields on the same docs.
- `registrations` is staff-only (contains addresses/emergency contacts) so the public landing page can't query it for counts. Public-safe aggregates are mirrored into `siteCounters/liveCounters` instead (`bumpEventRegistrationCount` on submit, `setEventRegistrationCounts`/`setLivePlayerCount` as an admin-triggered reconcile). When adding a new publicly-visible number derived from a staff-only collection, follow this same mirror-to-a-public-doc pattern rather than loosening Firestore rules.
- `EVENT_TYPES` in this file is the single source of truth for the Intramurals/Sportsfest/Prisaa event list — `RegistrationPage` and `AdminSchedulePage` both derive their dropdowns/filters from it.

**Reset script** (`reset-sports-schedules.cjs`): a standalone Node/`firebase-admin` script (not part of the Vite app) for wiping sports/teams config, match schedules, and all registrations between events/seasons. Requires a `serviceAccountKey.json` (gitignored, never commit it) in the repo root. Defaults to a dry run; pass `--yes` to actually write. Does not touch `users` or the staff allowlist collections.

**Page/role map**: `DashboardPage`, `ProfilePage`, `RegistrationPage`, `TeamAndSportsPage`, `MatchSchedulesPage`, `RankingPage` are open to any authenticated user. `AdminSchedulePage` (`/admin`, aliased `/schedule-admin`) requires `admin`/`superadmin` and is the real registrations/sports/schedules management console — treat it as the admin home, not a stub. `ModeratorPage` (match record entry) requires `moderator`/`superadmin`. `SuperAdminPage` (analytics) requires `superadmin` only.

## Known CSS gotchas

- **Never put `border-radius` and `overflow-y: auto` (a scrollbar) on the same element**, e.g. a modal/dialog container. When content overflows, the scrollbar track renders flush against the straight edge of the box and visually squares off that corner, even though `border-radius` is still set. This happened in `.asp-modal` in `AdminSchedulePage.css` (Student Details modal): the outer `.asp-modal` had both `border-radius: 12px` and `overflow-y: auto`, so its top-right/bottom-right corners looked unrounded whenever the content was tall enough to scroll.
  - Fix pattern: keep `border-radius` + `overflow: hidden` on the outer container, make it a flex column, keep the header `flex-shrink: 0`, and put `overflow-y: auto` only on an inner content wrapper (e.g. `.asp-modal__body`) that has no border-radius of its own. This keeps the rounded corners intact and also keeps the header pinned while the body scrolls.
  - Apply this same split (rounded/clipped outer shell + separately-scrolling inner body) to any future modal, card, or panel that can grow taller than its container. This same fix was later applied to `.mp-request-modal`/`.mp-request-modal__body` in `ModeratorPage.css` (Request a Schedule modal).

- **A `position: absolute` close button needs its modal container to be `position: relative`, or it escapes to the nearest positioned ancestor instead** — which in this codebase is `.mp-modal-overlay` (`position: fixed`, covering the whole viewport). `.mp-format-close`/`.mp-modal-close-x` are reused across many modals in `ModeratorPage.jsx`, but only modifier classes like `.mp-format-modal` and `.mp-modal--wide` used to set `position: relative` — a modal that only added `.mp-modal` (e.g. the Request a Schedule modal) had its × button jump to the top of the browser viewport instead of the modal's own corner. Fixed by adding `position: relative` to the base `.mp-modal` class itself so every modal gets it regardless of which modifier class it uses.

- **A `backdrop-filter: blur(...)` glass panel with a thin, mostly-white tint (e.g. `rgba(255,255,255,0.1)`) reads fine over a solid dark background, but becomes unreadable wherever it overlaps lighter content it scrolls over.** `.dash-sport-filter__panel` (DashboardPage.css, the Dashboard header's Sport filter dropdown) is `position: absolute` and opens downward over the page body, which on mobile can include the white "Upcoming Matches" card directly beneath the header. The panel's blur just blurs that white card through the thin tint, and the ~75%-opacity white option text washes out to near-invisible against it — confirmed on an actual device (Chrome/Android), so this isn't a `-webkit-backdrop-filter` prefix gap (that's added too, for Safari/iOS, but wasn't the cause here). Fixed by making the panel's own background opaque enough to dominate regardless of what's behind it (`rgba(4, 18, 34, 0.92)`, matching the dashboard's dark navy) rather than relying on a light, near-transparent tint. Any `position: absolute`/`fixed` glass panel that can open over content of varying brightness should use an opaque-enough background of its own, not just a thin tint plus blur.
