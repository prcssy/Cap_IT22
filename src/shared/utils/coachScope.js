/* ─────────────────────────────────────────────
   What a coach handles: coaches/{email}.teams + .sports + .divisions.

   `divisions` narrows a coach to some categories/divisions of their sports.
   Each entry is a key scoped to its sport, so a coach's picks for one sport
   never affect another:
     "<sport>::d:<divisionId>"  — a real division (e.g. Archery › Women › 30 Meters)
     "<sport>::c:<category>"    — a category with no divisions of its own (e.g. Chess › Men)
   An empty list = every category/division of the coach's sports, and a
   sport with no keys in the list is likewise handled in full — so coaches
   saved before divisions existed keep handling exactly what they did.
───────────────────────────────────────────── */
import { sportCategoryOptions } from './sportCategory';

const norm = (v) => String(v || '').trim().toLowerCase();
const prefix = (sportName) => `${norm(sportName)}::`;

/** Checkbox options for one sport's categories/divisions: [{ key, label }]. */
export function coachDivisionOptions(sport) {
  if (!sport) return [];
  const p = prefix(sport.name);
  return sportCategoryOptions(sport).flatMap((g) => (g.divisions.length
    ? g.divisions.map((d) => ({ key: `${p}d:${d.id}`, label: `${g.label} · ${d.name}` }))
    : [{ key: `${p}c:${norm(g.label)}`, label: g.label }]));
}

/** Does this coach handle this registration's team, sport and division? */
export function coachHandles(coach, reg) {
  if (!coach || !reg) return false;
  if (!(coach.teams || []).includes(reg.teamName)) return false;
  const sports = coach.sports || [];
  if (sports.length && !sports.includes(reg.sport)) return false;
  const p = prefix(reg.sport);
  const keys = (coach.divisions || []).filter((k) => k.startsWith(p));
  if (keys.length === 0) return true; // whole sport
  if (reg.divisionId) return keys.includes(`${p}d:${reg.divisionId}`);
  if (reg.category) return keys.includes(`${p}c:${norm(reg.category)}`);
  return true; // older registration with no category recorded
}
