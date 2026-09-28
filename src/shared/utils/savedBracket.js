import { bracketSlotsFor } from '../services/firestoreService';

/* Saved double-bracket fixtures start out with generator placeholders
   ("Winner SF1", "Loser UB-SF2", "Winner LB1") in the slots whose teams come
   from earlier matches. The bracket trees on the Admin and Match Schedules
   pages connect their boxes BY those placeholder names — so once a result
   fills a slot with a real team (advanceBracketWinner in firestoreService),
   the tree lost the link: it drew a line from the team's first-round box
   instead, and the result box kept saying "Winner of Match 1".

   A filled slot remembers where its team came from (teamAFrom/teamBFrom:
   { matchId, result }), so the original placeholder can be rebuilt from
   that — the same text advanceBracketWinner replaced (bracketSlotsFor's
   first entry is exactly what the generator wrote). */

/* The structural reference for one slot: its original placeholder when it
   was filled from an earlier match, otherwise the slot's own value (a real
   first-round team, or a still-unfilled placeholder). */
export function savedSlotRef(match, side, byId) {
  const from = match[`team${side}From`];
  const source = from ? byId.get(from.matchId) : null;
  if (source) {
    const ref = bracketSlotsFor(source)[from.result === 'loser' ? 'loser' : 'winner'][0];
    if (ref) return ref;
  }
  return match[`team${side}`];
}

/* placeholder text → the real team now holding that slot, across a saved
   bracket — lets a tree show "GREEN SULTAN" wherever it would draw
   "Winner of Match 1". */
export function savedBracketResolved(matches) {
  const byId = new Map((matches || []).map((m) => [m.id, m]));
  const resolved = {};
  (matches || []).forEach((m) => {
    ['A', 'B'].forEach((side) => {
      const from = m[`team${side}From`];
      const source = from ? byId.get(from.matchId) : null;
      const name = m[`team${side}`];
      if (!source || !name) return;
      const result = from.result === 'loser' ? 'loser' : 'winner';
      // Every name that slot goes by: the stored placeholder(s), plus the
      // tree's own key for a winner ("Winner Finals" for the UB final, whose
      // stored placeholder is "Winner UB-F").
      const aliases = [...bracketSlotsFor(source)[result]];
      if (result === 'winner') aliases.push(`Winner ${String(source.matchLabel || '').replace(/^UB-/, '')}`);
      aliases.forEach((alias) => { if (alias !== name) resolved[alias] = name; });
    });
  });
  return resolved;
}
