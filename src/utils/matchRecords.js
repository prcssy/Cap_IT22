/* ─────────────────────────────────────────────
   Shared matching between a scheduled fixture (matchSchedules/{level})
   and a saved result (matchRecords/{level}) — used by both DashboardPage
   and the landing page's "Ongoing Matches" card so a match's finished/
   ongoing status reads the same everywhere.
───────────────────────────────────────────── */

export function norm(value) {
  return (value || '').trim().toLowerCase();
}

/* Categories used to be saved as values such as "MEN 5v5". Display code
   shows the sport and division, not the child match format. */
export function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

export function sameTeam(a, b) {
  return !!a && !!b && norm(a) === norm(b);
}

export function recordIdentity(record) {
  if (record?.id) return `id:${record.id}`;
  const participants = record?.participants?.length ? record.participants : [record?.teamA, record?.teamB];
  const teams = participants.map(p => norm(p?.name)).filter(Boolean).sort().join('|');
  return [norm(record?.sportName), norm(record?.category), teams].join('::');
}

/* New Moderator records store scheduleId, making the schedule fixture the
   source of truth. The team fallback keeps older records readable. */
export function recordMatchesSchedule(record, schedule) {
  if (!record || !schedule) return false;
  if (record.scheduleId) return String(record.scheduleId) === String(schedule.id);
  if (norm(record.sportName) !== norm(schedule.sport)) return false;
  const recordCategory = norm(displayCategory(record.category));
  const scheduleCategory = norm(displayCategory(schedule.category));
  if (recordCategory && scheduleCategory && recordCategory !== scheduleCategory
      && !recordCategory.endsWith(` ${scheduleCategory}`)
      && !scheduleCategory.endsWith(` ${recordCategory}`)) return false;
  const participants = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const names = participants.map(p => p?.name).filter(Boolean);
  return names.length >= 2
    && names.some(name => sameTeam(name, schedule.teamA))
    && names.some(name => sameTeam(name, schedule.teamB));
}

/* Walks the schedule list in order, attaching at most one Moderator record
   to each fixture (so one saved record can't be reused for several
   schedule rows), and returns { recordByScheduleId, recordedIds } —
   `recordedIds` is a Set of schedule ids that already have a result. */
export function resolveScheduleRecords(schedules, records) {
  const uniqueRecords = Array.from(
    new Map((records || []).map(record => [recordIdentity(record), record])).values(),
  );
  const usedRecordKeys = new Set();
  const recordByScheduleId = new Map();
  (schedules || []).forEach((schedule) => {
    const record = uniqueRecords.find(candidate => {
      const key = recordIdentity(candidate);
      return !usedRecordKeys.has(key) && recordMatchesSchedule(candidate, schedule);
    });
    if (!record) return;
    usedRecordKeys.add(recordIdentity(record));
    recordByScheduleId.set(schedule.id, record);
  });
  return { recordByScheduleId, recordedIds: new Set(recordByScheduleId.keys()) };
}
