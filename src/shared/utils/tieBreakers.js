/* ── Shared Elo/medal tie-break helpers ──
   Used by RankingPage's Potential Champion / Medal Tally tables and by the
   public Landing page's Potential Champion spotlight (scoped to "All
   Sports"/"All Divisions" there, since that spotlight isn't split by
   sport), so a team that wins a tie by head-to-head result or point
   differential is ranked #1 consistently on both pages instead of the
   landing page falling back to array order.

   Rule set (mirrors RankingPage.jsx's original "Elo tie-breaker system"):
     - exactly 2 items tied -> most recent head-to-head result
     - 3+ items tied         -> head-to-head point differential among the
                                 tied items only, then total points scored
                                 among them, then head-to-head
   Falls back to name when there's no decided meeting between the tied
   items, so the order stays stable even with no match history. */

function norm(str) {
  return (str || '').trim().toLowerCase();
}

/* Tolerant match for divisions saved before the group-label prefix
   existed (a bare old "5v5" is treated as matching "MEN 5v5" etc). */
function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}
function categoriesMatch(a, b) {
  const x = norm(displayCategory(a)), y = norm(displayCategory(b));
  if (x === y) return true;
  if (!x || !y) return false;
  return x.endsWith(` ${y}`) || y.endsWith(` ${x}`);
}

function matchWinnerName(record) {
  if (!record || record.draw || record.winner === 'DRAW') return null;
  if (record.winner === 'A') return record.teamA?.name || null;
  if (record.winner === 'B') return record.teamB?.name || null;
  return null;
}

function recordTimestamp(record) {
  return record?.updatedAt || record?.createdAt || 0;
}

/* 1-vs-1 matches between exactly two given team names, scoped to the given
   sport/division filter. 1-vs-many events are excluded: there's no A/B
   score to diff or a two-way winner. */
function headToHeadMatches(records, sportFilter, divisionFilter, nameA, nameB) {
  return (records || []).filter((r) => {
    if (r.participants?.length) return false;
    if (sportFilter !== 'All Sports' && norm(r.sportName) !== norm(sportFilter)) return false;
    if (divisionFilter !== 'All Divisions' && !categoriesMatch(r.category, divisionFilter)) return false;
    const names = [norm(r.teamA?.name), norm(r.teamB?.name)];
    return names.includes(norm(nameA)) && names.includes(norm(nameB));
  });
}

/* Winner of the single most recently completed head-to-head match between
   two teams, or null if they've never met (or every meeting was a draw). */
function mostRecentHeadToHeadWinner(records, sportFilter, divisionFilter, nameA, nameB) {
  const decided = headToHeadMatches(records, sportFilter, divisionFilter, nameA, nameB)
    .filter((r) => matchWinnerName(r));
  if (!decided.length) return null;
  const latest = decided.reduce((a, b) => (recordTimestamp(b) > recordTimestamp(a) ? b : a));
  return matchWinnerName(latest);
}

/* Sum of (points scored - points against) and total points scored, across
   every 1-vs-1 points-scored match `teamName` played against the OTHER
   teams in `tiedNames` — never against teams outside the tied group, and
   never counting time-based matches (no score to diff there). */
function pointDifferentialAmongTied(records, sportFilter, divisionFilter, teamName, tiedNames) {
  let differential = 0;
  let pointsScored = 0;
  (records || []).forEach((r) => {
    if (r.participants?.length) return;
    if (sportFilter !== 'All Sports' && norm(r.sportName) !== norm(sportFilter)) return;
    if (divisionFilter !== 'All Divisions' && !categoriesMatch(r.category, divisionFilter)) return;
    const isA = norm(r.teamA?.name) === norm(teamName);
    const isB = norm(r.teamB?.name) === norm(teamName);
    if (!isA && !isB) return;
    const opponent = isA ? r.teamB : r.teamA;
    if (!opponent?.name || !tiedNames.has(norm(opponent.name))) return;
    const own = isA ? r.teamA?.points : r.teamB?.points;
    const against = isA ? r.teamB?.points : r.teamA?.points;
    if (typeof own !== 'number' || typeof against !== 'number') return;
    differential += (own - against);
    pointsScored += own;
  });
  return { differential, pointsScored };
}

/* Reorders each run of items that share the exact same rank (as decided by
   `isSameRank`) according to the rules above; items not tied are left
   exactly where the incoming sort put them. `sortedDesc` only needs to
   already be grouped by rank (descending) — the order within each tied run
   is decided here, not by the caller. Every item needs a `.team` (team
   name) field. */
export function applyPointDifferentialTieBreakers(sortedDesc, records, sportFilter, divisionFilter, isSameRank) {
  const result = [];
  let i = 0;
  while (i < sortedDesc.length) {
    let j = i + 1;
    while (j < sortedDesc.length && isSameRank(sortedDesc[j], sortedDesc[i])) j++;
    const group = sortedDesc.slice(i, j);

    if (group.length === 2) {
      const [a, b] = group;
      const winner = mostRecentHeadToHeadWinner(records, sportFilter, divisionFilter, a.team, b.team);
      // No decided meeting between them -> leave as-is (falls back to
      // whatever the incoming sort already decided).
      result.push(...(winner && norm(winner) === norm(b.team) ? [b, a] : [a, b]));
    } else if (group.length >= 3) {
      const tiedNames = new Set(group.map((t) => norm(t.team)));
      const withTieStats = group.map((t) => ({
        team: t,
        ...pointDifferentialAmongTied(records, sportFilter, divisionFilter, t.team, tiedNames),
      }));
      withTieStats.sort((x, y) => {
        if (y.differential !== x.differential) return y.differential - x.differential;
        if (y.pointsScored !== x.pointsScored) return y.pointsScored - x.pointsScored;
        const h2h = mostRecentHeadToHeadWinner(records, sportFilter, divisionFilter, x.team.team, y.team.team);
        if (h2h && norm(h2h) === norm(x.team.team)) return -1;
        if (h2h && norm(h2h) === norm(y.team.team)) return 1;
        return x.team.team.localeCompare(y.team.team);
      });
      result.push(...withTieStats.map((s) => s.team));
    } else {
      result.push(...group);
    }
    i = j;
  }
  return result;
}
