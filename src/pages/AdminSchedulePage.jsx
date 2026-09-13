import React, { useState, useContext, useEffect, useCallback, useRef } from 'react';
import { AuthContext } from '../components/AuthContext';
import { useNavigate } from 'react-router-dom';
import './AdminSchedulePage.css';
import { FaTimes, FaSync, FaSearch, FaUsers, FaUserGraduate, FaChevronDown, FaCheck, FaEdit, FaPlus, FaMapMarkerAlt, FaTrophy, FaTrash, FaExclamationTriangle, FaDownload, FaBell, FaArrowRight } from 'react-icons/fa';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { getSportsTeamsConfig, getMatchSchedules, getMatchRecords, saveGeneratedSchedule, upsertMatchSchedule, deleteMatchSchedule, deleteScheduleSet, setLivePlayerCount, setEventRegistrationCounts, getEventKey, getEventLabel, EVENT_TYPES, getVenues, getAllMatchSchedules, subscribeScheduleRequests, updateScheduleRequest, deleteScheduleRequest } from '../services/firestoreService';
import SportsTeamsManager from './SportsTeamsManager';
import VenuesManager from './VenuesManager';
import LevelTabs from '../components/LevelTabs';

const LEVELS = [
  { key: 'elementary', label: 'Elementary' },
  { key: 'highSchool',  label: 'High School' },
  { key: 'college',     label: 'College' },
];


/* ─── Grade-level bucketing ───────────────────────── */
const ELEMENTARY_GRADES = new Set(['Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6']);
const HIGH_SCHOOL_GRADES = new Set(['Grade 7','Grade 8','Grade 9','Grade 10','Grade 11','Grade 12']);
const COLLEGE_GRADES = new Set(['1st Year','2nd Year','3rd Year','4th Year']);

const ALL_GRADES = [
  'Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6',
  'Grade 7','Grade 8','Grade 9','Grade 10','Grade 11','Grade 12',
  '1st Year','2nd Year','3rd Year','4th Year',
];

function getSchoolLevel(gradeLevel) {
  if (!gradeLevel) return null;
  if (ELEMENTARY_GRADES.has(gradeLevel)) return 'elementary';
  if (HIGH_SCHOOL_GRADES.has(gradeLevel)) return 'highSchool';
  if (COLLEGE_GRADES.has(gradeLevel)) return 'college';
  return null;
}

function buildSummary(registrations) {
  const map = {};
  registrations.forEach(({ sport, gender, gradeLevel }) => {
    if (!sport) return;
    const level = getSchoolLevel(gradeLevel);
    const g     = (gender || '').toLowerCase();
    const label = g === 'female' ? 'Women' : g === 'male' ? 'Men' : 'Mixed';
    const key   = `${sport.trim()}||${label}`;
    if (!map[key]) map[key] = { sport: sport.trim(), gender: label, elementary: 0, highSchool: 0, college: 0 };
    if (level) map[key][level]++;
  });
  return Object.values(map).sort((a, b) => {
    const sc = a.sport.localeCompare(b.sport);
    return sc !== 0 ? sc : a.gender.localeCompare(b.gender);
  });
}

/* Does this registration count as a player in the summary above?

   buildSummary only tallies a registration that has a sport AND a
   recognisable grade level — anything else contributes 0 to the
   Elementary / High School / College totals. The per-event chips have
   to use the exact same test, or they'd report a bigger population
   than the table right beneath them (half-filled or abandoned test
   registrations would show up in the chips but nowhere else). */
function countsAsPlayer(r) {
  return Boolean(r && r.sport && getSchoolLevel(r.gradeLevel));
}

/* Which event bucket a registration belongs to. Registrations saved
   before the event picker existed have no event on them, so they land
   in `unassigned` rather than being silently dropped. */
function getEventBucket(r) {
  return getEventKey(r.eventKey || r.event) || 'unassigned';
}

/* Tally registrations per event (Intramurals / Sportsfest / Prisaa). */
function buildEventCounts(registrations) {
  const counts = { unassigned: 0 };
  EVENT_TYPES.forEach(({ key }) => { counts[key] = 0; });
  registrations.filter(countsAsPlayer).forEach((r) => {
    counts[getEventBucket(r)]++;
  });
  return counts;
}

const TEAM_COLORS = {
  'Black Beetles':   '#1a1a1a',
  'Purple Jaguars':  '#6d28d9',
  'Brown Cubs':      '#92400e',
  'Orange Bulldogs': '#ea580c',
  'Yellow Vipers':   '#b45309',
  'Maroon Owls':     '#9f1239',
  'Green Gators':    '#15803d',
  'Red Rhinos':      '#dc2626',
};

const TABS = ['Registration', 'Venues', 'Sports & Teams', 'Match Schedules Format', 'Schedule Requests'];
const VENUES_TAB_INDEX = TABS.indexOf('Venues');
const REGISTRATION_TAB_INDEX = TABS.indexOf('Registration');
const SPORTS_TEAMS_TAB_INDEX = TABS.indexOf('Sports & Teams');
const MATCH_SCHEDULES_TAB_INDEX = TABS.indexOf('Match Schedules Format');
const SCHEDULE_REQUESTS_TAB_INDEX = TABS.indexOf('Schedule Requests');

/* ═══════════════════════════════════════════════════════════════════════
   MATCH SCHEDULES FORMAT — everything below (through MatchScheduleFormatSection)
   used to live in its own file. It's merged in here since Registration,
   Sports & Teams, and Match Schedules Format are all admin-only screens
   that belong to this one page.
═══════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════
   FORMAT OPTIONS — same ids used by SportsTeamsManager's
   per-division format picker, so a division's saved format
   is already the pre-selected default here.
═══════════════════════════════════════════ */
const FORMATS = [
  { id: 'single-rr', label: 'Single Round-Robin' },
  { id: 'double-rr', label: 'Double Round-Robin' },
  { id: 'bracket',   label: 'Single Bracket' },
  { id: 'double-bracket', label: 'Double Bracket' },
];

const uid = () => Math.random().toString(36).slice(2, 10);
const LEVEL_LABELS = { elementary: 'Elementary', highSchool: 'High School', college: 'College' };

/* Firestore denies a write/read with `permission-denied` for anything a
   security rule doesn't explicitly allow — that reads identically to an
   actual offline/network failure unless it's checked for by name, so a
   generic "check your connection" message would misdiagnose a rules gap. */
function friendlyFirestoreError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  return isPermission
    ? `${fallback} — your account doesn't have permission for this yet (check Firestore rules).`
    : `${fallback} — check your connection and try again.`;
}

/* ═══════════════════════════════════════════
   AUTO-SCHEDULING — date/time assignment for a freshly generated schedule.
   All matches in the same round (round-robin) or stage (bracket/double
   bracket) share one time slot, since they're played on different courts
   at once; the next round/stage starts SLOT_GAP_MINUTES later. Once a
   slot would land at/after DAY_CUTOFF_MINUTES, scheduling rolls over to
   the next calendar day, restarting at the admin's chosen start time.
   Purely a starting point — every match stays editable afterward via the
   per-match Edit modal, same as before this existed.
═══════════════════════════════════════════ */
const SLOT_GAP_MINUTES = 90;
const DAY_CUTOFF_MINUTES = 17 * 60; // 5:00 PM

const scheduleGroupKey = (m) => m.stage ?? `round-${m.round}`;
const timeStrToMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const minutesToTimeStr = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const addDaysToDateStr = (dateStr, days) => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

function assignAutoSchedule(matches, startDate, startTime) {
  let currentDate = startDate;
  let currentMinutes = timeStrToMinutes(startTime);
  let prevKey = null;
  let isFirstGroup = true;

  return matches.map((m) => {
    const key = scheduleGroupKey(m);
    if (key !== prevKey) {
      if (!isFirstGroup) {
        currentMinutes += SLOT_GAP_MINUTES;
        if (currentMinutes >= DAY_CUTOFF_MINUTES) {
          currentDate = addDaysToDateStr(currentDate, 1);
          currentMinutes = timeStrToMinutes(startTime);
        }
      }
      isFirstGroup = false;
      prevKey = key;
    }
    return { ...m, date: currentDate, time: minutesToTimeStr(currentMinutes) };
  });
}

/* Was this match produced by the round-robin/bracket generator (as opposed
   to the manual "Add Schedule" form)? Newer records carry an explicit
   `source` flag, but matches saved before that flag existed don't — for
   those, fall back to shape: only the generator ever sets `round` to a
   number or attaches `stage`/`matchLabel`; the manual form always saves
   `round: null` and never sets those fields. */
/* ── Moderator results, matched back onto the admin's fixtures ──
   The admin needs to see which matches already have a saved result: those
   are the ones that must not be silently re-dated or deleted, because the
   Ranking page has already applied their points. ── */
function normText(value) {
  return (value || '').trim().toLowerCase();
}

function stripFormatSuffix(category) {
  return (category || '').trim().replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '').trim();
}

function recordMatchesSchedule(record, schedule) {
  if (!record || !schedule) return false;
  if (record.scheduleId) return String(record.scheduleId) === String(schedule.id);
  if (normText(record.sportName) !== normText(schedule.sport)) return false;
  const rc = normText(stripFormatSuffix(record.category));
  const sc = normText(stripFormatSuffix(schedule.category));
  if (rc && sc && rc !== sc && !rc.endsWith(` ${sc}`) && !sc.endsWith(` ${rc}`)) return false;
  const roster = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const names = roster.map(p => normText(p?.name)).filter(Boolean);
  return names.includes(normText(schedule.teamA)) && names.includes(normText(schedule.teamB));
}

function recordWinnerName(record) {
  if (!record || record.draw || record.winner === 'DRAW') return null;
  const roster = record.participants?.length ? record.participants : [];
  if (roster.length > 2) return roster.find(p => p.place === 1)?.name || null;
  if (record.winner === 'A') return record.teamA?.name || null;
  if (record.winner === 'B') return record.teamB?.name || null;
  return null;
}

function isGeneratedMatch(m) {
  if (!m) return false;
  if (m.source) return m.source === 'generated';
  return m.round != null || !!m.stage || !!m.matchLabel;
}

/* ── Circular team network — visual overview of who's in the pool ── */
function TeamNetwork({ teams }) {
  const width = 620, height = 220, cx = width / 2, cy = height / 2, r = 82;
  const pts = teams.map((t, i) => {
    const a = (Math.PI * 2 * i) / teams.length - Math.PI / 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), t };
  });
  const lines = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      lines.push(<line key={`${i}-${j}`} x1={pts[i].x} y1={pts[i].y} x2={pts[j].x} y2={pts[j].y} stroke="#c7cfe6" strokeWidth="0.7" />);
    }
  }
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="msf-network">
      <defs>
        {pts.map((p, i) => p.t.logo && (
          <clipPath key={`clip-${i}`} id={`msf-network-clip-${i}`}>
            <circle cx={p.x} cy={p.y} r="18" />
          </clipPath>
        ))}
      </defs>
      {lines}
      {pts.map((p, i) => (
        <g key={i}>
          {p.t.logo ? (
            <>
              <image
                href={p.t.logo} x={p.x - 18} y={p.y - 18} width="36" height="36"
                clipPath={`url(#msf-network-clip-${i})`} preserveAspectRatio="xMidYMid slice"
              />
              <circle cx={p.x} cy={p.y} r="18" fill="none" stroke="#fff" strokeWidth="2" />
            </>
          ) : (
            <>
              <circle cx={p.x} cy={p.y} r="18" fill={p.t.color || '#5b678a'} stroke="#fff" strokeWidth="2" />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
                {(p.t.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </text>
            </>
          )}
        </g>
      ))}
    </svg>
  );
}

/* ── Generic navy dropdown, shared shape for Sports / Category / Format ── */
function FilterDropdown({ label, value, placeholder, options, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="msf-field" ref={wrapRef}>
      <label>{label}</label>
      <div className={`msf-select ${open ? 'msf-select--open' : ''}`}>
        <button
          type="button"
          className="msf-select__btn"
          disabled={disabled}
          onClick={() => setOpen(o => !o)}
        >
          {value || placeholder}
          <FaChevronDown className="msf-select__arrow" />
        </button>
        {open && (
          <div className="msf-select__panel">
            <div className="msf-select__title">{label} OPTION</div>
            {options.length === 0 && <div className="msf-select__empty">Nothing configured yet</div>}
            {options.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`msf-select__opt ${value === opt.label ? 'msf-select__opt--active' : ''}`}
                onClick={() => { onChange(opt); setOpen(false); }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Team badge: uploaded logo if present, else a colored initial circle ── */
function TeamBadge({ team, size = 52 }) {
  const initials = (team?.name || '??').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return team?.logo ? (
    <img src={team.logo} alt={team.name} className="msf-team-logo" style={{ width: size, height: size }} />
  ) : (
    <div className="msf-team-logo msf-team-logo--fallback" style={{ width: size, height: size, background: team?.color || '#5b678a' }}>
      {initials}
    </div>
  );
}

/* ═══════════════════════════════════════════
   ROUND-ROBIN GENERATOR
   Circle method: fixes team[0], rotates the rest each round
   so every team plays every other team exactly once (twice for
   double round-robin). An odd team count gets a bye each round.
═══════════════════════════════════════════ */
function generateRounds(teamNames, doubleLegged) {
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
function stageNamesFor(totalRounds) {
  const tail = ['Finals'];
  if (totalRounds >= 2) tail.unshift('Semifinals');
  if (totalRounds >= 3) tail.unshift('Quarterfinals');
  for (let extra = totalRounds - 3; extra >= 1; extra--) {
    tail.unshift(`Round of ${Math.pow(2, extra + 3)}`);
  }
  return tail;
}
function stageCodeFor(name) {
  if (name === 'Finals') return 'F';
  if (name === 'Semifinals') return 'SF';
  if (name === 'Quarterfinals') return 'QF';
  const m = name.match(/Round of (\d+)/);
  return m ? `R${m[1]}` : 'M';
}

function generateBracket(teamNames) {
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

/* ── Horizontal bracket tree: team boxes → round dots → champion ──
   Coordinates are computed once per render: each match's y is the
   average of its two children's y, which is what naturally produces
   the classic elbow-merge bracket look with plain straight lines. ── */
function BracketTree({ stages, leaves, teamByName }) {
  const ROW_H = 60;
  const TEAM_W = 168;
  const TEAM_H = 40;
  const COL_GAP = 130;

  if (!stages.length) return null;
  const totalRounds = stages.length;
  const leafY = leaves.map((_, i) => i * ROW_H + ROW_H / 2);

  const matchY = [];
  stages.forEach((stage, r) => {
    matchY.push(stage.matches.map((_, m) => (
      r === 0
        ? (leafY[2 * m] + leafY[2 * m + 1]) / 2
        : (matchY[r - 1][2 * m] + matchY[r - 1][2 * m + 1]) / 2
    )));
  });

  const colX = (r) => TEAM_W + (r + 1) * COL_GAP;
  const championX = colX(totalRounds - 1) + COL_GAP;
  const championY = matchY[totalRounds - 1][0];
  const height = leaves.length * ROW_H;
  const width = championX + 130;

  const elbow = (childX, y1, y2, parentX, parentY) => {
    const midX = (childX + parentX) / 2;
    return `M ${childX} ${y1} H ${midX} M ${childX} ${y2} H ${midX} M ${midX} ${y1} V ${y2} M ${midX} ${parentY} H ${parentX}`;
  };

  const connectors = [];
  stages.forEach((stage, r) => {
    const childX = r === 0 ? TEAM_W : colX(r - 1);
    stage.matches.forEach((_, m) => {
      const y1 = r === 0 ? leafY[2 * m] : matchY[r - 1][2 * m];
      const y2 = r === 0 ? leafY[2 * m + 1] : matchY[r - 1][2 * m + 1];
      connectors.push(elbow(childX, y1, y2, colX(r), matchY[r][m]));
    });
  });
  connectors.push(`M ${colX(totalRounds - 1)} ${championY} H ${championX}`);

  return (
    <div className="msf-bracket" style={{ height }}>
      <div className="msf-bracket-headers">
        <div style={{ width: colX(0) }}>{stages[0].name}</div>
        {stages.slice(1).map((s, i) => <div key={i} style={{ width: COL_GAP }}>{s.name}</div>)}
        <div style={{ width: width - colX(totalRounds - 1) }}>Champion</div>
      </div>

      <div className="msf-bracket-canvas" style={{ height, width }}>
        <svg width={width} height={height} className="msf-bracket-lines">
          {connectors.map((d, i) => <path key={i} d={d} />)}
        </svg>

        {leaves.map((name, i) => (
          name ? (
            <div key={i} className="msf-bracket-team" style={{ top: leafY[i] - TEAM_H / 2, height: TEAM_H, width: TEAM_W }}>
              <TeamBadge team={teamByName(name)} size={26} />
              <span>{name}</span>
            </div>
          ) : (
            <div key={i} className="msf-bracket-team msf-bracket-team--bye" style={{ top: leafY[i] - TEAM_H / 2, height: TEAM_H, width: TEAM_W }}>
              <span>Bye</span>
            </div>
          )
        ))}

        {stages.map((stage, r) => stage.matches.map((match, m) => (
          <div key={`${r}-${m}`} className="msf-bracket-node" style={{ left: colX(r), top: matchY[r][m] }}>
            <span className="msf-bracket-node__dot" />
            <span className="msf-bracket-node__label">{r === totalRounds - 1 ? 'GC' : match.label}</span>
          </div>
        )))}

        <div className="msf-bracket-champion" style={{ left: championX, top: championY }}>
          <FaTrophy />
          <span>Champion</span>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   DOUBLE BRACKET (double elimination) GENERATOR
   Reuses the single-elim generator for the Upper (Winner's) Bracket.
   Lower (Loser's) Bracket: Round 1 pairs the Upper Bracket's first-round
   losers against each other; every later Upper Bracket round drops its
   losers into the Lower Bracket against that round's Lower Bracket
   survivors (cross-paired one slot over, so nobody instantly replays
   the team that just eliminated them), followed by a consolidation
   match that halves the Lower Bracket field again. The Lower Bracket's
   last team meets the Upper Bracket's last team in the Grand Final.
   Standard tournament rule: if the Lower Bracket team wins the Grand
   Final, the Upper Bracket team only has ONE loss so far (double
   elimination requires two) — a single reset match is then needed to
   decide the real champion. That's why the total is "N (up to N+1)".
═══════════════════════════════════════════ */
function generateDoubleBracket(teamNames) {
  const wb = generateBracket(teamNames);
  if (!wb.stages.length) {
    return { wbStages: [], leaves: [], lbRounds: [], grandFinal: null, ubMatchCount: 0, lbMatchCount: 0, totalMatches: 0 };
  }

  const wbStages = wb.stages;
  const R = wbStages.length;

  const wbLoserLabel = (stageIdx, matchIdx) => {
    const code = stageIdx === R - 1 ? 'F' : stageCodeFor(wbStages[stageIdx].name);
    return `Loser UB-${code}${matchIdx + 1}`;
  };

  const lbRounds = [];
  let lbCounter = 1;

  // LB Round 1 — pairs of Upper Bracket round-1 losers
  const r0 = wbStages[0].matches;
  const round1 = [];
  for (let i = 0; i < r0.length; i += 2) {
    round1.push({ label: `LB${lbCounter++}`, a: wbLoserLabel(0, i), b: r0[i + 1] ? wbLoserLabel(0, i + 1) : null });
  }
  lbRounds.push({ name: 'Round 1', matches: round1 });
  let currentWinners = round1.map(m => `Winner ${m.label}`);

  for (let wr = 1; wr < R; wr++) {
    const isLastWBRound = wr === R - 1;
    const wbLosers = wbStages[wr].matches.map((_, i) => wbLoserLabel(wr, i));

    if (isLastWBRound) {
      lbRounds.push({ name: "Losers Final", matches: [{ label: 'LB-F', a: currentWinners[0], b: wbLosers[0] }] });
      currentWinners = ['Winner LB-F'];
    } else {
      const dropIn = currentWinners.map((w, i) => ({
        label: `LB${lbCounter++}`,
        a: w,
        b: wbLosers[(i + 1) % wbLosers.length],
      }));
      lbRounds.push({ name: `Round ${lbRounds.length + 1}`, matches: dropIn });
      let winners = dropIn.map(m => `Winner ${m.label}`);

      if (winners.length > 1) {
        const consolidation = [];
        for (let i = 0; i < winners.length; i += 2) {
          consolidation.push({ label: `LB${lbCounter++}`, a: winners[i], b: winners[i + 1] });
        }
        lbRounds.push({ name: `Round ${lbRounds.length + 1}`, matches: consolidation });
        currentWinners = consolidation.map(m => `Winner ${m.label}`);
      } else {
        currentWinners = winners;
      }
    }
  }

  const grandFinal = { label: 'GF', a: 'Winner UB-F', b: currentWinners[0] };
  const ubMatchCount = wbStages.reduce((s, st) => s + st.matches.filter(m => !m.isBye).length, 0);
  const lbMatchCount = lbRounds.reduce((s, r) => s + r.matches.length, 0);

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

/* ── Compact label-only bracket tree — used for both the Upper Bracket
   (minus its champion box, since the winner heads to the Grand Final
   instead) and the Lower Bracket (which has no real team names at all,
   only "Loser UB-QF1" / "Winner LB1" style placeholders). ── */
function LabelBracketTree({ roundNames, roundsMatches, leafLabels }) {
  const ROW_H = 44;
  const LEAF_W = 168;
  const LEAF_H = 32;
  const COL_GAP = 118;

  const totalRounds = roundsMatches.length;
  if (!totalRounds) return null;

  const leafCount = leafLabels ? leafLabels.length : roundsMatches[0].length * 2;
  const leafY = Array.from({ length: leafCount }, (_, i) => i * ROW_H + ROW_H / 2);

  const matchY = [];
  roundsMatches.forEach((matches, r) => {
    matchY.push(matches.map((_, m) => (
      r === 0
        ? ((leafY[2 * m] ?? leafY[2 * m + 1]) + (leafY[2 * m + 1] ?? leafY[2 * m])) / 2
        : ((matchY[r - 1][2 * m] ?? matchY[r - 1][2 * m + 1]) + (matchY[r - 1][2 * m + 1] ?? matchY[r - 1][2 * m])) / 2
    )));
  });

  const colX = (r) => LEAF_W + (r + 1) * COL_GAP;
  const height = Math.max(leafCount * ROW_H, matchY[totalRounds - 1][0] + ROW_H);
  const width = colX(totalRounds - 1) + 30;

  const elbow = (childX, y1, y2, parentX, parentY) => {
    const midX = (childX + parentX) / 2;
    return `M ${childX} ${y1} H ${midX} M ${childX} ${y2} H ${midX} M ${midX} ${y1} V ${y2} M ${midX} ${parentY} H ${parentX}`;
  };

  const connectors = [];
  roundsMatches.forEach((matches, r) => {
    const childX = r === 0 ? LEAF_W : colX(r - 1);
    matches.forEach((m, i) => {
      const hasTwoChildren = r > 0 || (m.a && m.b);
      if (!hasTwoChildren) return;
      const y1 = r === 0 ? leafY[2 * i] : matchY[r - 1][2 * i];
      const y2 = r === 0 ? (leafY[2 * i + 1] ?? leafY[2 * i]) : (matchY[r - 1][2 * i + 1] ?? matchY[r - 1][2 * i]);
      connectors.push(elbow(childX, y1, y2, colX(r), matchY[r][i]));
    });
  });

  return (
    <div className="msf-lbracket" style={{ height: height + 34 }}>
      <div className="msf-lbracket-headers">
        {leafLabels && <div style={{ width: colX(0) }}>{roundNames[0]}</div>}
        {roundNames.slice(leafLabels ? 1 : 0).map((n, i) => <div key={i} style={{ width: COL_GAP }}>{n}</div>)}
      </div>
      <div className="msf-lbracket-canvas" style={{ height, width }}>
        <svg width={width} height={height} className="msf-bracket-lines">
          {connectors.map((d, i) => <path key={i} d={d} />)}
        </svg>

        {leafLabels && leafLabels.map((label, i) => (
          <div key={i} className="msf-lbracket-leaf" style={{ top: leafY[i] - LEAF_H / 2, height: LEAF_H, width: LEAF_W }}>
            <span className="msf-lbracket-leaf__dot" />
            <span>{label}</span>
          </div>
        ))}

        {roundsMatches.map((matches, r) => matches.map((m, i) => (
          <div key={`${r}-${i}`} className="msf-bracket-node" style={{ left: colX(r), top: matchY[r][i] }}>
            <span className="msf-bracket-node__dot" />
            <span className="msf-bracket-node__label">{m.label}</span>
          </div>
        )))}
      </div>
    </div>
  );
}

function MatchScheduleFormatSection({ level, pendingRequest, onConsumedPrefill, actorRole }) {
  const [sportsList, setSportsList] = useState([]);
  const [teamsList,  setTeamsList]  = useState([]);
  const [loading,    setLoading]    = useState(false);

  const [selSport,    setSelSport]    = useState(null); // sport object
  const [selCategory, setSelCategory] = useState(null); // { label, value, format }
  const [selFormat,   setSelFormat]   = useState(null); // { id, label }
  const [activeRound, setActiveRound] = useState(0);

  /* Start date/time for auto-scheduling a freshly generated set — the admin
     picks these before saving, and every match still stays editable
     afterward via the per-match Edit modal. */
  const [scheduleStartDate, setScheduleStartDate] = useState('');
  const [scheduleStartTime, setScheduleStartTime] = useState('');

  const [savedSchedules, setSavedSchedules] = useState([]); // persisted matches, this level
  const [matchRecords, setMatchRecords] = useState([]);     // results saved by Moderator, this level
  const [venues, setVenues] = useState([]);                 // admin-entered venue list (global)
  const [allSchedules, setAllSchedules] = useState([]);      // matches across EVERY level, for venue conflict checks
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [toast, setToast] = useState(null); // { text } | null
  const [successModal, setSuccessModal] = useState(null); // { sport, category, format, teams, rounds, matches } | null
  const listRef = useRef(null);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm, setAddForm] = useState({ sport: '', category: '', date: '', time: '', location: '', matchLabel: '', pairs: [{ teamA: '', teamB: '' }] });
  // Set only while the currently-open Add Schedule modal is fulfilling a
  // moderator's schedule request — cleared as soon as it's saved or the
  // modal is closed, so it can never wrongly mark a later, unrelated
  // "Add Schedule" as resolving an old request.
  const [fulfillingRequestId, setFulfillingRequestId] = useState(null);

  // Prefills the Add Schedule form (sport/division/both teams) from a
  // schedule request the admin chose to open here — see
  // AdminSchedulePage's "Open Match Schedules" action on the Schedule
  // Requests tab. `pendingRequest` is a one-shot "command" prop, so this
  // is the "adjust state when a prop changes" pattern React's own docs
  // call out as safe to run directly during render (guarded by the id
  // comparison below) rather than in an effect — it's a pure, synchronous
  // derivation of this component's own state, not a side effect.
  const [lastHandledRequestId, setLastHandledRequestId] = useState(null);
  if (pendingRequest && pendingRequest.id !== lastHandledRequestId) {
    setLastHandledRequestId(pendingRequest.id);
    setAddForm({
      sport: pendingRequest.sport || '',
      category: pendingRequest.category || '',
      date: '', time: '', location: '',
      matchLabel: pendingRequest.reason || '',
      pairs: [{ teamA: pendingRequest.teamA || '', teamB: pendingRequest.teamB || '' }],
    });
    setFulfillingRequestId(pendingRequest.id);
    setAddModalOpen(true);
  }

  // Telling the parent the request has been consumed DOES belong in an
  // effect — that's notifying an external system (the parent's own
  // state), not deriving this component's.
  useEffect(() => {
    if (pendingRequest && pendingRequest.id === lastHandledRequestId) onConsumedPrefill?.();
  }, [pendingRequest, lastHandledRequestId, onConsumedPrefill]);

  /* ── Manual "Edit Schedule" ── */
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState(null); // full match object being edited, or null

  /* ── Load Sports & Teams config (admin-entered, per level) ── */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getSportsTeamsConfig(level);
      setSportsList(cfg.sports || []);
      setTeamsList(cfg.teams || []);
      const schedules = await getMatchSchedules(level);
      setSavedSchedules(schedules);
      /* Optional: the schedule manager still works if results can't be
         read, it just won't show which fixtures are already recorded. */
      try {
        setMatchRecords(await getMatchRecords(level) || []);
      } catch (recordError) {
        console.warn('Match records unavailable:', recordError);
        setMatchRecords([]);
      }
      /* Venues + every level's schedules — needed to disable an
         already-booked venue in the Add/Edit Schedule dropdowns. Optional
         in the same spirit as match records: a failure here shouldn't
         block the rest of the page, it just means venues show unrestricted. */
      try {
        const [v, all] = await Promise.all([getVenues(), getAllMatchSchedules()]);
        setVenues(v);
        setAllSchedules(all);
      } catch (venueError) {
        console.warn('Venues unavailable:', venueError);
        setVenues([]);
        setAllSchedules([]);
      }
    } catch (e) {
      console.error('Failed to load sports/teams/schedules:', e);
    } finally {
      setLoading(false);
    }
  }, [level]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  /* ── Category options come from a sport's own divisions.
     If the admin never set up divisions for this sport, fall back to a
     single "General" category so the flow isn't blocked.
     The group label is the schedule division (for example, Men/Women).
     Do not save the child division name here because it is also used for
     the match format (for example, 5v5) and must not appear in SPORTS.
     Shared by the generator's own Sport pick and the manual "Add Schedule"
     modal's Sport pick, so both always resolve categories the same way. ── */
  const categoryOptionsFor = (sportObj) => {
    const raw = (sportObj?.categoryGroups || []).flatMap(g =>
      (g.divisions || []).map(d => {
        const division = (g.label || d.name || '').trim();
        return { value: d.id, label: division, format: d.format };
      })
    );
    return raw.length > 0
      ? raw
      : sportObj
        ? [{ value: 'general', label: 'General', format: null }]
        : [];
  };
  const categoryOptions = categoryOptionsFor(selSport);

  /* ── Teams eligible for a given sport ──
     NOTE: despite the field name, SportsTeamsManager's TeamSportsPickerModal
     stores sport *names* in team.sportIds, not sport ids. Match on name,
     case/whitespace-insensitive so a rename or stray casing difference
     doesn't drop a team the admin genuinely assigned.
     Also requires a real (non-blank) team name and dedupes by id (fallback
     to name) — otherwise a team that was ever saved twice in Firestore, or
     a blank draft row that slipped through, would show up as a selectable
     "team" the admin never actually added. ── */
  const norm = (s) => (s || '').trim().toLowerCase();
  const teamsForSport = (sportName) => {
    if (!sportName) return [];
    return Array.from(
      new Map(
        teamsList
          .filter(t =>
            (t.name || '').trim() &&
            (t.sportIds || []).some(id => norm(id) === norm(sportName))
          )
          .map(t => [t.id || t.name, t])
      ).values()
    );
  };

  const eligibleTeams = teamsForSport(selSport?.name);

  const handlePickSport = (opt) => {
    setSelSport(opt.raw);
    setSelCategory(null);
    setSelFormat(null);
    setActiveRound(0);
  };
  const handlePickCategory = (opt) => {
    setSelCategory(opt.raw);
    // Pre-fill format with whatever was configured for this division in Sports & Teams
    const preset = FORMATS.find(f => f.id === opt.raw.format);
    setSelFormat(preset || null);
    setActiveRound(0);
  };
  const handlePickFormat = (opt) => { setSelFormat(opt.raw); setActiveRound(0); };

  const handleReset = () => {
    setSelSport(null); setSelCategory(null); setSelFormat(null); setActiveRound(0);
    setScheduleStartDate(''); setScheduleStartTime('');
  };

  const ready = selSport && selCategory && selFormat && eligibleTeams.length >= 2;
  const isBracket = selFormat?.id === 'bracket';
  const isDoubleBracket = selFormat?.id === 'double-bracket';
  const isDoubleLeg = selFormat?.id === 'double-rr';

  /* ── Regeneration lock ──
     Once a schedule has been saved for a (sport, category), generating
     again for that sport/category is blocked — regardless of which
     format it was generated with — the admin must explicitly reset
     (delete) that set first before picking any format again. This
     intentionally does NOT key on level, because savedSchedules is
     already scoped to the current level's own `matchSchedules/{level}`
     document. */
  const lockedMatches = (selSport && selCategory)
    ? savedSchedules.filter(m => m.sport === selSport.name && m.category === selCategory.label)
    : [];
  const isLocked = lockedMatches.length > 0;
  const lockedResultsCount = lockedMatches.filter(m => matchRecords.some(r => recordMatchesSchedule(r, m))).length;

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resettingSchedule, setResettingSchedule] = useState(false);

  const handleResetClick = () => {
    if (isLocked) {
      setResetConfirmOpen(true);
    } else {
      handleReset();
    }
  };

  const handleConfirmResetSchedule = async () => {
    if (!selSport || !selCategory) return;
    setResettingSchedule(true);
    try {
      const remaining = await deleteScheduleSet(level, selSport.name, selCategory.label, actorRole);
      setSavedSchedules(remaining);
      syncAllSchedulesForLevel(remaining);
      setResetConfirmOpen(false);
      setActiveRound(0);
      setToast({ text: 'Schedule reset — you can now generate a new one.' });
    } catch (e) {
      console.error('Failed to reset schedule:', e);
      setToast({ text: 'Failed to reset schedule — try again.' });
    } finally {
      setResettingSchedule(false);
    }
  };

  const rounds = ready && !isBracket && !isDoubleBracket
    ? generateRounds(eligibleTeams.map(t => t.name), isDoubleLeg)
    : [];
  const bracket = ready && isBracket
    ? generateBracket(eligibleTeams.map(t => t.name))
    : null;
  const doubleBracket = ready && isDoubleBracket
    ? generateDoubleBracket(eligibleTeams.map(t => t.name))
    : null;

  const totalMatches = isBracket
    ? (bracket?.totalMatches || 0)
    : isDoubleBracket
      ? (doubleBracket?.totalMatches || 0)
      : rounds.reduce((s, r) => s + r.length, 0);
  const legSize = isDoubleLeg ? rounds.length / 2 : rounds.length;

  const teamByName = (name) => eligibleTeams.find(t => t.name === name);

  /* ── Save the generated schedule ── */
  const handleSaveGenerated = async () => {
    if (!scheduleStartDate || !scheduleStartTime) return;

    const buildMatch = (extra) => ({
      id: uid(),
      sport: selSport.name,
      category: selCategory.label,
      format: selFormat.label,
      teamALogo: teamByName(extra.teamA)?.logo || null,
      teamBLogo: teamByName(extra.teamB)?.logo || null,
      date: '',
      time: '',
      location: '',
      status: 'scheduled',
      source: 'generated',
      ...extra,
    });

    let matches;
    if (isBracket) {
      matches = bracket.stages.flatMap((stage, stageIdx) =>
        stage.matches
          .filter(m => !m.isBye) // a bye has no actual game — the team just advances
          .map(m => buildMatch({ round: stageIdx + 1, stage: stage.name, matchLabel: m.label, teamA: m.a, teamB: m.b }))
      );
    } else if (isDoubleBracket) {
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
      matches = [...ubMatches, ...lbMatches, gfMatch];
    } else {
      matches = rounds.flatMap((pairs, roundIdx) =>
        pairs.map(([a, b]) => buildMatch({ round: roundIdx + 1, teamA: a, teamB: b }))
      );
    }

    matches = assignAutoSchedule(matches, scheduleStartDate, scheduleStartTime);

    setSavingSchedule(true);
    try {
      const merged = await saveGeneratedSchedule(level, matches, actorRole);
      setSavedSchedules(merged);
      syncAllSchedulesForLevel(merged);
      setSuccessModal({
        sport: selSport.name,
        category: selCategory.label,
        format: selFormat.label,
        teams: eligibleTeams.length,
        rounds: isBracket ? bracket.stages.length : isDoubleBracket ? doubleBracket.wbStages.length + doubleBracket.lbRounds.length + 1 : rounds.length,
        matches: totalMatches,
      });
    } catch (e) {
      console.error('Failed to save schedule:', e);
      setToast({ text: 'Could not save schedule — check your connection and try again.' });
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleReviewSummary = () => {
    setSuccessModal(null);
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* ── Venue availability ──
     A venue is "occupied" when another match — any sport, any level,
     since it's the same physical space — already sits at the exact same
     date + time. `excludeId` lets the Edit modal ignore the match it's
     currently editing, so re-saving it without changing date/time/venue
     doesn't lock itself out. Blank date/time means nothing to conflict
     with yet, so nothing is disabled until both are picked. */
  const venueOccupied = (venueName, date, time, excludeId) => {
    if (!venueName || !date || !time) return false;
    return allSchedules.some(m =>
      m.id !== excludeId &&
      (m.location || '') === venueName &&
      m.date === date &&
      m.time === time
    );
  };

  /* Keeps allSchedules (used for venue conflict checks) in sync with this
     level's matches right after a save/delete, without a full re-fetch
     of every level. */
  const syncAllSchedulesForLevel = (levelMatches) => {
    setAllSchedules(prev => [
      ...prev.filter(m => m.level !== level),
      ...levelMatches.map(m => ({ ...m, level })),
    ]);
  };

  /* ── Manual "Add Schedule" ── */
  const handleAddTeamRow = () => {
    setAddForm(f => ({ ...f, pairs: [...f.pairs, { teamA: '', teamB: '' }] }));
  };
  const handlePairChange = (idx, side, value) => {
    setAddForm(f => ({
      ...f,
      pairs: f.pairs.map((p, i) => (i === idx ? { ...p, [side]: value } : p)),
    }));
  };

  const handleConfirmAdd = async () => {
    const validPairs = addForm.pairs.filter(p => p.teamA && p.teamB);
    if (!addForm.sport || !addForm.category || !addForm.date || !addForm.time || validPairs.length === 0) return;
    if (venueOccupied(addForm.location, addForm.date, addForm.time, null)) {
      setToast({ text: 'That venue is already booked at this date & time — pick another.' });
      return;
    }
    const pool = teamsList.filter(t => (t.sportIds || []).includes(addForm.sport));
    const addSportObj = sportsList.find(s => s.name === addForm.sport) || null;
    const matchedDivision = categoryOptionsFor(addSportObj).find(o => o.label === addForm.category);
    const presetFormat = FORMATS.find(f => f.id === matchedDivision?.format);

    let merged = savedSchedules;
    for (const pair of validPairs) {
      const match = {
        id: uid(),
        sport: addForm.sport,
        category: addForm.category,
        format: presetFormat?.label || '',
        round: null,
        teamA: pair.teamA,
        teamB: pair.teamB,
        teamALogo: pool.find(t => t.name === pair.teamA)?.logo || null,
        teamBLogo: pool.find(t => t.name === pair.teamB)?.logo || null,
        date: addForm.date,
        time: addForm.time,
        location: addForm.location,
        matchLabel: addForm.matchLabel.trim() || null,
        status: 'scheduled',
        source: 'manual',
        requestId: fulfillingRequestId || null,
      };
      merged = await upsertMatchSchedule(level, match, actorRole);
    }
    setSavedSchedules(merged);
    syncAllSchedulesForLevel(merged);
    setAddModalOpen(false);

    if (fulfillingRequestId) {
      const requestId = fulfillingRequestId;
      setFulfillingRequestId(null);
      updateScheduleRequest(requestId, { status: 'scheduled' }, actorRole).catch((err) => {
        console.error('Failed to auto-mark schedule request as scheduled:', err);
      });
    }
  };

  /* ── Manual "Edit Schedule" ── */
  const openEditModal = (match) => {
    setEditForm({ ...match });
    setEditModalOpen(true);
    setDeleteConfirmOpen(false);
  };

  const editPool = teamsForSport(editForm?.sport);
  const editCategoryOptions = categoryOptionsFor(sportsList.find(s => s.name === editForm?.sport) || null);

  const handleConfirmEdit = async () => {
    if (!editForm || !editForm.category || !editForm.date || !editForm.time || !editForm.teamA || !editForm.teamB) return;
    if (venueOccupied(editForm.location, editForm.date, editForm.time, editForm.id)) {
      setToast({ text: 'That venue is already booked at this date & time — pick another.' });
      return;
    }
    const updated = {
      ...editForm,
      teamALogo: editPool.find(t => t.name === editForm.teamA)?.logo ?? editForm.teamALogo ?? null,
      teamBLogo: editPool.find(t => t.name === editForm.teamB)?.logo ?? editForm.teamBLogo ?? null,
      matchLabel: (editForm.matchLabel || '').trim() || null,
    };
    const merged = await upsertMatchSchedule(level, updated, actorRole);
    setSavedSchedules(merged);
    syncAllSchedulesForLevel(merged);
    setEditModalOpen(false);
    setEditForm(null);
    setToast({ text: 'Schedule updated successfully.' });
  };

  /* ── Delete Schedule (from the Edit modal) ── */
  const [deletingSchedule, setDeletingSchedule] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const handleDeleteSchedule = async () => {
    if (!editForm?.id) return;
    setDeletingSchedule(true);
    try {
      const merged = await deleteMatchSchedule(level, editForm.id, actorRole);
      setSavedSchedules(merged);
      syncAllSchedulesForLevel(merged);
      setDeleteConfirmOpen(false);
      setEditModalOpen(false);
      setEditForm(null);
      setToast({ text: 'Schedule deleted.' });
    } catch (e) {
      console.error('Failed to delete schedule:', e);
      setToast({ text: 'Failed to delete schedule — try again.' });
    } finally {
      setDeletingSchedule(false);
    }
  };

  /* ── Grouped list view (by sport, then by date) ──
     Each sport gets its own table so, e.g., Badminton and Tennis fixtures
     never run together in one long list. Within a sport, anything saved
     without a date yet (every match that just came out of the generator)
     is surfaced separately up top instead of being silently dropped, so
     it's always reachable via Edit to add the date/time/venue. */
  const recordForMatch = (match) => matchRecords.find(r => recordMatchesSchedule(r, match)) || null;

  const sportSlug = (s) => (s || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const scheduleSportOrder = sportsList.map(s => s.name);
  const sportSections = Object.entries(
    savedSchedules.reduce((acc, m) => {
      const key = m.sport || 'Other';
      (acc[key] = acc[key] || []).push(m);
      return acc;
    }, {})
  )
    .sort(([a], [b]) => {
      const ia = scheduleSportOrder.indexOf(a);
      const ib = scheduleSportOrder.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map(([sport, matches]) => ({
      sport,
      count: matches.length,
      undated: matches.filter(m => !m.date),
      groupedByDate: matches.filter(m => m.date).reduce((acc, m) => {
        (acc[m.date] = acc[m.date] || []).push(m);
        return acc;
      }, {}),
    }));

  /* ── Download the visible schedule list as a PDF ──
     Mirrors the on-screen grouping (sport → date), one table per sport,
     so the printout matches what the admin is looking at. */
  const handleDownloadPdf = () => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFontSize(14);
    doc.setFont(undefined, 'bold');
    doc.text('SANTA RITA COLLEGE OF PAMPANGA, INC', pageWidth / 2, 40, { align: 'center' });
    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.text(`Match Schedule — ${LEVEL_LABELS[level] || level}`, pageWidth / 2, 58, { align: 'center' });
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`Generated ${new Date().toLocaleString()}`, pageWidth / 2, 72, { align: 'center' });
    doc.setTextColor(0);

    let cursorY = 90;
    sportSections.forEach(({ sport, undated, groupedByDate }) => {
      const rows = [];
      undated.forEach(m => rows.push(['TBD', 'TBD', m.teamA, m.teamB, m.location || '—']));
      Object.entries(groupedByDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([date, matches]) => {
          const dateLabel = new Date(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
          matches.forEach(m => rows.push([dateLabel, m.time || '—', m.teamA, m.teamB, m.location || '—']));
        });

      if (rows.length === 0) return;

      autoTable(doc, {
        startY: cursorY,
        head: [[sport, '', '', '', '']],
        body: [],
        theme: 'plain',
        styles: { fontSize: 11, fontStyle: 'bold' },
        margin: { left: 40, right: 40 },
      });
      autoTable(doc, {
        startY: doc.lastAutoTable.finalY,
        head: [['Date', 'Time', 'Team A', 'Team B', 'Venue']],
        body: rows,
        theme: 'grid',
        headStyles: { fillColor: [15, 32, 66] },
        styles: { fontSize: 9, cellPadding: 5 },
        margin: { left: 40, right: 40 },
      });
      cursorY = doc.lastAutoTable.finalY + 24;
    });

    doc.save(`match-schedule-${level}-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  if (loading) return <div className="msf-loading">Loading sports & teams…</div>;

  const sportOptions = sportsList.map(s => s.name);
  const addPool = teamsForSport(addForm.sport);
  const addCategoryOptions = categoryOptionsFor(sportsList.find(s => s.name === addForm.sport) || null);

  return (
    <div className="msf-wrap">
      <div className="msf-level-banner">
        <h2>{(LEVEL_LABELS[level] || level || '').toUpperCase()}</h2>
        <div className="msf-level-banner__bar" />
      </div>

      {/* ── GENERATOR CARD ── */}
      <div className="msf-card">
        <div className="msf-filters">
          <FilterDropdown
            label="SPORTS"
            value={selSport?.name}
            placeholder="Select sport"
            options={sportsList.map(s => ({ value: s.id, label: s.name, raw: s }))}
            onChange={handlePickSport}
          />
          <FilterDropdown
            label="CATEGORY/DIVISION"
            value={selCategory?.label}
            placeholder="Select category"
            options={categoryOptions.map(o => ({ value: o.value, label: o.label, raw: o }))}
            onChange={handlePickCategory}
            disabled={!selSport}
          />
          <FilterDropdown
            label="FORMAT"
            value={selFormat?.label}
            placeholder="Select format"
            options={FORMATS.map(f => ({ value: f.id, label: f.label, raw: f }))}
            onChange={handlePickFormat}
            disabled={!selCategory || isLocked}
          />
          <button className="msf-reset-btn" onClick={handleResetClick}>
            {isLocked ? <><FaTrash /> Reset Schedule</> : <><FaSync /> Reset</>}
          </button>
        </div>

        {isLocked ? (
          <div className="msf-result-head">
            <div>
              <h3>{selCategory.label}</h3>
              <p className="msf-muted">
                A schedule already exists for this sport and category ({lockedMatches[0]?.format || 'saved'}).
              </p>
              <p className="msf-form-note" style={{ color: '#a83218', fontWeight: 700 }}>
                Click "Reset Schedule" above to delete it before generating a new one in a different format.
              </p>
            </div>
            <div className="msf-stats">
              <div className="msf-stat"><span>Teams</span><b>{eligibleTeams.length}</b></div>
              <div className="msf-stat"><span>Saved matches</span><b>{lockedMatches.length}</b></div>
            </div>
          </div>
        ) : !ready ? (
          <p className="msf-empty">
            {selSport && eligibleTeams.length < 2
              ? `Only ${eligibleTeams.length} team(s) assigned to ${selSport.name} — add at least 2 in Sports & Teams.`
              : sportsList.length === 0
                ? 'No sports configured yet — add sports and teams in the Sports & Teams tab first.'
                : 'Pick a sport, category and format to generate the schedule.'}
          </p>
        ) : (
          <>
            <div className="msf-result-head">
              <div>
                <h3>{selFormat.label}</h3>
                <p className="msf-muted">
                  {isBracket || isDoubleBracket
                    ? "Lose twice and you're out."
                    : `Every team plays against each other team ${isDoubleLeg ? 'twice' : 'once'}.`}
                </p>
              </div>
              <div className="msf-stats">
                <div className="msf-stat"><span>Teams</span><b>{eligibleTeams.length}</b></div>
                <div className="msf-stat">
                  <span>Total matches</span>
                  <b>{totalMatches}{isDoubleBracket ? ` (up to ${totalMatches + 1})` : ''}</b>
                </div>
              </div>
            </div>

            {isDoubleBracket ? (
              <div className="msf-dbracket">
                <p className="msf-dbracket__label">Upper Bracket (Winner's Bracket)</p>
                <LabelBracketTree
                  roundNames={doubleBracket.wbStages.map(s => s.name === 'Finals' ? "Winner's Finals" : s.name)}
                  roundsMatches={doubleBracket.wbStages.map(stage => stage.matches.map(m => ({ label: m.label, a: m.a, b: m.b })))}
                  leafLabels={doubleBracket.leaves.map(name => name || 'Bye')}
                />

                <p className="msf-dbracket__label msf-dbracket__label--lower">Lower Bracket (Loser's Bracket)</p>
                <LabelBracketTree
                  roundNames={doubleBracket.lbRounds.map(r => r.name)}
                  roundsMatches={doubleBracket.lbRounds.map(round => round.matches.map(m => ({ label: m.label, a: m.a, b: m.b })))}
                  leafLabels={doubleBracket.lbRounds[0].matches.flatMap(m => [m.a || 'Bye', m.b || 'Bye'])}
                />

                <div className="msf-dbracket__final">
                  <div className="msf-dbracket__final-row">
                    <span className="msf-lbracket-leaf__dot" /> Winner UB-F
                  </div>
                  <div className="msf-dbracket__final-row">
                    <span className="msf-lbracket-leaf__dot" /> Winner LB-F
                  </div>
                  <FaTrophy className="msf-dbracket__trophy" />
                  <span className="msf-dbracket__champion-label">Grand Final Champion</span>
                  <p className="msf-dbracket__note">
                    If the Lower Bracket team wins the Grand Final, a single reset match decides the title —
                    that's the "up to {totalMatches + 1}" match.
                  </p>
                </div>
              </div>
            ) : isBracket ? (
              <BracketTree stages={bracket.stages} leaves={bracket.leaves} teamByName={teamByName} />
            ) : (
              <>
                <TeamNetwork teams={eligibleTeams} />

                <p className="msf-selectround-title">Select Round</p>
                {isDoubleLeg ? (
                  <div className="msf-roundgroups">
                    <div className="msf-roundgroup">
                      <div className="msf-roundgroup__label">
                        First leg (1 – {legSize})
                      </div>
                      <div className="msf-roundgrid">
                        {rounds.slice(0, legSize).map((_, i) => (
                          <button
                            key={i}
                            className={`msf-roundtab ${activeRound === i ? 'msf-roundtab--active' : ''}`}
                            onClick={() => setActiveRound(i)}
                          >
                            Round {i + 1}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="msf-roundgroup">
                      <div className="msf-roundgroup__label">
                        Second leg ({legSize + 1} – {rounds.length})
                      </div>
                      <div className="msf-roundgrid">
                        {rounds.slice(legSize).map((_, i) => {
                          const idx = legSize + i;
                          return (
                            <button
                              key={idx}
                              className={`msf-roundtab ${activeRound === idx ? 'msf-roundtab--active' : ''}`}
                              onClick={() => setActiveRound(idx)}
                            >
                              Round {idx + 1}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="msf-roundgrid msf-roundgrid--flat">
                    {rounds.map((_, i) => (
                      <button
                        key={i}
                        className={`msf-roundtab ${activeRound === i ? 'msf-roundtab--active' : ''}`}
                        onClick={() => setActiveRound(i)}
                      >
                        Round {i + 1}
                      </button>
                    ))}
                  </div>
                )}

                <div className="msf-matchpanel">
                  <div className="msf-matchgrid-head">
                    <span>Round {activeRound + 1} matches</span>
                    <span className="msf-matchgrid-head__sep">|</span>
                    <span>{rounds[activeRound]?.length || 0} matches</span>
                  </div>

                  <div className="msf-matchgrid">
                    {rounds[activeRound]?.map(([a, b], i) => (
                      <div key={i} className="msf-matchcard">
                        <span className="msf-matchcard__num">Match{i + 1}</span>
                        <div className="msf-matchcard__body">
                          <div className="msf-teamblock">
                            <TeamBadge team={teamByName(a)} />
                            <span>{a}</span>
                          </div>
                          <span className="msf-vs">VS</span>
                          <div className="msf-teamblock">
                            <TeamBadge team={teamByName(b)} />
                            <span>{b}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="msf-form-row" style={{ marginTop: 20 }}>
              <div className="msf-form-group">
                <label>Start Date</label>
                <input
                  type="date"
                  value={scheduleStartDate}
                  onChange={e => setScheduleStartDate(e.target.value)}
                />
              </div>
              <div className="msf-form-group">
                <label>Start Time</label>
                <input
                  type="time"
                  value={scheduleStartTime}
                  onChange={e => setScheduleStartTime(e.target.value)}
                />
              </div>
            </div>
            <p className="msf-form-note">
              Matches are auto-scheduled from here, 1h30m apart per round/stage (matches in the same
              round or stage share a slot). You can still change the date, time, or venue of any match
              afterward from the list below.
            </p>

            <div className="msf-savebar">
              <button
                className="msf-btn-primary"
                disabled={savingSchedule || !scheduleStartDate || !scheduleStartTime}
                onClick={handleSaveGenerated}
              >
                {savingSchedule ? 'Saving…' : 'Save Generated Schedule'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── TOURNAMENT SUMMARY + MATCH SCHEDULE SUMMARY — own card, sits below the round matches, not merged into it ──
         Hidden while locked: its bracket/rounds are a freshly computed preview, not the actually-saved
         schedule, so showing it here would misrepresent what's stored until the admin resets. ── */}
      {ready && !isLocked && (
        <div className="msf-card msf-card--summary">
          <div className="msf-summary-layout">
            <aside className="msf-tsummary">
              <h4 className="msf-tsummary__title">Tournament Summary</h4>
              <div className="msf-tsummary__row"><span>Sport</span><b>{selSport.name.toUpperCase()}</b></div>
              <div className="msf-tsummary__row"><span>Category</span><b>{selCategory.label.toUpperCase()}</b></div>
              <div className="msf-tsummary__row"><span>Format</span><b>{selFormat.label.toUpperCase()}</b></div>
              <div className="msf-tsummary__row"><span>Total Teams</span><b>{eligibleTeams.length}</b></div>
              {isBracket ? (
                bracket.stages.map((stage, i) => (
                  <div key={i} className="msf-tsummary__row">
                    <span>{stage.name === 'Finals' ? 'Final Matches' : stage.name}</span>
                    <b>{stage.matches.filter(m => !m.isBye).length}</b>
                  </div>
                ))
              ) : isDoubleBracket ? (
                <>
                  <div className="msf-tsummary__row"><span>Upper Bracket Matches</span><b>{doubleBracket.ubMatchCount}</b></div>
                  <div className="msf-tsummary__row"><span>Lower Bracket Matches</span><b>{doubleBracket.lbMatchCount}</b></div>
                  <div className="msf-tsummary__row"><span>Grand Final</span><b>1</b></div>
                  <div className="msf-tsummary__row"><span>Possible Extra Match</span><b>1</b></div>
                </>
              ) : (
                <div className="msf-tsummary__row"><span>Rounds</span><b>{rounds.length}</b></div>
              )}
              <div className="msf-tsummary__total">
                <span>Total Matches</span>
                <b>{totalMatches}</b>
                {isDoubleBracket && <em>(up to {totalMatches + 1} if necessary)</em>}
              </div>
            </aside>

            <div className="msf-summary">
              <div className="msf-summary__filters">
                <FilterDropdown
                  label="SELECT SPORTS"
                  value={selSport?.name}
                  placeholder="Select sport"
                  options={sportsList.map(s => ({ value: s.id, label: s.name, raw: s }))}
                  onChange={handlePickSport}
                />
                <FilterDropdown
                  label="SELECT CATEGORY/DIVISION"
                  value={selCategory?.label}
                  placeholder="Select category"
                  options={categoryOptions.map(o => ({ value: o.value, label: o.label, raw: o }))}
                  onChange={handlePickCategory}
                />
                <button className="msf-reset-btn" onClick={handleReset}><FaSync /> Reset</button>
              </div>

                <h4 className="msf-summary__heading">Match Schedule Summary</h4>

                <div className="msf-summary__table">
                  {isDoubleBracket ? (
                    <>
                      <div className="msf-summary__leg">UPPER BRACKET (WINNER'S BRACKET)</div>
                      <table className="msf-bsummary">
                        <thead>
                          <tr><th>Stage</th><th>Match</th><th>Team</th><th>Vs</th><th>Team</th></tr>
                        </thead>
                        <tbody>
                          {doubleBracket.wbStages.map((stage, si) => (
                            stage.matches.map((m, mi) => (
                              <tr key={`ub-${si}-${mi}`}>
                                {mi === 0 && (
                                  <td className="msf-bsummary__stage" rowSpan={stage.matches.length}>
                                    {(stage.name === 'Finals' ? "Winner's Finals" : stage.name).toUpperCase()}
                                    <span>{stage.matches.length} {stage.matches.length === 1 ? 'Match' : 'Matches'}</span>
                                  </td>
                                )}
                                <td>UB-{m.label}</td>
                                <td className="msf-bsummary__team">{m.a ?? <em>Bye</em>}</td>
                                <td className="msf-bsummary__vs">vs</td>
                                <td className="msf-bsummary__team">{m.b ?? <em>Bye</em>}</td>
                              </tr>
                            ))
                          ))}
                        </tbody>
                      </table>

                      <div className="msf-summary__leg">LOWER BRACKET (LOSER'S BRACKET)</div>
                      <table className="msf-bsummary">
                        <thead>
                          <tr><th>Stage</th><th>Match</th><th>Team</th><th>Vs</th><th>Team</th></tr>
                        </thead>
                        <tbody>
                          {doubleBracket.lbRounds.map((round, ri) => (
                            round.matches.map((m, mi) => (
                              <tr key={`lb-${ri}-${mi}`}>
                                {mi === 0 && (
                                  <td className="msf-bsummary__stage" rowSpan={round.matches.length}>
                                    {round.name.toUpperCase()}
                                    <span>{round.matches.length} {round.matches.length === 1 ? 'Match' : 'Matches'}</span>
                                  </td>
                                )}
                                <td>{m.label}</td>
                                <td className="msf-bsummary__team">{m.a ?? <em>Bye</em>}</td>
                                <td className="msf-bsummary__vs">vs</td>
                                <td className="msf-bsummary__team">{m.b ?? <em>Bye</em>}</td>
                              </tr>
                            ))
                          ))}
                        </tbody>
                      </table>

                      <div className="msf-summary__leg">GRAND FINAL</div>
                      <table className="msf-bsummary">
                        <tbody>
                          <tr>
                            <td className="msf-bsummary__stage">
                              GRAND FINAL
                              <span>1 Match (up to 2 if necessary)</span>
                            </td>
                            <td>GF</td>
                            <td className="msf-bsummary__team">{doubleBracket.grandFinal.a}</td>
                            <td className="msf-bsummary__vs">vs</td>
                            <td className="msf-bsummary__team">{doubleBracket.grandFinal.b}</td>
                          </tr>
                        </tbody>
                      </table>
                    </>
                  ) : isBracket ? (
                    <table className="msf-bsummary">
                      <thead>
                        <tr><th>Stage</th><th>Match</th><th>Team</th><th>Vs</th><th>Team</th></tr>
                      </thead>
                      <tbody>
                        {bracket.stages.map((stage, si) => (
                          stage.matches.map((m, mi) => (
                            <tr key={`${si}-${mi}`}>
                              {mi === 0 && (
                                <td className="msf-bsummary__stage" rowSpan={stage.matches.length}>
                                  {stage.name.toUpperCase()}
                                  <span>{stage.matches.length} {stage.matches.length === 1 ? 'Match' : 'Matches'}</span>
                                </td>
                              )}
                              <td>{si === bracket.stages.length - 1 ? 'FINALS' : m.label}</td>
                              <td className="msf-bsummary__team">{m.a ?? <em>Bye</em>}</td>
                              <td className="msf-bsummary__vs">vs</td>
                              <td className="msf-bsummary__team">{m.b ?? <em>Bye</em>}</td>
                            </tr>
                          ))
                        ))}
                      </tbody>
                    </table>
                  ) : selFormat.id === 'double-rr' ? (
                    <>
                      <div className="msf-summary__leg">FIRST LEG (ROUND 1 TO {rounds.length / 2})</div>
                      {rounds.slice(0, rounds.length / 2).map((pairs, ri) => (
                        <div key={`leg1-${ri}`} className="msf-summary__round">
                          <div className="msf-summary__round-label">Round {ri + 1}</div>
                          {pairs.map(([a, b], i) => (
                            <div key={i} className="msf-summary__row">
                              <span className="msf-summary__num">{i + 1}</span>
                              <span className="msf-summary__team">{a}</span>
                              <span className="msf-summary__vs">vs</span>
                              <span className="msf-summary__team">{b}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                      <div className="msf-summary__leg">SECOND LEG (ROUND {rounds.length / 2 + 1} TO {rounds.length})</div>
                      {rounds.slice(rounds.length / 2).map((pairs, ri) => (
                        <div key={`leg2-${ri}`} className="msf-summary__round">
                          <div className="msf-summary__round-label">Round {rounds.length / 2 + ri + 1}</div>
                          {pairs.map(([a, b], i) => (
                            <div key={i} className="msf-summary__row">
                              <span className="msf-summary__num">{i + 1}</span>
                              <span className="msf-summary__team">{a}</span>
                              <span className="msf-summary__vs">vs</span>
                              <span className="msf-summary__team">{b}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </>
                  ) : (
                    rounds.map((pairs, ri) => (
                      <div key={ri} className="msf-summary__round">
                        <div className="msf-summary__round-label">Round {ri + 1}</div>
                        {pairs.map(([a, b], i) => (
                          <div key={i} className="msf-summary__row">
                            <span className="msf-summary__num">{i + 1}</span>
                            <span className="msf-summary__team">{a}</span>
                            <span className="msf-summary__vs">vs</span>
                            <span className="msf-summary__team">{b}</span>
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
      )}

      {/* ── MATCH SCHEDULES LIST — always visible, not gated behind a step ── */}
      <div className="msf-card msf-card--list" ref={listRef}>
        <div className="msf-list-head">
          <div>
            <h2>Match schedules</h2>
            <p className="msf-muted">Upcoming matches across every team and sport</p>
          </div>
          <div className="msf-list-head__actions">
            <button
              className="msf-btn-ghost"
              onClick={() => {
                setAddForm({ sport: '', category: '', date: '', time: '', location: '', matchLabel: '', pairs: [{ teamA: '', teamB: '' }] });
                setFulfillingRequestId(null);
                setAddModalOpen(true);
              }}
            >
              <FaPlus /> Add Schedule
            </button>
            <button
              className="msf-btn-primary"
              onClick={handleDownloadPdf}
              disabled={sportSections.length === 0}
            >
              <FaDownload /> Download PDF
            </button>
          </div>
        </div>

        {sportSections.length === 0 ? (
          <p className="msf-empty">No matches yet. Generate a schedule above, or add one manually.</p>
        ) : (
          <div className="msf-list-layout">
            <nav className="msf-sportnav" aria-label="Jump to sport">
              {sportSections.map(({ sport, count }) => (
                <a
                  key={sport}
                  href={`#sport-${sportSlug(sport)}`}
                  className="msf-sportnav__item"
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`sport-${sportSlug(sport)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  <span>{sport}</span>
                  <span className="msf-sportnav__count">{count}</span>
                </a>
              ))}
            </nav>

            <div className="msf-sporttables">
              {sportSections.map(({ sport, undated, groupedByDate }) => (
                <div key={sport} id={`sport-${sportSlug(sport)}`} className="msf-sporttable">
                  <h3 className="msf-sporttable__title">{sport}</h3>

                  {undated.length > 0 && (
                    <div className="msf-daygroup msf-daygroup--undated">
                      <div className="msf-daygroup__head msf-daygroup__head--undated">
                        <FaExclamationTriangle /> Needs date &amp; venue ({undated.length})
                      </div>
                      {undated.map(m => (
                        <div key={m.id} className="msf-matchrow">
                          <div className="msf-matchrow__time msf-matchrow__time--muted">TBD</div>
                          <div className="msf-matchrow__mid">
                            <div className="msf-matchrow__teams">{m.teamA} vs {m.teamB}</div>
                          </div>
                          <button className="msf-icon-edit" onClick={() => openEditModal(m)}><FaEdit /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  {Object.entries(groupedByDate).map(([date, matches]) => (
                    <div key={date} className="msf-daygroup">
                      <div className="msf-daygroup__head">{new Date(date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
                      {matches.map(m => {
                        const record = recordForMatch(m);
                        const winner = recordWinnerName(record);
                        return (
                          <div key={m.id} className="msf-matchrow">
                            <div className="msf-matchrow__time">{m.time}</div>
                            <div className="msf-matchrow__mid">
                              {m.matchLabel && <div className="msf-matchrow__label">{m.matchLabel}</div>}
                              <div className="msf-matchrow__teams">{m.teamA} vs {m.teamB}</div>
                              {m.location && <div className="msf-matchrow__loc"><FaMapMarkerAlt /> {m.location}</div>}
                              {record && (
                                <div className="msf-matchrow__loc" style={{ color: '#14713a', fontWeight: 700 }}>
                                  <FaTrophy /> {winner ? `${winner} won — result recorded` : 'Draw — result recorded'}
                                </div>
                              )}
                            </div>
                            <button className="msf-icon-edit" onClick={() => openEditModal(m)}><FaEdit /></button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Reset Schedule confirmation — deletes the whole locked (sport, category)
         set at once, unlike the per-match "Delete Schedule" in the Edit modal ── */}
      {resetConfirmOpen && (
        <div className="msf-overlay" onClick={() => setResetConfirmOpen(false)}>
          <div className="msf-confirm-delete" onClick={e => e.stopPropagation()}>
            <h3>Reset this schedule?</h3>
            <p>
              This will permanently delete all <b>{lockedMatches.length}</b> saved match{lockedMatches.length === 1 ? '' : 'es'} for{' '}
              <b>{selSport?.name} / {selCategory?.label}</b> ({lockedMatches[0]?.format}). This can't be undone.
            </p>
            {lockedResultsCount > 0 && (
              <p style={{ color: '#a83218', fontWeight: 700 }}>
                {lockedResultsCount} of these {lockedResultsCount === 1 ? 'match' : 'matches'} already {lockedResultsCount === 1 ? 'has' : 'have'} a
                recorded result. Deleting them leaves that result — and the rating points it awarded — with nothing to point at.
              </p>
            )}
            <div className="msf-confirm-delete__actions">
              <button type="button" className="msf-btn-ghost" onClick={() => setResetConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="msf-btn-danger"
                disabled={resettingSchedule}
                onClick={handleConfirmResetSchedule}
              >
                {resettingSchedule ? 'Resetting…' : 'Reset Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className="msf-toast"><FaCheck /> {toast.text}</div>
      )}

      {/* ── Save success modal (animated, floats above the page) ── */}
      {successModal && (
        <div className="msf-overlay" onClick={handleReviewSummary}>
          <div className="msf-success-wrap" onClick={e => e.stopPropagation()}>
            <p className="msf-success-eyebrow">Schedule saved succesfully</p>
            <div className="msf-success-card">
              <div className="msf-success-check"><FaCheck /></div>
              <h2>Schedule saved successfully</h2>
              <p className="msf-muted">Tournament schedule has been saved</p>

              <div className="msf-success-meta">
                <div><span>SPORT</span><b>{successModal.sport}</b></div>
                <div><span>CATEGORY/DIVISION</span><b>{successModal.category}</b></div>
                <div><span>FORMAT</span><b>{successModal.format}</b></div>
              </div>

              <div className="msf-success-stats">
                <div><span>TOTAL TEAMS</span><b>{successModal.teams}</b></div>
                <div><span>TOTAL ROUNDS</span><b>{successModal.rounds}</b></div>
                <div><span>TOTAL MATCHES</span><b>{successModal.matches}</b></div>
                <div><span>STATUS</span><b className="msf-badge-saved">Saved</b></div>
              </div>

              <div className="msf-success-checklist">
                <p className="msf-success-checklist__title">What happens next?</p>
                <p><FaCheck /> Tournament structure has been saved.</p>
                <p><FaCheck /> Match pairings have been recorded.</p>
                <p><FaCheck /> Schedule summary is ready for review.</p>
                <p><FaCheck /> You may now submit the schedule.</p>
              </div>

              <button className="msf-btn-primary msf-btn-block" onClick={handleReviewSummary}>Review summary</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Schedule modal (a real overlay, not a page swap) ── */}
      {addModalOpen && (
        <div className="msf-overlay" onClick={() => { setAddModalOpen(false); setFulfillingRequestId(null); }}>
          <div className="msf-addwrap" onClick={e => e.stopPropagation()}>
            <p className="msf-add-eyebrow">Match Schedule (Time, Date and Venue)</p>
            <div className="msf-add-card">
              <h2 className="msf-add-card__title">Match Schedule</h2>
              <div className="msf-add-card__divider" />

              {fulfillingRequestId && (
                <p className="msf-form-note" style={{ marginTop: -8, marginBottom: 14 }}>
                  Fulfilling a moderator's schedule request — sport, division, and both teams are already filled
                  in below. Just add the time, date, and venue.
                </p>
              )}

              <div className="msf-form-group">
                <label>Sport</label>
                <select
                  value={addForm.sport}
                  onChange={e => setAddForm(f => ({ ...f, sport: e.target.value, category: '', pairs: [{ teamA: '', teamB: '' }] }))}
                >
                  <option value="">Select a sport</option>
                  {sportOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div className="msf-form-group">
                <label>Category/Division</label>
                <select
                  value={addForm.category}
                  onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                  disabled={!addForm.sport}
                >
                  <option value="">Select a category</option>
                  {addCategoryOptions.map(o => <option key={o.value} value={o.label}>{o.label}</option>)}
                </select>
              </div>

              <div className="msf-form-row">
                <div className="msf-form-group">
                  <label>Time</label>
                  <input type="time" value={addForm.time} onChange={e => setAddForm(f => ({ ...f, time: e.target.value }))} />
                </div>
                <div className="msf-form-group">
                  <label>Date</label>
                  <input type="date" value={addForm.date} onChange={e => setAddForm(f => ({ ...f, date: e.target.value }))} />
                </div>
              </div>

              {addForm.pairs.map((pair, idx) => {
                const isLast = idx === addForm.pairs.length - 1;
                return (
                  <div className="msf-form-row msf-form-row--vs" key={idx}>
                    <div className="msf-form-group">
                      <label>Teams</label>
                      <select value={pair.teamA} onChange={e => handlePairChange(idx, 'teamA', e.target.value)}>
                        <option value="">Select a teams</option>
                        {addPool.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                      </select>
                    </div>
                    <span className="msf-vs">VS</span>
                    <div className="msf-form-group">
                      <label>Teams</label>
                      <select value={pair.teamB} onChange={e => handlePairChange(idx, 'teamB', e.target.value)}>
                        <option value="">Select a teams</option>
                        {addPool.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                      </select>
                    </div>
                    {/* Fulfilling a moderator's schedule request is always exactly
                        one match between the two teams they asked for — offering
                        to bulk-add more pairs here doesn't make sense for that flow. */}
                    {isLast && !fulfillingRequestId && (
                      <button type="button" className="msf-addteam-btn" onClick={handleAddTeamRow} disabled={!addForm.sport}>
                        <FaPlus /> Add Team
                      </button>
                    )}
                  </div>
                );
              })}

              <div className="msf-form-group">
                <label>Label <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
                <input
                  type="text"
                  placeholder="e.g. Tie breaking match"
                  value={addForm.matchLabel}
                  onChange={e => setAddForm(f => ({ ...f, matchLabel: e.target.value }))}
                  maxLength={60}
                />
                <p className="msf-form-note" style={{ marginTop: 6 }}>Shown wherever this match appears — moderators and the public schedule both see it.</p>
              </div>

              <div className="msf-form-group">
                <label>Venue</label>
                <select
                  value={addForm.location}
                  onChange={e => setAddForm(f => ({ ...f, location: e.target.value }))}
                >
                  <option value="">Select a venue</option>
                  {venues.map(v => {
                    const occupied = venueOccupied(v.name, addForm.date, addForm.time, null);
                    return (
                      <option key={v.id} value={v.name} disabled={occupied}>
                        {v.name}{occupied ? ' (Occupied)' : ''}
                      </option>
                    );
                  })}
                </select>
                {venues.length === 0 && (
                  <p className="msf-form-note">No venues configured yet — add one in the Venues tab.</p>
                )}
              </div>

              <div className="msf-form-actions">
                <button className="msf-btn-ghost msf-btn-block" onClick={() => { setAddModalOpen(false); setFulfillingRequestId(null); }}>Cancel</button>
                <button className="msf-btn-primary msf-btn-block" onClick={handleConfirmAdd}>Add to Schedule</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Schedule modal — same look as the Add Schedule modal ── */}
      {editModalOpen && editForm && (
        <div className="msf-overlay" onClick={() => setEditModalOpen(false)}>
          <div className="msf-addwrap" onClick={e => e.stopPropagation()}>
            <p className="msf-add-eyebrow">Match Schedule (Time, Date and Venue)</p>
            <div className="msf-add-card">
              <h2 className="msf-add-card__title">Edit Match Schedule</h2>
              <div className="msf-add-card__divider" />

              <div className="msf-form-group">
                <label>Sport</label>
                <input type="text" value={editForm.sport || ''} disabled />
              </div>

              <div className="msf-form-group">
                <label>Category/Division</label>
                {isGeneratedMatch(editForm) ? (
                  <input type="text" value={editForm.category || ''} disabled />
                ) : (
                  <select
                    value={editForm.category || ''}
                    onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                  >
                    <option value="">Select a category</option>
                    {editCategoryOptions.map(o => <option key={o.value} value={o.label}>{o.label}</option>)}
                    {editForm.category && !editCategoryOptions.some(o => o.label === editForm.category) && (
                      <option value={editForm.category}>{editForm.category}</option>
                    )}
                  </select>
                )}
              </div>

              <div className="msf-form-row">
                <div className="msf-form-group">
                  <label>Time</label>
                  <input type="time" value={editForm.time || ''} onChange={e => setEditForm(f => ({ ...f, time: e.target.value }))} />
                </div>
                <div className="msf-form-group">
                  <label>Date</label>
                  <input type="date" value={editForm.date || ''} onChange={e => setEditForm(f => ({ ...f, date: e.target.value }))} />
                </div>
              </div>

              <div className="msf-form-group">
                <label>Teams</label>
              </div>
              <div className="msf-teams-row">
                <select
                  className="msf-teams-row__select"
                  value={editForm.teamA || ''}
                  disabled={isGeneratedMatch(editForm)}
                  onChange={e => setEditForm(f => ({ ...f, teamA: e.target.value }))}
                >
                  <option value="">Select a teams</option>
                  {editPool.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                  {editForm.teamA && !editPool.some(t => t.name === editForm.teamA) && (
                    <option value={editForm.teamA}>{editForm.teamA}</option>
                  )}
                </select>
                <span className="msf-vs">VS</span>
                <select
                  className="msf-teams-row__select"
                  value={editForm.teamB || ''}
                  disabled={isGeneratedMatch(editForm)}
                  onChange={e => setEditForm(f => ({ ...f, teamB: e.target.value }))}
                >
                  <option value="">Select a teams</option>
                  {editPool.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                  {editForm.teamB && !editPool.some(t => t.name === editForm.teamB) && (
                    <option value={editForm.teamB}>{editForm.teamB}</option>
                  )}
                </select>
              </div>
              {isGeneratedMatch(editForm) && (
                <p className="msf-form-note">
                  Teams are locked because this match came from the schedule generator. Delete and re-generate to change matchups.
                </p>
              )}
              {recordForMatch(editForm) && (
                <p className="msf-form-note" style={{ color: '#a83218', fontWeight: 700 }}>
                  A moderator has already recorded a result for this match, and its rating points are live on
                  the Ranking page. Editing the teams or deleting it will orphan that result — reopen the record
                  in the Moderator page instead.
                </p>
              )}

              <div className="msf-form-group">
                <label>Label <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional)</span></label>
                <input
                  type="text"
                  placeholder="e.g. Tie breaking match"
                  value={editForm.matchLabel || ''}
                  onChange={e => setEditForm(f => ({ ...f, matchLabel: e.target.value }))}
                  maxLength={60}
                />
                <p className="msf-form-note" style={{ marginTop: 6 }}>Shown wherever this match appears — moderators and the public schedule both see it.</p>
              </div>

              <div className="msf-form-group">
                <label>Venue</label>
                <select
                  value={editForm.location || ''}
                  onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))}
                >
                  <option value="">Select a venue</option>
                  {venues.map(v => {
                    const occupied = venueOccupied(v.name, editForm.date, editForm.time, editForm.id);
                    return (
                      <option key={v.id} value={v.name} disabled={occupied}>
                        {v.name}{occupied ? ' (Occupied)' : ''}
                      </option>
                    );
                  })}
                  {editForm.location && !venues.some(v => v.name === editForm.location) && (
                    <option value={editForm.location}>{editForm.location} (no longer listed)</option>
                  )}
                </select>
                {venues.length === 0 && (
                  <p className="msf-form-note">No venues configured yet — add one in the Venues tab.</p>
                )}
              </div>

              <div className="msf-form-actions">
                <button className="msf-btn-ghost msf-btn-block" onClick={() => { setEditModalOpen(false); setEditForm(null); setDeleteConfirmOpen(false); }}>Cancel</button>
                <button className="msf-btn-primary msf-btn-block" onClick={handleConfirmEdit}>Save Changes</button>
              </div>

              <button
                type="button"
                className="msf-btn-delete-schedule"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <FaTrash /> Delete Schedule
              </button>
            </div>
          </div>

          {deleteConfirmOpen && (
            <div className="msf-overlay msf-overlay--nested" onClick={() => setDeleteConfirmOpen(false)}>
              <div className="msf-confirm-delete" onClick={e => e.stopPropagation()}>
                <h3>Delete this schedule?</h3>
                <p>
                  This will permanently remove <b>{editForm.teamA} vs {editForm.teamB}</b>
                  {editForm.date ? ` on ${editForm.date}` : ''}. This can't be undone.
                </p>
                {recordForMatch(editForm) && (
                  <p style={{ color: '#a83218', fontWeight: 700 }}>
                    This match already has a recorded result. Deleting the fixture leaves that result — and the
                    rating points it awarded — with nothing to point at.
                  </p>
                )}
                <div className="msf-confirm-delete__actions">
                  <button type="button" className="msf-btn-ghost" onClick={() => setDeleteConfirmOpen(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="msf-btn-danger"
                    disabled={deletingSchedule}
                    onClick={handleDeleteSchedule}
                  >
                    {deletingSchedule ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


export default function AdminSchedulePage() {
  const { isAdmin, authLoading, userProfile } = useContext(AuthContext);
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState(REGISTRATION_TAB_INDEX);
  const [level, setLevel] = useState('highSchool');

  // Registration data
  const [summaryRows,      setSummaryRows]      = useState([]);
  const [allRegistrations, setAllRegistrations] = useState([]);
  // Raw student registrations kept around so the summary can be
  // re-tallied per event without another round-trip to Firestore.
  const [studentRegs,      setStudentRegs]      = useState([]);
  const [eventCounts,      setEventCounts]      = useState({});
  const [summaryEvent,     setSummaryEvent]     = useState(''); // '' = all events
  const [summaryLoading,   setSummaryLoading]   = useState(false);
  const [summaryError,     setSummaryError]     = useState('');

  // Filters
  const [searchQuery,    setSearchQuery]    = useState('');
  const [filterGrade,    setFilterGrade]    = useState('');
  const [filterSection,  setFilterSection]  = useState('');
  const [filterSport,    setFilterSport]    = useState('');
  const [filterGender,   setFilterGender]   = useState('');
  const [filterEvent,    setFilterEvent]    = useState('');

  // Student detail modal
  const [selectedStudent, setSelectedStudent] = useState(null);

  // Schedule requests — moderators asking for a fixture to be arranged.
  // Subscribed live (not just fetched on tab open) so the pending badge
  // on the tab + sidebar updates the moment one comes in.
  const [scheduleRequests, setScheduleRequests] = useState([]);
  const [decliningRequestId, setDecliningRequestId] = useState(null);
  const [declineReasonDraft, setDeclineReasonDraft] = useState('');
  const [requestActionToast, setRequestActionToast] = useState(null);
  // The request currently being opened into Match Schedules Format for
  // fulfillment — handed to MatchScheduleFormatSection as a one-shot
  // "prefill the Add Schedule form" command, then cleared once it's read.
  const [prefillFromRequest, setPrefillFromRequest] = useState(null);
  const clearPrefillFromRequest = useCallback(() => setPrefillFromRequest(null), []);

  useEffect(() => {
    const unsubscribe = subscribeScheduleRequests(setScheduleRequests);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!requestActionToast) return;
    const t = setTimeout(() => setRequestActionToast(null), 3500);
    return () => clearTimeout(t);
  }, [requestActionToast]);

  const pendingRequestCount = scheduleRequests.filter((r) => r.status === 'pending').length;
  const sortedScheduleRequests = [...scheduleRequests].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const handleOpenRequestInSchedules = (request) => {
    setLevel(request.level);
    setActiveTab(MATCH_SCHEDULES_TAB_INDEX);
    setPrefillFromRequest(request);
    setRequestActionToast({ text: `Opened Match Schedules for ${LEVEL_LABELS[request.level] || request.level} — the sport, division and both teams are already filled in. Just add date/time/venue and confirm; the request is marked scheduled automatically.` });
  };

  const handleMarkRequestScheduled = async (requestId) => {
    try {
      await updateScheduleRequest(requestId, { status: 'scheduled' }, userProfile?.role);
    } catch (err) {
      console.error('Failed to mark schedule request as scheduled:', err);
      setRequestActionToast({ text: friendlyFirestoreError(err, 'Could not update the request') });
    }
  };

  const handleDeclineRequest = async (requestId) => {
    try {
      await updateScheduleRequest(requestId, { status: 'declined', declineReason: declineReasonDraft.trim() }, userProfile?.role);
      setDecliningRequestId(null);
      setDeclineReasonDraft('');
    } catch (err) {
      console.error('Failed to decline schedule request:', err);
      setRequestActionToast({ text: friendlyFirestoreError(err, 'Could not decline the request') });
    }
  };

  // Manual cleanup for a resolved (scheduled/declined) request — e.g. one
  // left over from before matches carried a `requestId` link, so deleting
  // the fixture couldn't auto-remove it.
  const handleDeleteRequest = async (requestId) => {
    try {
      await deleteScheduleRequest(requestId);
    } catch (err) {
      console.error('Failed to delete schedule request:', err);
      setRequestActionToast({ text: friendlyFirestoreError(err, 'Could not delete the request') });
    }
  };

  useEffect(() => { if (!isAdmin) navigate('/dashboard'); }, [isAdmin, navigate]);

const fetchSummary = useCallback(async () => {
  if (!db) {
    setSummaryError("Firestore not connected.");
    return;
  }

  setSummaryLoading(true);
  setSummaryError("");

  try {
    // Load player registrations
    const regSnap = await getDocs(collection(db, "registrations"));
    const registrations = regSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Load ALL registered users
    const userSnap = await getDocs(collection(db, "users"));
    const users = userSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    // This table is the STUDENT registration tabulation — staff accounts
    // (admin / moderator / super admin) manage it, they don't belong as
    // rows in it.
    const studentUsers = users.filter(
      u => (u.role || 'student').toLowerCase() === 'student'
    );
    const studentUids = new Set(studentUsers.map(u => u.id));
    const studentRegistrations = registrations.filter(r => studentUids.has(r.uid));

    // One row per STUDENT ACCOUNT (keyed by uid) — never collapsed or
    // matched by name, since two different accounts can legitimately
    // share the same name.
    const merged = studentUsers.map(user => {
      const registration = studentRegistrations.find(r => r.uid === user.id);

      return {
        ...user,
        ...(registration || {}),
        id: user.id,
        uid: user.id,
        fullName: (registration && registration.fullName) || user.name || '',
        email: (registration && registration.email) || user.email || '',
        // Gender / Grade-Year / Section always reflect what the student
        // set when they created their account, not whatever a later
        // sport-registration form happened to have typed into it.
        gender: user.gender || '—',
        gradeLevel: user.gradeLevel || '—',
        section: user.section || '—',
        // A student who hasn't registered for a sport yet isn't a
        // player — say so plainly instead of leaving it blank.
        sport: (registration && registration.sport) || 'N/A',
        position: (registration && registration.position) || 'N/A',
        teamName: (registration && registration.teamName) || 'N/A',
        event: (registration && (getEventLabel(registration.eventKey || registration.event) || registration.event)) || 'N/A',
      };
    }).sort((a, b) =>
      (a.fullName || '').localeCompare(b.fullName || '', undefined, { sensitivity: 'base' })
    );

    setAllRegistrations(merged);
    setStudentRegs(studentRegistrations);
    setSummaryRows(buildSummary(studentRegistrations));

    // Recompute the per-event totals from the real documents and publish
    // them, which also repairs any drift in the counter the registration
    // form increments as students submit.
    const freshEventCounts = buildEventCounts(studentRegistrations);
    setEventCounts(freshEventCounts);
    setEventRegistrationCounts(freshEventCounts).catch((err) => {
      console.error('Failed to publish event registration counts:', err);
    });

    // Publish just the total player count to the public landing page —
    // never the registrations themselves (see setLivePlayerCount's
    // comment in firestoreService.js for why). Fire-and-forget: a failed
    // write here shouldn't block or error out the registration table
    // this page actually exists to show.
    const summaryForCount = buildSummary(studentRegistrations);
    const totalPlayerCount = summaryForCount.reduce(
      (sum, row) => sum + row.elementary + row.highSchool + row.college, 0,
    );
    setLivePlayerCount(totalPlayerCount).catch((err) => {
      console.error('Failed to publish live player count:', err);
    });

  } catch (err) {
    console.error(err);
    setSummaryError("Failed to load registration data.");
  } finally {
    setSummaryLoading(false);
  }
}, []);

  useEffect(() => { if (activeTab === REGISTRATION_TAB_INDEX) fetchSummary(); }, [activeTab, fetchSummary]);

  // Summary table + level totals follow the event filter; with no filter
  // they show every event combined, exactly as before.
  const visibleSummaryRows = summaryEvent
    ? buildSummary(studentRegs.filter(r => getEventBucket(r) === summaryEvent))
    : summaryRows;

  // "All Events" is the sum of the buckets, never the raw document
  // count — those disagree whenever a registration is missing a sport
  // or grade level, and the chip has to agree with the Total above it.
  // Includes registrations with no event on them (saved before the
  // event picker existed) — they're still players, so leaving them out
  // would put this chip below the Total beside it.
  const totalEventPlayers = Object.values(eventCounts)
    .reduce((sum, n) => sum + (Number(n) || 0), 0);

  const totalElementary = visibleSummaryRows.reduce((s, r) => s + r.elementary, 0);
  const totalHighSchool = visibleSummaryRows.reduce((s, r) => s + r.highSchool, 0);
  const totalCollege    = visibleSummaryRows.reduce((s, r) => s + r.college, 0);
  const totalPlayers    = totalElementary + totalHighSchool + totalCollege;

  // Unique filter options from data
  const uniqueSections = [...new Set(allRegistrations.map(r => r.section).filter(Boolean))].sort();
  const uniqueSports   = [...new Set(allRegistrations.map(r => r.sport).filter(Boolean))].sort();

  const filteredStudents = allRegistrations.filter(r => {
    const q = searchQuery.toLowerCase();
    return (
      (!q             || (r.fullName || '').toLowerCase().includes(q)) &&
      (!filterGrade   || r.gradeLevel === filterGrade) &&
      (!filterSection || r.section    === filterSection) &&
      (!filterSport   || r.sport      === filterSport) &&
      (!filterGender  || (r.gender || '').toLowerCase() === filterGender.toLowerCase()) &&
      (!filterEvent   || getEventBucket(r) === filterEvent)
    );
  });

  const hasFilters = searchQuery || filterGrade || filterSection || filterSport || filterGender || filterEvent;
  const clearFilters = () => { setSearchQuery(''); setFilterGrade(''); setFilterSection(''); setFilterSport(''); setFilterGender(''); setFilterEvent(''); };

  const fmt = (row, level) => row[level] === 0 ? '--' : row[level];

  // ProtectedRoute already gates the /admin route by role, but that check
  // reads `userRole` while this component reads `isAdmin` — if those two
  // ever disagree (or this page is reused somewhere ProtectedRoute doesn't
  // wrap), the old code below only redirected inside a useEffect, which
  // runs *after* the full admin dashboard had already rendered once. That
  // let restricted registration data flash on screen for a moment before
  // navigating away. Bail out of the render itself instead, so nothing in
  // this page is ever painted for a non-admin account.
  if (authLoading) {
    return <div className="asp-page">Loading…</div>;
  }
  if (!isAdmin) {
    return null;
  }

  return (
    <div className="asp-page">

      {/* Header */}
      <header className="asp-header">
        <h1 className="asp-header__title">SANTA RITA COLLEGE OF PAMPANGA, INC</h1>
      </header>

      {/* Intro */}
      <div className="asp-intro">
        <div className="asp-intro__text">
          <h2 className="asp-intro__title">Update &amp; Edit</h2>
          <p className="asp-intro__sub">Manage registrations, sports, and match schedules</p>
        </div>
        <div className="asp-tabs asp-tabs--header">
          {TABS.map((tab, i) => (
            <button key={tab} className={`asp-tab${activeTab === i ? ' asp-tab--active' : ''}`} onClick={() => setActiveTab(i)} style={{ position: 'relative' }}>
              {tab}
              {tab === 'Schedule Requests' && pendingRequestCount > 0 && (
                <span style={{
                  position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, padding: '0 4px',
                  borderRadius: 999, background: '#c0392b', color: '#fff', fontSize: '0.65rem', fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}>
                  {pendingRequestCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Level switcher — applies to Sports & Teams and Match Schedules
          Format only. Venues are global (shared across every level), and
          Registration's summary/table already break Elementary/High
          School/College out as their own columns, so `level` has nothing
          to filter on either of those tabs. Schedule Requests spans every
          level at once, same reasoning. */}
      {activeTab !== VENUES_TAB_INDEX && activeTab !== REGISTRATION_TAB_INDEX && activeTab !== SCHEDULE_REQUESTS_TAB_INDEX && (
        <div className="asp-level-row">
          <LevelTabs
            levels={LEVELS}
            value={level}
            onChange={setLevel}
            containerClassName="asp-lvltabs"
            tabClassName="asp-lvltab"
            activeClassName="asp-lvltab--active"
          />
        </div>
      )}

      {/* Body */}
      <div className="asp-body">

        {/* ══ REGISTRATION TAB ══ */}
        {activeTab === REGISTRATION_TAB_INDEX && (
          <div className="asp-tab-content">

            {/* ── Card 1: Summary ── */}
            <div className="asp-card">
              {/* Card header row */}
              <div className="asp-card__toprow">
                <div className="asp-card__heading">
                  <FaUsers className="asp-card__icon" />
                  <span>REGISTRATION SUMMARY</span>
                </div>
                <div className="asp-card__toprow-right">
                  <button className="asp-refresh-btn" onClick={fetchSummary} disabled={summaryLoading} title="Refresh">
                    <FaSync className={summaryLoading ? 'asp-spin' : ''} />
                  </button>
                  <div className="asp-total-box asp-total-box--wide">
                    <div className="asp-total-seg">
                      <span className="asp-total-seg__num">{summaryLoading ? '…' : totalElementary}</span>
                      <span className="asp-total-seg__label">Elementary</span>
                    </div>
                    <div className="asp-total-div" />
                    <div className="asp-total-seg">
                      <span className="asp-total-seg__num">{summaryLoading ? '…' : totalHighSchool}</span>
                      <span className="asp-total-seg__label">High School</span>
                    </div>
                    <div className="asp-total-div" />
                    <div className="asp-total-seg">
                      <span className="asp-total-seg__num">{summaryLoading ? '…' : totalCollege}</span>
                      <span className="asp-total-seg__label">College</span>
                    </div>
                    <div className="asp-total-div" />
                    <div className="asp-total-seg asp-total-seg--grand">
                      <span className="asp-total-seg__num">{summaryLoading ? '…' : totalPlayers}</span>
                      <span className="asp-total-seg__label">Total</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Per-event registration counts. Clicking one scopes the
                  table below to that event; clicking it again clears it. */}
              <div className="asp-event-row">
                <span className="asp-event-row__label">Per Event</span>
                <div className="asp-event-chips">
                  <button
                    type="button"
                    className={`asp-event-chip${summaryEvent === '' ? ' asp-event-chip--active' : ''}`}
                    onClick={() => setSummaryEvent('')}
                  >
                    <span className="asp-event-chip__num">
                      {summaryLoading ? '…' : totalEventPlayers}
                    </span>
                    <span className="asp-event-chip__label">All Events</span>
                  </button>
                  {EVENT_TYPES.map(ev => (
                    <button
                      key={ev.key}
                      type="button"
                      className={`asp-event-chip${summaryEvent === ev.key ? ' asp-event-chip--active' : ''}`}
                      onClick={() => setSummaryEvent(prev => (prev === ev.key ? '' : ev.key))}
                    >
                      <span className="asp-event-chip__num">
                        {summaryLoading ? '…' : (Number(eventCounts[ev.key]) || 0)}
                      </span>
                      <span className="asp-event-chip__label">{ev.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <p className="asp-card__subtitle">
                Total Registered Players
                {summaryEvent && (
                  <span className="asp-card__subtitle-tag">
                    {EVENT_TYPES.find(e => e.key === summaryEvent)?.label || 'No Event'}
                  </span>
                )}
              </p>

              {summaryError && <div className="asp-alert asp-alert--error">{summaryError}</div>}

              <div className="asp-table-wrap">
                {summaryLoading ? (
                  <p className="asp-empty">Loading from Firestore…</p>
                ) : visibleSummaryRows.length === 0 ? (
                  <p className="asp-empty">
                    {summaryEvent
                      ? `No registrations for ${EVENT_TYPES.find(e => e.key === summaryEvent)?.label || 'No Event'} yet.`
                      : 'No registrations found.'}
                  </p>
                ) : (
                  <table className="asp-table">
                    <thead>
                      <tr>
                        <th>Sports</th>
                        <th>Elementary</th>
                        <th>High School</th>
                        <th>College</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSummaryRows.map(row => (
                        <tr key={`${row.sport}-${row.gender}`}>
                          <td className="asp-td--sport" data-label="Sports">{row.sport.toUpperCase()} {row.gender.toUpperCase()}</td>
                          <td data-label="Elementary">{fmt(row, 'elementary')}</td>
                          <td data-label="High School">{fmt(row, 'highSchool')}</td>
                          <td data-label="College">{fmt(row, 'college')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* ── Card 2: Student Details ── */}
            <div className="asp-card">
              {/* Card header row */}
              <div className="asp-card__toprow">
                <div className="asp-card__heading">
                  <FaUserGraduate className="asp-card__icon" />
                  <span>STUDENT REGISTRATION DETAILS</span>
                </div>
                <div className="asp-search-wrap">
                  <FaSearch className="asp-search-icon" />
                  <input
                    className="asp-search-input"
                    type="text"
                    placeholder="Search by name…"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>

              {/* Filter pills */}
              <div className="asp-filters">
                <select className="asp-filter-pill" value={filterGrade} onChange={e => setFilterGrade(e.target.value)}>
                  <option value="">Grade/Year ▾</option>
                  {ALL_GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
                <select className="asp-filter-pill" value={filterSection} onChange={e => setFilterSection(e.target.value)}>
                  <option value="">Section ▾</option>
                  {uniqueSections.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="asp-filter-pill" value={filterSport} onChange={e => setFilterSport(e.target.value)}>
                  <option value="">Sports ▾</option>
                  {uniqueSports.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="asp-filter-pill" value={filterGender} onChange={e => setFilterGender(e.target.value)}>
                  <option value="">Gender ▾</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Others">Others</option>
                </select>
                <select className="asp-filter-pill" value={filterEvent} onChange={e => setFilterEvent(e.target.value)}>
                  <option value="">Event ▾</option>
                  {EVENT_TYPES.map(ev => <option key={ev.key} value={ev.key}>{ev.label}</option>)}
                  <option value="unassigned">No Event</option>
                </select>
                {hasFilters && (
                  <button className="asp-clear-btn" onClick={clearFilters}>
                    <FaTimes /> Clear Filter
                  </button>
                )}
                <span className="asp-results-count">{filteredStudents.length} result{filteredStudents.length !== 1 ? 's' : ''}</span>
              </div>

              <div className="asp-table-wrap" style={{ marginTop: 8 }}>
                {summaryLoading ? (
                  <p className="asp-empty">Loading from Firestore…</p>
                ) : filteredStudents.length === 0 ? (
                  <p className="asp-empty">{hasFilters ? 'No students match the selected filters.' : 'No registrations found.'}</p>
                ) : (
                  <table className="asp-table asp-table--students">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>Gender</th>
                        <th>Grade/Year</th>
                        <th>Section</th>
                        <th>Sport</th>
                        <th>Event</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStudents.map((reg, idx) => (
                        <tr key={reg.id || idx}>
                          <td className="asp-td--num" data-label="#">{idx + 1}</td>
                          <td className="asp-td--name" data-label="Name">
                            <span className="asp-avatar">
                              {(reg.fullName || 'U').charAt(0).toUpperCase()}
                            </span>
                            <span className="asp-name-text">
                              {reg.fullName || <em className="asp-placeholder">Last Name, First Name, Middle Name</em>}
                            </span>
                          </td>
                          <td data-label="Gender">
                            <span className={`asp-gender-badge asp-gender--${(reg.gender || 'unknown').toLowerCase()}`}>
                              {reg.gender || '—'}
                            </span>
                          </td>
                          <td data-label="Grade/Year">{reg.gradeLevel || '—'}</td>
                          <td data-label="Section">{reg.section || '—'}</td>
                          <td className="asp-td--sport" data-label="Sport">{reg.sport || '—'}</td>
                          <td data-label="Event">{reg.event || '—'}</td>
                          <td data-label="Action">
                            <button className="asp-btn-view" onClick={() => setSelectedStudent(reg)}>View</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

          </div>
        )}

        {/* ══ SPORTS & TEAMS TAB ══ */}
        {activeTab === SPORTS_TEAMS_TAB_INDEX && (
          <div className="asp-tab-content">
            <div className="asp-level-banner">
              <h2>{LEVELS.find(l => l.key === level)?.label.toUpperCase()}</h2>
              <div className="asp-level-banner__bar" />
            </div>
            <SportsTeamsManager level={level} />
          </div>
        )}

        {/* ══ MATCH SCHEDULES FORMAT TAB ══ */}
        {activeTab === MATCH_SCHEDULES_TAB_INDEX && (
          <MatchScheduleFormatSection
            level={level}
            pendingRequest={prefillFromRequest}
            onConsumedPrefill={clearPrefillFromRequest}
            actorRole={userProfile?.role}
          />
        )}

        {/* ══ VENUES TAB ══ */}
        {activeTab === VENUES_TAB_INDEX && (
          <VenuesManager />
        )}

        {/* ══ SCHEDULE REQUESTS TAB ══ */}
        {activeTab === SCHEDULE_REQUESTS_TAB_INDEX && (
          <div className="asp-tab-content">
            <div className="asp-card">
              <div className="asp-card__toprow">
                <div className="asp-card__heading">
                  <FaBell className="asp-card__icon" />
                  <span>SCHEDULE REQUESTS</span>
                </div>
              </div>
              <p style={{ margin: '0 0 14px', fontSize: '0.85rem', opacity: 0.75 }}>
                Fixtures moderators have asked you to arrange. Open Match Schedules to add the actual date/time/venue,
                then mark the request scheduled — or decline it with a reason the moderator will see.
              </p>

              {sortedScheduleRequests.length === 0 ? (
                <p style={{ opacity: 0.6, fontStyle: 'italic' }}>No schedule requests yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedScheduleRequests.map((r) => (
                    <div key={r.id} style={{ border: '1px solid #e2e6f0', borderRadius: 12, padding: '12px 16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: '0.95rem' }}>
                            {r.sport}{r.category ? ` · ${r.category}` : ''}
                          </div>
                          <div style={{ fontSize: '0.75rem', opacity: 0.65, marginTop: 2 }}>
                            {LEVEL_LABELS[r.level] || r.level} • Requested by {r.requestedByName || r.requestedByEmail || 'a moderator'}
                            {r.createdAt ? ` • ${new Date(r.createdAt).toLocaleString()}` : ''}
                          </div>
                        </div>
                        <span style={{
                          padding: '3px 10px', borderRadius: 20, fontSize: '0.7rem', fontWeight: 800, whiteSpace: 'nowrap',
                          background: r.status === 'pending' ? '#fff3d6' : r.status === 'scheduled' ? '#e6f7ec' : '#fde8e6',
                          color: r.status === 'pending' ? '#8a5f04' : r.status === 'scheduled' ? '#14713a' : '#a83218',
                        }}>
                          {r.status === 'pending' ? 'Pending' : r.status === 'scheduled' ? 'Scheduled' : 'Declined'}
                        </span>
                      </div>

                      <p style={{ margin: '8px 0 0', fontSize: '0.85rem' }}><b>Reason:</b> {r.reason}</p>

                      {r.status === 'declined' && r.declineReason && (
                        <p style={{ margin: '6px 0 0', fontSize: '0.8rem', color: '#a83218' }}>
                          <b>Decline reason:</b> {r.declineReason}
                        </p>
                      )}

                      {r.status !== 'pending' && (
                        <div style={{ marginTop: 10 }}>
                          <button type="button" className="asp-btn asp-btn--danger" onClick={() => handleDeleteRequest(r.id)}>
                            <FaTrash /> Remove
                          </button>
                        </div>
                      )}

                      {r.status === 'pending' && (
                        <div style={{ marginTop: 10 }}>
                          {decliningRequestId === r.id ? (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                              <input
                                type="text"
                                placeholder="Reason for declining (optional)"
                                value={declineReasonDraft}
                                onChange={(e) => setDeclineReasonDraft(e.target.value)}
                                style={{ flex: '1 1 220px', padding: '7px 10px', borderRadius: 8, border: '1px solid #d7dce6' }}
                              />
                              <button type="button" className="asp-btn asp-btn--danger" onClick={() => handleDeclineRequest(r.id)}>
                                Confirm decline
                              </button>
                              <button type="button" className="asp-btn" onClick={() => { setDecliningRequestId(null); setDeclineReasonDraft(''); }}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button type="button" className="asp-btn asp-btn--primary" onClick={() => handleOpenRequestInSchedules(r)}>
                                <FaArrowRight /> Open Match Schedules
                              </button>
                              <button type="button" className="asp-btn" onClick={() => handleMarkRequestScheduled(r.id)}>
                                <FaCheck /> Mark as scheduled
                              </button>
                              <button type="button" className="asp-btn asp-btn--danger" onClick={() => setDecliningRequestId(r.id)}>
                                <FaTimes /> Decline
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {requestActionToast && (
              <div className="msf-toast"><FaCheck /> {requestActionToast.text}</div>
            )}
          </div>
        )}
      </div>

      {/* ── Student Detail Modal ── */}
      {selectedStudent && (
        <div className="asp-modal-overlay" onClick={() => setSelectedStudent(null)}>
          <div className="asp-modal" onClick={e => e.stopPropagation()}>
            <div className="asp-modal__header">
              <h2>Student Details</h2>
              <button className="asp-modal__close" onClick={() => setSelectedStudent(null)}><FaTimes /></button>
            </div>
            <div className="asp-modal__body">
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Full Name</label>
                  <p>{selectedStudent.fullName || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Gender</label>
                  <p>{selectedStudent.gender || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group asp-form-group--center">
                  <label>Grade / Year Level</label>
                  <p>{selectedStudent.gradeLevel || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Section</label>
                  <p>{selectedStudent.section || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Date of Birth</label>
                  <p>{selectedStudent.dob || '—'}</p>
                </div>
                <div className="asp-form-group">
                  <label>Age</label>
                  <p>{selectedStudent.age || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group">
                  <label>Contact Number</label>
                  <p>{selectedStudent.contactNumber || '—'}</p>
                </div>
                <div className="asp-form-group">
                  <label>Email</label>
                  <p>{selectedStudent.email || selectedStudent.studentEmail || '—'}</p>
                </div>
              </div>
              <div className="asp-form-group">
                <label>Address</label>
                <p>{selectedStudent.address || '—'}</p>
              </div>
              <div className="asp-form-group">
                <label>Emergency Contact</label>
                <p>{selectedStudent.emergencyContact || '—'}</p>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group asp-form-group--center">
                  <label>Sport</label>
                  <p>{selectedStudent.sport || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Position</label>
                  <p>{selectedStudent.position || '—'}</p>
                </div>
              </div>
              <div className="asp-form-row">
                <div className="asp-form-group asp-form-group--center">
                  <label>Team Name</label>
                  <p>{selectedStudent.teamName || '—'}</p>
                </div>
                <div className="asp-form-group asp-form-group--center">
                  <label>Event</label>
                  <p>{selectedStudent.event || '—'}</p>
                </div>
              </div>
              {selectedStudent.message && (
                <div className="asp-form-group">
                  <label>Message</label>
                  <p>{selectedStudent.message}</p>
                </div>
              )}
              <div className="asp-form-row">
                {selectedStudent.photoURL && (
                  <div className="asp-form-group">
                    <label>Photo</label>
                    <p><a href={selectedStudent.photoURL} target="_blank" rel="noreferrer">View photo</a></p>
                  </div>
                )}
                {selectedStudent.waiverURL && (
                  <div className="asp-form-group">
                    <label>Waiver / Consent Form</label>
                    <p><a href={selectedStudent.waiverURL} target="_blank" rel="noreferrer">View waiver</a></p>
                  </div>
                )}
              </div>
              <div className="asp-form-actions">
                <button type="button" className="asp-btn-cancel" onClick={() => setSelectedStudent(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
