/* Single-Race format: every team competes in ONE event (swimming heat,
   track race, …) and the winner is the champion.

   A race is saved as a single match in matchSchedules/{level}.matches:
     { …usual match fields, format: 'Single-Race Format', race: true,
       participants: [{ name, logo }, …],
       teamA / teamB (+ logos) = the first two participants }
   teamA/teamB are kept only so code that predates races (and filters on
   "has both teams") still treats it as a real fixture. It has no `stage`
   on purpose — every bracket helper keys off `stage`, so a race is never
   mistaken for a bracket. Pure functions only (no Firebase/React). */

export const RACE_FORMAT_ID = 'single-race';
export const RACE_FORMAT_LABEL = 'Single-Race Format';

const norm = (v) => String(v ?? '').trim().toLowerCase();

export function isRaceMatch(match) {
  return !!match
    && (match.race === true || match.format === RACE_FORMAT_LABEL)
    && Array.isArray(match.participants)
    && match.participants.filter((p) => p && p.name).length >= 2;
}

/* Every team in the fixture, in lane order. A plain 2-team match yields
   its two teams, so callers don't need to special-case it. */
export function raceParticipants(match) {
  if (isRaceMatch(match)) return match.participants.filter((p) => p && p.name);
  return [
    { name: match?.teamA, logo: match?.teamALogo || null },
    { name: match?.teamB, logo: match?.teamBLogo || null },
  ].filter((p) => p.name);
}

/* Fields to spread into a freshly generated match for a race between `teams`
   ({ name, logo }). */
export function buildRaceFields(teams) {
  const field = teams.filter((t) => t && t.name).map((t) => ({ name: t.name, logo: t.logo || null }));
  return {
    race: true,
    participants: field,
    round: 1,
    teamA: field[0]?.name || '',
    teamB: field[1]?.name || '',
  };
}

/* "5 teams" / "2 teams" */
export function raceTeamCount(match) {
  return raceParticipants(match).length;
}

/* Minutes (float, as the moderator stores time results) → "m:ss" / "h:mm:ss". */
export function formatRaceTime(minutes) {
  if (minutes == null || minutes === '' || Number.isNaN(Number(minutes))) return null;
  const totalSeconds = Math.round(Number(minutes) * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

/* A saved moderator record → finishing order for the race diagram/results
   table: [{ name, logo, place, scoreLabel }] sorted best first. Records with
   3+ teams carry `participants` with a saved `place`; a 2-team result only
   has teamA/teamB plus a winner flag. Returns [] when there's no record. */
export function raceStandingsFromRecord(record) {
  if (!record) return [];
  const scoreOf = (p) => {
    if (p?.points != null) return `${p.points} pts`;
    return formatRaceTime(p?.minutes);
  };

  if (record.participants?.length > 2) {
    return [...record.participants]
      .map((p) => ({ name: p.name, logo: p.logo || null, place: p.place || null, scoreLabel: scoreOf(p) }))
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  }

  const pair = [record.teamA, record.teamB].filter(Boolean);
  const draw = record.draw || record.winner === 'DRAW';
  return pair
    .map((p, i) => ({
      name: p.name,
      logo: p.logo || null,
      place: draw ? 1 : (record.winner === 'A') === (i === 0) ? 1 : 2,
      scoreLabel: scoreOf(p),
    }))
    .sort((a, b) => a.place - b.place);
}

/* Name of the race winner, or null while there's no result or on a tie for
   first (a tie is left for the moderator to break, same as everywhere else). */
export function raceWinnerName(record) {
  const standings = raceStandingsFromRecord(record);
  const first = standings.filter((s) => s.place === 1);
  return first.length === 1 ? first[0].name || null : null;
}

/* Does this saved record belong to this race fixture? Exact scheduleId wins;
   older/loose records fall back to "every participant appears in the roster". */
export function recordCoversRace(record, match) {
  if (!record || !match) return false;
  if (record.scheduleId) return String(record.scheduleId) === String(match.id);
  const roster = (record.participants?.length ? record.participants : [record.teamA, record.teamB])
    .map((p) => norm(p?.name)).filter(Boolean);
  return raceParticipants(match).every((p) => roster.includes(norm(p.name)));
}
