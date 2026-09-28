/* When a scheduled match starts and ends — the one rule every page uses
   (Dashboard, Moderator, Landing, Super Admin analytics), so an extension a
   moderator adds keeps the match "ongoing" everywhere at once.

   A match is assumed to run ASSUMED_MATCH_MINUTES from its scheduled
   date + time; `extraMinutes` on the saved fixture (added with the
   moderator's "+ time" button, see extendMatchSchedule) pushes the end
   later. */

export const ASSUMED_MATCH_MINUTES = 120;
export const EXTEND_STEP_MINUTES = 15;

export function matchStart(match) {
  if (!match?.date || !match?.time) return null;
  const start = new Date(`${match.date}T${match.time}`);
  return Number.isNaN(start.getTime()) ? null : start;
}

export function matchDurationMinutes(match) {
  const extra = Number(match?.extraMinutes) || 0;
  return ASSUMED_MATCH_MINUTES + Math.max(0, extra);
}

export function matchEnd(match) {
  const start = matchStart(match);
  return start ? new Date(start.getTime() + matchDurationMinutes(match) * 60000) : null;
}

const norm = (v) => String(v || '').trim().toLowerCase();

/* True when a moderator result already exists for this fixture — exact by
   scheduleId, else (older records) same sport with both teams in it. */
export function scheduleHasRecord(schedule, records) {
  return (records || []).some((r) => {
    if (!r) return false;
    if (r.scheduleId) return String(r.scheduleId) === String(schedule.id);
    if (norm(r.sportName) !== norm(schedule.sport)) return false;
    const names = (r.participants?.length ? r.participants : [r.teamA, r.teamB]).map((p) => norm(p?.name));
    return names.includes(norm(schedule.teamA)) && names.includes(norm(schedule.teamB));
  });
}

/* "Ongoing" everywhere means: inside its time window (incl. added time),
   not marked finished by the moderator, and no result recorded yet — a
   match that's already been scored is over even if its slot hasn't ended. */
export function isMatchLive(match, records, now = Date.now()) {
  if (!match || match.finished) return false;
  const start = matchStart(match);
  if (!start || now < start.getTime() || now >= matchEnd(match).getTime()) return false;
  return !scheduleHasRecord(match, records);
}

/* "1:05:09" / "45:03" / "0:09" — time left until `end`, never negative. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
