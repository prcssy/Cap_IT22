import { useState, useContext, useEffect, useCallback, useMemo, useRef } from 'react';
import { AuthContext } from '../shared/context/AuthContext';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import { ScheduleRequestsContext } from '../shared/context/ScheduleRequestsContext';
import { useNavigate } from 'react-router-dom';
import './AdminSchedulePage.css';
// Recent Registrations (moved here from Super Admin) reuses SuperAdminPage's
// sa-* table/card classes unchanged, so it looks exactly as it did there.
import '../superadmin/SuperAdminPage.css';
import { FaTimes, FaSync, FaUsers, FaChevronDown, FaCheck, FaEdit, FaPlus, FaMapMarkerAlt, FaTrophy, FaTrash, FaExclamationTriangle, FaDownload, FaBell, FaArrowRight } from 'react-icons/fa';
// jspdf/jspdf-autotable are loaded on demand (see handleDownloadPdf /
// handleDownloadBracketPdf below), not imported statically here.
import { db } from '../shared/firebase';
import { getAllRegistrations, getAllUsers, getSportsTeamsConfig, getMatchSchedules, getMatchRecords, saveGeneratedSchedule, upsertMatchSchedule, deleteMatchSchedule, deleteScheduleSet, inScheduleSet, setLivePlayerCount, setEventRegistrationCounts, getEventKey, EVENT_TYPES, getVenues, getAllMatchSchedules, updateScheduleRequest, deleteScheduleRequest } from '../shared/services/firestoreService';
import SportsTeamsManager from './SportsTeamsManager';
import VenuesManager from './VenuesManager';
import LevelTabs from '../shared/components/LevelTabs';
import StudentRegistrationDetails from '../superadmin/StudentRegistrationDetails';


/* ─── Grade-level bucketing ───────────────────────── */
const ELEMENTARY_GRADES = new Set(['Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6']);
const HIGH_SCHOOL_GRADES = new Set(['Grade 7','Grade 8','Grade 9','Grade 10','Grade 11','Grade 12']);
const COLLEGE_GRADES = new Set(['1st Year','2nd Year','3rd Year','4th Year']);

function getSchoolLevel(gradeLevel) {
  if (!gradeLevel) return null;
  if (ELEMENTARY_GRADES.has(gradeLevel)) return 'elementary';
  if (HIGH_SCHOOL_GRADES.has(gradeLevel)) return 'highSchool';
  if (COLLEGE_GRADES.has(gradeLevel)) return 'college';
  return null;
}

function buildSummary(registrations) {
  const map = {};
  registrations.forEach(({ sport, gender, gradeLevel, status }) => {
    // A rejected registration no longer holds a spot on a team, so it
    // shouldn't keep counting toward the Elementary/High School/College
    // totals (or the grand Total Players tile derived from them) once an
    // admin has rejected it.
    if (!sport || status === 'rejected') return;
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
   recognisable grade level, and isn't rejected — anything else
   contributes 0 to the Elementary / High School / College totals. The
   per-event chips have to use the exact same test, or they'd report a
   bigger population than the table right beneath them (half-filled or
   abandoned test registrations — or ones an admin has since rejected —
   would show up in the chips but nowhere else). */
function countsAsPlayer(r) {
  return Boolean(r && r.sport && getSchoolLevel(r.gradeLevel) && r.status !== 'rejected');
}

/* Which event bucket a registration belongs to. Registrations saved
   before the event picker existed have no event on them, so they land
   in `unassigned` rather than being silently dropped. */
function getEventBucket(r, eventList = EVENT_TYPES) {
  return getEventKey(r.eventKey || r.event, eventList) || 'unassigned';
}

/* Tally registrations per event (Intramurals / Sportsfest / Prisaa, or
   whatever Super Admin's Web Customization page currently lists). */
function buildEventCounts(registrations, eventList = EVENT_TYPES) {
  const counts = { unassigned: 0 };
  eventList.forEach(({ key }) => { counts[key] = 0; });
  registrations.filter(countsAsPlayer).forEach((r) => {
    counts[getEventBucket(r, eventList)]++;
  });
  return counts;
}

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
   at once; the next round/stage starts slotGapFor(sport) later. Once a
   slot would land at/after DAY_CUTOFF_MINUTES, scheduling rolls over to
   the next calendar day, restarting at the admin's chosen start time.
   Purely a starting point — every match stays editable afterward via the
   per-match Edit modal, same as before this existed.
═══════════════════════════════════════════ */
const DEFAULT_SLOT_GAP_MINUTES = 60;
const SLOT_GAP_BY_SPORT = { basketball: 90, volleyball: 90 }; // 1:30 per game
const slotGapFor = (sport) =>
  SLOT_GAP_BY_SPORT[String(sport || '').trim().toLowerCase()] ?? DEFAULT_SLOT_GAP_MINUTES;
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
    // Basketball/volleyball: every match gets its own 1:30 slot, even within
    // the same round/stage. Other sports still share one slot per round.
    const key = m.sport && SLOT_GAP_BY_SPORT[String(m.sport).trim().toLowerCase()]
      ? m.id
      : scheduleGroupKey(m);
    if (key !== prevKey) {
      if (!isFirstGroup) {
        currentMinutes += slotGapFor(m.sport);
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

/* A bracket slot that hasn't been won into yet still holds its generator
   placeholder text ("Winner QF1", "Loser UB-SF2", …) instead of a real
   team name. */
function isPlaceholderTeam(name) {
  return typeof name === 'string' && /^(Winner|Loser)\s/.test(name);
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
function FilterDropdown({ label, value, valueKey, placeholder, options, onChange, disabled }) {
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
          {(valueKey != null && options.find(o => o.value === valueKey)?.display) || value || placeholder}
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
                className={`msf-select__opt ${(valueKey != null ? valueKey === opt.value : value === opt.label) ? 'msf-select__opt--active' : ''}`}
                onClick={() => { onChange(opt); setOpen(false); }}
              >
                {opt.display || opt.label}
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
  const ROW_H = 64;
  const TEAM_W = 190;
  const TEAM_H = 44;
  const COL_GAP = 150;

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

/* Single-elimination stages are named "Quarterfinals"/"Semifinals"/
   "Finals"/"Round of N" with no prefix; double-elimination's are always
   "Upper Bracket – …"/"Lower Bracket – …"/"Grand Final" — same
   discriminator advanceBracketWinner (firestoreService.js) uses. */
function isSingleBracketStage(stage) {
  return !!stage
    && !stage.startsWith('Upper Bracket')
    && !stage.startsWith('Lower Bracket')
    && stage !== 'Grand Final';
}

/* ── Already-saved bracket, grouped back into rounds ──
   BracketTree only ever draws round-1 team names (every later round is
   just a labeled dot — it was built purely as a generator PREVIEW, before
   any result exists to show). Once a bracket is saved, what's actually
   useful is seeing the CURRENT team in every slot — including "Winner
   QF1" placeholders that have already been resolved by advanceBracketWinner
   once that earlier match got a result — so this reads directly off the
   saved matches instead of regenerating a fresh, round-1-only tree. */
function buildSavedBracketStages(matches) {
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

/* One node's two-team box — same coordinate math as the generator's
   BracketTree (leafY/matchY/colX/elbow), but a team-box sits at EVERY
   round's node instead of just round 1, reading each match's CURRENT
   teamA/teamB straight off the saved schedule. A slot that's still a
   generator placeholder ("Winner QF2") renders muted/italic instead of a
   team badge, same visual language as a bye slot in the generator tree. */
function SavedBracketTree({ stages, matchRecords }) {
  const ROW_H = 74;
  const NODE_W = 200;
  const NODE_H = 56;
  const LINE_GAP = 40; // horizontal space reserved for the connector between two columns
  const COL_W = NODE_W + LINE_GAP;

  if (!stages.length) return null;
  const totalRounds = stages.length;
  const leafCount = stages[0].matches.length * 2;

  // Y positions are still built bottom-up from an implicit "leaf" row (the
  // two teams feeding each round-1 box), same idea as the generator's
  // BracketTree — but here every round gets an actual box, including
  // round 1, so there's no separate leaf column to draw.
  const leafY = Array.from({ length: leafCount }, (_, i) => i * ROW_H + ROW_H / 2);
  const matchY = [];
  stages.forEach((stage, r) => {
    // A round can have fewer matches than half the previous one when a team
    // got a bye (byes are never saved as matches) — e.g. 5 teams: the bye team
    // walks straight into the finals, so the finals node has only ONE child
    // match. Average whichever children exist instead of reading undefined.
    matchY.push(stage.matches.map((_, m) => {
      const ys = (r === 0 ? leafY : matchY[r - 1]).slice(2 * m, 2 * m + 2);
      return ys.reduce((s, y) => s + y, 0) / ys.length;
    }));
  });

  const colX = (r) => r * COL_W; // left edge of round r's boxes
  const championX = colX(totalRounds - 1) + COL_W;
  const championY = matchY[totalRounds - 1][0];
  const height = leafCount * ROW_H;
  const width = championX + 150;

  const elbow = (childX, y1, y2, parentX, parentY) => {
    const midX = (childX + parentX) / 2;
    return `M ${childX} ${y1} H ${midX} M ${childX} ${y2} H ${midX} M ${midX} ${y1} V ${y2} M ${midX} ${parentY} H ${parentX}`;
  };

  // Connectors only run BETWEEN columns of boxes — round 1 has nothing
  // earlier to connect from, so it starts the tree with no incoming lines.
  const connectors = [];
  for (let r = 1; r < totalRounds; r++) {
    const childX = colX(r - 1) + NODE_W;
    const parentX = colX(r);
    stages[r].matches.forEach((_, m) => {
      const y1 = matchY[r - 1][2 * m];
      const y2 = matchY[r - 1][2 * m + 1] ?? y1; // bye: only one feeder match
      connectors.push(elbow(childX, y1, y2, parentX, matchY[r][m]));
    });
  }
  connectors.push(`M ${colX(totalRounds - 1) + NODE_W} ${championY} H ${championX}`);

  const finalMatch = stages[totalRounds - 1]?.matches[0] || null;
  const finalRecord = finalMatch && matchRecords.find((r) => recordMatchesSchedule(r, finalMatch));
  const championName = finalRecord ? recordWinnerName(finalRecord) : null;
  const championLogo = finalMatch && championName === finalMatch.teamA ? finalMatch.teamALogo
    : finalMatch && championName === finalMatch.teamB ? finalMatch.teamBLogo
    : null;

  return (
    <div className="msf-bracket" style={{ height }}>
      <div className="msf-bracket-headers">
        {stages.map((s, i) => <div key={i} style={{ width: COL_W }}>{s.name}</div>)}
        <div style={{ width: width - colX(totalRounds - 1) - COL_W }}>Champion</div>
      </div>

      <div className="msf-bracket-canvas" style={{ height, width }}>
        <svg width={width} height={height} className="msf-bracket-lines">
          {connectors.map((d, i) => <path key={i} d={d} />)}
        </svg>

        {stages.map((stage, r) => stage.matches.map((m, mi) => {
          const recorded = matchRecords.some((rec) => recordMatchesSchedule(rec, m));
          return (
            <div
              key={m.id}
              className={`msf-savedtree-node ${recorded ? 'msf-savedtree-node--done' : ''}`}
              style={{ left: colX(r), top: matchY[r][mi] - NODE_H / 2, width: NODE_W, height: NODE_H }}
            >
              {[[m.teamA, m.teamALogo], [m.teamB, m.teamBLogo]].map(([name, logo], slot) => (
                isPlaceholderTeam(name) ? (
                  <div className="msf-savedtree-slot msf-savedtree-slot--pending" key={slot}>{name}</div>
                ) : (
                  <div className="msf-savedtree-slot" key={slot}>
                    <TeamBadge team={{ name, logo }} size={18} />
                    <span>{name}</span>
                  </div>
                )
              ))}
            </div>
          );
        }))}

        <div className="msf-bracket-champion" style={{ left: championX, top: championY }}>
          {championName ? <TeamBadge team={{ name: championName, logo: championLogo }} size={30} /> : <FaTrophy />}
          <span>{championName || 'Champion'}</span>
        </div>
      </div>
    </div>
  );
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
function generateDoubleBracket(teamNames) {
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

/* Renumbers every real match (skipping byes) sequentially — Upper Bracket
   rounds, then Lower Bracket rounds — as "Match N", and rewrites every
   reference to it ("Winner QF1", "Loser UB-SF2", …) into "Winner of
   Match N" / "Loser of Match N". Matches how published brackets (e.g.
   the MLBB M7 Worlds knockout stage) label nodes, so it's immediately
   clear which match feeds which — instead of internal codes like
   "QF1"/"LB3" that only make sense to someone who knows the generator.
   This only reshapes what the PREVIEW tree displays; it returns new
   objects rather than mutating wbStages/lbRounds, so the actual match
   records used to save/schedule the tournament are untouched. */
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

/* ── Already-saved double bracket, regrouped from flat saved matches back
   into { wbStages, leaves, lbRounds } — the same shape generateDoubleBracket
   returns — so DoubleBracketTree can draw it without caring whether it's
   reading a live preview or persisted data. Saved UB matchLabels were
   prefixed at save time ("UB-QF1"); stripped back to the raw codes
   ("QF1") DoubleBracketTree's connector renaming expects. LB labels were
   never prefixed, so they pass through unchanged. */
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
   matching the double-elimination bracket look (two feeder trees
   merging into one final) instead of two disconnected mini-trees. ── */
function DoubleBracketTree({ wbStages: wbStagesRaw, leaves, lbRounds: lbRoundsRaw, teamByName }) {
  const ROW_H = 56;
  const LEAF_W = 190;
  const LEAF_H = 40;
  const COL_GAP = 250;

  if (!wbStagesRaw.length || !lbRoundsRaw.length) return null;

  const { wbStages, lbRounds } = withMatchNumbers(wbStagesRaw, lbRoundsRaw);

  const colX = (r) => LEAF_W + (r + 1) * COL_GAP;

  /* Merges two inputs (each with its own origin x, since a "fresh" drop-in
     box's line has to start at its right edge, not a bare column x) into
     one parent point. Reduces to a plain single-origin elbow when the two
     origins share an x, which covers every normal (non-drop-in) merge. */
  const mergeLines = (x1, y1, x2, y2, parentX, parentY) => {
    const midX = (Math.max(x1, x2) + parentX) / 2;
    return `M ${x1} ${y1} H ${midX} M ${x2} ${y2} H ${midX} M ${midX} ${y1} V ${y2} M ${midX} ${parentY} H ${parentX}`;
  };

  /* Lays out one bracket's rounds on top of a fixed row of round-0 leaves.
     Every match's winner is now rendered as a boxed row exactly like a
     leaf, not a bare dot, so a box's usable connector point is its RIGHT
     edge (boxX + LEAF_W) rather than the column x it starts at — that's
     what `lineX` tracks below.

     Each match's a/b inputs are resolved BY NAME against previously
     produced winners rather than by row index — a normal elimination
     round halves the match count, but the Lower Bracket's "drop-in"
     rounds carry the SAME match count as the round before (each match
     pairs one LB survivor with a brand-new Upper Bracket loser), which
     breaks any layout that assumes round r always has half as many rows
     as round r-1. A name not seen before gets its own fresh boxed row —
     placed right next to its actual match partner when that partner's
     already known, so paired inputs read as one grouped unit — and only
     falls back to a sequential counter when neither side is known yet. */
  const layoutRounds = (roundsMatches, rootLeaves, top, nodeLabel) => {
    const known = {};
    rootLeaves.forEach((name, i) => {
      if (name) known[name] = { y: top + i * ROW_H + ROW_H / 2, lineX: LEAF_W };
    });
    let cursorY = top + rootLeaves.length * ROW_H;
    const freshBoxes = [];
    const matchY = [];
    const connectors = [];
    const captions = []; // "Match N" label shown right above its own two input boxes

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
        // Both slots empty (e.g. 5 teams padded to 8: the 4th first-round
        // match is Bye vs Bye) — nothing to draw or connect for this match.
        if (!a && !b) return null;
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
            <TeamBadge team={teamByName ? teamByName(name) : { name }} size={26} />
            <span>{name}</span>
          </div>
        ) : (
          <div key={`ub-${i}`} className="msf-bracket-team msf-bracket-team--bye" style={{ top: UB_TOP + i * ROW_H + ROW_H / 2 - LEAF_H / 2, left: 0, height: LEAF_H, width: LEAF_W }}>
            <span>Bye</span>
          </div>
        )
      ))}

      {ub.matchY.map((round, r) => round.map((node, i) => node && (
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

      {lb.matchY.map((round, r) => round.map((node, i) => node && (
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

function MatchScheduleFormatSection({ level, pendingRequest, onConsumedPrefill, actorRole }) {
  const { schoolName, logo } = useContext(BrandingContext);
  const LEVEL_LABELS = useContext(LevelLabelsContext);
  const [sportsList, setSportsList] = useState([]);
  const [teamsList,  setTeamsList]  = useState([]);
  const [loading,    setLoading]    = useState(false);

  const [selSport,    setSelSport]    = useState(null); // sport object
  const [selCategory, setSelCategory] = useState(null); // { label, value, format }
  const [selFormat,   setSelFormat]   = useState(null); // { id, label }
  const [activeRound, setActiveRound] = useState(0);

  // Sport/category/format picks belong to one level's own sports list, so
  // clear them when the level changes (e.g. Track and Field exists in
  // Elementary but not College). Same "adjust state when a prop changes"
  // render-time pattern as the pendingRequest handling below.
  const [pickedLevel, setPickedLevel] = useState(level);
  if (pickedLevel !== level) {
    setPickedLevel(level);
    setSelSport(null);
    setSelCategory(null);
    setSelFormat(null);
    setActiveRound(0);
  }

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
        // `label` is what gets saved on matches; `display` adds the division
        // (e.g. "MEN (Senior)") so same-category divisions are tellable apart.
        const dName = (d.name || '').trim();
        const display = dName && dName.toLowerCase() !== division.toLowerCase() ? `${division} (${dName})` : division;
        return { value: d.id, label: division, display, format: d.format };
      })
    );
    return raw.length > 0
      ? raw
      : sportObj
        ? [{ value: 'general', label: 'General', format: null }]
        : [];
  };
  const categoryOptions = categoryOptionsFor(selSport);

  /* Category/division caption for a schedule row, e.g. "MEN (Senior) · Single
     Bracket". Resolves the division's full display name via its saved
     divisionId; older matches without one fall back to the stored category. */
  const matchCaption = (m) => {
    const sportObj = sportsList.find(s => norm(s.name) === norm(m.sport));
    const div = m.divisionId && categoryOptionsFor(sportObj).find(o => o.value === m.divisionId);
    return [div?.display || m.category, m.format].filter(Boolean).join(' · ');
  };

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
  const teamsForSport = useCallback((sportName, divisionId) => {
    if (!sportName) return [];
    // team.divisionMap[sportName] = the divisions of that sport the team plays
    // in (set in Sports & Teams). No entry / empty = plays every division.
    const inDivision = (t) => {
      const allowed = Object.entries(t.divisionMap || {}).find(([k]) => norm(k) === norm(sportName))?.[1];
      return !divisionId || !allowed?.length || allowed.includes(divisionId);
    };
    return Array.from(
      new Map(
        teamsList
          .filter(t =>
            (t.name || '').trim() &&
            (t.sportIds || []).some(id => norm(id) === norm(sportName)) &&
            inDivision(t)
          )
          .map(t => [t.id || t.name, t])
      ).values()
    );
  }, [teamsList]);

  const eligibleTeams = useMemo(
    () => teamsForSport(selSport?.name, selCategory?.value),
    [teamsForSport, selSport, selCategory]
  );

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
  const lockedMatches = useMemo(() => (
    (selSport && selCategory)
      ? savedSchedules.filter(m => inScheduleSet(m, selSport.name, selCategory.label, selCategory.value))
      : []
  ), [selSport, selCategory, savedSchedules]);
  const isLocked = lockedMatches.length > 0;
  const lockedResultsCount = useMemo(
    () => lockedMatches.filter(m => matchRecords.some(r => recordMatchesSchedule(r, m))).length,
    [lockedMatches, matchRecords]
  );
  // Bracket-tree layout is rebuilt from scratch (rounds, byes, connector
  // math) every time it runs — only worth doing again when the underlying
  // matches actually change, not on every unrelated re-render of this page.
  const savedBracketStages = useMemo(() => buildSavedBracketStages(lockedMatches), [lockedMatches]);
  // Rebuild the generator's full tree (all team boxes incl. byes) so a saved
  // single bracket looks exactly like the preview shown at generation time.
  // Only trusted if it still lines up with what was saved (same labels, and
  // every saved real-team pairing matches); otherwise the caller falls back
  // to SavedBracketTree, which reads straight off the saved matches.
  const savedFullBracket = useMemo(() => {
    if (!lockedMatches.length || !lockedMatches.every(m => isSingleBracketStage(m.stage))) return null;
    const full = generateBracket(eligibleTeams.map(t => t.name));
    const byLabel = new Map();
    full.stages.forEach(s => s.matches.forEach(m => { if (!m.isBye) byLabel.set(m.label, m); }));
    if (byLabel.size !== lockedMatches.length) return null;
    const ok = lockedMatches.every((m) => {
      const g = byLabel.get(m.matchLabel);
      if (!g) return false;
      const same = (saved, gen) => isPlaceholderTeam(saved) || isPlaceholderTeam(gen) || saved === gen;
      return same(m.teamA, g.a) && same(m.teamB, g.b);
    });
    return ok ? full : null;
  }, [lockedMatches, eligibleTeams]);
  const savedDoubleBracketStages = useMemo(() => buildSavedDoubleBracketStages(lockedMatches), [lockedMatches]);

  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resettingSchedule, setResettingSchedule] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const hasUnsavedPicks = !!(selSport || selCategory || selFormat || scheduleStartDate || scheduleStartTime);

  const handleResetClick = () => {
    if (isLocked) {
      setResetConfirmOpen(true);
    } else if (hasUnsavedPicks) {
      setClearConfirmOpen(true);
    } else {
      handleReset();
    }
  };

  const handleConfirmResetSchedule = async () => {
    if (!selSport || !selCategory) return;
    setResettingSchedule(true);
    try {
      const remaining = await deleteScheduleSet(level, selSport.name, selCategory.label, actorRole, selCategory.value);
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
      divisionId: selCategory.value,
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
    const filledPairs = addForm.pairs.filter(p => p.teamA && p.teamB);
    if (filledPairs.some(p => norm(p.teamA) === norm(p.teamB))) {
      setToast({ text: 'A team cannot be scheduled against itself — pick two different teams.' });
      return;
    }
    const validPairs = filledPairs;
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
    if (norm(editForm.teamA) === norm(editForm.teamB)) {
      setToast({ text: 'A team cannot be scheduled against itself — pick two different teams.' });
      return;
    }
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

  const scheduleSportOrder = useMemo(() => sportsList.map(s => s.name), [sportsList]);
  const sportSections = useMemo(() => Object.entries(
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
    })), [savedSchedules, scheduleSportOrder]);

  /* ── Download the visible schedule list as a PDF ──
     Mirrors the on-screen grouping (sport → date), one table per sport,
     so the printout matches what the admin is looking at. jsPDF/autoTable
     are loaded on demand here rather than imported statically at the top
     of the file — they're a sizeable chunk of code that most admin
     sessions never touch, since exporting a PDF is one action among many
     on this page. */
  const handleDownloadPdf = async () => {
    const { jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');
    const { loadPdfLogo, drawLogoTitleRow } = await import('../shared/utils/loadPdfLogo');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();

    const logoInfo = await loadPdfLogo(logo);
    const titleY = 40;
    drawLogoTitleRow(doc, { pageWidth, y: titleY, title: schoolName, logoInfo });

    doc.setFontSize(11);
    doc.setFont(undefined, 'normal');
    doc.text(`Match Schedule — ${LEVEL_LABELS[level] || level}`, pageWidth / 2, titleY + 18, { align: 'center' });
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(`Generated ${new Date().toLocaleString()}`, pageWidth / 2, titleY + 32, { align: 'center' });
    doc.setTextColor(0);

    let cursorY = titleY + 50;
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

  /* Draws the saved single-elimination bracket as an actual diagram (boxes
     + elbow connectors), same column layout as SavedBracketTree on screen,
     translated into jsPDF's line/rect/text primitives — a plain match-list
     table (like handleDownloadPdf above) wouldn't read as "a bracket". */
  const handleDownloadBracketPdf = async () => {
    const stages = buildSavedBracketStages(lockedMatches);
    if (!stages.length) return;

    const { jsPDF } = await import('jspdf');
    const { loadPdfLogo, drawLogoTitleRow } = await import('../shared/utils/loadPdfLogo');

    const NODE_W = 150, NODE_H = 46, ROW_H = 60, LINE_GAP = 46;
    const COL_W = NODE_W + LINE_GAP;
    const MARGIN = 50;
    const totalRounds = stages.length;
    const leafCount = stages[0].matches.length * 2;

    const pdf = new jsPDF({
      orientation: 'landscape',
      unit: 'pt',
      format: [Math.max(842, MARGIN * 2 + (totalRounds + 1) * COL_W + 120), Math.max(595, MARGIN * 2 + leafCount * ROW_H)],
    });
    const pageWidth = pdf.internal.pageSize.getWidth();

    // Logo + title both fit inside the existing MARGIN(50)-tall header
    // strip above the bracket columns (which start at MARGIN + 60), so no
    // page-size math above needs to change to make room for it.
    const logoInfo = await loadPdfLogo(logo);
    const titleY = 30;
    drawLogoTitleRow(pdf, { pageWidth, y: titleY, title: schoolName, logoInfo, fontSize: 14, logoHeight: 18, maxLogoWidth: 42 });

    pdf.setFontSize(10);
    pdf.setFont(undefined, 'normal');
    pdf.text(
      `${selSport?.name || ''} — ${selCategory?.label || ''} Bracket (${LEVEL_LABELS[level] || level})`,
      pageWidth / 2, titleY + 16, { align: 'center' },
    );

    const colX = (r) => MARGIN + r * COL_W;
    const leafY = Array.from({ length: leafCount }, (_, i) => MARGIN + 60 + i * ROW_H + ROW_H / 2);
    const matchY = [];
    stages.forEach((stage, r) => {
      matchY.push(stage.matches.map((_, m) => (
        r === 0
          ? (leafY[2 * m] + leafY[2 * m + 1]) / 2
          : (matchY[r - 1][2 * m] + matchY[r - 1][2 * m + 1]) / 2
      )));
    });
    const championX = colX(totalRounds - 1) + COL_W;
    const championY = matchY[totalRounds - 1][0];

    pdf.setFontSize(10);
    pdf.setFont(undefined, 'bold');
    pdf.setTextColor(91, 103, 138);
    stages.forEach((s, r) => pdf.text(s.name.toUpperCase(), colX(r), MARGIN + 60, { align: 'left' }));
    pdf.text('CHAMPION', championX, MARGIN + 60, { align: 'left' });
    pdf.setTextColor(0);

    pdf.setDrawColor(183, 191, 216);
    pdf.setLineWidth(1);
    for (let r = 1; r < totalRounds; r++) {
      const childX = colX(r - 1) + NODE_W;
      const parentX = colX(r);
      const midX = (childX + parentX) / 2;
      stages[r].matches.forEach((_, m) => {
        const y1 = matchY[r - 1][2 * m];
        const y2 = matchY[r - 1][2 * m + 1];
        const parentY = matchY[r][m];
        pdf.line(childX, y1, midX, y1);
        pdf.line(childX, y2, midX, y2);
        pdf.line(midX, y1, midX, y2);
        pdf.line(midX, parentY, parentX, parentY);
      });
    }
    pdf.line(colX(totalRounds - 1) + NODE_W, championY, championX, championY);

    // Logos are stored as base64 data URLs (data:image/jpeg;... or
    // data:image/png;...) directly on the match doc — jsPDF's addImage
    // takes that string as-is, it just needs the right format keyword.
    // Wrapped in try/catch: a malformed/unreadable logo must never abort
    // the whole export, just fall back to text-only for that slot.
    const logoFormat = (dataUrl) => (/^data:image\/png/i.test(dataUrl || '') ? 'PNG' : 'JPEG');
    const drawLogo = (logo, x, y, size) => {
      if (!logo) return false;
      try {
        pdf.addImage(logo, logoFormat(logo), x, y, size, size);
        return true;
      } catch (err) {
        console.warn('Could not draw team logo in bracket PDF:', err);
        return false;
      }
    };

    const drawSlot = (name, logo, x, w, lineY) => {
      const pending = isPlaceholderTeam(name);
      const logoSize = 12;
      const hasLogo = !pending && drawLogo(logo, x + 6, lineY - logoSize + 2, logoSize);
      pdf.setFont(undefined, pending ? 'italic' : 'bold');
      pdf.setFontSize(8.5);
      pdf.setTextColor(pending ? 150 : 20);
      const textX = x + (hasLogo ? 6 + logoSize + 4 : 6);
      const text = pdf.splitTextToSize(name || 'TBD', w - (textX - x) - 6)[0] || '';
      pdf.text(text, textX, lineY);
    };

    stages.forEach((stage, r) => {
      stage.matches.forEach((m, mi) => {
        const x = colX(r);
        const y = matchY[r][mi] - NODE_H / 2;
        const recorded = matchRecords.some((rec) => recordMatchesSchedule(rec, m));
        pdf.setDrawColor(recorded ? 134 : 221, recorded ? 239 : 225, recorded ? 172 : 238);
        pdf.setFillColor(255, 255, 255);
        pdf.roundedRect(x, y, NODE_W, NODE_H, 5, 5, 'FD');
        drawSlot(m.teamA, m.teamALogo, x, NODE_W, y + NODE_H * 0.4);
        pdf.setDrawColor(238, 240, 245);
        pdf.line(x + 6, y + NODE_H / 2, x + NODE_W - 6, y + NODE_H / 2);
        drawSlot(m.teamB, m.teamBLogo, x, NODE_W, y + NODE_H * 0.85);
      });
    });

    const finalMatch = stages[totalRounds - 1]?.matches[0] || null;
    const finalRecord = finalMatch && matchRecords.find((r) => recordMatchesSchedule(r, finalMatch));
    const championName = finalRecord ? recordWinnerName(finalRecord) : null;
    const championLogo = finalMatch && championName === finalMatch.teamA ? finalMatch.teamALogo
      : finalMatch && championName === finalMatch.teamB ? finalMatch.teamBLogo
      : null;
    const championHasLogo = drawLogo(championLogo, championX, championY - 22, 16);
    pdf.setFont(undefined, 'bold');
    pdf.setFontSize(10);
    pdf.setTextColor(0);
    pdf.text(championName || 'TBD', championX + (championHasLogo ? 20 : 0), championY, { align: 'left' });

    pdf.setFontSize(8);
    pdf.setFont(undefined, 'normal');
    pdf.setTextColor(110);
    pdf.text(`Generated ${new Date().toLocaleString()}`, MARGIN, pdf.internal.pageSize.getHeight() - 20);

    pdf.save(`bracket-${selSport?.name || 'sport'}-${selCategory?.label || ''}-${level}-${new Date().toISOString().slice(0, 10)}.pdf`);
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
            valueKey={selCategory?.value}
            placeholder="Select category"
            options={categoryOptions.map(o => ({ value: o.value, label: o.label, display: o.display, raw: o }))}
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
              <p className="msf-form-note" style={{ color: '#a83218', fontWeight: 700, margin: '4px 0 0' }}>
                Click "Reset Schedule" above to delete it before generating a new one in a different format.
              </p>
            </div>
            <div className="msf-stats">
              <div className="msf-stat"><span>Teams</span><b>{eligibleTeams.length}</b></div>
              <div className="msf-stat"><span>Saved matches</span><b>{lockedMatches.length}</b></div>
            </div>
          </div>
        ) : null}

        {isLocked && lockedMatches.every(m => isSingleBracketStage(m.stage)) && (
          <>
            <div className="msf-bracket-actions">
              <button type="button" className="msf-reset-btn" onClick={handleDownloadBracketPdf}>
                <FaDownload /> Download Bracket PDF
              </button>
            </div>
            {savedFullBracket ? (
              <BracketTree stages={savedFullBracket.stages} leaves={savedFullBracket.leaves} teamByName={teamByName} />
            ) : (
              <SavedBracketTree
                stages={savedBracketStages}
                matchRecords={matchRecords}
              />
            )}
          </>
        )}

        {isLocked && lockedMatches[0]?.format === 'Double Bracket' && (
          <div className="msf-dbracket">
            <div className="msf-dbracket__scroll">
              <DoubleBracketTree {...savedDoubleBracketStages} teamByName={teamByName} />
            </div>
          </div>
        )}

        {isLocked ? null : !ready ? (
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
                <div className="msf-dbracket__scroll">
                  <DoubleBracketTree
                    wbStages={doubleBracket.wbStages}
                    leaves={doubleBracket.leaves}
                    lbRounds={doubleBracket.lbRounds}
                    teamByName={teamByName}
                  />
                </div>

                <p className="msf-dbracket__note">
                  If the Lower Bracket team wins the Grand Final, a single reset match decides the title —
                  that's the "up to {totalMatches + 1}" match.
                </p>
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
                  valueKey={selCategory?.value}
                  placeholder="Select category"
                  options={categoryOptions.map(o => ({ value: o.value, label: o.label, display: o.display, raw: o }))}
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
                            {matchCaption(m) && <div className="msf-matchrow__cat">{matchCaption(m)}</div>}
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
                              {matchCaption(m) && <div className="msf-matchrow__cat">{matchCaption(m)}</div>}
                              {m.location
                                ? <div className="msf-matchrow__loc"><FaMapMarkerAlt /> {m.location}</div>
                                : <div className="msf-matchrow__tbd"><FaExclamationTriangle /> Venue to be determined</div>}
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

      {/* ── Clear selections confirmation — no saved data at stake here (isLocked is
         false in this branch), just the in-progress sport/category/format/date picks ── */}
      {clearConfirmOpen && (
        <div className="msf-overlay" onClick={() => setClearConfirmOpen(false)}>
          <div className="msf-confirm-delete" onClick={e => e.stopPropagation()}>
            <h3>Clear these selections?</h3>
            <p>This will clear the sport, category, format, and date/time you've picked so far.</p>
            <div className="msf-confirm-delete__actions">
              <button type="button" className="msf-btn-ghost" onClick={() => setClearConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="msf-btn-danger"
                onClick={() => { handleReset(); setClearConfirmOpen(false); }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

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
            <p className="msf-success-eyebrow">Tournament Schedule</p>
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
                  {addCategoryOptions.map(o => <option key={o.value} value={o.label}>{o.display || o.label}</option>)}
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
                    {editCategoryOptions.map(o => <option key={o.value} value={o.label}>{o.display || o.label}</option>)}
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
                  disabled={isGeneratedMatch(editForm) && !isPlaceholderTeam(editForm.teamA)}
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
                  disabled={isGeneratedMatch(editForm) && !isPlaceholderTeam(editForm.teamB)}
                  onChange={e => setEditForm(f => ({ ...f, teamB: e.target.value }))}
                >
                  <option value="">Select a teams</option>
                  {editPool.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                  {editForm.teamB && !editPool.some(t => t.name === editForm.teamB) && (
                    <option value={editForm.teamB}>{editForm.teamB}</option>
                  )}
                </select>
              </div>
              {isGeneratedMatch(editForm) && (isPlaceholderTeam(editForm.teamA) || isPlaceholderTeam(editForm.teamB)) && (
                <p className="msf-form-note">
                  This bracket slot is normally filled in automatically once the earlier match's result is
                  recorded — you can also set it by hand now if needed.
                </p>
              )}
              {isGeneratedMatch(editForm) && !isPlaceholderTeam(editForm.teamA) && !isPlaceholderTeam(editForm.teamB) && (
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
  const { schoolName, events } = useContext(BrandingContext);
  const LEVEL_LABELS = useContext(LevelLabelsContext);
  const LEVELS = useMemo(() => [
    { key: 'elementary', label: LEVEL_LABELS.elementary },
    { key: 'highSchool',  label: LEVEL_LABELS.highSchool },
    { key: 'college',     label: LEVEL_LABELS.college },
  ], [LEVEL_LABELS]);
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState(REGISTRATION_TAB_INDEX);
  const [level, setLevel] = useState('elementary');

  // Registration data
  const [summaryRows,      setSummaryRows]      = useState([]);
  // Raw student registrations kept around so the summary can be
  // re-tallied per event without another round-trip to Firestore, and so
  // the Recent Registrations card below can list the latest submissions.
  const [studentRegs,      setStudentRegs]      = useState([]);
  const [eventCounts,      setEventCounts]      = useState({});
  const [summaryEvent,     setSummaryEvent]     = useState(''); // '' = all events
  const [summaryLoading,   setSummaryLoading]   = useState(false);
  const [summaryError,     setSummaryError]     = useState('');

  // Schedule requests — moderators asking for a fixture to be arranged.
  // Sourced from the one shared listener ScheduleRequestsProvider owns for
  // the whole authenticated session (see App.jsx), instead of opening a
  // second `onSnapshot` on the same `scheduleRequests/all` doc here —
  // Sidebar (always mounted alongside this page) used to have its own.
  const { scheduleRequests } = useContext(ScheduleRequestsContext);
  const [decliningRequestId, setDecliningRequestId] = useState(null);
  const [declineReasonDraft, setDeclineReasonDraft] = useState('');
  const [requestActionToast, setRequestActionToast] = useState(null);
  // The request currently being opened into Match Schedules Format for
  // fulfillment — handed to MatchScheduleFormatSection as a one-shot
  // "prefill the Add Schedule form" command, then cleared once it's read.
  const [prefillFromRequest, setPrefillFromRequest] = useState(null);
  const clearPrefillFromRequest = useCallback(() => setPrefillFromRequest(null), []);

  useEffect(() => {
    if (!requestActionToast) return;
    const t = setTimeout(() => setRequestActionToast(null), 3500);
    return () => clearTimeout(t);
  }, [requestActionToast]);

  const pendingRequestCount = useMemo(
    () => scheduleRequests.filter((r) => r.status === 'pending').length,
    [scheduleRequests]
  );
  const sortedScheduleRequests = useMemo(
    () => [...scheduleRequests].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [scheduleRequests]
  );

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
    // getAllRegistrations/getAllUsers go through firestoreService's shared
    // in-flight de-dupe cache, so this and the embedded
    // StudentRegistrationDetails table (which reads the same 2 collections
    // on the same tab load) share one network round trip instead of two.
    const [registrations, users] = await Promise.all([
      getAllRegistrations(),
      getAllUsers(),
    ]);

    // This table is the STUDENT registration tabulation — staff accounts
    // (admin / moderator / super admin) manage it, they don't belong as
    // rows in it.
    const studentUsers = users.filter(
      u => (u.role || 'student').toLowerCase() === 'student'
    );
    const studentUids = new Set(studentUsers.map(u => u.id));
    const studentUsersById = new Map(studentUsers.map(u => [u.id, u]));
    // Elementary/High School/College is bucketed from gradeLevel, but a
    // registration's own gradeLevel is just a snapshot of whatever the
    // student picked on the form the moment they submitted it — it never
    // gets updated if their account's grade/year level changes afterward
    // (promotion, correction, etc.), so two registrations from the same
    // student can carry two different snapshots. StudentRegistrationDetails
    // (the table directly below these tiles) already sidesteps this by
    // overriding gradeLevel with the student's current `users/{uid}` value
    // instead of trusting the registration doc — do the same here so the
    // tiles and the table always agree on which level a student counts
    // toward, instead of the tiles occasionally showing a stale bucket.
    const studentRegistrations = registrations
      .filter(r => studentUids.has(r.uid))
      .map(r => ({ ...r, gradeLevel: studentUsersById.get(r.uid)?.gradeLevel || '—' }));

    setStudentRegs(studentRegistrations);
    setSummaryRows(buildSummary(studentRegistrations));

    // Recompute the per-event totals from the real documents and publish
    // them, which also repairs any drift in the counter the registration
    // form increments as students submit.
    const freshEventCounts = buildEventCounts(studentRegistrations, events);
    setEventCounts(freshEventCounts);
    setEventRegistrationCounts(freshEventCounts, events).catch((err) => {
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
}, [events]);

  useEffect(() => { if (activeTab === REGISTRATION_TAB_INDEX) fetchSummary(); }, [activeTab, fetchSummary]);

  // Summary table + level totals follow the event filter; with no filter
  // they show every event combined, exactly as before. Recomputing this
  // means re-scanning every student registration (buildSummary), so it's
  // only worth doing again when the filter or the underlying data changes.
  const visibleSummaryRows = useMemo(() => (
    summaryEvent
      ? buildSummary(studentRegs.filter(r => getEventBucket(r, events) === summaryEvent))
      : summaryRows
  ), [summaryEvent, studentRegs, events, summaryRows]);

  // "All Events" is the sum of the buckets, never the raw document
  // count — those disagree whenever a registration is missing a sport
  // or grade level, and the chip has to agree with the Total above it.
  // Includes registrations with no event on them (saved before the
  // event picker existed) — they're still players, so leaving them out
  // would put this chip below the Total beside it.
  const totalEventPlayers = useMemo(() => Object.values(eventCounts)
    .reduce((sum, n) => sum + (Number(n) || 0), 0), [eventCounts]);

  const { totalElementary, totalHighSchool, totalCollege, totalPlayers } = useMemo(() => {
    const elementary = visibleSummaryRows.reduce((s, r) => s + r.elementary, 0);
    const highSchool = visibleSummaryRows.reduce((s, r) => s + r.highSchool, 0);
    const college    = visibleSummaryRows.reduce((s, r) => s + r.college, 0);
    return {
      totalElementary: elementary,
      totalHighSchool: highSchool,
      totalCollege: college,
      totalPlayers: elementary + highSchool + college,
    };
  }, [visibleSummaryRows]);

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
        <h1 className="asp-header__title">{schoolName}</h1>
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
                  {events.map(ev => (
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
                    {events.find(e => e.key === summaryEvent)?.label || 'No Event'}
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
                      ? `No registrations for ${events.find(e => e.key === summaryEvent)?.label || 'No Event'} yet.`
                      : 'No registrations found.'}
                  </p>
                ) : (
                  <table className="asp-table">
                    <thead>
                      <tr>
                        <th>Sports</th>
                        <th>{LEVEL_LABELS.elementary}</th>
                        <th>{LEVEL_LABELS.highSchool}</th>
                        <th>{LEVEL_LABELS.college}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSummaryRows.map(row => (
                        <tr key={`${row.sport}-${row.gender}`}>
                          <td className="asp-td--sport" data-label="Sports">{row.sport.toUpperCase()} {row.gender.toUpperCase()}</td>
                          <td data-label={LEVEL_LABELS.elementary}>{fmt(row, 'elementary')}</td>
                          <td data-label={LEVEL_LABELS.highSchool}>{fmt(row, 'highSchool')}</td>
                          <td data-label={LEVEL_LABELS.college}>{fmt(row, 'college')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* ── Card 2: Student Registration Details ── */}
            {/* Full approve/reject console — same component Super Admin's
                Data Analytics tab uses. This used to be a read-only "Recent
                Registrations" list (8 rows, no actions) here, which meant a
                plain Admin could see registrations but never actually
                approve or reject one — that action only existed on the
                Super-Admin-only route. Admin is documented (see CLAUDE.md)
                as running "the real registrations... management console",
                so it needs the actual decision-making UI, not just a
                summary. Super Admin keeps its own copy too; nothing here
                takes access away from anyone. */}
            {/* Re-run the summary fetch after an Approve/Reject/Delete so the
                Total Players tiles (and the public counters they publish)
                update immediately, instead of only after switching tabs or
                reloading the page. */}
            <StudentRegistrationDetails onStatusChange={fetchSummary} onDeleted={fetchSummary} />

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

    </div>
  );
}
