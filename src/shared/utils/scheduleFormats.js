/* Schedule generators for the five Match Schedules formats — moved here
   unchanged from AdminSchedulePage.jsx so the whole format pipeline
   (generate → save → record → advance → champion) can be tested end to end
   (scheduleFormats.test.js). AdminSchedulePage imports them from here. */

import { buildRaceFields, RACE_FORMAT_ID } from './raceFormat';

/* ═══════════════════════════════════════════
   ROUND-ROBIN GENERATOR
   Circle method: fixes team[0], rotates the rest each round
   so every team plays every other team exactly once (twice for
   double round-robin). An odd team count gets a bye each round.
═══════════════════════════════════════════ */
export function generateRounds(teamNames, doubleLegged) {
  let arr = [...teamNames];
  const hasBye = arr.length % 2 !== 0;
  if (hasBye) arr.push('BYE');
  const n = arr.length;
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== 'BYE' && b !== 'BYE') pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }

  if (doubleLegged) {
    const reverseLegs = rounds.map(pairs => pairs.map(([a, b]) => [b, a]));
    return [...rounds, ...reverseLegs];
  }
  return rounds;
}

/* ═══════════════════════════════════════════
   SINGLE BRACKET (elimination) GENERATOR
   Pads the field to the next power of two with byes, pairs teams
   sequentially, then each later round references the previous
   round's winner as a placeholder ("Winner QF1") — except a bye
   match, which auto-advances a known team instead of a placeholder.
   Every bracket needs exactly teams.length - 1 matches to crown
   one champion, regardless of how many byes are involved.
═══════════════════════════════════════════ */
export function stageNamesFor(totalRounds) {
  const tail = ['Finals'];
  if (totalRounds >= 2) tail.unshift('Semifinals');
  if (totalRounds >= 3) tail.unshift('Quarterfinals');
  for (let extra = totalRounds - 3; extra >= 1; extra--) {
    tail.unshift(`Round of ${Math.pow(2, extra + 3)}`);
  }
  return tail;
}
export function stageCodeFor(name) {
  if (name === 'Finals') return 'F';
  if (name === 'Semifinals') return 'SF';
  if (name === 'Quarterfinals') return 'QF';
  const m = name.match(/Round of (\d+)/);
  return m ? `R${m[1]}` : 'M';
}

export function generateBracket(teamNames) {
  const n = teamNames.length;
  if (n < 2) return { stages: [], totalMatches: 0, leaves: [] };
  const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
  const padded = [...teamNames];
  while (padded.length < bracketSize) padded.push(null); // null = bye slot

  const totalRounds = Math.log2(bracketSize);
  const names = stageNamesFor(totalRounds);

  let currentEntries = [];
  for (let i = 0; i < padded.length; i += 2) {
    currentEntries.push({ a: padded[i], b: padded[i + 1] });
  }

  const stages = [];
  for (let r = 0; r < totalRounds; r++) {
    const stageName = names[r];
    const code = stageCodeFor(stageName);
    const matches = currentEntries.map((m, i) => ({
      label: stageName === 'Finals' && totalRounds === r + 1 ? 'Finals' : `${code}${i + 1}`,
      a: m.a,
      b: m.b,
      isBye: m.a === null || m.b === null,
    }));
    stages.push({ name: stageName, matches });

    const next = [];
    for (let i = 0; i < matches.length; i += 2) {
      const m1 = matches[i];
      const m2 = matches[i + 1];
      if (!m2) break;
      const advance = (m) => (m.isBye ? (m.a ?? m.b) : `Winner ${m.label}`);
      next.push({ a: advance(m1), b: advance(m2) });
    }
    currentEntries = next;
  }

  return { stages, totalMatches: n - 1, leaves: padded };
}

/* ═══════════════════════════════════════════
   DOUBLE BRACKET (double elimination) GENERATOR
   Reuses the single-elim generator for the Upper (Winner's) Bracket.

   Lower (Loser's) Bracket format — verified match-for-match against a
   real published double-elim bracket (MLBB M7 Worlds, 8-team knockout
   stage): Round 1 pairs the Upper Bracket's round-1 losers against each
   other (Match 7/8 there). Every later Upper Bracket round's fresh
   losers are IMMEDIATELY cross-paired against the Lower Bracket's
   current survivors — one slot rotated over (Match 10 there pairs
   "Loser of Match 6" against "Winner of Match 7", not "Winner of Match
   5" — the group whose own bracket didn't just eliminate them), so
   nobody instantly replays the team that just knocked them down a
   bracket. That drop-in round's winners then play each other in a
   consolidation round (Match 12 there) to halve the Lower Bracket field
   again. The Lower Bracket's last survivor meets the Upper Bracket
   Final's loser one last time (the actual "Losers Final" / Match 13),
   and that winner meets the Upper Bracket champion in the Grand Final.
   Standard tournament rule: if the Lower Bracket team wins the Grand
   Final, the Upper Bracket team only has ONE loss so far (double
   elimination requires two) — a single reset match is then needed to
   decide the real champion. That's why the total is "N (up to N+1)".
═══════════════════════════════════════════ */
export function generateDoubleBracket(teamNames) {
  const wb = generateBracket(teamNames);
  if (!wb.stages.length) {
    return { wbStages: [], leaves: [], lbRounds: [], grandFinal: null, ubMatchCount: 0, lbMatchCount: 0, totalMatches: 0 };
  }

  const wbStages = wb.stages;
  const R = wbStages.length;

  const wbLoserLabel = (stageIdx, matchIdx) => {
    const isFinal = stageIdx === R - 1;
    const code = isFinal ? 'F' : stageCodeFor(wbStages[stageIdx].name);
    return isFinal ? 'Loser UB-F' : `Loser UB-${code}${matchIdx + 1}`;
  };

  const lbRounds = [];
  let lbCounter = 1;

  // LB Round 1 — sequential pairs of Upper Bracket round-1 losers,
  // skipping byes (a bye auto-advances — no real loser to place here).
  const r1Losers = wbStages[0].matches
    .map((m, i) => (m.isBye ? null : wbLoserLabel(0, i)))
    .filter(Boolean);
  const round1 = [];
  for (let i = 0; i < r1Losers.length; i += 2) {
    round1.push({ label: `LB${lbCounter++}`, a: r1Losers[i], b: r1Losers[i + 1] ?? null });
  }
  if (round1.length) lbRounds.push({ name: 'Round 1', matches: round1 });
  let currentWinners = round1.length
    ? round1.map(m => (m.b ? `Winner ${m.label}` : m.a)) // an unpaired leftover just carries forward as itself
    : r1Losers; // degenerate: fewer than 2 real round-1 losers (heavy byes)

  for (let wr = 1; wr < R; wr++) {
    const isLastWBRound = wr === R - 1;
    // Skip byes here too — heavy padding (e.g. 10 teams into a 16-slot
    // bracket) can leave a bye this deep, and a bye has no real loser.
    const wbLosers = wbStages[wr].matches
      .map((m, i) => (m.isBye ? null : wbLoserLabel(wr, i)))
      .filter(Boolean);

    if (isLastWBRound) {
      lbRounds.push({ name: 'Losers Final', matches: [{ label: 'LB-F', a: currentWinners[0], b: wbLosers[0] }] });
      currentWinners = ['Winner LB-F'];
    } else {
      // Cross-pair each Lower Bracket survivor against a DIFFERENT
      // Upper Bracket loser than the one from their own group's round
      // (rotated one slot over), so nobody instantly replays the team
      // that just eliminated them. The two groups are normally the same
      // size, but heavy byes can leave an odd leftover on either side —
      // anything that doesn't get a drop-in match this round just joins
      // the consolidation pool below instead of being silently dropped.
      const pairCount = Math.min(currentWinners.length, wbLosers.length);
      const dropIn = [];
      for (let i = 0; i < pairCount; i++) {
        dropIn.push({ label: `LB${lbCounter++}`, a: currentWinners[i], b: wbLosers[(i + 1) % pairCount] });
      }
      lbRounds.push({ name: `Round ${lbRounds.length + 1}`, matches: dropIn });
      let pool = dropIn.map(m => `Winner ${m.label}`)
        .concat(currentWinners.slice(pairCount), wbLosers.slice(pairCount));

      if (pool.length > 1) {
        const consolidation = [];
        const survivors = [];
        for (let i = 0; i < pool.length; i += 2) {
          if (i + 1 >= pool.length) { survivors.push(pool[i]); continue; }
          const label = `LB${lbCounter++}`;
          consolidation.push({ label, a: pool[i], b: pool[i + 1] });
          survivors.push(`Winner ${label}`);
        }
        lbRounds.push({ name: `Round ${lbRounds.length + 1}`, matches: consolidation });
        currentWinners = survivors;
      } else {
        currentWinners = pool;
      }
    }
  }

  const grandFinal = { label: 'GF', a: 'Winner UB-F', b: currentWinners[0] };
  const ubMatchCount = wbStages.reduce((s, st) => s + st.matches.filter(m => !m.isBye).length, 0);
  // Only real games: a lone team with no lower-bracket opponent (b: null)
  // just carries forward — it's never saved as a fixture (buildScheduleMatches
  // drops it), so counting it over-stated the total (3 teams showed 5, saved 4).
  const lbMatchCount = lbRounds.reduce((s, r) => s + r.matches.filter(m => m.a && m.b).length, 0);

  return {
    wbStages,
    leaves: wb.leaves,
    lbRounds,
    grandFinal,
    ubMatchCount,
    lbMatchCount,
    totalMatches: ubMatchCount + lbMatchCount + 1, // Grand Final; a reset match is the "+1 if necessary"
  };
}


/* The fixtures a format saves — what the admin's "Save Generated Schedule"
   writes to matchSchedules/{level} (before auto date/time assignment).
   `formatId` is the Match Schedules Format id: 'single-rr', 'double-rr',
   'bracket', 'double-bracket' or RACE_FORMAT_ID. `buildMatch` adds the
   per-fixture fields (id, sport, category, logos, …) around each `extra`. */
export function buildScheduleMatches(formatId, teams, buildMatch) {
  const names = teams.map(t => t.name);

  if (formatId === RACE_FORMAT_ID) {
    // One fixture for the whole field. No `stage`: every bracket helper
    // keys off it, so leaving it unset keeps a race from being read as one.
    return [buildMatch(buildRaceFields(teams))];
  }

  if (formatId === 'bracket') {
    const bracket = generateBracket(names);
    return bracket.stages.flatMap((stage, stageIdx) =>
      stage.matches
        .filter(m => !m.isBye) // a bye has no actual game — the team just advances
        .map(m => buildMatch({ round: stageIdx + 1, stage: stage.name, matchLabel: m.label, teamA: m.a, teamB: m.b }))
    );
  }

  if (formatId === 'double-bracket') {
    const doubleBracket = generateDoubleBracket(names);
    if (!doubleBracket.grandFinal) return [];
    const ubMatches = doubleBracket.wbStages.flatMap((stage, stageIdx) =>
      stage.matches
        .filter(m => !m.isBye)
        .map(m => buildMatch({ round: stageIdx + 1, stage: `Upper Bracket – ${stage.name}`, matchLabel: `UB-${m.label}`, teamA: m.a, teamB: m.b }))
    );
    const lbMatches = doubleBracket.lbRounds.flatMap((round, roundIdx) =>
      round.matches
        .filter(m => m.a && m.b) // drop any bye slot that slipped through
        .map(m => buildMatch({ round: roundIdx + 1, stage: `Lower Bracket – ${round.name}`, matchLabel: m.label, teamA: m.a, teamB: m.b }))
    );
    const gfMatch = buildMatch({
      round: null,
      stage: 'Grand Final',
      matchLabel: doubleBracket.grandFinal.label,
      teamA: doubleBracket.grandFinal.a,
      teamB: doubleBracket.grandFinal.b,
    });
    return [...ubMatches, ...lbMatches, gfMatch];
  }

  // Round-robin ('single-rr') or double round-robin ('double-rr').
  return generateRounds(names, formatId === 'double-rr').flatMap((pairs, roundIdx) =>
    pairs.map(([a, b]) => buildMatch({ round: roundIdx + 1, teamA: a, teamB: b }))
  );
}

/* The ONE match that decides a bracket's champion: the Grand Final of a
   double bracket, or the last round of a single bracket. null for a
   round-robin/race set, or when that match can't be pinned down. (Any stage
   merely containing "final" is NOT enough — "Semifinals", "Upper Bracket –
   Finals" and "Losers Final" all contain it.) */
export function decidingMatch(matches) {
  if (!matches?.length) return null;
  const isDouble = matches.some(m => (m.stage || '').startsWith('Upper Bracket'));
  const isSingle = !isDouble && matches.every(m => m.stage
    && !m.stage.startsWith('Lower Bracket') && m.stage !== 'Grand Final');
  let candidates;
  if (isDouble) {
    candidates = matches.filter(m => m.stage === 'Grand Final');
  } else if (isSingle) {
    const maxRound = Math.max(...matches.map(m => (m.round != null ? m.round : -1)));
    candidates = maxRound >= 0 ? matches.filter(m => m.round === maxRound) : [];
  } else {
    return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/* Round-robin champion: nobody until EVERY game has a result, then the team
   with the most wins. Level on wins for first place → null (TBA) — point
   difference only orders the rest, it doesn't crown anyone. `winnerOf`
   reads a record's winner name (null for a draw). */
export function roundRobinLeader(matches, resultFor, winnerOf) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  const standings = new Map(); // norm(name) -> { name, wins, diff }
  const row = (name) => {
    const k = norm(name);
    if (!standings.has(k)) standings.set(k, { name, wins: 0, diff: 0 });
    return standings.get(k);
  };
  for (const match of matches) {
    const record = resultFor(match);
    if (!record) return null; // a game is still unplayed
    row(match.teamA); row(match.teamB);
    const winner = winnerOf(record);
    if (winner) row(winner).wins += 1;
    const a = record.teamA, b = record.teamB;
    if (a?.points != null && b?.points != null) {
      row(a.name).diff += a.points - b.points;
      row(b.name).diff += b.points - a.points;
    }
  }
  const ranked = [...standings.values()].sort((x, y) => y.wins - x.wins || y.diff - x.diff);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[0].wins === ranked[1].wins) return null;
  return ranked[0].name;
}
