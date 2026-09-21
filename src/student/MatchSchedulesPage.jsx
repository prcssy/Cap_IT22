import React, { useState, useEffect, useMemo, useContext } from 'react';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import './MatchSchedulesPage.css';
// Double Bracket tree (.msf-dbracket*/.msf-bracket-*/.msf-lbracket-leaf*) reuses
// the admin Schedule Manager's classes unchanged, so it renders identically here.
import '../admin/AdminSchedulePage.css';
import Contact from '../public/Landing/Contact/Contact';
import { FaSearch, FaTrophy } from 'react-icons/fa';
import { getMatchSchedules, getMatchRecords, getTeamRankings } from '../shared/services/firestoreService';
import LevelTabs from '../shared/components/LevelTabs';
import { useLockedLevel } from '../shared/utils/schoolLevel';

/* ═══════════════════════════════════════════════════════════
   This page is fully data-driven: every match shown here comes
   from what an admin actually saved in the Schedule Manager
   (matchSchedules/{level} in Firestore). If the admin hasn't
   generated or added anything yet, nothing renders except an
   empty-state message — no placeholder/sample data.
   ═══════════════════════════════════════════════════════════ */

/* ── Deterministic color per team name, so the same team always
   gets the same avatar color even without a saved logo ── */
const PALETTE = ['#c0392b', '#8d6e63', '#f1c40f', '#27ae60', '#8e44ad', '#e67e22', '#800000', '#2c3e50', '#2980b9', '#16a085'];
function colorFor(name) {
  if (!name) return '#95a5a6';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/* ── Remove the child division/format suffix from legacy schedule records.
   Older admin saves stored values such as "MEN 5v5" in category. The
   public schedule should show only the sport and division, not the format. ── */
function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

/* ── Results saved by Moderator, matched back onto the schedule ──
   Newer records carry the scheduleId, which is exact. Older ones are
   matched on sport + division + both team names. ── */
function norm(value) {
  return (value || '').trim().toLowerCase();
}

function recordMatchesSchedule(record, schedule) {
  if (!record || !schedule) return false;
  if (record.scheduleId) return String(record.scheduleId) === String(schedule.id);
  if (norm(record.sportName) !== norm(schedule.sport)) return false;
  const rc = norm(displayCategory(record.category));
  const sc = norm(displayCategory(schedule.category));
  if (rc && sc && rc !== sc && !rc.endsWith(` ${sc}`) && !sc.endsWith(` ${rc}`)) return false;
  const roster = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const names = roster.map(p => norm(p?.name)).filter(Boolean);
  return names.includes(norm(schedule.teamA)) && names.includes(norm(schedule.teamB));
}

/* Winner's name for a finished fixture, or null while it's unplayed. */
function winnerNameOf(record) {
  if (!record || record.draw || record.winner === 'DRAW') return null;
  const roster = record.participants?.length ? record.participants : [];
  if (roster.length > 2) return roster.find(p => p.place === 1)?.name || null;
  /* Follow the saved scores (higher points / lower time) so an edited result
     can't leave a stale `winner` flag crowning the wrong team. The flag only
     decides when the scores are level or missing. */
  const { teamA, teamB } = record;
  const higherIsBetter = teamA?.points != null && teamB?.points != null;
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const a = num(higherIsBetter ? teamA.points : teamA?.minutes);
  const b = num(higherIsBetter ? teamB.points : teamB?.minutes);
  if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) {
    return (higherIsBetter ? a > b : a < b) ? teamA.name || null : teamB.name || null;
  }
  if (record.winner === 'A') return record.teamA?.name || null;
  if (record.winner === 'B') return record.teamB?.name || null;
  return null;
}

/* ── Single-elimination stages are named "Quarterfinals"/"Semifinals"/
   "Finals"/"Round of N" with no prefix; double-elimination's are always
   "Upper Bracket – …"/"Lower Bracket – …"/"Grand Final". Only the former
   shape is drawn as the connected tree below — same discriminator the
   admin's Schedule Manager uses. ── */
function isSingleBracketStage(stage) {
  return !!stage
    && !stage.startsWith('Upper Bracket')
    && !stage.startsWith('Lower Bracket')
    && stage !== 'Grand Final';
}

/* A bracket slot that hasn't been won into yet still holds its generator
   placeholder text ("Winner QF1") instead of a real team name. */
function isPlaceholderTeam(name) {
  return typeof name === 'string' && /^(Winner|Loser)\s/.test(name);
}

/* ── Group a saved single-bracket's matches back into rounds, reading
   each match's CURRENT teamA/teamB straight off the saved schedule so a
   placeholder already resolved by the moderator's result shows the real
   team, exactly like the admin's Schedule Manager view. ── */
function buildBracketStages(matches) {
  const byRound = new Map();
  matches.forEach((m) => {
    const r = m.round || 0;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r).push(m);
  });
  return [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((r) => ({
      name: byRound.get(r)[0]?.stage || `Round ${r}`,
      matches: byRound.get(r),
    }));
}

/* ── Build the tab key/label for a match's sport + category ── */
function categoryOf(match) {
  const sport = (match.sport || '').trim();
  const cat = displayCategory(match.category);
  const label = cat && cat.toLowerCase() !== 'general' ? `${sport} ${cat}` : sport;
  return { key: label.toUpperCase(), label };
}

/* ── Format a stored yyyy-mm-dd date into "THURSDAY, JUN 11" ── */
function formatDay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase();
}

/* ── Format a stored 24h "HH:MM" time into "7:00 AM" ── */
function formatTime(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h)) return timeStr;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m || 0).padStart(2, '0')} ${period}`;
}

/* ═══════════════════════════════════════════════════════════
   TEAM PILL — avatar + name, used inside round/bracket cards
   ═══════════════════════════════════════════════════════════ */
function TeamPill({ name, logo, result }) {
  if (!name) {
    return (
      <div className="ms-team-pill ms-team-pill--tbd">
        <span className="ms-team-pill__avatar ms-team-pill__avatar--tbd">?</span>
        <span className="ms-team-pill__name ms-team-pill__name--tbd">TBD</span>
      </div>
    );
  }
  return (
    <div className="ms-team-pill">
      {logo
        ? <img src={logo} alt="" className="ms-team-pill__avatar ms-team-pill__avatar--img" />
        : <span className="ms-team-pill__avatar" style={{ background: colorFor(name) }}>{name.charAt(0)}</span>
      }
      <span className="ms-team-pill__name">{name}</span>
      {result && (
        <span
          style={{
            marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em',
            padding: '2px 7px', borderRadius: 20,
            background: result === 'WIN' ? '#e6f7ec' : result === 'DRAW' ? '#eef1f8' : '#fdeeea',
            color: result === 'WIN' ? '#14713a' : result === 'DRAW' ? '#46536b' : '#a83218',
          }}
        >
          {result}
        </span>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ROUNDS VIEW — groups a category's generated matches into
   columns by stage/round exactly as the admin generated them
   (round-robin legs, bracket stages, or grand-final matches)
   ═══════════════════════════════════════════════════════════ */
function RoundsView({ matches, resultFor, champion }) {
  const columns = useMemo(() => {
    const map = new Map();
    matches.forEach(m => {
      const key = m.stage || (m.round != null ? `Round ${m.round}` : 'Matches');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    });
    return Array.from(map.entries());
  }, [matches]);

  if (columns.length === 0) return null;

  return (
    <div className="ms-rounds-wrap">
      {columns.map(([label, colMatches]) => (
        <div key={label} className="ms-rounds-col">
          <div className="ms-rounds-col__title">{label}</div>
          {colMatches.map((m) => {
            const record = resultFor ? resultFor(m) : null;
            const winner = winnerNameOf(record);
            const badge = (team) => {
              if (!record) return null;
              if (!winner) return 'DRAW';
              return norm(team) === norm(winner) ? 'WIN' : 'LOSE';
            };
            return (
              <div key={m.id} className="ms-rounds-match">
                {m.matchLabel && <span className="ms-rounds-match__label">{m.matchLabel}</span>}
                <TeamPill name={m.teamA} logo={m.teamALogo} result={badge(m.teamA)} />
                <span className="ms-rounds-match__vs">vs</span>
                <TeamPill name={m.teamB} logo={m.teamBLogo} result={badge(m.teamB)} />
              </div>
            );
          })}
        </div>
      ))}
      <div className="ms-rounds-col ms-rounds-col--champion">
        <FaTrophy className="ms-bracket-trophy" />
        <span className="ms-bracket-champion-label">CHAMPION</span>
        <div className="ms-bracket-champion-box">
          {champion
            ? <span className="ms-bracket-champion-name" style={{ fontWeight: 800 }}>{champion}</span>
            : <span className="ms-bracket-champion-placeholder">?</span>}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   BRACKET TREE — same horizontal, elbow-connector tree the admin's
   Schedule Manager draws for a saved single-elimination bracket: one
   two-team box per node at EVERY round (not just round 1), joined by
   connector lines that converge into a Champion box.
   ═══════════════════════════════════════════════════════════ */
function BracketTree({ stages, resultFor, champion }) {
  const ROW_H = 74;
  const NODE_W = 200;
  const NODE_H = 56;
  const LINE_GAP = 40;
  const COL_W = NODE_W + LINE_GAP;

  if (!stages.length) return null;
  const totalRounds = stages.length;
  const leafCount = stages[0].matches.length * 2;
  const leafY = Array.from({ length: leafCount }, (_, i) => i * ROW_H + ROW_H / 2);

  const matchY = [];
  stages.forEach((stage, r) => {
    matchY.push(stage.matches.map((_, m) => (
      r === 0
        ? (leafY[2 * m] + leafY[2 * m + 1]) / 2
        : (matchY[r - 1][2 * m] + matchY[r - 1][2 * m + 1]) / 2
    )));
  });

  const colX = (r) => r * COL_W;
  const championX = colX(totalRounds - 1) + COL_W;
  const championY = matchY[totalRounds - 1][0];
  const height = leafCount * ROW_H;
  const width = championX + 150;

  const elbow = (childX, y1, y2, parentX, parentY) => {
    const midX = (childX + parentX) / 2;
    return `M ${childX} ${y1} H ${midX} M ${childX} ${y2} H ${midX} M ${midX} ${y1} V ${y2} M ${midX} ${parentY} H ${parentX}`;
  };

  const connectors = [];
  for (let r = 1; r < totalRounds; r++) {
    const childX = colX(r - 1) + NODE_W;
    const parentX = colX(r);
    stages[r].matches.forEach((_, m) => {
      connectors.push(elbow(childX, matchY[r - 1][2 * m], matchY[r - 1][2 * m + 1], parentX, matchY[r][m]));
    });
  }
  connectors.push(`M ${colX(totalRounds - 1) + NODE_W} ${championY} H ${championX}`);

  const finalMatch = stages[totalRounds - 1]?.matches[0] || null;
  /* The page-level champion also honours later extra games between the
     finalists; fall back to the final's own result if it isn't supplied. */
  const finalRecord = finalMatch ? resultFor(finalMatch) : null;
  const championName = champion || (finalRecord ? winnerNameOf(finalRecord) : null);
  const teamLogo = (name) => {
    if (!finalMatch || !name) return null;
    if (norm(name) === norm(finalMatch.teamA)) return finalMatch.teamALogo;
    if (norm(name) === norm(finalMatch.teamB)) return finalMatch.teamBLogo;
    return null;
  };
  const championLogo = teamLogo(championName);

  return (
    <div className="ms-btree" style={{ minHeight: height }}>
      <div className="ms-btree-headers">
        {stages.map((s, i) => <div key={i} style={{ width: COL_W }}>{s.name}</div>)}
        <div style={{ width: width - colX(totalRounds - 1) - COL_W }}>Champion</div>
      </div>

      <div className="ms-btree-canvas" style={{ height, width }}>
        <svg width={width} height={height} className="ms-btree-lines">
          {connectors.map((d, i) => <path key={i} d={d} />)}
        </svg>

        {stages.map((stage, r) => stage.matches.map((m, mi) => {
          const recorded = !!resultFor(m);
          return (
            <div
              key={m.id}
              className={`ms-btree-node ${recorded ? 'ms-btree-node--done' : ''}`}
              style={{ left: colX(r), top: matchY[r][mi] - NODE_H / 2, width: NODE_W, height: NODE_H }}
            >
              {[[m.teamA, m.teamALogo], [m.teamB, m.teamBLogo]].map(([name, logo], slot) => (
                isPlaceholderTeam(name) ? (
                  <div className="ms-btree-slot ms-btree-slot--pending" key={slot}>{name}</div>
                ) : (
                  <div className="ms-btree-slot" key={slot}>
                    {logo
                      ? <img src={logo} alt="" className="ms-btree-avatar" />
                      : <span className="ms-btree-avatar ms-btree-avatar--fallback" style={{ background: colorFor(name) }}>{name ? name.charAt(0) : '?'}</span>}
                    <span>{name || 'TBD'}</span>
                  </div>
                )
              ))}
            </div>
          );
        }))}

        <div className="ms-btree-champion" style={{ left: championX, top: championY }}>
          {championName
            ? (championLogo
                ? <img src={championLogo} alt="" className="ms-btree-champion-avatar" />
                : <span className="ms-btree-champion-avatar ms-btree-champion-avatar--fallback" style={{ background: colorFor(championName) }}>{championName.charAt(0)}</span>)
            : <FaTrophy />}
          <span>{championName || 'Champion'}</span>
        </div>
      </div>
    </div>
  );
}

/* Same stage-name → code mapping the admin generator uses ("Quarterfinals"
   → "QF", "Round of 16" → "R16", …) — needed so the "Loser UB-<code><i>"
   references below are rebuilt exactly as they were saved. */
function stageCodeFor(name) {
  if (name === 'Finals') return 'F';
  if (name === 'Semifinals') return 'SF';
  if (name === 'Quarterfinals') return 'QF';
  const m = (name || '').match(/Round of (\d+)/);
  return m ? `R${m[1]}` : 'M';
}

/* ── Renumbers every real match (skipping byes) sequentially — Upper
   Bracket rounds, then Lower Bracket rounds — as "Match N", and rewrites
   every reference to it ("Winner QF1", "Loser UB-SF2", …) into "Winner of
   Match N" / "Loser of Match N". Ported unchanged from the admin Schedule
   Manager's own double-bracket tree, which this component matches. ── */
function withMatchNumbers(wbStages, lbRounds) {
  let n = 0;
  const rename = {};

  const ubNumbers = wbStages.map((stage, stageIdx) => {
    const isFinal = stageIdx === wbStages.length - 1;
    return stage.matches.map((m, i) => {
      if (m.isBye) return null;
      n += 1;
      rename[`Winner ${m.label}`] = `Winner of Match ${n}`;
      const code = isFinal ? 'F' : stageCodeFor(stage.name);
      rename[isFinal ? 'Loser UB-F' : `Loser UB-${code}${i + 1}`] = `Loser of Match ${n}`;
      return n;
    });
  });
  const lbNumbers = lbRounds.map(round => round.matches.map((m) => {
    n += 1;
    rename[`Winner ${m.label}`] = `Winner of Match ${n}`;
    return n;
  }));

  const apply = (s) => (s != null && rename[s]) || s;
  return {
    wbStages: wbStages.map((stage, stageIdx) => ({
      ...stage,
      matches: stage.matches.map((m, i) => ({
        ...m,
        label: m.isBye ? m.label : `Match ${ubNumbers[stageIdx][i]}`,
        a: apply(m.a),
        b: apply(m.b),
      })),
    })),
    lbRounds: lbRounds.map((round, roundIdx) => ({
      ...round,
      matches: round.matches.map((m, i) => ({
        ...m,
        label: `Match ${lbNumbers[roundIdx][i]}`,
        a: apply(m.a),
        b: apply(m.b),
      })),
    })),
  };
}

/* ── Already-saved double bracket, regrouped from the flat saved matches
   back into { wbStages, leaves, lbRounds } — same shape the admin
   generator's DoubleBracketTree consumes. Saved UB matchLabels were
   prefixed at save time ("UB-QF1"); stripped back to the raw codes
   ("QF1") the connector renaming above expects. LB labels were never
   prefixed, so they pass through unchanged. ── */
function buildSavedDoubleBracketStages(matches) {
  const groupByStage = (list) => {
    const byStage = new Map();
    list.forEach((m) => {
      if (!byStage.has(m.stage)) byStage.set(m.stage, []);
      byStage.get(m.stage).push(m);
    });
    return [...byStage.values()].sort((a, b) => (a[0]?.round || 0) - (b[0]?.round || 0));
  };

  const ubGroups = groupByStage(matches.filter(m => (m.stage || '').startsWith('Upper Bracket')));
  const lbGroups = groupByStage(matches.filter(m => (m.stage || '').startsWith('Lower Bracket')));

  const wbStages = ubGroups.map((group) => ({
    name: (group[0].stage || '').replace(/^Upper Bracket\s*[–-]\s*/, ''),
    matches: group.map(m => ({ label: (m.matchLabel || '').replace(/^UB-/, ''), a: m.teamA, b: m.teamB })),
  }));
  const lbRounds = lbGroups.map((group) => ({
    name: (group[0].stage || '').replace(/^Lower Bracket\s*[–-]\s*/, ''),
    matches: group.map(m => ({ label: m.matchLabel, a: m.teamA, b: m.teamB })),
  }));
  const leaves = wbStages[0]?.matches.flatMap(m => [m.a, m.b]) || [];

  return { wbStages, leaves, lbRounds };
}

/* ── Double Bracket tree: Upper (Winner's) and Lower (Loser's) brackets
   drawn on ONE shared canvas so their final-round winners can converge
   with real connector lines into a single "GC" node and Champion box —
   ported unchanged from the admin Schedule Manager so it renders in
   exactly the same format here. ── */
function DoubleBracketTree({ wbStages: wbStagesRaw, leaves, lbRounds: lbRoundsRaw }) {
  const ROW_H = 56;
  const LEAF_W = 190;
  const LEAF_H = 40;
  const COL_GAP = 250;

  if (!wbStagesRaw.length || !lbRoundsRaw.length) return null;

  const { wbStages, lbRounds } = withMatchNumbers(wbStagesRaw, lbRoundsRaw);

  const colX = (r) => LEAF_W + (r + 1) * COL_GAP;

  const mergeLines = (x1, y1, x2, y2, parentX, parentY) => {
    const midX = (Math.max(x1, x2) + parentX) / 2;
    return `M ${x1} ${y1} H ${midX} M ${x2} ${y2} H ${midX} M ${midX} ${y1} V ${y2} M ${midX} ${parentY} H ${parentX}`;
  };

  const layoutRounds = (roundsMatches, rootLeaves, top, nodeLabel) => {
    const known = {};
    rootLeaves.forEach((name, i) => {
      if (name) known[name] = { y: top + i * ROW_H + ROW_H / 2, lineX: LEAF_W };
    });
    let cursorY = top + rootLeaves.length * ROW_H;
    const freshBoxes = [];
    const matchY = [];
    const connectors = [];
    const captions = [];

    roundsMatches.forEach((matches, r) => {
      const childX = r === 0 ? LEAF_W : colX(r - 1);
      const inputBoxX = r === 0 ? 0 : colX(r - 1);
      const isFinalRound = r === roundsMatches.length - 1;
      matchY.push(matches.map((m, i) => {
        const place = (label, hintY) => {
          const y = hintY != null ? hintY + ROW_H : cursorY + ROW_H / 2;
          cursorY = Math.max(cursorY, y + ROW_H / 2);
          const entry = { y, lineX: childX + LEAF_W };
          known[label] = entry;
          if (r > 0) freshBoxes.push({ label, x: childX, y });
          return entry;
        };
        const aKnown = m.a != null ? known[m.a] : null;
        const bKnown = m.b != null ? known[m.b] : null;
        const a = aKnown ?? (m.a != null ? place(m.a, bKnown ? bKnown.y : null) : null);
        const b = bKnown ?? (m.b != null ? place(m.b, a ? a.y : null) : null);
        const y = a && b ? (a.y + b.y) / 2 : (a ?? b).y;
        if (a && b) connectors.push(mergeLines(a.lineX, a.y, b.lineX, b.y, colX(r), y));
        if (m.label) known[`Winner of ${m.label}`] = { y, lineX: colX(r) + LEAF_W };
        if (m.label && a && b) captions.push({ label: m.label, x: inputBoxX, y: Math.min(a.y, b.y) - LEAF_H / 2 - 14 });
        return { y, label: nodeLabel(m, i, r, isFinalRound) };
      }));
    });

    const bottom = Math.max(cursorY, top + rootLeaves.length * ROW_H);
    return { matchY, connectors, freshBoxes, captions, bottom, finalY: matchY[matchY.length - 1][0].y };
  };

  const UB_TOP = 56;
  const ub = layoutRounds(
    wbStages.map(s => s.matches), leaves, UB_TOP,
    (m) => `Winner of ${m.label}`
  );
  const ubRoundsCount = wbStages.length;
  const ubFinalX = colX(ubRoundsCount - 1) + LEAF_W;
  const ubFinalY = ub.finalY;

  const lbLeafLabels = lbRounds[0].matches.flatMap(m => [m.a || 'Bye', m.b || 'Bye']);
  const LB_LABEL_Y = ub.bottom + 34;
  const LB_TOP = LB_LABEL_Y + 54;
  const lb = layoutRounds(
    lbRounds.map(r => r.matches), lbLeafLabels, LB_TOP,
    (m) => `Winner of ${m.label}`
  );
  const lbRoundsCount = lbRounds.length;
  const lbFinalX = colX(lbRoundsCount - 1) + LEAF_W;
  const lbFinalY = lb.finalY;

  const gcX = Math.max(ubFinalX, lbFinalX) + 140;
  const gcY = (ubFinalY + lbFinalY) / 2;
  const championX = gcX + 90;

  const totalHeight = lb.bottom + 30;
  const totalWidth = Math.max(colX(ubRoundsCount - 1) + LEAF_W, colX(lbRoundsCount - 1) + LEAF_W, championX + 130);

  const connectors = [
    ...ub.connectors,
    ...lb.connectors,
    mergeLines(ubFinalX, ubFinalY, lbFinalX, lbFinalY, gcX, gcY),
    `M ${gcX} ${gcY} H ${championX}`,
  ];

  return (
    <div className="msf-dbracket2" style={{ height: totalHeight, width: totalWidth }}>
      <svg width={totalWidth} height={totalHeight} className="msf-bracket-lines">
        {connectors.map((d, i) => <path key={i} d={d} />)}
      </svg>

      <p className="msf-dbracket__label" style={{ top: 0 }}>Upper Bracket (Winner's Bracket)</p>
      <div className="msf-dbracket2-headers" style={{ top: 30 }}>
        <div style={{ width: colX(0) }}>{wbStages[0].name}</div>
        {wbStages.slice(1).map((s, i) => <div key={i} style={{ width: COL_GAP }}>{s.name === 'Finals' ? "Winner's Finals" : s.name}</div>)}
        <div style={{ width: COL_GAP }}>Grand Finals</div>
      </div>

      {leaves.map((name, i) => (
        name ? (
          <div key={`ub-${i}`} className="msf-bracket-team" style={{ top: UB_TOP + i * ROW_H + ROW_H / 2 - LEAF_H / 2, left: 0, height: LEAF_H, width: LEAF_W }}>
            <span className="msf-lbracket-leaf__dot" />
            <span>{name}</span>
          </div>
        ) : (
          <div key={`ub-${i}`} className="msf-bracket-team msf-bracket-team--bye" style={{ top: UB_TOP + i * ROW_H + ROW_H / 2 - LEAF_H / 2, left: 0, height: LEAF_H, width: LEAF_W }}>
            <span>Bye</span>
          </div>
        )
      ))}

      {ub.matchY.map((round, r) => round.map((node, i) => (
        <div key={`ub-node-${r}-${i}`} className="msf-lbracket-leaf" style={{ top: node.y - LEAF_H / 2, left: colX(r), height: LEAF_H, width: LEAF_W }}>
          <span className="msf-lbracket-leaf__dot" />
          <span>{node.label}</span>
        </div>
      )))}

      {ub.captions.map((c, i) => (
        <span key={`ub-cap-${i}`} className="msf-dbracket__matchcap" style={{ left: c.x, top: c.y, width: LEAF_W }}>{c.label}</span>
      ))}

      <p className="msf-dbracket__label msf-dbracket__label--lower" style={{ top: LB_LABEL_Y }}>Lower Bracket (Loser's Bracket)</p>
      <div className="msf-dbracket2-headers" style={{ top: LB_LABEL_Y + 30 }}>
        {lbRounds.map((r, i) => <div key={i} style={{ width: i === 0 ? colX(0) : COL_GAP }}>{r.name}</div>)}
      </div>

      {lbLeafLabels.map((label, i) => (
        <div key={`lb-${i}`} className="msf-lbracket-leaf" style={{ top: LB_TOP + i * ROW_H + ROW_H / 2 - LEAF_H / 2, left: 0, height: LEAF_H, width: LEAF_W }}>
          <span className="msf-lbracket-leaf__dot" />
          <span>{label}</span>
        </div>
      ))}

      {lb.freshBoxes.map((box, i) => (
        <div key={`lb-fresh-${i}`} className="msf-lbracket-leaf" style={{ top: box.y - LEAF_H / 2, left: box.x, height: LEAF_H, width: LEAF_W }}>
          <span className="msf-lbracket-leaf__dot" />
          <span>{box.label}</span>
        </div>
      ))}

      {lb.matchY.map((round, r) => round.map((node, i) => (
        <div key={`lb-node-${r}-${i}`} className="msf-lbracket-leaf" style={{ top: node.y - LEAF_H / 2, left: colX(r), height: LEAF_H, width: LEAF_W }}>
          <span className="msf-lbracket-leaf__dot" />
          <span>{node.label}</span>
        </div>
      )))}

      {lb.captions.map((c, i) => (
        <span key={`lb-cap-${i}`} className="msf-dbracket__matchcap" style={{ left: c.x, top: c.y, width: LEAF_W }}>{c.label}</span>
      ))}

      <div className="msf-bracket-node" style={{ left: gcX, top: gcY }}>
        <span className="msf-bracket-node__dot" />
        <span className="msf-bracket-node__label">GC</span>
      </div>

      <div className="msf-bracket-champion" style={{ left: championX, top: gcY }}>
        <FaTrophy />
        <span>Champion</span>
      </div>
    </div>
  );
}

/* ── Wraps the substring of `text` that matches the current search query
   in a <mark>, so every field the search bar actually searches (team,
   venue) visibly shows why a row matched. No-op when there's no query
   or no match. ── */
function HighlightText({ text, query }) {
  const str = text || '';
  const q = (query || '').trim();
  if (!q) return str;
  const idx = str.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return str;
  return (
    <>
      {str.slice(0, idx)}
      <mark className="ms-search-highlight">{str.slice(idx, idx + q.length)}</mark>
      {str.slice(idx + q.length)}
    </>
  );
}

/* ── Schedule table for a single day ── */
function ScheduleDayTable({ day, matches, resultFor, search }) {
  return (
    <div className="ms-day-card">
      <div className="ms-day-header">{day}</div>
      <div className="ms-table-wrap" role="table">
        <div className="ms-row ms-row--head" role="row">
          <div className="ms-cell ms-cell-time" role="columnheader">TIME</div>
          <div className="ms-cell ms-cell-sport" role="columnheader">SPORTS</div>
          <div className="ms-cell ms-cell-venue" role="columnheader">VENUE</div>
          <div className="ms-cell ms-cell-team" role="columnheader">TEAM</div>
        </div>
        {matches.map((m) => (
          <div className="ms-row" role="row" key={m.id}>
            {/* Wrapped so mobile can lay these three out as an even,
                centered row under the team matchup — display: contents
                on desktop keeps them as plain grid items so the 4-column
                grid still lines up with the header row above. */}
            <div className="ms-row-details">
              <div className="ms-cell ms-cell-time" role="cell" data-label="Time">{formatTime(m.time)}</div>
              <div className="ms-cell ms-cell-sport" role="cell" data-label="Sport">{categoryOf(m).label}</div>
              <div className="ms-cell ms-cell-venue" role="cell" data-label="Venue">
                <HighlightText text={m.location || 'TBA'} query={search} />
              </div>
            </div>
            <div className="ms-cell ms-cell-team ms-cell-team--body" role="cell">
              {(() => {
                const record = resultFor ? resultFor(m) : null;
                const winner = winnerNameOf(record);
                const bold = (team) => (winner && norm(team) === norm(winner) ? { fontWeight: 800 } : undefined);
                return (
                  <>
                    {m.matchLabel && (
                      <span
                        style={{
                          marginRight: 8, fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.04em',
                          textTransform: 'uppercase', padding: '2px 7px', borderRadius: 20,
                          background: '#fff3d6', color: '#8a5f04',
                        }}
                      >
                        {m.matchLabel}
                      </span>
                    )}
                    <span style={bold(m.teamA)}><HighlightText text={m.teamA} query={search} /></span>
                    <span className="ms-team-vs">vs</span>
                    <span style={bold(m.teamB)}><HighlightText text={m.teamB} query={search} /></span>
                    {record && (
                      <span
                        style={{
                          marginLeft: 8, fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em',
                          padding: '2px 7px', borderRadius: 20, background: '#eef1f8', color: '#46536b',
                        }}
                      >
                        {winner ? `${winner} WON` : 'DRAW'}
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MatchSchedulesPage() {
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  /* No "All Levels" option: each level's matches are generated/numbered
     independently (its own round numbers, its own bracket stages), so
     merging two levels' matches under the same category name into one
     bracket/rounds view produced a broken, mixed-up format — teams and
     rounds from unrelated brackets stitched into a single tree. The
     format view only makes sense scoped to one level at a time. */
  const LEVELS = useMemo(() => [
    { label: levelLabels.elementary, key: 'elementary' },
    { label: levelLabels.highSchool, key: 'highSchool' },
    { label: levelLabels.college, key: 'college' },
  ], [levelLabels]);
  const lockedLevel = useLockedLevel();
  const [pickedLevel, setLevelKey] = useState(LEVELS[0].key);
  const levelKey = lockedLevel || pickedLevel;
  const level = LEVELS.find(l => l.key === levelKey) || LEVELS[0];
  const [category, setCategory] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [matchesByLevel, setMatchesByLevel] = useState({ elementary: [], highSchool: [], college: [] });
  const [records, setRecords] = useState([]); // Moderator results, all levels
  const [rankingsByLevel, setRankingsByLevel] = useState({}); // { [level]: { [scopeKey]: { [team]: rating } } }
  const contactRef = React.useRef(null);

  /* ── Load real data from Firestore for every level ── */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [elementary, highSchool, college] = await Promise.all([
          getMatchSchedules('elementary'),
          getMatchSchedules('highSchool'),
          getMatchSchedules('college'),
        ]);
        if (cancelled) return;

        /* Results are optional: if the moderator's records can't be read,
           the schedule still renders, just without WIN/LOSE badges. */
        const recordLists = await Promise.all(
          ['elementary', 'highSchool', 'college'].map(levelKey =>
            getMatchRecords(levelKey).catch(() => [])),
        );
        if (cancelled) return;
        setRecords(recordLists.flat().filter(Boolean));

        /* Team ratings decide an elimination bracket's champion. Optional:
           without them the champion falls back to the game results. */
        const rankingLists = await Promise.all(
          ['elementary', 'highSchool', 'college'].map(levelKey =>
            getTeamRankings(levelKey).catch(() => ({}))),
        );
        if (cancelled) return;
        setRankingsByLevel({
          elementary: rankingLists[0] || {},
          highSchool: rankingLists[1] || {},
          college: rankingLists[2] || {},
        });

        const tag = (levelKey, matches) =>
          (matches || [])
            .filter(m => m && m.teamA && m.teamB)
            .map(m => ({ ...m, level: levelKey }));

        setMatchesByLevel({
          elementary: tag('elementary', elementary),
          highSchool: tag('highSchool', highSchool),
          college: tag('college', college),
        });
      } catch (e) {
        console.error('Failed to load match schedules:', e);
        if (!cancelled) {
          setMatchesByLevel({ elementary: [], highSchool: [], college: [] });
          setRecords([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  /* ── Matches visible for the selected level filter ── */
  const levelMatches = useMemo(() => matchesByLevel[level.key] || [], [level, matchesByLevel]);

  /* ── Category tabs are built entirely from whatever sports/categories
     the admin actually has matches for — never a fixed list ── */
  const categories = useMemo(() => {
    const map = new Map();
    levelMatches.forEach(m => {
      const c = categoryOf(m);
      if (!map.has(c.key)) map.set(c.key, c.label);
    });
    return Array.from(map.entries()).map(([key, label]) => ({ key, label }));
  }, [levelMatches]);

  /* ── Keep the selected category valid as data loads/changes ── */
  useEffect(() => {
    if (categories.length === 0) {
      if (category !== null) setCategory(null);
      return;
    }
    if (!category || !categories.some(c => c.key === category.key)) {
      setCategory(categories[0]);
    }
  }, [categories, category]);

  const categoryMatches = useMemo(() => {
    if (!category) return [];
    return levelMatches.filter(m => categoryOf(m).key === category.key);
  }, [levelMatches, category]);

  /* ── Rounds/bracket view only for matches that came from the generator
     (they carry a round number or a stage label) ── */
  const generatedMatches = useMemo(
    () => categoryMatches.filter(m => m.round != null || m.stage),
    [categoryMatches]
  );

  /* ── A saved single-elimination bracket gets the connected tree view;
     round-robin legs keep the column view below, same distinction the
     admin's Schedule Manager makes. ── */
  const isBracketShaped = useMemo(
    () => generatedMatches.length > 0 && generatedMatches.every(m => m.stage && isSingleBracketStage(m.stage)),
    [generatedMatches]
  );

  /* ── A saved double-elimination bracket gets the same Upper/Lower
     Bracket tree the admin's Schedule Manager draws. ── */
  const isDoubleBracketShaped = useMemo(
    () => generatedMatches.length > 0 && generatedMatches.some(m => (m.stage || '').startsWith('Upper Bracket')),
    [generatedMatches]
  );

  /* ── Schedule table only shows matches an admin has actually pinned
     to a real date + time — a freshly generated match with blank
     date/time doesn't belong on the "real-time schedule" yet. Scoped to
     the selected category tab, same as the bracket/rounds view above,
     so the category buttons actually control what's shown below too. ── */
  const scheduledMatches = useMemo(
    () => categoryMatches.filter(m => m.date && m.time),
    [categoryMatches]
  );

  const filteredSchedule = useMemo(() => {
    const byDay = new Map();
    scheduledMatches.forEach(m => {
      const day = formatDay(m.date);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(m);
    });
    const days = Array.from(byDay.entries())
      .map(([day, matches]) => ({
        day,
        matches: matches
          .filter(m => {
            if (!search.trim()) return true;
            const q = search.trim().toLowerCase();
            return (
              m.teamA.toLowerCase().includes(q) ||
              m.teamB.toLowerCase().includes(q) ||
              (m.location || '').toLowerCase().includes(q)
            );
          })
          .sort((a, b) => (a.time || '').localeCompare(b.time || '')),
      }))
      .filter(d => d.matches.length > 0);
    return days;
  }, [scheduledMatches, search]);

  /* One saved result per fixture, so the same record can never be shown
     against two different matches. */
  const resultFor = useMemo(() => {
    const byScheduleId = new Map();
    const used = new Set();
    return (match) => {
      if (byScheduleId.has(match.id)) return byScheduleId.get(match.id);
      /* A record saved against this exact fixture beats a name-only match,
         and among several the most recently saved one wins — otherwise a
         stale earlier result for the same two teams can shadow the current. */
      const stamp = (r) => r.updatedAt || r.createdAt || 0;
      let hitIndex = -1;
      records.forEach((record, index) => {
        if (used.has(index) || !recordMatchesSchedule(record, match)) return;
        if (hitIndex < 0) { hitIndex = index; return; }
        const cur = records[hitIndex];
        const exact = record.scheduleId != null && String(record.scheduleId) === String(match.id);
        const curExact = cur.scheduleId != null && String(cur.scheduleId) === String(match.id);
        if (exact && !curExact) hitIndex = index;
        else if (exact === curExact && exact && stamp(record) > stamp(cur)) hitIndex = index;
      });
      const hit = hitIndex >= 0 ? records[hitIndex] : null;
      if (hit) used.add(hitIndex);
      byScheduleId.set(match.id, hit);
      return hit;
    };
  }, [records]);

  /* Champion.
     - Elimination brackets: whoever won the final, once it has a result.
     - Round-robin / rounds view: nobody until EVERY game in the category has
       a saved result, then the team with the most wins. Games added later
       (extra schedule / requested game) count too, so the champion reopens
       until those are played. Ties on wins fall to point difference; a
       still-tied top spot means no champion yet. */
  const champion = useMemo(() => {
    if (generatedMatches.length === 0) return null;

    if (isBracketShaped || isDoubleBracketShaped) {
      const finals = generatedMatches.filter((m) => {
        const stage = (m.stage || '').toLowerCase();
        return stage.includes('final') || stage.includes('champion');
      });
      const maxRound = Math.max(...generatedMatches.map(m => (m.round != null ? m.round : -1)));
      const lastRound = maxRound >= 0 ? generatedMatches.filter(m => m.round === maxRound) : [];
      const candidates = finals.length ? finals : lastRound;
      let finalMatch = null;
      let champ = null;
      for (const match of candidates) {
        const winner = winnerNameOf(resultFor(match));
        if (winner) { finalMatch = match; champ = winner; break; }
      }
      if (!champ) return null;

      /* Rule: once the final is played, the finalist with the higher rating
         (the same rating the Ranking page shows for this sport + division)
         is the champion. The game-result logic below only decides when the
         ratings are unavailable or level. */
      const scopeKey = `${norm(finalMatch.sport)}::${norm(displayCategory(finalMatch.category))}`;
      const scope = rankingsByLevel[finalMatch.level]?.[scopeKey];
      const ratingOf = (team) => {
        const hit = scope && Object.entries(scope).find(([name]) => norm(name) === norm(team));
        const value = hit ? Number(hit[1]) : NaN;
        return Number.isFinite(value) ? value : null;
      };
      const rA = ratingOf(finalMatch.teamA);
      const rB = ratingOf(finalMatch.teamB);
      if (rA != null && rB != null && rA !== rB) {
        return (rA > rB ? finalMatch.teamA : finalMatch.teamB).toUpperCase();
      }

      /* An extra game between the same two finalists (e.g. a tie-break added
         to the schedule after the final) that was played later supersedes the
         final's result — the latest recorded game between them decides. */
      const pairKey = (m) => [norm(m.teamA), norm(m.teamB)].sort().join('|');
      const when = (m) => (m.date ? new Date(`${m.date}T${m.time || '00:00'}`).getTime() || 0 : 0);
      const finalKey = pairKey(finalMatch);
      let latest = finalMatch;
      for (const m of categoryMatches) {
        if (m === finalMatch || pairKey(m) !== finalKey || when(m) <= when(latest)) continue;
        if (winnerNameOf(resultFor(m))) latest = m;
      }
      return (latest === finalMatch ? champ : winnerNameOf(resultFor(latest))).toUpperCase();
    }

    const standings = new Map(); // norm(name) -> { name, wins, diff }
    const row = (name) => {
      const k = norm(name);
      if (!standings.has(k)) standings.set(k, { name, wins: 0, diff: 0 });
      return standings.get(k);
    };
    for (const match of categoryMatches) {
      const record = resultFor(match);
      if (!record) return null; // a game is still unplayed
      row(match.teamA); row(match.teamB);
      const winner = winnerNameOf(record);
      if (winner) row(winner).wins += 1;
      const a = record.teamA, b = record.teamB;
      if (a?.points != null && b?.points != null) {
        row(a.name).diff += a.points - b.points;
        row(b.name).diff += b.points - a.points;
      }
    }
    const ranked = [...standings.values()].sort((x, y) => y.wins - x.wins || y.diff - x.diff);
    if (!ranked.length) return null;
    if (ranked[1] && ranked[0].wins === ranked[1].wins && ranked[0].diff === ranked[1].diff) return null;
    return ranked[0].name.toUpperCase();
  }, [generatedMatches, categoryMatches, isBracketShaped, isDoubleBracketShaped, resultFor, rankingsByLevel]);

  const hasAnyData = categories.length > 0;

  return (
    <div className="ms-page">

      {/* ── Top header ── */}
      <header className="ms-dash-header">
        <h1 className="ms-dash-header__title">{schoolName}</h1>
      </header>

      {/* ── Page intro ── */}
      <div className="ms-page-intro">
        <h2 className="ms-page-title">Game Schedules</h2>
        <p className="ms-page-subtitle">Stay updated with real-time schedules. Follow every game from start to finish.</p>
      </div>

      {/* ── Scrollable body ── */}
      <div className="ms-body">

        {/* Level filter */}
        {!lockedLevel && (
        <LevelTabs
          levels={LEVELS}
          value={levelKey}
          onChange={setLevelKey}
          containerClassName="ms-lvltabs"
          tabClassName="ms-lvltab"
          activeClassName="ms-lvltab--active"
        />
        )}

        {loading ? (
          <p className="ms-state-note">Loading schedules…</p>
        ) : !hasAnyData ? (
          <p className="ms-state-note">
            No game schedules have been posted yet for {level.label}. Once an admin generates or adds a schedule, it will appear here.
          </p>
        ) : (
          <>
            {/* Category selector */}
            <div className="ms-toolbar">
              <div className="ms-category-tabs">
                {categories.map(c => (
                  <button
                    key={c.key}
                    className={`ms-category-tab ${category?.key === c.key ? 'ms-category-tab--active' : ''}`}
                    onClick={() => setCategory(c)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Bracket / rounds section (format) */}
            <div className="ms-bracket-card">
              <h3 className="ms-bracket-title">{category?.label || ''}</h3>
              {generatedMatches.length > 0 ? (
                isBracketShaped ? (
                  <BracketTree stages={buildBracketStages(generatedMatches)} resultFor={resultFor} champion={champion} />
                ) : isDoubleBracketShaped ? (
                  <div className="msf-dbracket">
                    <div className="msf-dbracket__scroll">
                      <DoubleBracketTree {...buildSavedDoubleBracketStages(generatedMatches)} />
                    </div>
                  </div>
                ) : (
                  <RoundsView matches={generatedMatches} resultFor={resultFor} champion={champion} />
                )
              ) : (
                <p className="ms-bracket-empty">No bracket or rounds generated yet for {category?.label}.</p>
              )}
            </div>

            {/* Section title */}
            <h2 className="ms-section-title">MATCH SCHEDULES</h2>

            {/* Search — filters the match schedules list right below it */}
            <div className="ms-search-wrap">
              <FaSearch className="ms-search-icon" />
              <input
                type="text"
                className="ms-search-input"
                placeholder="Search Team and Venue"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            {/* Schedule tables grouped by day */}
            <div className="ms-schedule-list">
              {filteredSchedule.length > 0 ? (
                filteredSchedule.map(day => (
                  <ScheduleDayTable key={day.day} day={day.day} matches={day.matches} resultFor={resultFor} search={search} />
                ))
              ) : search.trim() ? (
                <p className="ms-schedule-empty">No matches found for "{search}".</p>
              ) : (
                <p className="ms-schedule-empty">No matches have a confirmed date and time yet.</p>
              )}
            </div>
          </>
        )}

        {/* Contact footer */}
        <Contact contactFooterRef={contactRef} />
      </div>
    </div>
  );
}
