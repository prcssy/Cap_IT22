import { Fragment, useState, useEffect, useRef, useMemo, useCallback, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FaChevronDown, FaTrophy, FaPlus, FaTimes, FaCheck, FaEdit,
  FaExclamationTriangle, FaUsers, FaLock, FaInfo, FaSync, FaMedal,
  FaCalculator, FaClock, FaStar, FaExchangeAlt, FaPaperPlane,
} from 'react-icons/fa';
import './ModeratorPage.css';
import {
  getSportsTeamsConfig,
  getMatchSchedules,
  subscribeMatchSchedules,
  getMatchRecords,
  submitMatchRecord,
  editMatchRecord,
  recalculateRatings,
  getTeamRankings,
  createScheduleRequest,
  markMatchScheduleFinished,
} from '../shared/services/firestoreService';
import LevelTabs from '../shared/components/LevelTabs';
import { AuthContext } from '../shared/context/AuthContext';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import { ScheduleRequestsContext } from '../shared/context/ScheduleRequestsContext';
import { isRaceMatch, raceParticipants } from '../shared/utils/raceFormat';

/* ═══════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════ */

const GAME_FORMATS = [
  { id: 'solo-time', label: 'Single Play (Solo Time)' },
  { id: 'solo-points', label: 'Single Play (Solo Points)' },
  { id: 'team-play', label: 'Team Play' },
];

/* ── Sports format picker (the "Choose sports format" modal moderators see
   first) — each choice decides two independent things for the rest of the
   flow: whether the match is judged on points or elapsed time (mode), and
   whether it's a straight 1-vs-1 or one team facing several opponents at
   once (multi). Nothing else on the page renders until one is picked. */
const FORMAT_CHOICES = [
  {
    id: '1v1-points', title: '1V1', tag: 'Points',
    description: 'A one-on-one match where the winner is decided by the points or score each team earned.',
    mode: 'points', multi: false, teams: 2,
  },
  {
    id: '1v1-time', title: '1V1', tag: 'Time',
    description: 'A one-on-one match where the winner is decided by the fastest recorded time.',
    mode: 'time', multi: false, teams: 2,
  },
  {
    id: 'many-points', title: '1 VS MANY', tag: 'Points',
    description: 'One team faces several opponents in the same event, all scored by points. Every team is rated against every other team.',
    mode: 'points', multi: true, teams: 4,
  },
  {
    id: 'many-time', title: '1 VS MANY', tag: 'Time',
    description: 'One team faces several opponents in the same event, all scored by time. Every team is rated against every other team.',
    mode: 'time', multi: true, teams: 4,
  },
];

function formatById(id) {
  return FORMAT_CHOICES.find((f) => f.id === id) || null;
}

/* Maps a division's format (set by the admin in Sports & Teams) straight
   onto the matching sports-format choice, so the moderator isn't asked to
   re-pick something already decided for that division. */
const DIVISION_FORMAT_TO_CHOICE = {
  'single-time': '1v1-time',
  'single-solo': '1v1-points',
  'single-group': 'many-time',
  'team-play': 'many-points',
};
function choiceIdForDivisionFormat(format) {
  return DIVISION_FORMAT_TO_CHOICE[format] || null;
}
function formatHeadline(choice) {
  if (!choice) return '';
  return `${choice.title === '1V1' ? 'Single play' : '1 vs many play'} (${choice.tag})`;
}

/* ── Rating formula constants ──
   Moderator and Ranking share the same Elo-style rating model:
     E_A = 1 / (1 + 10^((R_B - R_A) / 400))          (expected score)
     R_A' = R_A + K(S_A - E_A) + Ppu(F1 - F2 + F3)
   where S_A is 1 for a win / 0 for a loss (0.5 on a tie), F1 is this team's
   recorded points (or the time-mode performance value), F2 is that team's
   total violations, and F3 is a flat comeback bonus. In a 1-vs-many event
   the same formula runs once per opponent pairing and the changes are
   summed — exactly what the confirmation screen prints out. */
const K_FACTOR = 32;       // K: how strongly a single pairing can move a rating
const PPU = 0.5;           // Ppu: weight applied to the performance term (F1 - F2 + F3)
const COMEBACK_BONUS = 20; // F3 when the winning team came back from behind

// Every brand-new team starts at the same baseline within each sport/division.
// Keep this as the single source of truth for all fallback rating lookups.
const INITIAL_POINTS_PER_SPORT = 1200;
const DEFAULT_POINTS = INITIAL_POINTS_PER_SPORT;
const MIN_MULTI_TEAMS = 3;
const MAX_MULTI_TEAMS = 8;

const uid = () => Math.random().toString(36).slice(2, 10);

/* Which stat a sport is normally judged on. Only used for a soft hint now —
   the moderator's chosen sports format is what actually drives the form. */
const POINTS_BASED_SPORTS = ['basketball', 'volleyball', 'table tennis', 'sepak takraw', 'badminton'];
const TIME_BASED_SPORTS = ['mobile legends', 'chess', 'athletics', 'swimming', 'track and field'];

function scoringModeForSport(sportName) {
  const n = norm(sportName);
  if (POINTS_BASED_SPORTS.includes(n)) return 'points';
  if (TIME_BASED_SPORTS.includes(n)) return 'time';
  return null;
}

/* Firestore denies a write/read with `permission-denied` for anything a
   security rule doesn't explicitly allow — that's indistinguishable from
   an actual offline/network failure unless it's checked for by name, and
   "check your connection" is actively misleading when the real problem is
   the Firestore rules file needing an entry for the collection involved. */
function friendlyFirestoreError(err, fallback) {
  const isPermission = err?.code === 'permission-denied' || /permission/i.test(err?.message || '');
  return isPermission
    ? `${fallback} — your account doesn't have permission for this yet (check Firestore rules).`
    : `${fallback} — check your connection and try again.${err?.code ? ` (${err.code})` : ''}`;
}

/* Case/whitespace-insensitive compare — schedules & team.sportIds store
   sport/team *names* (free text from Admin), never ids. */
function norm(str) {
  return (str || '').trim().toLowerCase();
}

/* Schedule categories historically included the child format name, such as
   "MEN 5v5". The moderator uses only the sport division, so strip that
   format suffix while keeping legacy schedules matchable. */
function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

/* Expected score for the team rated `ra` against an opponent rated `rb`. */
function expectedScore(ra, rb) {
  return round4(1 / (1 + Math.pow(10, (rb - ra) / 400)));
}

/* Performance value (F1). The worksheet uses the team's recorded score/time
   itself, not the difference between the two teams' scores. */
function signedPerformance(mode, ownScore, oppScore) {
  /* F1 is a DIFFERENCE, per the formula key — not a raw score. Returning
     the team's own points here inflated every rating in a high-scoring
     sport (an 88-point basketball win added +44 instead of +8) and gave
     the loser a rating gain. Points: higher is better, so own − opponent.
     Time: lower is better, so the sign flips, and the gap is written in MM.SS
     (see timeGapMmSs). */
  return mode === 'points' ? ownScore - oppScore : timeGapMmSs(oppScore - ownScore);
}

/* A gap between two times (decimal minutes, how they're stored) written the way
   the worksheet writes it, as MM.SS: 10:30 − 05:01 is 5 min 29 s → 5.29 (NOT
   5.4833). Whole seconds are carried properly (15:25 − 10:30 → 4.55) and the
   sign is kept. Mirrors timeGapMmSs in functions/matchMath.js. */
function timeGapMmSs(deltaMinutes) {
  const totalSeconds = Math.round(Math.abs(deltaMinutes) * 60);
  if (totalSeconds === 0) return 0;
  const value = Number((Math.floor(totalSeconds / 60) + (totalSeconds % 60) / 100).toFixed(2));
  return deltaMinutes < 0 ? -value : value;
}

/* True when `a` is the better result than `b` for this mode. */
function isBetter(mode, a, b) {
  return mode === 'points' ? a > b : a < b;
}

/* One head-to-head rating change: K(S − E) + Ppu(F1 − F2 + F3). */
function pairComputation({ mode, ownRating, oppRating, ownScore, oppScore, violations, comeback, sOverride }) {
  const E = expectedScore(ownRating, oppRating);
  let S;
  if (sOverride != null) S = sOverride;
  else if (ownScore === oppScore) S = 0.5;
  else S = isBetter(mode, ownScore, oppScore) ? 1 : 0;
  const f1 = signedPerformance(mode, ownScore, oppScore);
  const f2 = violations || 0;
  const f3 = comeback && S === 1 ? COMEBACK_BONUS : 0;
  const change = K_FACTOR * (S - E) + PPU * (f1 - f2 + f3);
  return { E, S, f1, f2, f3, change, ownRating, oppRating };
}

/* Full computation for a whole match: every team rated against every other
   team, changes summed, placements resolved from the raw scores. */
function buildComputation({ rows, mode, winnerOverrideId: rawWinnerOverrideId }) {
  /* 'DRAW' is a sentinel winner: a two-team match that ended level. Each side
     scores S = 0.5 against the other and both share 1st place. */
  const isDraw = rawWinnerOverrideId === 'DRAW' && rows.length === 2;
  const winnerOverrideId = isDraw ? null : rawWinnerOverrideId;
  /* A manual winner override applies regardless of team count: the
     overridden team is placed first (ties among the rest keep score order),
     and it's treated as beating every other team head-to-head — not just
     in a 2-team match. Previously this only applied when rows.length === 2,
     so setting a winner in a 1-vs-many event (even to resolve a tied top
     score, which the form itself requires) was silently discarded. */
  const ordered = [...rows].sort((a, b) => {
    if (winnerOverrideId) {
      if (a.id === winnerOverrideId && b.id !== winnerOverrideId) return -1;
      if (b.id === winnerOverrideId && a.id !== winnerOverrideId) return 1;
    }
    return mode === 'points' ? b.score - a.score : a.score - b.score;
  });
  const placeById = {};
  ordered.forEach((r, i) => { placeById[r.id] = isDraw ? 1 : i + 1; });

  const teams = rows.map((t) => {
    const opponents = rows.filter((o) => o.id !== t.id);
    const pairings = opponents.map((o) => {
      const sOverride = isDraw
        ? 0.5
        : winnerOverrideId && (t.id === winnerOverrideId || o.id === winnerOverrideId)
          ? (winnerOverrideId === t.id ? 1 : 0)
          : null;
      const p = pairComputation({
        mode,
        ownRating: t.prevPoints,
        oppRating: o.prevPoints,
        ownScore: t.score,
        oppScore: o.score,
        violations: t.totalViolations,
        comeback: t.comeback,
        sOverride,
      });
      return { ...p, oppId: o.id, oppName: o.name, oppScore: o.score };
    });
    const change = pairings.reduce((s, p) => s + p.change, 0);
    const expected = pairings.length ? pairings.reduce((s, p) => s + p.E, 0) / pairings.length : 0;
    const totalF1 = pairings.reduce((s, p) => s + p.f1, 0);
    const wins = pairings.filter((p) => p.S === 1).length;
    return {
      ...t,
      pairings,
      expected,
      change,
      totalF1,
      wins,
      finalPoints: round4(t.prevPoints + change),
      place: placeById[t.id],
    };
  });

  const winnerId = isDraw
    ? 'DRAW'
    : winnerOverrideId
      ? winnerOverrideId
      : (teams.find((t) => t.place === 1)?.id ?? null);

  return { teams, winnerId };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/* Points are stored with decimals (a rating of 1026.0168 is a real value,
   not a rounding artefact) — this prints them without trailing zeros. */
function fmtPts(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const r = round4(Number(n));
  return Number.isInteger(r) ? String(r) : String(Number(r.toFixed(4)));
}
function fmtSigned(n, digits = 4) {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${Number(v.toFixed(digits))}`;
}

/* Map a division's saved format id (from Sports & Teams) to one of
   the 3 game-format buckets used by the summary filter. */
function bucketForFormat(formatId) {
  if (formatId === 'single-time') return 'solo-time';
  if (formatId === 'single-solo' || formatId === 'single-group') return 'solo-points';
  if (formatId === 'team-play') return 'team-play';
  return 'solo-points';
}

/* Same flattening logic Sports & Teams uses: one row per division. */
function flatDivisions(sport) {
  return (sport?.categoryGroups || []).flatMap((g) => {
    const divs = g.divisions || [];
    if (divs.length === 0) return [{ id: `${g.id}_lbl`, name: g.label, format: '', groupLabel: g.label }];
    return divs.map((d) => ({ ...d, name: d.name || g.label, groupLabel: g.label }));
  });
}

/* Full division name for a schedule row, e.g. "MEN (Senior)". Two divisions
   can share a category label ("MEN"), so this resolves via the saved
   divisionId; matches saved before that existed keep their plain category. */
function scheduleDivisionLabel(schedule, sports) {
  const sport = (sports || []).find((s) => norm(s.name) === norm(schedule.sport));
  const group = (sport?.categoryGroups || []).find((g) => (g.divisions || []).some((d) => d.id === schedule.divisionId));
  const div = group?.divisions.find((d) => d.id === schedule.divisionId);
  if (!div) return schedule.category || '';
  const label = (group.label || div.name || '').trim();
  const dName = (div.name || '').trim();
  return dName && dName.toLowerCase() !== label.toLowerCase() ? `${label} (${dName})` : label;
}

/* Category a result is saved (and rated) under. A group with several
   divisions — MEN → Senior / Junior — is a separate competition per division,
   so it saves as "MEN (Senior)" and gets its own ranking scope; otherwise the
   ratings of Senior and Junior games would chain into each other. A group with
   a single division keeps its plain category, so existing scopes are untouched. */
function scopedCategory(schedule, sports) {
  if (!schedule?.divisionId) return schedule?.category || '';
  const sport = (sports || []).find((s) => norm(s.name) === norm(schedule.sport));
  const group = (sport?.categoryGroups || []).find((g) => (g.divisions || []).some((d) => d.id === schedule.divisionId));
  if (!group || group.divisions.length < 2) return schedule.category || '';
  return scheduleDivisionLabel(schedule, sports) || schedule.category || '';
}

/* A schedule's category (MEN) and division (Senior) as separate values, for
   the Match schedules filters. division is '' when the group has just one. */
function scheduleParts(schedule, sports) {
  const sport = (sports || []).find((s) => norm(s.name) === norm(schedule.sport));
  const group = (sport?.categoryGroups || []).find((g) => (g.divisions || []).some((d) => d.id === schedule.divisionId));
  if (group) {
    const div = group.divisions.find((d) => d.id === schedule.divisionId);
    const category = displayCategory((group.label || '').trim());
    const dName = (div?.name || '').trim();
    return {
      category,
      division: group.divisions.length > 1 && norm(dName) !== norm(category) ? dName : '',
    };
  }
  const m = String(schedule.category || '').match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m
    ? { category: displayCategory(m[1]), division: m[2].trim() }
    : { category: displayCategory(schedule.category), division: '' };
}

/* One row per sport (no division baked in) — feeds the "Select sport" dropdown. */
function buildSportOnlyOptions(sports) {
  return (sports || []).map((sport) => ({
    key: sport.id, sportId: sport.id, label: sport.name, logo: sport.logo,
  }));
}

/* Request-a-schedule picker: unlike the rating scope, the admin schedules
   each division of a multi-division group separately, so a group with
   Senior + Junior is offered as "MEN (Senior)" and "MEN (Junior)" — the same
   labels the admin's category dropdown uses. */
function buildRequestDivisionOptionsForSport(sport) {
  if (!sport) return [];
  const byLabel = new Map();
  (sport.categoryGroups || []).forEach((g) => {
    const divs = g.divisions || [];
    const groupLabel = displayCategory((g.label || '').trim());
    (divs.length ? divs : [null]).forEach((d) => {
      const dName = (d?.name || '').trim();
      const label = divs.length > 1 && dName && norm(dName) !== norm(groupLabel)
        ? `${groupLabel} (${dName})`
        : (groupLabel || dName);
      if (label && !byLabel.has(norm(label))) {
        byLabel.set(norm(label), { key: d?.id || g.id, label, category: label, format: d?.format || '' });
      }
    });
  });
  return [...byLabel.values()];
}

/* Divisions belonging to a single sport. The group label is the displayed
   division; the child division name is the format and is not shown. */
function buildDivisionOptionsForSport(sport) {
  if (!sport) return [];
  /* One option per real division. MEN 5v5 and MEN 3v3 both score into the
     same `sport::men` scope, so offering "MEN" twice would just be two
     buttons that do the same thing — and Ranking lists them deduped too. */
  const byLabel = new Map();
  flatDivisions(sport).forEach((d) => {
    const name = (d.name || '').trim();
    const group = (d.groupLabel || '').trim();
    const label = displayCategory(group || name);
    if (!label || byLabel.has(norm(label))) return;
    byLabel.set(norm(label), { key: d.id, label, category: label, format: d.format || '' });
  });
  return [...byLabel.values()];
}

/* Case-insensitive lookup inside one scope's { teamName: points } map, so
   a stored "Red Rhinos" still matches a config spelling of "RED RHINOS". */
function pointsInScope(teamMap, teamName) {
  if (!teamMap || !teamName) return null;
  const hit = Object.entries(teamMap).find(([name]) => norm(name) === norm(teamName));
  const value = hit ? Number(hit[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

/* Team rankings are scoped per sport + division. */
function rankingScopeKey(sportName, category) {
  return `${norm(sportName)}::${norm(displayCategory(category))}`;
}

/* Category match, tolerant of schedules saved before the group-label prefix. */
function categoriesMatch(scheduleCategory, activeCategory) {
  const a = norm(displayCategory(scheduleCategory));
  const b = norm(displayCategory(activeCategory));
  if (a === b) return true;
  if (!a || !b) return false;
  return a.endsWith(` ${b}`) || b.endsWith(` ${a}`);
}

const ASSUMED_MATCH_MINUTES = 120;

/* Where a fixture sits against the clock. The moderator only records
   finished games — see matchHasFinished below, which is the actual gate
   on recordableMatches. This status is only a label/sort order for the
   matches that already passed that gate. */
const MATCH_STATUS_LABEL = {
  finished: 'Finished',
  ongoing: 'Ongoing',
  undated: 'No date yet',
  upcoming: 'Upcoming',
};
const MATCH_STATUS_ORDER = { finished: 0, ongoing: 1, undated: 2, upcoming: 3 };
const MATCH_STATUS_COLOR = {
  finished: { bg: '#e6f7ec', fg: '#14713a' },
  ongoing: { bg: '#fff3d6', fg: '#8a5f04' },
  undated: { bg: '#eef1f8', fg: '#46536b' },
  upcoming: { bg: '#eaf2ff', fg: '#14549b' },
};

function matchStatus(schedule) {
  if (schedule.finished) return 'finished';
  if (!schedule.date || !schedule.time) return 'undated';
  const start = new Date(`${schedule.date}T${schedule.time}`);
  if (Number.isNaN(start.getTime())) return 'undated';
  const end = start.getTime() + ASSUMED_MATCH_MINUTES * 60000;
  const now = Date.now();
  if (now >= end) return 'finished';
  if (now >= start.getTime()) return 'ongoing';
  return 'upcoming';
}

function matchHasFinished(schedule) {
  // Every scheduled match is visible to the moderator, but only a finished
  // one can be recorded: either the moderator pressed "Mark as finished"
  // (schedule.finished) or a dated match's assumed duration has elapsed.
  if (schedule?.finished) return true;
  if (!schedule?.date || !schedule?.time) return false;
  const start = new Date(`${schedule.date}T${schedule.time}`);
  if (Number.isNaN(start.getTime())) return false;
  const end = new Date(start.getTime() + ASSUMED_MATCH_MINUTES * 60000);
  return Date.now() >= end.getTime();
}

/* Fallbacks for when Sports & Teams is empty but schedules already exist. */
function deriveSportsFromSchedules(schedules) {
  const bySport = new Map();
  (schedules || []).forEach((s) => {
    if (!s.sport) return;
    const key = norm(s.sport);
    if (!bySport.has(key)) {
      bySport.set(key, { id: `sched__${key}`, name: s.sport, logo: null, categoryGroups: [] });
    }
    const sport = bySport.get(key);
    if (s.category) {
      const category = displayCategory(s.category);
      const catKey = norm(category);
      if (!sport.categoryGroups.some((g) => norm(g.label) === catKey)) {
        sport.categoryGroups.push({
          id: `${sport.id}__${catKey}`, label: category,
          divisions: [{ id: `${sport.id}__${catKey}__d`, name: category, format: '' }],
        });
      }
    }
  });
  return [...bySport.values()];
}

function deriveTeamsFromSchedules(schedules) {
  const byName = new Map();
  (schedules || []).forEach((s) => {
    [[s.teamA, s.teamALogo], [s.teamB, s.teamBLogo]].forEach(([name, logo]) => {
      if (!name) return;
      const key = norm(name);
      if (!byName.has(key)) {
        byName.set(key, { id: `sched-team__${key}`, name, logo: logo || null, sportIds: s.sport ? [s.sport] : [] });
      } else if (s.sport && !byName.get(key).sportIds.includes(s.sport)) {
        byName.get(key).sportIds.push(s.sport);
      }
    });
  });
  return [...byName.values()];
}

/* "HH:MM:SS" / "MM:SS" free-typed duration -> minutes (float), or null */
function parseDuration(str) {
  if (!str || !str.trim()) return null;
  const parts = str.trim().split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  let h = 0, s = 0, m;
  if (parts.length === 3) { [h, m, s] = parts.map(Number); }
  else if (parts.length === 2) { [m, s] = parts.map(Number); }
  else if (parts.length === 1) { [m] = parts.map(Number); }
  else return null;
  const total = h * 60 + m + s / 60;
  return isNaN(total) ? null : total;
}

function formatDurationInput(raw) {
  const digits = (raw || '').replace(/\D/g, '').slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4)}`;
}

function sanitizePointsInput(raw) {
  return (raw || '').replace(/\D/g, '').slice(0, 5);
}

function minutesToDurationString(mins) {
  if (mins == null || Number.isNaN(mins)) return '';
  const totalSeconds = Math.round(mins * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatMinutes(mins) {
  if (mins == null) return '--';
  const totalSeconds = Math.round(mins * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}mins and ${String(s).padStart(2, '0')} seconds`;
}

function placeLabel(place) {
  if (place === 1) return '1st Placer';
  if (place === 2) return '2nd Placer';
  if (place === 3) return '3rd Placer';
  return `${place}th Placer`;
}

/* Pill dropdown for the Match schedules filters — same look as the Ranking
   page's Sport/Division selects (a native <select>'s open list can't be
   themed). value '' means "all". */
function FilterSelect({ value, onChange, options, allLabel, disabled }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const items = [{ value: '', label: allLabel }, ...options.map((o) => ({ value: o, label: o }))];

  return (
    <div className="mp-fs" ref={wrapRef}>
      <button
        type="button"
        className="mp-fs__btn"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        {value || allLabel}
        <FaChevronDown className={`mp-fs__chevron ${open ? 'mp-fs__chevron--open' : ''}`} />
      </button>
      <ul className={`mp-fs__menu ${open ? 'mp-fs__menu--open' : ''}`}>
        {items.map((item) => (
          <li
            key={item.value || '__all'}
            className={`mp-fs__item ${value === item.value ? 'mp-fs__item--active' : ''}`}
            onClick={() => { onChange(item.value); setOpen(false); }}
          >
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function initials(name) {
  return (name || '?').split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/* Recomputes both teams' final points live from the inline edit row of the
   summary table (1v1 records only). */
function computeEditFinalPoints(record, editDraft, isPoints) {
  const violA = parseInt(editDraft.totalViolationsA, 10) || 0;
  const violB = parseInt(editDraft.totalViolationsB, 10) || 0;

  let f1A, f1B;
  if (isPoints) {
    const pA = editDraft.pointsA === '' ? record.teamA.points : Number(editDraft.pointsA);
    const pB = editDraft.pointsB === '' ? record.teamB.points : Number(editDraft.pointsB);
    const valid = pA != null && pB != null && !Number.isNaN(pA) && !Number.isNaN(pB);
    // F1 is a DIFFERENCE (own − opponent), same as signedPerformance() used
    // everywhere else — using the raw score here inflated every edit and
    // flipped the sign of the losing team's rating change.
    f1A = valid ? pA - pB : 0;
    f1B = valid ? pB - pA : 0;
  } else {
    const mA = editDraft.minutesA === '' ? record.teamA.minutes : Number(editDraft.minutesA);
    const mB = editDraft.minutesB === '' ? record.teamB.minutes : Number(editDraft.minutesB);
    const valid = mA != null && mB != null && !Number.isNaN(mA) && !Number.isNaN(mB);
    // Time: lower is better, so a team's performance is opponent time minus
    // its own — matches signedPerformance('time', ...) and stays correct
    // if the moderator edits the time values themselves, instead of always
    // recomputing from the original record.diff.
    f1A = valid ? signedPerformance('time', mA, mB) : 0;
    f1B = valid ? signedPerformance('time', mB, mA) : 0;
  }

  // Winner must follow the EDITED scores, not the record's original
  // `winner` flag — otherwise editing team A/B's score enough to flip who's
  // actually ahead still credits the old winner with the Elo win-term (S),
  // producing a finalPoints value that silently disagrees with the score
  // shown right next to it. Only fall back to the original winner when the
  // edit is a genuine tie or the inputs are incomplete (f1A/f1B both 0).
  const isDraw = f1A === 0 && record.winner === 'DRAW';
  const isWinnerA = f1A > 0 ? true : f1A < 0 ? false : record.winner === 'A';
  const ratingA = record.teamA.prevPoints ?? DEFAULT_POINTS;
  const ratingB = record.teamB.prevPoints ?? DEFAULT_POINTS;
  const eA = expectedScore(ratingA, ratingB);
  const eB = expectedScore(ratingB, ratingA);
  const sA = isDraw ? 0.5 : (isWinnerA ? 1 : 0);
  const sB = isDraw ? 0.5 : (isWinnerA ? 0 : 1);
  // Comeback flags come from the edit row's toggles (falling back to what was
  // saved), and — like pairComputation — only count for the team that won.
  const comebackA = editDraft.comebackA ?? !!record.teamA.comeback;
  const comebackB = editDraft.comebackB ?? !!record.teamB.comeback;
  const changeA = K_FACTOR * (sA - eA) + PPU * (f1A - violA + (comebackA && sA === 1 ? COMEBACK_BONUS : 0));
  const changeB = K_FACTOR * (sB - eB) + PPU * (f1B - violB + (comebackB && sB === 1 ? COMEBACK_BONUS : 0));

  return {
    finalPointsA: round4(ratingA + changeA),
    finalPointsB: round4(ratingB + changeB),
    winner: isDraw ? 'DRAW' : (isWinnerA ? 'A' : 'B'),
  };
}


/* ═══════════════════════════════════════════
   GENERIC OPTION DROPDOWN
═══════════════════════════════════════════ */
function OptionDropdown({
  panelLabel, value, placeholder, options, onChange,
  variant = 'navy', disabled = false, renderOption,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const selected = options.find((o) => o.key === value);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {variant === 'navy' || variant === 'pill' ? (
        <button
          type="button"
          className={`mp-sport-trigger ${variant === 'pill' ? 'mp-sport-trigger--pill' : ''}`}
          disabled={disabled}
          onClick={() => setOpen((p) => !p)}
        >
          <span>{!selected && variant === 'pill' && <span className="mp-sport-required">*</span>}{selected ? selected.label : (placeholder || 'Select')}</span>
          <span className={`mp-sport-trigger__arrow ${open ? 'mp-sport-trigger__arrow--open' : ''}`}><FaChevronDown /></span>
        </button>
      ) : (
        <button
          type="button"
          className={`mp-select-trigger ${!selected ? 'mp-select-trigger--placeholder' : ''}`}
          disabled={disabled}
          onClick={() => setOpen((p) => !p)}
        >
          <span className="mp-select-trigger__label">{selected ? selected.label : (placeholder || 'Select')}</span>
          <FaChevronDown style={{ fontSize: '0.7rem', flexShrink: 0, opacity: 0.6 }} />
        </button>
      )}

      <div className={`mp-dd-panel ${variant === 'teams' ? 'mp-dd-panel--teams' : ''} ${open ? 'mp-dd-panel--open' : ''}`}>
        <div className="mp-dd-panel__scroll">
          {panelLabel && <div className="mp-dd-panel__label">{panelLabel}</div>}
          {options.length === 0 ? (
            <div className="mp-dd-panel__label" style={{ padding: '10px 6px', textTransform: 'none', fontSize: '0.78rem' }}>
              Nothing available yet
            </div>
          ) : options.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`mp-dd-option ${o.key === value ? 'mp-dd-option--active' : ''} ${o.disabled ? 'mp-dd-option--disabled' : ''}`}
              disabled={o.disabled}
              onClick={() => { if (o.disabled) return; onChange(o.key); setOpen(false); }}
            >
              {renderOption ? renderOption(o) : o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   INFO TOOLTIP
═══════════════════════════════════════════ */
function InfoTip({ caption, children, placement = 'top' }) {
  return (
    <span className={`mp-info-btn${placement === 'bottom' ? ' mp-info-btn--drop' : ''}`} tabIndex={0}>
      <FaInfo style={{ fontSize: '0.5rem' }} />
      <span className="mp-tooltip">
        <span className="mp-tooltip__cap">{caption}</span>
        <span className="mp-tooltip__body">{children}</span>
      </span>
    </span>
  );
}

/* ═══════════════════════════════════════════
   STEP 1 — CHOOSE SPORTS FORMAT
═══════════════════════════════════════════ */
function FormatPickerModal({ current, onChoose, onClose, match, suggestedId }) {
  return (
    <div className="mp-modal-overlay" onClick={onClose}>
      <div className="mp-modal mp-format-modal" onClick={(e) => e.stopPropagation()}>
        <button className="mp-format-close" onClick={onClose} aria-label="Close"><FaTimes /></button>

        <h2 className="mp-format-title">How was this played?</h2>
        <p className="mp-format-sub">
          <b>{match.teamA} vs {match.teamB}</b> — {match.sport}{match.category ? ` · ${match.category}` : ''}.
          Pick the format and the record form opens with both teams already filled in.
        </p>

        <div className="mp-format-grid">
          {FORMAT_CHOICES.map((f) => (
            <div
              key={f.id}
              className={`mp-format-card ${current === f.id ? 'mp-format-card--active' : ''} ${!current && suggestedId === f.id ? 'mp-format-card--active' : ''}`}
            >
              <div className="mp-format-card__head">
                <span className="mp-format-card__title">{f.title}</span>
                <span className={`mp-format-card__tag mp-format-card__tag--${f.mode}`}>
                  {f.mode === 'points' ? <FaStar /> : <FaClock />} {f.tag}
                </span>
              </div>
              <p className="mp-format-card__desc">{f.description}</p>
              {suggestedId === f.id && (
                <p className="mp-format-card__desc" style={{ color: '#8a5f04', fontWeight: 700, flex: 'none' }}>
                  Suggested for {match.sport}.
                </p>
              )}
              <button type="button" className="mp-format-card__btn" onClick={() => onChoose(f.id)}>
                {current === f.id ? 'Selected' : 'Choose'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   VIOLATIONS MODAL
═══════════════════════════════════════════ */
function ViolationsModal({ sideLabel, teamLabel, teamLogo, initialRows, violationOptions, onClose, onSubmit }) {
  /* Once the sport has predefined violation types (set by the admin under
     Sports & Teams), every one of them is loaded as a row up front — the
     moderator's only job is filling in counts, not deciding which
     violations exist. Sports with no predefined list fall back to the old
     free-text/add-slot flow so scoring isn't blocked while an admin
     hasn't set any up yet. */
  const hasOptions = (violationOptions || []).length > 0;

  const [rows, setRows] = useState(() => {
    if (hasOptions) {
      const byType = new Map((initialRows || []).map((r) => [norm(r.type), r.count]));
      return violationOptions.map((opt) => ({ id: uid(), type: opt.name, count: byType.get(norm(opt.name)) ?? '' }));
    }
    return initialRows.length ? initialRows : [];
  });
  const [bump, setBump] = useState(false);

  const total = rows.reduce((sum, r) => sum + (parseInt(r.count, 10) || 0), 0);

  useEffect(() => { setBump(true); const t = setTimeout(() => setBump(false), 300); return () => clearTimeout(t); }, [total]);

  const addSlot = () => setRows((r) => [...r, { id: uid(), type: '', count: '' }]);
  const updateRow = (id, patch) => setRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const removeRow = (id) => setRows((r) => r.filter((row) => row.id !== id));

  return (
    <div className="mp-modal-overlay" onClick={onClose}>
      <div className="mp-viol-wrap" onClick={(e) => e.stopPropagation()}>
        <div className="mp-viol-label">Violations</div>
        <div className="mp-modal" style={{ maxWidth: 460, position: 'relative' }}>
          <button className="mp-modal-close-x" onClick={onClose} aria-label="Close"><FaTimes /></button>

          <div className="mp-viol-heading">{sideLabel} violations</div>

          <div className="mp-viol-head">
            <div className="mp-viol-team">
              <div className="mp-viol-team-logo">
                {teamLogo ? <img src={teamLogo} alt="" /> : initials(teamLabel)}
              </div>
              <div className="mp-viol-team-name">{teamLabel || 'Select a team'}</div>
            </div>
            <div className="mp-viol-total">
              <div className="mp-viol-total__label">Total violations</div>
              <div className={`mp-viol-total__num ${bump ? 'mp-violation-box__num--bump' : ''}`}>{total}</div>
            </div>
          </div>

          {!hasOptions && (
            <button type="button" className="mp-viol-add" onClick={addSlot}><FaPlus /> Add slot</button>
          )}

          <table className="mp-viol-table">
            <thead>
              <tr>
                <th>Type of violation</th>
                <th style={{ width: 110 }}>No. of violation</th>
                {!hasOptions && <th style={{ width: 36 }}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={hasOptions ? 2 : 3} style={{ color: '#8593ad', fontWeight: 500 }}>No violations logged yet.</td></tr>
              )}
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {hasOptions ? (
                      <span className="mp-viol-type-label">{row.type}</span>
                    ) : (
                      <input
                        type="text" placeholder="*Input type of violation" value={row.type}
                        onChange={(e) => updateRow(row.id, { type: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      type="number" min="0" placeholder="*No." value={row.count}
                      onChange={(e) => updateRow(row.id, { count: e.target.value })}
                    />
                  </td>
                  {!hasOptions && (
                    <td>
                      <button className="mp-viol-remove" onClick={() => removeRow(row.id)} aria-label="Remove"><FaTimes /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mp-viol-actions">
            <button className="mp-btn mp-btn--gray" onClick={onClose}>Cancel</button>
            <button
              className="mp-btn mp-btn--submit"
              onClick={() => onSubmit(rows.filter((r) => (hasOptions ? r.count !== '' : (r.type.trim() || r.count !== ''))))}
            >
              Submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   CONFIRMATION RECEIPT
═══════════════════════════════════════════ */
function ConfirmModal({ pending, levelLabel, onCancel, onConfirm, saving }) {
  const { sportName, category, mode, multi, teams, winnerId, formatLabel } = pending;
  const isDraw = winnerId === 'DRAW';
  const winnerTeam = teams.find((t) => t.id === winnerId) || teams[0];
  const diffLabel = mode === 'points' ? 'Total points difference' : 'Total time difference';
  const statLabel = mode === 'points' ? 'Points/Score' : 'Time';
  // 1-vs-many: every team is a card, best finisher first, so nothing needs scrolling sideways.
  const shownTeams = multi ? [...teams].sort((x, y) => (x.place ?? 99) - (y.place ?? 99)) : teams;
  const [calcFor, setCalcFor] = useState(null); // team whose "Summary computation" popup is open

  return (
    <div className="mp-modal-overlay" onClick={saving ? undefined : onCancel}>
      <div className={`mp-modal mp-modal--receipt ${multi ? 'mp-modal--wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="mp-receipt__body">
        <h2 className="mp-confirm__title">Confirmation match result</h2>

        <div className="mp-receipt__meta">
          <span>Level: <b>{levelLabel}</b></span>
          <span>Sport: <b>{sportName}</b></span>
          <span>Division: <b>{category || '—'}</b></span>
          <span>Format: <b>{formatLabel}</b></span>
        </div>

        <div className="mp-receipt__winner"><FaTrophy /> {isDraw ? 'Draw — no winner' : `Winner: ${winnerTeam.name}`}</div>

        <div className={`mp-receipt__teams ${multi ? 'mp-receipt__teams--multi' : ''}`}>
          {shownTeams.map((t, i) => (
            <div className="mp-receipt__team-slot" key={t.id}>
              {i > 0 && !multi && <div className="mp-receipt__vs">VS</div>}
              <div className={`mp-rteam ${t.id === winnerId ? 'mp-rteam--win' : ''}`}>
                <div className="mp-rteam__name">{t.name}</div>
                <div className="mp-rteam__row">
                  <div className="mp-rteam__logo">{t.logo ? <img src={t.logo} alt="" /> : initials(t.name)}</div>
                  <div className="mp-rteam__pts">
                    <div className="mp-rteam__pt">
                      <span className="mp-rteam__pt-label">{t.change >= 0 ? 'Gained points' : 'Lose points'}</span>
                      <span className={`mp-rteam__pt-num ${t.change >= 0 ? 'mp-gain' : 'mp-loss'}`}>{fmtSigned(t.change)}</span>
                    </div>
                    <div className="mp-rteam__pt">
                      <span className="mp-rteam__pt-label">Previous points</span>
                      <span className="mp-rteam__pt-num">{fmtPts(t.prevPoints)}</span>
                    </div>
                    <div className="mp-rteam__pt">
                      <span className="mp-rteam__pt-label">Final points</span>
                      <span className="mp-rteam__pt-num mp-rteam__pt-num--final">{fmtPts(t.finalPoints)}</span>
                    </div>
                  </div>
                </div>

                <ul className="mp-rteam__facts">
                  <li><FaMedal /> Standing: <b>{multi ? placeLabel(t.place) : (isDraw ? 'Draw = 0.5' : t.id === winnerId ? 'Winner = 1' : 'Lose = 0')}</b></li>
                  <li>{mode === 'points' ? <FaStar /> : <FaClock />} {statLabel}: <b>{mode === 'points' ? t.score : formatMinutes(t.score)}</b></li>
                  <li><FaExclamationTriangle /> Violations: <b>{t.totalViolations}</b></li>
                  <li><FaExchangeAlt /> Comeback: <b>{t.comeback ? `Yes (+${COMEBACK_BONUS})` : 'No (0)'}</b></li>
                  {!multi && <li><FaCalculator /> {diffLabel}: <b>{fmtSigned(t.totalF1, 2)}</b></li>}
                </ul>

                {multi && (
                  <>
                    <div className="mp-diff-list">
                      <div className="mp-diff-list__cap">{mode === 'points' ? 'Points' : 'Time'} difference</div>
                      {t.pairings.map((p) => (
                        <div className="mp-diff-list__row" key={p.oppId}>
                          <span>vs {p.oppName}</span>
                          <b className={p.f1 >= 0 ? 'mp-gain' : 'mp-loss'}>{fmtSigned(p.f1)}</b>
                        </div>
                      ))}
                      <div className="mp-diff-list__row mp-diff-list__row--total">
                        <span>Total</span>
                        <b>{fmtSigned(t.totalF1)}</b>
                      </div>
                    </div>

                    <div className="mp-gainbox">
                      <div className="mp-gainbox__head">
                        <span>Gained points per team</span>
                        <button
                          type="button"
                          className="mp-gainbox__info"
                          onClick={() => setCalcFor(t)}
                          aria-label={`Show the computation for ${t.name}`}
                          title="Show the computation"
                        >
                          <FaInfo />
                        </button>
                      </div>
                      {t.pairings.map((p) => (
                        <div className="mp-gainbox__row" key={p.oppId}>
                          <span>{p.oppName}</span>
                          <b className={p.change >= 0 ? 'mp-gain' : 'mp-loss'}>{fmtSigned(p.change)}</b>
                        </div>
                      ))}
                      <div className="mp-gainbox__sum">
                        <span>{t.change >= 0 ? 'Overall gained points' : 'Overall lose points'}</span>
                        <b className={t.change >= 0 ? 'mp-gain' : 'mp-loss'}>{fmtSigned(t.change)}</b>
                      </div>
                      <div className="mp-gainbox__sum">
                        <span>Final total points</span>
                        <b>{fmtPts(t.finalPoints)}</b>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mp-confirm__warn"><FaExclamationTriangle /> This action cannot be undone. Please review all details before confirming.</div>

        <div className="mp-confirm__actions">
          <button className="mp-btn mp-btn--cancel" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="mp-btn mp-btn--confirm" onClick={onConfirm} disabled={saving}>
            <FaLock /> {saving ? 'Saving…' : 'Confirm update'}
          </button>
        </div>
        </div>
      </div>

      {calcFor && (
        <ComputationModal
          team={calcFor}
          number={shownTeams.findIndex((t) => t.id === calcFor.id) + 1}
          mode={mode}
          onClose={() => setCalcFor(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   SUMMARY COMPUTATION — the step-by-step working behind one team's rating
   change in a 1-vs-many event. One column per opponent (the formula runs once
   per pairing), then the pairings are summed. Every number is read straight
   off the same buildComputation() result the save uses, and E is rounded to 4
   decimals exactly like the engine, so each line can be checked by hand.
═══════════════════════════════════════════ */
const num = (v) => String(Number(Number(v).toFixed(4)));
const minus = (v) => (Number(v) < 0 ? `−${num(Math.abs(v))}` : num(v));
const paren = (v) => (Number(v) < 0 ? `(${minus(v)})` : num(v));

/* "5 min 29 s" for a gap in decimal minutes (sign dropped; F1 carries it). */
function gapWords(deltaMinutes) {
  const totalSeconds = Math.round(Math.abs(deltaMinutes) * 60);
  return `${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
}

function Frac({ top, bottom }) {
  return (
    <span className="mp-frac">
      <span className="mp-frac__top">{top}</span>
      <span className="mp-frac__bottom">{bottom}</span>
    </span>
  );
}

function PairComputation({ team, pair, mode }) {
  const isTime = mode === 'time';
  const ra = pair.ownRating;
  const rb = pair.oppRating;
  const exponent = (rb - ra) / 400;
  const pow = Math.pow(10, exponent);
  const denominator = 1 + pow;
  const kTerm = K_FACTOR * (pair.S - pair.E);
  const perfInner = pair.f1 - pair.f2 + pair.f3;
  const perfTerm = PPU * perfInner;
  const outcome = pair.S === 1 ? 'won' : pair.S === 0 ? 'lost' : 'tied';

  return (
    <div className="mp-calc__pair">
      <h4 className="mp-calc__pair-title">{team.name} vs {pair.oppName}</h4>

      <div className="mp-calc__step">
        <span className="mp-calc__step-tag">1</span> Expected score formula
      </div>
      <div className="mp-calc__formula">
        E<sub>A</sub> = <Frac top="1" bottom={<>1 + 10<sup>(R<sub>B</sub> − R<sub>A</sub>) / 400</sup></>} />
      </div>
      <div className="mp-calc__lines">
        <div>E<sub>A</sub> = <Frac top="1" bottom={<>1 + 10<sup>({num(rb)} − {num(ra)}) / 400</sup></>} /></div>
        <div>E<sub>A</sub> = <Frac top="1" bottom={<>1 + 10<sup>{minus(exponent)}</sup></>} /></div>
        <div>E<sub>A</sub> = <Frac top="1" bottom={<>1 + {num(pow)}</>} /></div>
        <div>E<sub>A</sub> = <Frac top="1" bottom={num(denominator)} /></div>
      </div>
      <div className="mp-calc__result">E<sub>A</sub> = {num(pair.E)} or {(pair.E * 100).toFixed(2)}%</div>

      <div className="mp-calc__step">
        <span className="mp-calc__step-tag">2</span> Final score formula
      </div>
      <div className="mp-calc__formula">
        ΔR = K (S − E<sub>A</sub>) + Ppu (F<sub>1</sub> − F<sub>2</sub> + F<sub>3</sub>)
      </div>
      <ul className="mp-calc__legend">
        <li>K = {K_FACTOR}, Ppu = {PPU}</li>
        <li>S = {num(pair.S)} — {team.name} {outcome} against {pair.oppName}{isTime ? ' on time' : ' on points'}</li>
        <li>F<sub>1</sub> = {isTime
          ? `${minutesToDurationString(pair.oppScore)} − ${minutesToDurationString(team.score)} = ${gapWords(pair.oppScore - team.score)}, written in MM.SS as ${minus(pair.f1)} (opponent's time − own time)`
          : `${num(team.score)} − ${num(pair.oppScore)} = ${minus(pair.f1)} (own points − opponent's points)`}</li>
        <li>F<sub>2</sub> = {num(pair.f2)} (violations)</li>
        <li>F<sub>3</sub> = {num(pair.f3)} {pair.f3 ? `(comeback bonus, ${team.name} won this pairing)` : team.comeback ? '(comeback bonus only counts when the pairing is won)' : '(no comeback)'}</li>
      </ul>
      <div className="mp-calc__lines">
        <div>ΔR = {K_FACTOR}({num(pair.S)} − {num(pair.E)}) + {PPU}({paren(pair.f1)} − {num(pair.f2)} + {num(pair.f3)})</div>
        <div>ΔR = {K_FACTOR}({minus(pair.S - pair.E)}) + {PPU}({minus(perfInner)})</div>
        <div>ΔR = {minus(kTerm)} + {paren(perfTerm)}</div>
      </div>
      <div className="mp-calc__result">ΔR = {fmtSigned(pair.change)}</div>
    </div>
  );
}

function ComputationModal({ team, number, mode, onClose }) {
  const gained = team.change >= 0;
  return (
    <div className="mp-modal-overlay mp-modal-overlay--top" onClick={onClose}>
      <div className="mp-modal mp-modal--calc" onClick={(e) => e.stopPropagation()}>
        <button className="mp-modal-close-x" onClick={onClose} aria-label="Close"><FaTimes /></button>
        <div className="mp-calc__body">
          <p className="mp-calc__kicker">{number}. For {team.name} ({mode === 'time' ? 'Time' : 'Points'})</p>
          <h2 className="mp-calc__title">Summary computation</h2>
          <p className="mp-calc__sub">
            The rating formula runs once against every opponent; the results are added together and applied to the previous rating once.
          </p>

          <div className="mp-calc__grid">
            {team.pairings.map((p) => (
              <PairComputation key={p.oppId} team={team} pair={p} mode={mode} />
            ))}
          </div>

          <div className="mp-calc__total">
            <div className="mp-calc__total-title">Total for {team.name}</div>
            <div className="mp-calc__lines">
              <div>
                ΔR total = {team.pairings.map((p, i) => (
                  <span key={p.oppId}>{i > 0 ? ' + ' : ''}{paren(p.change)}</span>
                ))} = <b className={gained ? 'mp-gain' : 'mp-loss'}>{fmtSigned(team.change)}</b>
              </div>
              <div>
                Final rating = R + ΔR total = {fmtPts(team.prevPoints)} {gained ? '+' : '−'} {num(Math.abs(team.change))} = <b>{fmtPts(team.finalPoints)}</b>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   SUCCESS / INVALID / RESET MODALS
═══════════════════════════════════════════ */
function SuccessModal({ record, onClose, onViewRanking }) {
  const list = record.participants && record.participants.length
    ? record.participants
    : [record.teamA, record.teamB];
  const isDraw = record.winner === 'DRAW' || record.draw;
  const winner = record.participants && record.participants.length
    ? [...record.participants].sort((a, b) => (a.place || 99) - (b.place || 99))[0]
    : (record.winner === 'A' ? record.teamA : record.teamB);

  return (
    <div className="mp-modal-overlay" onClick={onClose}>
      <div className="mp-modal mp-result-modal mp-result-modal--success" onClick={(e) => e.stopPropagation()}>
        <button className="mp-result-close" onClick={onClose} aria-label="Close"><FaTimes /></button>
        <div className="mp-result-icon mp-result-icon--success"><FaCheck /></div>
        <h2 className="mp-result-title">Match record updated successfully!</h2>
        <p className="mp-result-sub">{isDraw ? 'The match ended in a draw' : `${winner.name} takes the win`}</p>
        <div className="mp-result-score">
          {list.map((t) => `${t.name}: ${fmtPts(t.finalPoints)}`).join('  •  ')}
        </div>
        <div className="mp-result-actions">
          <button className="mp-btn mp-btn--white" onClick={onClose}>Close</button>
          <button className="mp-btn mp-btn--navy-solid" onClick={onViewRanking}>View ranking</button>
        </div>
      </div>
    </div>
  );
}

function InvalidModal({ reasons, onClose }) {
  return (
    <div className="mp-modal-overlay" onClick={onClose}>
      <div className="mp-modal mp-result-modal mp-result-modal--error" onClick={(e) => e.stopPropagation()}>
        <button className="mp-result-close" onClick={onClose} aria-label="Close"><FaTimes /></button>
        <div className="mp-result-icon mp-result-icon--error"><FaExclamationTriangle /></div>
        <h2 className="mp-result-title">Invalid match result</h2>
        <p className="mp-result-sub">Please complete the following</p>
        {reasons.length > 0 && (
          <ul className="mp-result-list">
            {reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
        <div className="mp-result-actions">
          <button className="mp-btn mp-btn--danger-solid" onClick={onClose} style={{ flex: 1 }}>Ok</button>
        </div>
      </div>
    </div>
  );
}

function ResetConfirmModal({ onCancel, onConfirm }) {
  return (
    <div className="mp-modal-overlay" onClick={onCancel}>
      <div className="mp-modal mp-result-modal mp-reset-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mp-result-icon mp-result-icon--warn"><FaExclamationTriangle /></div>
        <h2 className="mp-result-title">Reset this match record form?</h2>
        <p className="mp-result-sub">Everything you've entered for every team will be cleared.</p>
        <div className="mp-result-actions">
          <button className="mp-btn mp-btn--cancel" onClick={onCancel} style={{ flex: 1 }}>Cancel</button>
          <button className="mp-btn mp-btn--reset-solid" onClick={onConfirm} style={{ flex: 1 }}><FaSync /> Reset</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   REQUEST A SCHEDULE — moderator asks the admin to set up a fixture
   instead of adding a manual match record themselves. The admin sees
   these live (sidebar badge + Schedule Requests tab on AdminSchedulePage)
   and either arranges the schedule or declines with a reason.
═══════════════════════════════════════════ */
const REQUEST_STATUS_LABEL = { pending: 'Pending', scheduled: 'Scheduled', declined: 'Declined' };
const REQUEST_STATUS_COLOR = {
  pending: { bg: '#fff3d6', fg: '#8a5f04' },
  scheduled: { bg: '#e6f7ec', fg: '#14713a' },
  declined: { bg: '#fde8e6', fg: '#a83218' },
};

function RequestScheduleModal({
  onClose, onSubmit, submitting,
  sportOptions, sportId, onSportChange,
  divisionOptions, divisionKey, onDivisionChange, divisionRequired,
  levelOptions, requestLevel, onLevelChange,
  teamOptions, teamAId, teamBId, onTeamAChange, onTeamBChange,
  extraTeamIds, onExtraTeamsChange,
  reason, onReasonChange,
  myRequests,
}) {
  const incomplete = !sportId || (divisionRequired && !divisionKey) || !requestLevel
    || !teamAId || !teamBId || teamAId === teamBId || !reason.trim();
  // A team can only be picked once across A, B and every extra row.
  const taken = new Set([teamAId, teamBId, ...extraTeamIds].filter(Boolean));
  const optionsFor = (current) => teamOptions.map((o) => ({ ...o, disabled: taken.has(o.key) && o.key !== current }));
  const teamAOptions = optionsFor(teamAId);
  const teamBOptions = optionsFor(teamBId);
  const canAddTeam = !!teamAId && !!teamBId
    && !extraTeamIds.includes('')
    && taken.size < teamOptions.length;
  const setExtra = (index, key) => onExtraTeamsChange(extraTeamIds.map((id, i) => (i === index ? key : id)));
  const removeExtra = (index) => onExtraTeamsChange(extraTeamIds.filter((_, i) => i !== index));

  return (
    <div className="mp-modal-overlay" onClick={submitting ? undefined : onClose}>
      <div className="mp-modal mp-request-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <button className="mp-format-close" onClick={onClose} aria-label="Close"><FaTimes /></button>
        <div className="mp-request-modal__body">
        <h2 className="mp-format-title">Request a schedule</h2>
        <p className="mp-format-sub">
          Ask the admin to arrange a fixture for two teams, or add more teams for a race. They'll be notified
          right away and either schedule it or let you know why not.
        </p>

        <div className="mp-format-sportpick" style={{ marginBottom: 14 }}>
          <OptionDropdown
            variant="pill"
            panelLabel="Year level"
            placeholder="Select year level"
            value={requestLevel}
            options={levelOptions}
            onChange={onLevelChange}
          />
          <OptionDropdown
            variant="pill"
            panelLabel="Sports option"
            placeholder="Select sport"
            value={sportId}
            options={sportOptions}
            onChange={onSportChange}
          />
          <OptionDropdown
            variant="pill"
            panelLabel="Division"
            placeholder={divisionOptions.length === 0 ? 'No divisions' : 'Select division'}
            value={divisionKey}
            options={divisionOptions}
            disabled={!sportId || divisionOptions.length === 0}
            onChange={onDivisionChange}
          />
        </div>

        <div className="mp-field">
          <div className="mp-field__label">
            Teams<span className="mp-required">*</span>
            <InfoTip caption="Teams">
              Only teams already registered for this sport (Sports &amp; Teams) show up here — that's what lets
              the admin's Add Schedule form pick them up automatically.
            </InfoTip>
          </div>
          {sportId && teamOptions.length < 2 ? (
            <p className="mp-schedule-hint" style={{ marginTop: 4 }}>
              <FaExclamationTriangle /> Fewer than two teams are registered for this sport yet — ask the admin to
              add them under Sports &amp; Teams first.
            </p>
          ) : (
            /* Every team in one row — Philippines VS China VS Russia VS USA —
               wrapping onto the next line when it runs out of room. */
            <div className="mp-request-teams">
              {[
                { id: teamAId, label: 'Team A', options: teamAOptions, onChange: onTeamAChange },
                { id: teamBId, label: 'Team B', options: teamBOptions, onChange: onTeamBChange },
                ...extraTeamIds.map((id, i) => ({
                  id, label: `Team ${i + 3}`, options: optionsFor(id), onChange: (key) => setExtra(i, key), removeAt: i,
                })),
              ].map((slot, index) => (
                <div className="mp-request-team" key={index}>
                  {index > 0 && <span className="mp-request-team__vs">VS</span>}
                  <div className="mp-request-team__pick">
                    <OptionDropdown
                      variant="teams"
                      panelLabel={slot.label}
                      placeholder="Select team"
                      value={slot.id}
                      options={slot.options}
                      disabled={!sportId}
                      onChange={slot.onChange}
                    />
                  </div>
                  {slot.removeAt != null && (
                    <button type="button" className="mp-request-extra__remove" onClick={() => removeExtra(slot.removeAt)} aria-label={`Remove ${slot.label}`}>
                      <FaTimes />
                    </button>
                  )}
                </div>
              ))}

              {sportId && teamOptions.length >= 3 && (
                <button
                  type="button"
                  className="mp-btn mp-btn--navy mp-request-addteam"
                  onClick={() => onExtraTeamsChange([...extraTeamIds, ''])}
                  disabled={!canAddTeam}
                >
                  <FaPlus /> Add team
                </button>
              )}
            </div>
          )}

          {extraTeamIds.length > 0 && (
            <p className="mp-schedule-hint" style={{ marginTop: 6 }}>
              <FaInfo /> {2 + extraTeamIds.filter(Boolean).length} teams — the admin will schedule them together as one race.
            </p>
          )}
        </div>

        <div className="mp-field">
          <div className="mp-field__label">
            Reason<span className="mp-required">*</span>
            <InfoTip caption="Reason">Why this schedule is needed — helps the admin prioritize and pick a slot/venue.</InfoTip>
          </div>
          <textarea
            className="mp-text-input"
            style={{ minHeight: 80, resize: 'vertical', width: '100%' }}
            placeholder="e.g. Both teams are available this Friday afternoon and want to settle the bracket tie."
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
          />
        </div>

        <div className="mp-confirm__actions" style={{ marginTop: 14 }}>
          <button className="mp-btn mp-btn--cancel" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="mp-btn mp-btn--confirm" onClick={onSubmit} disabled={incomplete || submitting}>
            <FaPaperPlane /> {submitting ? 'Sending…' : 'Send request'}
          </button>
        </div>

        {myRequests.length > 0 && (
          <div style={{ marginTop: 18, borderTop: '1px solid #e7ebf3', paddingTop: 12 }}>
            <div className="mp-dd-panel__label" style={{ marginBottom: 8 }}>Your requests</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
              {myRequests.map((r) => (
                <div key={r.id} style={{ border: '1px solid #e7ebf3', borderRadius: 10, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: '0.8rem' }}>
                      {r.sport}{r.category ? ` · ${r.category}` : ''}
                    </span>
                    <span
                      style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: '0.68rem', fontWeight: 700,
                        background: REQUEST_STATUS_COLOR[r.status]?.bg, color: REQUEST_STATUS_COLOR[r.status]?.fg,
                      }}
                    >
                      {REQUEST_STATUS_LABEL[r.status] || r.status}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.7, marginTop: 2 }}>
                    {levelOptions.find((l) => l.key === r.level)?.label || r.level}
                    {r.teamA && r.teamB ? ` • ${[r.teamA, r.teamB, ...(r.extraTeams || []).map((t) => t.name)].join(' vs ')}` : ''}
                  </div>
                  {r.status === 'declined' && r.declineReason && (
                    <div style={{ fontSize: '0.74rem', color: '#a83218', marginTop: 4 }}>
                      Admin: {r.declineReason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/* Small team logo (initials fallback) used in the inline edit row so each
   input can be tied to the team it belongs to. */
function EditTeamLogo({ team }) {
  return (
    <span className="mp-edit-logo" title={team?.name || ''}>
      {team?.logo ? <img src={team.logo} alt="" /> : initials(team?.name || '?')}
    </span>
  );
}

/* Per-team comeback toggle for the inline edit row. The bonus only counts for
   the team that wins, so it's disabled (but keeps its value) while this team
   isn't the one ahead in the edited score. */
function ComebackToggle({ on, canApply, onToggle }) {
  return (
    <button
      type="button"
      className={`mp-edit-comeback ${on ? 'mp-edit-comeback--on' : ''}`}
      aria-pressed={on}
      disabled={!canApply}
      onClick={onToggle}
      title={canApply ? `Comeback bonus +${COMEBACK_BONUS}` : 'The comeback bonus only counts for the winning team'}
    >
      <FaExchangeAlt /> Comeback {on ? 'Yes' : 'No'}
    </button>
  );
}

/* ═══════════════════════════════════════════
   MATCH PANEL — "Before the game" / "After the game"
═══════════════════════════════════════════ */
function MatchPanel({
  entry, index, mode, multi, teamOptions, teamLabel,
  onChange, onOpenViolations, onRemove, canRemove,
  prevPoints, compute, opponentLabel, opponentRating, opponentScoreText,
  isWinner, hasWinner, isDraw, onSetWinner, onSetLoser, onSetDraw,
  readOnly, teamLocked,
}) {
  const selectedTeam = teamOptions.find((o) => o.key === entry.teamId);
  const totalViolations = entry.violations.reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0);
  const status = isDraw ? 'draw' : hasWinner ? (isWinner ? 'win' : 'lose') : null;

  const [vBump, setVBump] = useState(false);
  const prevViol = useRef(totalViolations);
  useEffect(() => {
    if (prevViol.current !== totalViolations) {
      setVBump(true);
      const t = setTimeout(() => setVBump(false), 300);
      prevViol.current = totalViolations;
      return () => clearTimeout(t);
    }
  }, [totalViolations]);

  const scoreValue = mode === 'points' ? entry.points : entry.time;
  const onScoreChange = (raw) => {
    if (mode === 'points') onChange({ points: sanitizePointsInput(raw) });
    else onChange({ time: formatDurationInput(raw) });
  };

  const expectedPct = compute ? `${(compute.expected * 100).toFixed(2)}%` : '';
  const finalRate = compute ? fmtPts(compute.finalPoints) : '';

  return (
    <div className={`mp-team-panel${status ? ` mp-team-panel--${status}` : ''}`}>
      {selectedTeam && (
        <span className="mp-team-panel__badge">
          {selectedTeam.logo ? <img src={selectedTeam.logo} alt="" /> : initials(selectedTeam.label)}
        </span>
      )}

      {canRemove && !readOnly && (
        <button type="button" className="mp-team-panel__remove" onClick={onRemove} aria-label="Remove team">
          <FaTimes />
        </button>
      )}

      {/* ── BEFORE THE GAME ── */}
      <div className="mp-sec-title">Before the game</div>

      <div className="mp-grid2">
        <div className="mp-field">
          <div className="mp-field__label">
            {teamLabel}<span className="mp-required">*</span>
            <InfoTip caption="Team">The team you want to calculate for this panel.</InfoTip>
            {teamLocked && <span className="mp-field__locked-tag"><FaLock /> From schedule</span>}
          </div>
          <OptionDropdown
            variant="teams"
            panelLabel="Teams"
            value={entry.teamId}
            placeholder="Select team"
            options={teamOptions}
            onChange={(k) => onChange({ teamId: k })}
            disabled={teamLocked || readOnly}
          />
          <input className="mp-text-input mp-text-input--auto" readOnly value={selectedTeam ? `Auto rating: ${fmtPts(prevPoints)}` : 'Auto rating'} />
        </div>

        <div className="mp-field">
          <div className="mp-field__label">
            {multi ? 'Opponents' : `Team ${index === 0 ? 2 : 1}`}
            <InfoTip caption="Opponent rating">
              {multi
                ? 'Every other team in this event. Their average rating is shown here; each one is computed separately.'
                : 'The opposing team, taken from the other panel.'}
            </InfoTip>
          </div>
          <input className="mp-text-input mp-text-input--auto" readOnly value={opponentLabel || (multi ? 'No opponents yet' : 'Opponent team')} />
          <input className="mp-text-input mp-text-input--auto" readOnly value={opponentRating != null ? `Auto rating: ${fmtPts(opponentRating)}` : 'Auto rating'} />
        </div>
      </div>

      <div className="mp-field mp-field--center">
        <div className="mp-field__label mp-field__label--center">
          Expected score
          <InfoTip caption="Expected score">Percentage chance of winning, computed from both ratings before the game.</InfoTip>
        </div>
        <div className="mp-field__hint">(percentage chance of winning)</div>
        <input className="mp-text-input mp-text-input--auto" readOnly value={expectedPct || 'Auto percentage of winning'} />
      </div>

      {/* ── AFTER THE GAME ── */}
      <div className="mp-sec-title">After the game</div>

      <div className="mp-grid2">
        <div className="mp-field">
          <div className="mp-field__label">
            Team rating (your team)
            <InfoTip caption="Team rating">This team's saved rating before this match. New teams start at {DEFAULT_POINTS}.</InfoTip>
          </div>
          <input className="mp-text-input mp-text-input--auto" readOnly value={fmtPts(prevPoints)} />
        </div>

        <div className="mp-field">
          <div className="mp-field__label">
            Standing<span className="mp-required">*</span>
            <InfoTip caption="Standing">
              Filled automatically from the scores. You can still set it by hand if the official result differs.
            </InfoTip>
          </div>
          <div className="mp-standing">
            <label className="mp-standing__opt">
              <span className="mp-standing__chip mp-standing__chip--win">Win</span>
              <input
                type="radio"
                name={`standing-${entry.id}`}
                checked={status === 'win'}
                onChange={() => onSetWinner()}
                disabled={readOnly}
              />
            </label>
            <label className="mp-standing__opt">
              <span className="mp-standing__chip mp-standing__chip--lose">Lose</span>
              <input
                type="radio"
                name={`standing-${entry.id}`}
                checked={status === 'lose'}
                onChange={() => onSetLoser()}
                disabled={readOnly}
              />
            </label>
            {!multi && (
              <label className="mp-standing__opt">
                <span className="mp-standing__chip mp-standing__chip--draw">Draw</span>
                <input
                  type="radio"
                  name={`standing-${entry.id}`}
                  checked={status === 'draw'}
                  onChange={() => onSetDraw()}
                  disabled={readOnly}
                />
              </label>
            )}
          </div>
        </div>
      </div>

      <div className="mp-grid2">
        <div className="mp-field">
          <div className="mp-field__label">
            {mode === 'points' ? 'Team points (your team)' : 'Team time (your team)'}<span className="mp-required">*</span>
            <InfoTip caption={mode === 'points' ? 'Points info' : 'Time duration info'}>
              {mode === 'points'
                ? 'Input the points this team scored so its performance can be analysed.'
                : 'Input this team\'s finishing time (HH:MM:SS) so its performance can be analysed.'}
            </InfoTip>
          </div>
          <input
            className="mp-text-input"
            type="text"
            inputMode="numeric"
            placeholder={mode === 'points' ? 'Input points' : 'HH:MM:SS'}
            maxLength={mode === 'points' ? 5 : 8}
            value={scoreValue}
            onChange={(e) => onScoreChange(e.target.value)}
            disabled={readOnly}
          />
        </div>

        <div className="mp-field">
          <div className="mp-field__label">
            {multi
              ? (mode === 'points' ? 'Opponents points (avg)' : 'Opponents time (avg)')
              : (mode === 'points' ? 'Opponent points' : 'Opponent time')}
          </div>
          <input className="mp-text-input mp-text-input--auto" readOnly value={opponentScoreText || (mode === 'points' ? 'Opponent points' : 'Opponent time')} />
        </div>
      </div>

      <div className="mp-field">
        <div className="mp-field__label">
          Violation
          <InfoTip caption="Violation info">Log every violation this team committed — each one lowers the performance term.</InfoTip>
        </div>
        <div className="mp-violation-row">
          <div className="mp-violation-box">
            <div className="mp-violation-box__label">Total violations</div>
            <div className={`mp-violation-box__num ${vBump ? 'mp-violation-box__num--bump' : ''}`}>{totalViolations}</div>
          </div>
          <button type="button" className="mp-btn mp-btn--navy" onClick={onOpenViolations} disabled={readOnly}>Add/View violation</button>
        </div>
      </div>

      <div className="mp-field">
        <div className="mp-field__label">
          Comeback rule<span className="mp-required">*</span>
          <InfoTip caption="Comeback rule info">
            Worth +{COMEBACK_BONUS} to the performance term, and only counted for a game this team actually won.
          </InfoTip>
        </div>
        <div className="mp-radio-col">
          <label className="mp-radio">
            <input
              type="radio"
              name={`comeback-${entry.id}`}
              checked={entry.comeback === true}
              onChange={() => onChange({ comeback: true })}
              disabled={readOnly}
            />
            Yes (The team made a comeback and won the game)
          </label>
          <label className="mp-radio">
            <input
              type="radio"
              name={`comeback-${entry.id}`}
              checked={entry.comeback !== true}
              onChange={() => onChange({ comeback: false })}
              disabled={readOnly}
            />
            No (No comeback)
          </label>
        </div>
        {entry.comeback && status === 'lose' && (
          <div className="mp-field__hint mp-field__hint--warn">
            The comeback bonus is only applied to games this team won, so it won't be counted here.
          </div>
        )}
      </div>

      {/* ── FINAL RATE ── */}
      <div className="mp-sec-title mp-sec-title--sub">Final rate</div>

      <div className="mp-field">
        <input className="mp-text-input mp-text-input--auto" readOnly value={finalRate ? `Auto computed rating: ${finalRate}` : 'Auto (computed rating)'} />
      </div>

      <div className="mp-points-row">
        <div className="mp-points-box">
          <div className="mp-points-box__label">Current points <span>(saved)</span></div>
          <div className="mp-points-box__num">{fmtPts(prevPoints)}</div>
        </div>
        <div className="mp-points-box">
          <div className="mp-points-box__label">Final points rating <span>(auto)</span></div>
          <div className="mp-points-box__num">{compute ? fmtPts(compute.finalPoints) : '—'}</div>
        </div>
      </div>

      <div className="mp-pill">
        <div className="mp-pill__seg">{selectedTeam ? selectedTeam.label : teamLabel}</div>
        <div className={`mp-pill__seg ${status === 'win' ? 'mp-pill__seg--win' : status === 'lose' ? 'mp-pill__seg--lose' : status === 'draw' ? 'mp-pill__seg--draw' : ''}`}>
          <FaTrophy /> {status === 'win' ? 'Win' : status === 'lose' ? 'Lose' : status === 'draw' ? 'Draw' : '—'}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════ */
const mkEntry = () => ({ id: uid(), teamId: '', points: '', time: '', violations: [], comeback: false });

export default function ModeratorPage() {
  const navigate = useNavigate();
  const { currentUser, userProfile } = useContext(AuthContext);
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  // Moderators are scoped to one school level (set by a Super Admin); only
  // a Super Admin (staffLevel null) can switch between levels.
  const staffLevel = userProfile?.staffLevel || null;
  const LEVELS = useMemo(() => [
    { key: 'elementary', label: levelLabels.elementary },
    { key: 'highSchool', label: levelLabels.highSchool },
    { key: 'college', label: levelLabels.college },
  ].filter((l) => !staffLevel || l.key === staffLevel), [levelLabels, staffLevel]);
  const summaryRef = useRef(null);

  const [pickedLevel, setLevel] = useState('elementary');
  const level = staffLevel || pickedLevel;
  const [sports, setSports] = useState([]);
  const [teams, setTeams] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [rankings, setRankings] = useState({});
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  /* ── STEP 1: sports format ── */
  const [formatId, setFormatId] = useState('');
  /* The picker no longer opens on arrival: a moderator normally starts from
     the finished-match list below, which selects the format itself. It's
     still one click away, and 1-vs-many events open it manually. */
  const [formatPickerOpen, setFormatPickerOpen] = useState(false);
  /* The fixture whose format is being chosen. Set when a match is clicked
     in the list, so choosing a format keeps that match's teams instead of
     wiping the form. Null means "record something with no fixture". */
  const [formatPickerFor, setFormatPickerFor] = useState(null);
  const formatChoice = formatById(formatId);
  const mode = formatChoice ? formatChoice.mode : 'points';
  const isMulti = !!formatChoice?.multi;

  const effectiveSports = useMemo(
    () => (sports.length > 0 ? sports : deriveSportsFromSchedules(schedules)),
    [sports, schedules],
  );
  const effectiveTeams = useMemo(() => {
    /* Keep configured team records first so their ids, logos, and ranking
       data remain authoritative, then add any teams referenced by saved
       schedules. A schedule can legitimately contain a team that was not
       saved in the current Sports & Teams config (or whose sport assignment
       was later changed), and dropping it makes the Moderator dropdown
       appear empty even though the schedule contains the matchup. */
    const merged = new Map();
    [...teams, ...deriveTeamsFromSchedules(schedules)].forEach((team) => {
      const key = norm(team.name);
      if (!key) return;
      if (!merged.has(key)) {
        merged.set(key, team);
        return;
      }
      const existing = merged.get(key);
      merged.set(key, {
        ...team,
        ...existing,
        logo: existing.logo || team.logo || null,
        sportIds: Array.from(new Set([...(team.sportIds || []), ...(existing.sportIds || [])])),
      });
    });
    return [...merged.values()];
  }, [teams, schedules]);
  const usingScheduleFallback = sports.length === 0 && effectiveSports.length > 0;

  const [sportId, setSportId] = useState('');
  const selectedSport = effectiveSports.find((s) => s.id === sportId) || null;

  const divisionOptions = useMemo(
    () => buildDivisionOptionsForSport(selectedSport),
    [selectedSport],
  );
  const [divisionKey, setDivisionKey] = useState('');
  const selectedDivision = divisionOptions.find((d) => d.key === divisionKey) || null;
  const divisionRequired = divisionOptions.length > 0;

  /* Year Level — carried only by pre-existing manual (no-fixture) records
     from before that entry path was removed in favor of "Request a
     schedule"; still read/written when re-computing one of those via
     loadRecordIntoForm below. New records are always tied to a fixture. */
  const [yearLevel, setYearLevel] = useState('');

  /* Declared before activeSport because that memo reads it: a fixture
     supplies the division for sports that have none configured. */
  const [lockedMatch, setLockedMatch] = useState(null);

  const activeSport = useMemo(() => {
    if (!selectedSport) return null;
    if (!divisionRequired) {
      /* No divisions configured for this sport in Sports & Teams. If the
         work came from a fixture, keep that fixture's own division so
         (say) Volleyball WOMEN and Volleyball MEN still rank separately
         instead of collapsing into one nameless scope. */
      const fromFixture = lockedMatch && norm(lockedMatch.sport) === norm(selectedSport.name)
        ? scopedCategory(lockedMatch, sports)
        : '';
      return { sportId: selectedSport.id, sportName: selectedSport.name, category: fromFixture, logo: selectedSport.logo || null, format: '' };
    }
    if (!selectedDivision) {
      /* A fixture whose category matches none of the configured divisions
         (naming drift between Schedules and Sports & Teams) still knows its
         own division — use it rather than demanding a manual pick. */
      if (lockedMatch && lockedMatch.category && norm(lockedMatch.sport) === norm(selectedSport.name)) {
        return { sportId: selectedSport.id, sportName: selectedSport.name, category: scopedCategory(lockedMatch, sports), logo: selectedSport.logo || null, format: '' };
      }
      return null;
    }
    const fixtureHere = lockedMatch && norm(lockedMatch.sport) === norm(selectedSport.name) ? lockedMatch : null;
    return {
      sportId: selectedSport.id, sportName: selectedSport.name,
      category: fixtureHere?.divisionId ? scopedCategory(fixtureHere, sports) : selectedDivision.category,
      logo: selectedSport.logo || null, format: selectedDivision.format,
    };
  }, [selectedSport, divisionRequired, selectedDivision, lockedMatch, sports]);

  /* ── form state: one entry per participating team ── */
  const [entries, setEntries] = useState(() => [mkEntry(), mkEntry()]);
  const [winnerId, setWinnerId] = useState(null);
  const [winnerManual, setWinnerManual] = useState(false);

  const [lockedRecord, setLockedRecord] = useState(null);
  const [editingRecord, setEditingRecord] = useState(null); // record being re-computed from the summary table
  const [violModal, setViolModal] = useState(null);         // entry id | null
  const [pending, setPending] = useState(null);
  const [invalidReasons, setInvalidReasons] = useState(null);
  const [successRecord, setSuccessRecord] = useState(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // summary table
  const [formatFilter, setFormatFilter] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [savingEditId, setSavingEditId] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const editTeamOptions = useMemo(
    () => effectiveTeams.map((t) => ({ key: t.id, label: t.name, logo: t.logo || null })),
    [effectiveTeams],
  );

  /* ── "Request a schedule" (ask the admin to arrange a fixture) ── */
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [requestLevel, setRequestLevel] = useState('highSchool');
  const [requestFetchedConfig, setRequestFetchedConfig] = useState(null); // { sports, teams } — only populated when requestLevel differs from the page's own `level`
  const [requestSportId, setRequestSportId] = useState('');
  const [requestDivisionKey, setRequestDivisionKey] = useState('');
  const [requestTeamAId, setRequestTeamAId] = useState('');
  const [requestTeamBId, setRequestTeamBId] = useState('');
  // Teams beyond A and B, for an event with more than two (a race). '' = an empty row.
  const [requestExtraTeamIds, setRequestExtraTeamIds] = useState([]);
  const [requestReason, setRequestReason] = useState('');
  const [requestSubmitting, setRequestSubmitting] = useState(false);
  const [requestToast, setRequestToast] = useState(null);

  // Sourced from the one shared listener ScheduleRequestsProvider owns for
  // the whole authenticated session (see App.jsx) — a newly-sent request
  // (or the admin resolving one) still shows up in "Your requests" without
  // a page refresh, just without this page opening its own second
  // `onSnapshot` on the same doc.
  const { scheduleRequests: allScheduleRequests } = useContext(ScheduleRequestsContext);

  const myScheduleRequests = useMemo(() => {
    const email = (currentUser?.email || '').toLowerCase();
    if (!email) return [];
    return allScheduleRequests
      .filter((r) => (r.requestedByEmail || '').toLowerCase() === email)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [allScheduleRequests, currentUser]);

  const openRequestModal = () => {
    setRequestLevel(level);
    setRequestFetchedConfig(null);
    setRequestSportId('');
    setRequestDivisionKey('');
    setRequestTeamAId('');
    setRequestTeamBId('');
    setRequestExtraTeamIds([]);
    setRequestReason('');
    setRequestModalOpen(true);
  };

  // The sport/division/team pickers inside the request modal need the
  // target level's own config. While requestLevel matches the page's
  // current level tab, `effectiveSports`/`effectiveTeams` (already loaded)
  // are used directly below — this effect only has work to do, and only
  // ever calls setState, once the moderator picks a *different* level
  // than the one currently shown.
  useEffect(() => {
    if (!requestModalOpen || requestLevel === level) return;
    let cancelled = false;
    getSportsTeamsConfig(requestLevel).then((cfg) => {
      if (!cancelled) setRequestFetchedConfig({ sports: cfg.sports || [], teams: cfg.teams || [] });
    }).catch(() => { if (!cancelled) setRequestFetchedConfig({ sports: [], teams: [] }); });
    return () => { cancelled = true; };
  }, [requestModalOpen, requestLevel, level]);

  const requestSports = useMemo(
    () => (requestLevel === level ? effectiveSports : (requestFetchedConfig?.sports || [])),
    [requestLevel, level, effectiveSports, requestFetchedConfig],
  );
  const requestTeamsPool = useMemo(
    () => (requestLevel === level ? effectiveTeams : (requestFetchedConfig?.teams || [])),
    [requestLevel, level, effectiveTeams, requestFetchedConfig],
  );
  const requestSportOptions = useMemo(() => buildSportOnlyOptions(requestSports), [requestSports]);
  const requestSelectedSport = requestSports.find((s) => s.id === requestSportId) || null;
  const requestDivisionOptions = useMemo(
    () => buildRequestDivisionOptionsForSport(requestSelectedSport),
    [requestSelectedSport],
  );
  const requestDivisionRequired = requestDivisionOptions.length > 0;
  const requestSelectedDivision = requestDivisionOptions.find((d) => d.key === requestDivisionKey) || null;

  // Same "teams registered for this sport" filter the main record form
  // uses (teamOptionsForSport above) — the admin's Add Schedule screen
  // matches teams by name against this same sport-scoped pool, so picking
  // from it here guarantees the names line up once the admin opens it.
  const requestTeamOptions = useMemo(() => {
    if (!requestSelectedSport) return [];
    const bySport = requestTeamsPool.filter((t) =>
      (t.sportIds || []).some((sportName) => norm(sportName) === norm(requestSelectedSport.name)));
    const pool = bySport.length ? bySport : requestTeamsPool;
    return pool.map((t) => ({ key: t.id, label: t.name, logo: t.logo || null }));
  }, [requestTeamsPool, requestSelectedSport]);

  async function handleSendScheduleRequest() {
    if (
      !requestSportId || (requestDivisionRequired && !requestDivisionKey)
      || !requestTeamAId || !requestTeamBId || requestTeamAId === requestTeamBId
      || !requestReason.trim()
    ) return;
    const teamA = requestTeamsPool.find((t) => t.id === requestTeamAId);
    const teamB = requestTeamsPool.find((t) => t.id === requestTeamBId);
    // Blank rows are ignored; a repeated team counts once.
    const extraIds = [...new Set(requestExtraTeamIds.filter((id) => id && id !== requestTeamAId && id !== requestTeamBId))];
    const extraTeams = extraIds
      .map((id) => requestTeamsPool.find((t) => t.id === id))
      .filter(Boolean)
      .map((t) => ({ name: t.name, logo: t.logo || null }));
    setRequestSubmitting(true);
    try {
      await createScheduleRequest({
        level: requestLevel,
        sport: requestSelectedSport?.name || '',
        category: requestSelectedDivision?.category || '',
        teamA: teamA?.name || '',
        teamB: teamB?.name || '',
        teamALogo: teamA?.logo || null,
        teamBLogo: teamB?.logo || null,
        ...(extraTeams.length ? { extraTeams } : {}),
        reason: requestReason.trim(),
        requestedByEmail: currentUser?.email || '',
        requestedByName: userProfile?.name || '',
      }, userProfile?.role);
      setRequestModalOpen(false);
      setRequestToast({ text: 'Request sent — the admin has been notified.' });
    } catch (err) {
      console.error('Failed to send schedule request:', err);
      setRequestToast({ text: friendlyFirestoreError(err, 'Could not send the request') });
    } finally {
      setRequestSubmitting(false);
    }
  }

  useEffect(() => {
    if (!requestToast) return;
    const t = setTimeout(() => setRequestToast(null), 3500);
    return () => clearTimeout(t);
  }, [requestToast]);

  /* ── load config, schedules, records & rankings whenever the level changes ── */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const [configR, schedsR, recsR, ranksR] = await Promise.allSettled([
        getSportsTeamsConfig(level),
        getMatchSchedules(level),
        getMatchRecords(level),
        getTeamRankings(level),
      ]);
      if (cancelled) return;

      const failed = [];
      if (configR.status === 'fulfilled') {
        setSports(configR.value.sports || []);
        setTeams(configR.value.teams || []);
      } else {
        console.error('Failed to load Sports & Teams config:', configR.reason);
        setSports([]); setTeams([]);
        failed.push('Sports & Teams');
      }
      if (schedsR.status === 'fulfilled') {
        setSchedules(schedsR.value || []);
      } else {
        console.error('Failed to load match schedules:', schedsR.reason);
        setSchedules([]);
        failed.push('Match Schedules');
      }
      if (recsR.status === 'fulfilled') {
        setRecords(recsR.value || []);
      } else {
        console.error('Failed to load match records:', recsR.reason);
        setRecords([]);
        failed.push('Match Records');
      }
      if (ranksR.status === 'fulfilled') {
        setRankings(ranksR.value || {});
      } else {
        console.error('Failed to load team rankings:', ranksR.reason);
        setRankings({});
        failed.push('Team Rankings');
      }

      if (failed.length) {
        const reason = [configR, schedsR, recsR, ranksR].find((r) => r.status === 'rejected')?.reason;
        const isPermission = reason?.code === 'permission-denied' || /permission/i.test(reason?.message || '');
        setLoadError(
          isPermission
            ? `Couldn't load ${failed.join(', ')} — your account doesn't have permission to read this data (check Firestore rules).`
            : `Couldn't load ${failed.join(', ')} — check your connection and try refreshing.`,
        );
      }

      setSportId('');
      setDivisionKey('');
      setYearLevel('');
      setLockedMatch(null);
      setLockedRecord(null);
      // A format chosen on the previous level tab (e.g. College) was left
      // standing after switching tabs, since only the schedule-scoped state
      // above was cleared. With no lockedMatch to re-derive activeSport from,
      // the "Update match record" form still rendered on a level with zero
      // finished matches — empty "Select team" dropdowns and all — because
      // the render check below only gates on formatChoice, not on this
      // level's recordableMatches. Clearing it here keeps the two in sync.
      setFormatId('');
      setFormatPickerOpen(false);
      setFormatPickerFor(null);
      setEditingRecord(null);
      setEntries([mkEntry(), mkEntry()]);
      setWinnerId(null);
      setWinnerManual(false);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [level]);

  // Live on top of the one-time fetch above — an admin deleting/editing a
  // schedule (or fulfilling a moderator's request) should disappear from
  // this list immediately, not just after the moderator reloads the page
  // or switches level tabs.
  useEffect(() => {
    const unsubscribe = subscribeMatchSchedules(level, setSchedules);
    return unsubscribe;
  }, [level]);

  const resetForm = useCallback((teamCount) => {
    const n = teamCount ?? entries.length;
    setEntries(Array.from({ length: Math.max(2, n) }, () => mkEntry()));
    setWinnerId(null);
    setWinnerManual(false);
    setLockedMatch(null);
    setLockedRecord(null);
    setEditingRecord(null);
  }, [entries.length]);

  /* The Reset button: clears only what the moderator types in — points,
     time, violations, comeback and the Win/Lose/Draw standing. The panel
     itself (chosen match, locked teams, format, sport/division) stays put,
     unlike resetForm which rebuilds every entry and unlocks the fixture. */
  const resetInputs = useCallback(() => {
    if (lockedRecord) return; // read-only view of a saved record — nothing to reset
    setEntries((es) => es.map((e) => ({ ...e, points: '', time: '', violations: [], comeback: false })));
    setWinnerId(null);
    setWinnerManual(false);
    setViolModal(null);
    setInvalidReasons(null);
  }, [lockedRecord]);

  /* Choosing a sports format rebuilds the form from scratch with the right
     number of team panels (2 for 1v1, 4 to start with for 1-vs-many). */
  const teamIdByName = useCallback((name) => {
    const hit = effectiveTeams.find((t) => norm(t.name) === norm(name));
    return hit ? hit.id : '';
  }, [effectiveTeams]);

  /* Chosen after a match was clicked, so the fixture's two teams are
     carried into the new panels. A 1-vs-many format keeps them as the
     first two entries and leaves the rest blank to fill in. */
  function applyFormat(id, fixture) {
    const f = formatById(id);
    if (!f) return false;
    /* A Single-Race fixture already names every team in the field, so all of
       them are seeded (and the form is exactly that size). */
    const raceFixture = !!fixture && isRaceMatch(fixture);
    const seeded = !fixture
      ? []
      : raceFixture
        ? raceParticipants(fixture).map((p) => teamIdByName(p.name))
        : [teamIdByName(fixture.teamA), teamIdByName(fixture.teamB)];

    setFormatId(id);
    setFormatPickerOpen(false);
    setFormatPickerFor(null);
    setEntries(Array.from(
      { length: raceFixture ? seeded.length : f.teams },
      (_, i) => ({ ...mkEntry(), teamId: seeded[i] || '' }),
    ));
    setWinnerId(null);
    setWinnerManual(false);
    setLockedRecord(null);
    setEditingRecord(null);
    if (!fixture) setLockedMatch(null); // manual entry: nothing to lock to
    return true;
  }

  function handleChooseFormat(id) {
    applyFormat(id, formatPickerFor);
  }

  function handleResetClick() {
    setResetConfirmOpen(true);
  }

  const updateEntry = useCallback((id, patch) => {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const addEntry = () => {
    setEntries((es) => (es.length >= MAX_MULTI_TEAMS ? es : [...es, mkEntry()]));
  };
  const removeEntry = (id) => {
    setEntries((es) => (es.length <= MIN_MULTI_TEAMS ? es : es.filter((e) => e.id !== id)));
    setWinnerId((w) => (w === id ? null : w));
  };

  /* ── schedule helpers ── */
  const scheduleMatchesForSelection = useMemo(() => {
    if (!activeSport) return [];
    return schedules.filter((s) =>
      norm(s.sport) === norm(activeSport.sportName)
      && (divisionRequired ? categoriesMatch(s.category, activeSport.category) : true));
  }, [schedules, activeSport, divisionRequired]);

  const readyTeamNames = useMemo(() => {
    const names = new Set();
    scheduleMatchesForSelection.forEach((s) => {
      if (!matchHasFinished(s)) return;
      if (s.teamA) names.add(norm(s.teamA));
      if (s.teamB) names.add(norm(s.teamB));
    });
    return names;
  }, [scheduleMatchesForSelection]);

  const hasScheduleForSelection = scheduleMatchesForSelection.length > 0;

  const teamOptionsForSport = useMemo(() => {
    if (!activeSport) return effectiveTeams.map((t) => ({ key: t.id, label: t.name, logo: t.logo || null }));
    // Admin stores sport names in sportIds. Match by normalized name so
    // casing/whitespace differences cannot hide teams from the moderator.
    const bySport = effectiveTeams.filter((t) =>
      (t.sportIds || []).some((sportName) => norm(sportName) === norm(activeSport.sportName))
    );
    const pool = bySport.length ? bySport : effectiveTeams;
    // Keep every team registered for the selected sport available here.
    // The finished-match picker still controls which scheduled 1-vs-1 match
    // can be loaded, but filtering this dropdown by match completion caused
    // newly inputted schedules (especially future-dated ones) to show no
    // teams at all.
    return pool.map((t) => ({ key: t.id, label: t.name, logo: t.logo || null }));
  }, [effectiveTeams, activeSport, hasScheduleForSelection, readyTeamNames, isMulti]);


  const findRecordForSchedule = useCallback((s) => records.find((r) => {
    /* A record saved from this fixture carries its scheduleId, which is
       exact. Falling straight through to the name/category comparison
       missed records whose sport has no configured divisions (the record
       stores an empty category, the schedule says "WOMEN"), so a match
       that had just been recorded still offered to record it again. */
    if (r.scheduleId) return String(r.scheduleId) === String(s.id);
    if (norm(r.sportName) !== norm(s.sport)) return false;
    if (s.category && r.category && !categoriesMatch(r.category, s.category)) return false;
    const names = [norm(r.teamA?.name), norm(r.teamB?.name)];
    return names.includes(norm(s.teamA)) && names.includes(norm(s.teamB));
  }), [records]);
  const isMatchRecorded = useCallback((s) => !!findRecordForSchedule(s), [findRecordForSchedule]);

  /* Every scheduled matchup at this level, whatever sport or division it
     belongs to — exactly what the public Match Schedules page lists,
     including generated bracket matches that are still only "team vs
     team" with no date attached. This is the moderator's entry point:
     click the match and the sport, division, and both teams fill
     themselves in. Ordering: not-yet-recorded first, then finished →
     ongoing → undated → upcoming, newest first inside each group. */
  // Every scheduled matchup with both teams filled in, finished or not.
  // Used only to tell "nothing scheduled" apart from "scheduled but none
  // finished yet" in the empty-state message below.
  const scheduledMatches = useMemo(
    () => schedules.filter((s) => s.teamA && s.teamB),
    [schedules],
  );

  // Every scheduled match is listed for the moderator, but only finished
  // ones (marked by the moderator, or elapsed) can be picked for recording.
  const listedMatches = useMemo(() => {
    const startOf = (s) => {
      const d = new Date(`${s.date}T${s.time || '00:00'}`);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    };
    return scheduledMatches
      .map((s) => ({ ...s, status: matchStatus(s), canRecord: matchHasFinished(s) }))
      .sort((a, b) => {
        const aDone = isMatchRecorded(a) ? 1 : 0;
        const bDone = isMatchRecorded(b) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        const byStatus = MATCH_STATUS_ORDER[a.status] - MATCH_STATUS_ORDER[b.status];
        if (byStatus !== 0) return byStatus;
        // Same sport + division: Round 1 first (leftmost), then Round 2, …
        // Otherwise keep the newest-first order between different sports.
        const aScope = `${norm(a.sport)}::${norm(a.divisionId || a.category)}`;
        const bScope = `${norm(b.sport)}::${norm(b.divisionId || b.category)}`;
        if (aScope !== bScope) return startOf(b) - startOf(a);
        const byRound = (a.round ?? Infinity) - (b.round ?? Infinity);
        if (byRound !== 0 && Number.isFinite(byRound)) return byRound;
        return startOf(a) - startOf(b);
      });
  }, [scheduledMatches, isMatchRecorded]);
  const recordableMatches = useMemo(() => listedMatches.filter((s) => s.canRecord), [listedMatches]);

  /* Sport / Category / Division filters for the Match schedules panel, so a
     match can be found without scrolling the whole list. Purely a view
     filter — it never changes which match is selected or recorded. */
  const [fSport, setFSport] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fDivision, setFDivision] = useState('');
  const partsOf = useCallback((s) => scheduleParts(s, sports), [sports]);
  const filterOptions = useMemo(() => {
    const uniq = (arr) => [...new Map(arr.filter(Boolean).map((v) => [norm(v), v])).values()];
    const rows = listedMatches.map((s) => ({ sport: s.sport, ...partsOf(s) }));
    const inSport = rows.filter((r) => !fSport || norm(r.sport) === norm(fSport));
    const inCat = inSport.filter((r) => !fCategory || norm(r.category) === norm(fCategory));
    return {
      sports: uniq(rows.map((r) => r.sport)),
      categories: uniq(inSport.map((r) => r.category)),
      divisions: uniq(inCat.map((r) => r.division)),
    };
  }, [listedMatches, partsOf, fSport, fCategory]);
  const shownMatches = useMemo(() => listedMatches.filter((s) => {
    const p = partsOf(s);
    return (!fSport || norm(s.sport) === norm(fSport))
      && (!fCategory || norm(p.category) === norm(fCategory))
      && (!fDivision || norm(p.division) === norm(fDivision));
  }), [listedMatches, partsOf, fSport, fCategory, fDivision]);

  /* Rebuilds every rating from the saved records (each sport + division from
     1200), so a record saved on a stale baseline is fixed without re-entering
     its scores, and orphaned ratings are dropped. */
  const [recalculating, setRecalculating] = useState(false);
  async function handleRecalculate() {
    if (recalculating) return;
    setRecalculating(true);
    try {
      const data = await recalculateRatings(level);
      setRecords(data.records || []);
      setRankings(data.rankings || {});
    } catch (err) {
      console.error('Failed to recalculate ratings:', err);
      setLoadError('Could not recalculate the ratings. Please try again.');
    } finally {
      setRecalculating(false);
    }
  }

  const [markingId, setMarkingId] = useState(null);
  async function handleMarkFinished(s) {
    if (markingId) return;
    setMarkingId(s.id);
    try {
      // The schedule subscription pushes the updated row back, so the card
      // flips to "Finished" without any local state change here.
      await markMatchScheduleFinished(level, s.id, userProfile?.role);
    } catch (err) {
      console.error('Failed to mark match as finished:', err);
      setLoadError('Could not mark that match as finished. Please try again.');
    } finally {
      setMarkingId(null);
    }
  }

  /* ── ratings & live computation ── */
  const scopeKey = activeSport ? rankingScopeKey(activeSport.sportName, activeSport.category) : null;
  /* A scope's saved ratings only count while records exist for it — after an
     admin reset deletes the records, leftover ratings must not carry on. */
  const scopedRankings = useMemo(() => {
    if (!scopeKey) return {};
    const names = new Set();
    records.forEach((r) => {
      if (rankingScopeKey(r.sportName, r.category) !== scopeKey) return;
      (r.participants?.length ? r.participants : [r.teamA, r.teamB])
        .forEach((p) => { if (p?.name) names.add(norm(p.name)); });
    });
    // Only teams that still have a record in this scope keep their points.
    return Object.fromEntries(
      Object.entries(rankings[scopeKey] || {}).filter(([name]) => names.has(norm(name))),
    );
  }, [scopeKey, records, rankings]);

  const prevPointsFor = useCallback((teamName) => {
    if (!teamName) return DEFAULT_POINTS;
    // Re-opening a saved record: its own stored "previous points" are the
    // right baseline, since live rankings already include this match.
    const snapshot = editingRecord || lockedRecord;

    /* Game order = the fixture's scheduled date/time (falls back to when it
       was recorded). A team's rating going into a game is the final rating of
       its previous game in the same sport/division, so the first round is
       always followed by the next — regardless of the order they were saved. */
    const schedById = new Map(schedules.map((x) => [x.id, x]));
    const orderOf = (rec) => {
      /* A record points at its fixture via scheduleId; a locked fixture (no
         record yet) IS the schedule, so read its own date/time. Without this
         its order fell to 0, every saved game looked "later", and the form
         showed the 1200 baseline instead of the team's saved rating. */
      const sc = rec?.scheduleId ? schedById.get(rec.scheduleId) : (rec?.date ? rec : null);
      /* A moderator-requested fixture (rematch, tie-break) always comes after
         the regular games, whatever date it got — same rule as the server's
         scheduleOrder, so it adopts each team's current rating. */
      const offset = sc?.requestId && sc.round == null && !sc.stage ? 1e15 : 0;
      if (sc?.date) {
        const t = new Date(`${sc.date}T${sc.time || '00:00'}`).getTime();
        if (!Number.isNaN(t)) return offset + t;
      }
      return offset + (rec?.createdAt || 0);
    };
    /* A brand-new (unrecorded) game starts from each team's CURRENT rating in
       this sport + division — the same number the Ranking page shows. Only a
       reopened saved record uses the chronological baseline below. */
    const target = snapshot;
    if (target) {
      const targetKey = snapshot
        ? rankingScopeKey(snapshot.sportName, snapshot.category)
        : scopeKey;
      const targetOrder = orderOf(target);
      const sideOf = (r) => (r.participants && r.participants.length ? r.participants : [r.teamA, r.teamB])
        .find((pp) => pp && norm(pp.name) === norm(teamName));
      const sameScope = records.filter((r) => r.id !== snapshot?.id
        && rankingScopeKey(r.sportName, r.category) === targetKey && sideOf(r));
      const earlier = sameScope
        .filter((r) => orderOf(r) < targetOrder
          // A brand-new entry (no snapshot) comes after every already-saved
          // game that shares its slot; only a reopened record is bounded by
          // its own createdAt.
          || (orderOf(r) === targetOrder && (r.createdAt || 0) <= (snapshot ? snapshot.createdAt || 0 : Infinity)))
        .sort((a, b) => orderOf(a) - orderOf(b) || (a.createdAt || 0) - (b.createdAt || 0));
      if (earlier.length) {
        const fp = sideOf(earlier[earlier.length - 1]).finalPoints;
        if (fp != null) return fp;
      }
      /* Nothing earlier: start from the team's baseline going into its very
         first recorded game here (not the live rating, which already includes
         later games). */
      // A team's first game in a scope always starts at the baseline (the
      // server replays it the same way), never a stored leftover value.
      return DEFAULT_POINTS;
    }

    /* This exact sport + division is the first choice: a rating only means
       something against the teams it was earned from. */
    const inScope = pointsInScope(scopedRankings, teamName);
    if (inScope != null) return inScope;

    /* Ratings are per sport + division: a team with no rating in this scope
       starts from the baseline, whatever it earned in other sports. */
    return DEFAULT_POINTS;
  }, [scopedRankings, records, schedules, scopeKey, lockedMatch, editingRecord, lockedRecord]);

  const entryScore = useCallback((entry) => {
    if (mode === 'points') return entry.points === '' ? null : Number(entry.points);
    return parseDuration(entry.time);
  }, [mode]);

  /* Rows ready for the maths: only entries with a team AND a valid score. */
  const rows = useMemo(() => entries.map((e) => {
    const team = effectiveTeams.find((t) => t.id === e.teamId) || null;
    const score = entryScore(e);
    return {
      id: e.id,
      entryId: e.id,
      teamId: e.teamId,
      name: team?.name || '',
      logo: team?.logo || null,
      score,
      totalViolations: e.violations.reduce((s, r) => s + (parseInt(r.count, 10) || 0), 0),
      violations: e.violations,
      comeback: !!e.comeback,
      prevPoints: team ? prevPointsFor(team.name) : DEFAULT_POINTS,
      ready: !!team && score != null && !Number.isNaN(score),
    };
  }), [entries, effectiveTeams, entryScore, prevPointsFor]);

  const readyRows = useMemo(() => rows.filter((r) => r.ready), [rows]);

  /* Equal scores in a one-on-one match are a draw unless the moderator picks
     a winner by hand. */
  const autoDraw = !isMulti && readyRows.length === 2 && readyRows[0].score === readyRows[1].score;
  const winnerOverride = winnerManual ? winnerId : (autoDraw ? 'DRAW' : null);

  const computation = useMemo(() => {
    if (readyRows.length < 2) return null;
    return buildComputation({ rows: readyRows, mode, winnerOverrideId: winnerOverride });
  }, [readyRows, mode, winnerOverride]);

  const computeById = useMemo(() => {
    const map = {};
    (computation?.teams || []).forEach((t) => { map[t.id] = t; });
    return map;
  }, [computation]);

  /* Standing is filled in from the scores unless the moderator overrode it
     with the Win/Lose radios (winnerManual). */
  useEffect(() => {
    if (winnerManual || lockedRecord) return;
    if (!computation) { setWinnerId(null); return; }
    setWinnerId(computation.winnerId);
  }, [computation, winnerManual, lockedRecord]);

  function handleSetWinner(entryId) {
    setWinnerManual(true);
    setWinnerId(entryId);
  }
  function handleSetDraw() {
    if (entries.length !== 2) return; // draws only exist in one-on-one matches
    setWinnerManual(true);
    setWinnerId('DRAW');
  }
  function handleSetLoser(entryId) {
    if (winnerId !== entryId && winnerId !== 'DRAW') return; // already a loser — nothing to do
    if (entries.length === 2) {
      const other = entries.find((e) => e.id !== entryId);
      setWinnerManual(true);
      setWinnerId(other ? other.id : null);
    } else {
      setWinnerManual(false); // hand it back to the automatic placement
      setWinnerId(null);
    }
  }

  /* ── finished match picker (1v1 only) ── */
  function applyRecordToForm(rec) {
    const list = rec.participants && rec.participants.length ? rec.participants : [rec.teamA, rec.teamB];
    const next = list.map((p) => {
      const t = effectiveTeams.find((x) => norm(x.name) === norm(p.name));
      return {
        id: uid(),
        teamId: t ? t.id : (p.id || ''),
        points: p.points != null ? String(p.points) : '',
        time: p.minutes != null ? minutesToDurationString(p.minutes) : '',
        violations: p.violations || [],
        comeback: !!p.comeback,
      };
    });
    setEntries(next);
    const winnerIdx = rec.participants && rec.participants.length
      ? list.findIndex((p) => p.place === 1)
      : (rec.winner === 'A' ? 0 : 1);
    setWinnerManual(true);
    setWinnerId(rec.winner === 'DRAW' && !(rec.participants && rec.participants.length)
      ? 'DRAW'
      : next[winnerIdx >= 0 ? winnerIdx : 0].id);
  }

  /* Point the sport/division pickers at whatever the chosen fixture says,
     so ratings are read from (and written back to) the right scope. */
  /* Looks up a fixture's own division synchronously (state set via
     selectScopeFromSchedule isn't readable until the next render). */
  function findDivisionForSchedule(s) {
    const sport = effectiveSports.find((x) => norm(x.name) === norm(s.sport));
    if (!sport) return null;
    const divs = buildDivisionOptionsForSport(sport);
    return divs.find((d) => categoriesMatch(d.category, s.category))
      || divs.find((d) => categoriesMatch(s.category, d.category))
      || null;
  }

  function selectScopeFromSchedule(s) {
    const sport = effectiveSports.find((x) => norm(x.name) === norm(s.sport));
    if (!sport) return;
    setSportId(sport.id);
    const div = findDivisionForSchedule(s);
    setDivisionKey(div ? div.key : '');
  }

  function handlePickFinishedMatch(s) {
    selectScopeFromSchedule(s);
    setLockedMatch(s);
    setLockedRecord(null);

    /* Already recorded → reopen that same record for editing rather than
       starting a second one. Confirming overwrites it (same record id), so
       one fixture can never produce two results. */
    const rec = findRecordForSchedule(s);
    if (rec) {
      const savedFormat = formatById(rec.formatId)
        || FORMAT_CHOICES.find((f) => !f.multi && f.mode === (rec.mode || 'points'));
      if (savedFormat) setFormatId(savedFormat.id);
      setEditingRecord(rec);
      applyRecordToForm(rec);
      setFormatPickerOpen(false);
      setFormatPickerFor(null);
      return;
    }

    /* Not recorded yet. If the admin already set a format for this
       fixture's division in Sports & Teams, use it straight away instead
       of asking the moderator to re-pick something already decided.
       Falls back to the "how was this played?" picker only when the
       division has no format configured. */
    setEditingRecord(null);
    const div = findDivisionForSchedule(s);
    const autoId = div?.format ? choiceIdForDivisionFormat(div.format) : null;

    /* A race is always many teams at once, so it can only use a 1-vs-many
       format: the division's own if it has one, else time-based (races are
       normally timed). No format picker — nothing left to decide. */
    if (isRaceMatch(s)) {
      applyFormat(formatById(autoId)?.multi ? autoId : 'many-time', s);
      return;
    }
    /* A head-to-head fixture (e.g. a requested 1v1 rematch in a race
       division) is only ever these two teams: keep the division's scoring
       mode but use the 1V1 layout, not four panels with blank extra slots. */
    const autoFormat = formatById(autoId);
    const pairId = autoFormat?.multi ? (autoFormat.mode === 'time' ? '1v1-time' : '1v1-points') : autoId;
    if (pairId && applyFormat(pairId, s)) return;

    setEntries([
      { ...mkEntry(), teamId: teamIdByName(s.teamA) },
      { ...mkEntry(), teamId: teamIdByName(s.teamB) },
    ]);
    setWinnerId(null);
    setWinnerManual(false);
    setFormatPickerFor(s);
    setFormatPickerOpen(true);
  }

  /* ── validation + update ── */
  function handleUpdateClick() {
    /* Year Level only applies to a manual (no-fixture) record — a match
       that came from (or once came from) a real schedule entry already has
       its own division and no notion of a single grade/year. */
    const isManualEntry = !lockedMatch && !editingRecord?.scheduleId;

    const reasons = [];
    if (!formatChoice) reasons.push('Choose a sports format first.');
    if (!selectedSport) reasons.push('Select a sport.');
    if (selectedSport && divisionRequired && !selectedDivision && !activeSport) reasons.push('Select a division.');
    if (isManualEntry && !yearLevel) reasons.push('Select a year level.');

    entries.forEach((e, i) => {
      const row = rows.find((r) => r.id === e.id);
      if (!row?.name) reasons.push(`Select team ${i + 1}.`);
      else if (row.score == null || Number.isNaN(row.score)) {
        reasons.push(mode === 'points'
          ? `Enter a valid points score for ${row.name}.`
          : `Enter a valid time duration for ${row.name} (HH:MM:SS).`);
      }
    });

    const names = rows.filter((r) => r.name).map((r) => norm(r.name));
    if (new Set(names).size !== names.length) reasons.push('Each team can only be entered once.');

    if (reasons.length === 0 && computation) {
      const best = computation.teams.filter((t) => t.place === 1);
      const tiedTop = computation.teams.filter((t) => t.score === best[0].score);
      if (tiedTop.length > 1 && !winnerManual && !autoDraw) {
        reasons.push(isMulti
          ? 'The top scores are tied — set the winner with the Win/Lose buttons, or correct the scores.'
          : 'The scores are tied — choose Draw, set the winner with the Win/Lose buttons, or correct the scores.');
      }
      if (winnerManual && winnerId === 'DRAW' && computation.teams.length === 2
        && computation.teams[0].score !== computation.teams[1].score) {
        reasons.push('A draw needs equal scores — correct the scores, or set a winner instead.');
      }
    }

    if (reasons.length) { setInvalidReasons(reasons); return; }

    const comp = buildComputation({ rows: readyRows, mode, winnerOverrideId: winnerOverride });

    setPending({
      mode,
      multi: isMulti,
      formatId,
      scheduleId: lockedMatch?.id || null,
      formatLabel: formatHeadline(formatChoice),
      sportId: activeSport.sportId,
      sportName: activeSport.sportName,
      category: activeSport.category,
      format: activeSport.format,
      yearLevel: isManualEntry ? yearLevel : (editingRecord?.yearLevel ?? null),
      teams: comp.teams,
      winnerId: comp.winnerId,
      // Captured here (not re-read from state in handleConfirm) so the
      // Cloud Function's own buildComputation run is given the exact same
      // input that produced this preview.
      winnerOverrideId: winnerOverride,
    });
  }

  async function handleConfirm() {
    if (!pending) return;
    setSaving(true);

    const { teams: cTeams } = pending;
    // Raw inputs only — no prevPoints/change/finalPoints. The Cloud Function
    // looks prevPoints up itself from teamRankings/{level} and recomputes
    // everything from scratch; it never trusts a client-computed rating.
    const rowsPayload = cTeams.map((t) => ({
      id: t.id,
      teamId: t.teamId || null,
      name: t.name,
      logo: t.logo || null,
      score: t.score,
      totalViolations: t.totalViolations,
      violations: t.violations || [],
      comeback: !!t.comeback,
    }));

    try {
      const { record, records, rankings } = await submitMatchRecord({
        level,
        recordId: editingRecord?.id || null,
        scheduleId: pending.scheduleId || editingRecord?.scheduleId || null,
        mode: pending.mode,
        multi: pending.multi,
        formatId: pending.formatId,
        sportId: pending.sportId,
        sportName: pending.sportName,
        category: pending.category,
        format: pending.format,
        yearLevel: pending.yearLevel || null,
        winnerOverrideId: pending.winnerOverrideId,
        rows: rowsPayload,
        createdAt: editingRecord?.createdAt || null,
      });

      setRecords(records);
      setRankings(rankings);
      setPending(null);
      setSuccessRecord(record);
      resetForm(entries.length);
    } catch (err) {
      console.error(err);
      setInvalidReasons([friendlyFirestoreError(err, 'Something went wrong while saving')]);
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  /* ── summary table ── */
  const filteredRecords = useMemo(() => {
    if (!formatFilter) return records;
    return records.filter((r) => bucketForFormat(r.format) === formatFilter);
  }, [records, formatFilter]);

  function startEdit(record) {
    setEditingId(record.id);
    setEditDraft({
      teamAId: record.teamA.id,
      teamBId: record.teamB.id,
      totalViolationsA: record.teamA.totalViolations,
      totalViolationsB: record.teamB.totalViolations,
      minutesA: record.teamA.minutes ?? '',
      minutesB: record.teamB.minutes ?? '',
      pointsA: record.teamA.points ?? '',
      pointsB: record.teamB.points ?? '',
      comebackA: !!record.teamA.comeback,
      comebackB: !!record.teamB.comeback,
    });
  }

  /* Multi-team records go back into the main form (there's no sensible
     single-row inline editor for four teams) — the same record id is kept
     so confirming overwrites it instead of creating a duplicate. */
  function loadRecordIntoForm(record) {
    const choice = FORMAT_CHOICES.find((f) => f.id === record.formatId)
      || FORMAT_CHOICES.find((f) => f.mode === record.mode && !!f.multi === !!record.multi)
      || FORMAT_CHOICES[0];
    setFormatId(choice.id);
    setFormatPickerOpen(false);

    const sport = effectiveSports.find((s) => norm(s.name) === norm(record.sportName));
    if (sport) {
      setSportId(sport.id);
      const divs = buildDivisionOptionsForSport(sport);
      const div = divs.find((d) => categoriesMatch(d.category, record.category));
      setDivisionKey(div ? div.key : '');
    }

    setEditingRecord(record);
    setLockedMatch(null);
    setLockedRecord(null);
    setYearLevel(record.yearLevel || '');
    applyRecordToForm(record);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveEdit(record) {
    if (savingEditId) return; // guards against a fast double-click firing two concurrent saves
    setSavingEditId(record.id);
    try {
      await saveEditInner(record);
    } finally {
      setSavingEditId(null);
    }
  }

  async function saveEditInner(record) {
    const teamAObj = effectiveTeams.find((t) => t.id === editDraft.teamAId) || { id: record.teamA.id, name: record.teamA.name, logo: record.teamA.logo };
    const teamBObj = effectiveTeams.find((t) => t.id === editDraft.teamBId) || { id: record.teamB.id, name: record.teamB.name, logo: record.teamB.logo };

    // Identity/display fields (team id/name/logo) are trusted from the
    // client same as before — the Cloud Function only ever recomputes
    // finalPoints itself from record.teamA/teamB.prevPoints (already
    // authoritative, since it was written by the server) plus these edited
    // violations/score inputs, never accepting a finalPoints value as-is.
    const { record: updated, records, rankings } = await editMatchRecord({
      level,
      recordId: record.id,
      teamA: { id: teamAObj.id, name: teamAObj.name, logo: teamAObj.logo || null },
      teamB: { id: teamBObj.id, name: teamBObj.name, logo: teamBObj.logo || null },
      totalViolationsA: editDraft.totalViolationsA,
      totalViolationsB: editDraft.totalViolationsB,
      pointsA: editDraft.pointsA,
      pointsB: editDraft.pointsB,
      minutesA: editDraft.minutesA,
      minutesB: editDraft.minutesB,
      comebackA: editDraft.comebackA,
      comebackB: editDraft.comebackB,
    });

    setRecords(records);
    setRankings(rankings);

    setEditingId(null);
    setEditDraft(null);
    setFlashId(updated.id);
    setTimeout(() => setFlashId(null), 1100);
  }

  /* ── derived display bits ── */
  // The teams of a race come from its schedule: they can't be swapped, added or removed here.
  const raceLocked = !!lockedMatch && isRaceMatch(lockedMatch);
  const levelLabel = LEVELS.find((l) => l.key === level)?.label || level;
  const sportSuggestedMode = activeSport ? scoringModeForSport(activeSport.sportName) : null;
  const modeMismatch = !!(formatChoice && sportSuggestedMode && sportSuggestedMode !== mode);

  const violEntry = entries.find((e) => e.id === violModal) || null;
  const violTeam = violEntry ? effectiveTeams.find((t) => t.id === violEntry.teamId) : null;

  /* Opponent summary shown inside each panel. */
  function opponentInfoFor(entry) {
    const others = rows.filter((r) => r.id !== entry.id);
    const named = others.filter((r) => r.name);
    if (!isMulti) {
      const o = others[0];
      return {
        label: o?.name || '',
        rating: o?.name ? o.prevPoints : null,
        scoreText: o && o.score != null && !Number.isNaN(o.score)
          ? (mode === 'points' ? `${o.score} points` : minutesToDurationString(o.score))
          : '',
      };
    }
    const withScores = others.filter((r) => r.score != null && !Number.isNaN(r.score));
    const avgRating = named.length ? named.reduce((s, r) => s + r.prevPoints, 0) / named.length : null;
    const avgScore = withScores.length ? withScores.reduce((s, r) => s + r.score, 0) / withScores.length : null;
    return {
      label: named.length ? named.map((r) => r.name).join(', ') : '',
      rating: avgRating,
      scoreText: avgScore == null ? '' : (mode === 'points' ? `${Number(avgScore.toFixed(2))} points` : minutesToDurationString(avgScore)),
    };
  }

  return (
    <div className="mp-page">
      <header className="mp-header">
        <h1 className="mp-header__title">{schoolName}</h1>
      </header>

      <div className="mp-body">
        <div className="mp-intro" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h2 className="mp-intro__title">Update match records</h2>
            {formatChoice && (
              <div className="mp-format-chip">
                <span className="mp-format-chip__label">{formatHeadline(formatChoice)}</span>
              </div>
            )}
          </div>
          <button type="button" className="mp-btn mp-btn--navy" onClick={openRequestModal} style={{ flexShrink: 0 }}>
            <FaPaperPlane /> Request a schedule
          </button>
        </div>

        {loadError && (
          <p className="mp-schedule-hint mp-schedule-hint--empty">
            <FaExclamationTriangle /> {loadError}
          </p>
        )}

        {listedMatches.length > 0 && (
          <div className="mp-finished-panel">
            <div className="mp-finished-panel__head">
              <div>
                <div className="mp-finished-panel__title">Match schedules</div>
                <p
                  className="mp-finished-panel__sub"
                  style={{ margin: '2px 0 0', fontSize: '0.72rem', opacity: 0.7, fontWeight: 500 }}
                >
                  Every scheduled matchup, in any sport or division. Mark a match as finished, then pick it and its sport, division, and both teams fill in automatically.
                </p>
              </div>
            </div>
            <div className="mp-fs-row">
              {[
                ['Sport', fSport, (v) => { setFSport(v); setFCategory(''); setFDivision(''); }, filterOptions.sports, 'All Sports'],
                ['Category', fCategory, (v) => { setFCategory(v); setFDivision(''); }, filterOptions.categories, 'All Categories'],
                ['Division', fDivision, setFDivision, filterOptions.divisions, 'All Divisions'],
              ].map(([label, value, onChange, options, allLabel]) => (
                <div className="mp-fs-group" key={label}>
                  <span className="mp-fs-label">{label}</span>
                  <FilterSelect
                    value={value}
                    onChange={onChange}
                    options={options}
                    allLabel={allLabel}
                    disabled={options.length === 0}
                  />
                </div>
              ))}
            </div>
            {shownMatches.length === 0 && (
              <p className="mp-schedule-hint mp-schedule-hint--empty">No matches for this filter.</p>
            )}
            <div className="mp-finished-panel__list">
              {shownMatches.map((s) => {
                const active = lockedMatch?.id === s.id;
                const done = isMatchRecorded(s);
                return (
                  <div className="mp-finished-item" key={s.id}>
                  <button
                    type="button"
                    className={`mp-finished-card ${active ? 'mp-finished-card--active' : ''} ${done ? 'mp-finished-card--done' : ''} ${s.canRecord ? '' : 'mp-finished-card--pending'}`}
                    onClick={() => handlePickFinishedMatch(s)}
                    disabled={!s.canRecord}
                  >
                    <div className="mp-finished-card__sport">
                      <span style={{ opacity: 0.65 }}>{s.sport}{scheduleDivisionLabel(s, sports) ? ` · ${scheduleDivisionLabel(s, sports)}` : ''}{s.format ? ` · ${s.format}` : ''}</span>
                      <span
                        className="mp-finished-card__status-pill"
                        style={{
                          background: MATCH_STATUS_COLOR[s.status].bg,
                          color: MATCH_STATUS_COLOR[s.status].fg,
                        }}
                      >
                        {MATCH_STATUS_LABEL[s.status]}
                      </span>
                    </div>
                    <div className="mp-finished-card__teams">
                      {isRaceMatch(s) ? (
                        <>
                          {raceParticipants(s).slice(0, 4).map((p, i) => (
                            <span className="mp-finished-card__logo" key={`${p.name}-${i}`}>
                              {p.logo ? <img src={p.logo} alt="" /> : initials(p.name)}
                            </span>
                          ))}
                          {raceParticipants(s).length > 4 && (
                            <span className="mp-finished-card__vs">+{raceParticipants(s).length - 4}</span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="mp-finished-card__logo">
                            {s.teamALogo ? <img src={s.teamALogo} alt="" /> : initials(s.teamA)}
                          </span>
                          <span className="mp-finished-card__vs">vs</span>
                          <span className="mp-finished-card__logo">
                            {s.teamBLogo ? <img src={s.teamBLogo} alt="" /> : initials(s.teamB)}
                          </span>
                        </>
                      )}
                    </div>
                    {((s.stage || s.round != null) || s.matchLabel) && (
                      <div className="mp-finished-card__pills">
                        {(s.stage || s.round != null) && (
                          <span className="mp-finished-card__label-pill">
                            {isRaceMatch(s) ? `Race · ${raceParticipants(s).length} teams` : (s.stage || `Round ${s.round}`)}
                          </span>
                        )}
                        {s.matchLabel && (
                          <span className="mp-finished-card__label-pill">
                            {s.matchLabel}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mp-finished-card__names">
                      {isRaceMatch(s)
                        ? raceParticipants(s).map((p) => p.name).join(', ')
                        : <>{s.teamA} <span>vs</span> {s.teamB}</>}
                    </div>
                    <div className="mp-finished-card__meta">
                      {s.date || s.time
                        ? `${s.date || ''}${s.date && s.time ? ' · ' : ''}${s.time || ''}`
                        : (s.stage || (s.round != null ? (isRaceMatch(s) ? 'Race' : `Round ${s.round}`) : 'Date to be set'))}
                    </div>
                    {done ? (
                      <div className="mp-finished-card__status"><FaEdit /> Recorded — click to edit</div>
                    ) : active ? (
                      <div className="mp-finished-card__status mp-finished-card__status--active"><FaLock /> Selected</div>
                    ) : null}
                  </button>
                  {!s.canRecord && (
                    <button
                      type="button"
                      className="mp-finished-item__mark"
                      onClick={() => handleMarkFinished(s)}
                      disabled={markingId === s.id}
                    >
                      <FaCheck /> {markingId === s.id ? 'Saving…' : 'Mark as finished'}
                    </button>
                  )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mp-header-divider" />

        <LevelTabs
          levels={LEVELS}
          value={level}
          onChange={setLevel}
          containerClassName="mp-levelband__tabs"
          tabClassName="mp-levelband__tab"
          activeClassName="mp-levelband__tab--active"
          wrapperClassName="mp-levelband"
        />

        {/* Nothing renders below the level band until a match is chosen —
            the schedule list above is the whole interface at this point.
            The only exception is a level with no schedules at all, where a
            blank page would just look broken. Gating on recordableMatches
            here too (not just formatChoice) means a format left over from a
            previous level tab can never show this form on a level that has
            no finished matches of its own — the moderator records what the
            admin scheduled and finished, nothing more. */}
        {!(formatChoice && recordableMatches.length > 0) ? (
          scheduledMatches.length === 0 && (
            <div className="mp-card mp-card--empty">
              <h3 className="mp-card__title">No matches scheduled yet</h3>
              <p className="mp-card__sub">
                Once an admin saves a schedule for this level it appears here, ready to record — or ask them to arrange one.
              </p>
              <button type="button" className="mp-btn mp-btn--update" onClick={openRequestModal}>
                <FaPaperPlane /> Request a schedule
              </button>
            </div>
          )
        ) : (
          <>
            <div className="mp-card">
              <h3 className="mp-card__title">Update match record</h3>
              <p className="mp-card__sub">
                {isMulti
                  ? 'Fill in the required details for every team in this event.'
                  : 'Fill in the required details for both teams.'}
              </p>

              {usingScheduleFallback && (
                <p className="mp-schedule-hint">
                  <FaExclamationTriangle /> Sports &amp; Teams hasn't been (re)configured for this level — showing the sports, divisions, and teams found in existing schedules instead. Ask the admin to check the Sports &amp; Teams page.
                </p>
              )}
              {/* Makes an empty "Select team" dropdown self-explanatory instead of
                  silently showing nothing. This fires when Sports & Teams has zero
                  teams saved for the CURRENT level — almost always because the team
                  was created while Admin had a different level tab active (teams are
                  stored per level, so a College team is invisible while viewing High
                  School, and vice versa). */}
              {activeSport && teamOptionsForSport.length === 0 && (
                <p className="mp-schedule-hint mp-schedule-hint--empty">
                  <FaExclamationTriangle /> No teams found for <strong>{LEVELS.find(l => l.key === level)?.label}</strong> in Sports &amp; Teams.
                  If the admin already added this team, double-check it was saved under the <strong>{LEVELS.find(l => l.key === level)?.label}</strong> level tab — teams are scoped per level and won't appear under a different one.
                </p>
              )}
              {modeMismatch && (
                <p className="mp-schedule-hint">
                  <FaInfo /> {activeSport.sportName} is normally scored by {sportSuggestedMode === 'points' ? 'points' : 'time'}, but you chose a {mode === 'points' ? 'points' : 'time'}-based format. The form follows your format choice.
                </p>
              )}
              {!isMulti && activeSport && hasScheduleForSelection && readyTeamNames.size === 0 && (
                <p className="mp-schedule-hint mp-schedule-hint--empty">
                  <FaExclamationTriangle /> No matches for this division have finished yet — the admin has scheduled some, but they're upcoming or still in progress.
                </p>
              )}
              {activeSport && !hasScheduleForSelection && (
                <p className="mp-schedule-hint">
                  <FaInfo /> The admin hasn't scheduled any matches for this division yet — showing all registered teams for now.
                </p>
              )}
              {lockedRecord && (
                <p className="mp-schedule-hint mp-schedule-hint--locked">
                  <FaLock /> This match is already recorded — shown here read-only. To change any details, edit it in the summary table below.
                </p>
              )}
              {editingRecord && (
                <p className="mp-schedule-hint mp-schedule-hint--locked">
                  <FaEdit /> Re-computing a saved record. Confirming will overwrite it and its ranking points.
                  <button type="button" className="mp-schedule-hint__edit-link" onClick={() => resetForm()}>
                    Cancel edit
                  </button>
                </p>
              )}

              <div className={isMulti ? 'mp-multi-grid' : 'mp-matchup'}>
                {entries.map((entry, i) => {
                  const opp = opponentInfoFor(entry, i);
                  const row = rows.find((r) => r.id === entry.id);
                  const panel = (
                    <MatchPanel
                      key={entry.id}
                      entry={entry}
                      index={i}
                      mode={mode}
                      multi={isMulti}
                      teamLabel={isMulti ? `Team ${i + 1}` : `Team ${i + 1}`}
                      teamOptions={teamOptionsForSport}
                      onChange={(patch) => updateEntry(entry.id, patch)}
                      onOpenViolations={() => setViolModal(entry.id)}
                      onRemove={() => removeEntry(entry.id)}
                      canRemove={isMulti && !raceLocked && entries.length > MIN_MULTI_TEAMS}
                      prevPoints={row ? row.prevPoints : DEFAULT_POINTS}
                      compute={computeById[entry.id] || null}
                      opponentLabel={opp.label}
                      opponentRating={opp.rating}
                      opponentScoreText={opp.scoreText}
                      isWinner={winnerId === entry.id}
                      hasWinner={!!winnerId}
                      isDraw={winnerId === 'DRAW'}
                      onSetDraw={handleSetDraw}
                      onSetWinner={() => handleSetWinner(entry.id)}
                      onSetLoser={() => handleSetLoser(entry.id)}
                      readOnly={!!lockedRecord}
                      teamLocked={(!isMulti && !!lockedMatch) || raceLocked}
                    />
                  );
                  if (isMulti) return panel;
                  return (
                    <Fragment key={`slot-${entry.id}`}>
                      {i > 0 && <div className="mp-vs">VS</div>}
                      {panel}
                    </Fragment>
                  );
                })}
              </div>

              {isMulti && (
                <div className="mp-multi-actions">
                  <button
                    type="button"
                    className="mp-btn mp-btn--navy"
                    onClick={addEntry}
                    disabled={entries.length >= MAX_MULTI_TEAMS || !!lockedRecord || raceLocked}
                  >
                    <FaPlus /> Add team ({entries.length}/{MAX_MULTI_TEAMS})
                  </button>
                  <span className="mp-multi-actions__hint">
                    {raceLocked
                      ? `All ${entries.length} teams in this race come from its schedule. Enter each team's result — 1st place is the champion.`
                      : "Every team is rated against every other team, and the changes are added up."}
                  </span>
                </div>
              )}

              <div className="mp-update-row">
                <button type="button" className="mp-btn mp-btn--reset" onClick={handleResetClick}><FaSync /> Reset</button>
                <button type="button" className="mp-btn mp-btn--update" onClick={handleUpdateClick} disabled={!!lockedRecord}>Update</button>
              </div>
            </div>
          </>
        )}

        {/* ── Updated match summary ── */}
        <div className="mp-summary" ref={summaryRef}>
          <div className="mp-summary__head">
            <h3 className="mp-summary__title"><FaUsers className="mp-summary__title-icon" /> Updated match summary</h3>
            <button
              type="button"
              className="mp-summary__recalc"
              onClick={handleRecalculate}
              disabled={recalculating || records.length === 0}
              title="Rebuild every team's rating from the saved match records, starting from 1200"
            >
              <FaSync className={recalculating ? 'mp-spin' : ''} /> {recalculating ? 'Recalculating…' : 'Recalculate ratings'}
            </button>
            <div className="mp-summary__count">
              <div className="mp-summary__count-label">Total match complete</div>
              <div className="mp-summary__count-num">{records.length}</div>
            </div>
          </div>

          <div className="mp-summary__filter">
            <div className="mp-summary__filter-label">Game format</div>
            <OptionDropdown
              variant="navy" panelLabel="Select game format" placeholder="Select game format"
              value={formatFilter}
              options={[{ key: '', label: 'All formats' }, ...GAME_FORMATS.map((f) => ({ key: f.id, label: f.label }))]}
              onChange={setFormatFilter}
            />
          </div>

          <div className="mp-table-wrap">
            <table className="mp-table">
              <thead>
                <tr>
                  <th>Sports</th>
                  <th>Team</th>
                  <th className="mp-th-center">Violation</th>
                  <th>Duration / Score</th>
                  <th>Final points <InfoTip caption="Final points info" placement="bottom">Final points = Previous rating + K(S − E) + Ppu(team score/time performance − violations + comeback bonus). E is the Elo expected score from both teams' ratings, S is 1 for a win / 0 for a loss, K = {K_FACTOR}, Ppu = {PPU}, and the comeback bonus is +{COMEBACK_BONUS}. New teams start at {DEFAULT_POINTS}.</InfoTip></th>
                  <th className="mp-th-center" style={{ width: 60 }}>Edit</th>
                </tr>
              </thead>
              <tbody>
                {!loading && filteredRecords.length === 0 && (
                  <tr><td colSpan={6} className="mp-table__empty">No match records yet — update one above to see it here.</td></tr>
                )}
                {filteredRecords.map((r) => {
                  const rowIsPoints = r.mode === 'points' || r.teamA.points != null;
                  const rowIsMulti = !!r.multi && (r.participants || []).length > 2;

                  if (rowIsMulti) {
                    return (
                      <tr key={r.id} className={flashId === r.id ? 'mp-row-flash' : ''}>
                        <td data-label="Sports">{displayCategory(r.label || r.sportName || '').toUpperCase()} <span className="mp-tag-multi">1 vs many</span></td>
                        <td data-label="Team">
                          <div className="mp-team-cell">
                            {r.participants.map((p, i) => (
                              <Fragment key={p.id || i}>
                                {i > 0 && <span className="mp-team-cell__vs">·</span>}
                                <span className="mp-team-cell__side"><EditTeamLogo team={p} />{p.name}</span>
                              </Fragment>
                            ))}
                          </div>
                        </td>
                        <td className="mp-td-center" data-label="Violation">{r.participants.map((p) => p.totalViolations).join('-')}</td>
                        <td data-label="Duration / Score">
                          {rowIsPoints
                            ? r.participants.map((p) => `${p.points}`).join(' - ') + ' pts'
                            : r.participants.map((p) => minutesToDurationString(p.minutes)).join(' - ')}
                        </td>
                        <td className="mp-table__points" data-label="Final Points">{r.participants.map((p) => fmtPts(p.finalPoints)).join(' - ')}</td>
                        <td className="mp-td-center" data-label="Edit">
                          <button className="mp-table__edit-btn" onClick={() => loadRecordIntoForm(r)} aria-label="Edit"><FaEdit /></button>
                        </td>
                      </tr>
                    );
                  }

                  const editPreview = editingId === r.id ? computeEditFinalPoints(r, editDraft, rowIsPoints) : null;
                  // Teams currently picked in the edit row (falls back to the saved record's team),
                  // so each input can carry its team's logo and it's clear whose value it is.
                  const editTeamA = editingId === r.id ? (effectiveTeams.find((t) => t.id === editDraft.teamAId) || r.teamA) : null;
                  const editTeamB = editingId === r.id ? (effectiveTeams.find((t) => t.id === editDraft.teamBId) || r.teamB) : null;
                  return editingId === r.id ? (
                    <tr className="mp-edit-row" key={r.id}>
                      <td data-label="Sports">{displayCategory(r.label || r.sportName || '').toUpperCase()}</td>
                      <td data-label="Team">
                        <div className="mp-edit-form">
                          <div className="mp-edit-side">
                            <EditTeamLogo team={editTeamA} />
                            <div className="mp-edit-side__col">
                              <div className="mp-edit-team-select">
                                <OptionDropdown
                                  variant="teams"
                                  value={editDraft.teamAId}
                                  options={editTeamOptions}
                                  onChange={(key) => setEditDraft((d) => ({ ...d, teamAId: key }))}
                                />
                              </div>
                              <ComebackToggle
                                on={!!editDraft.comebackA}
                                canApply={editPreview.winner === 'A'}
                                onToggle={() => setEditDraft((d) => ({ ...d, comebackA: !d.comebackA }))}
                              />
                            </div>
                          </div>
                          <span className="mp-vs-mini">vs</span>
                          <div className="mp-edit-side">
                            <EditTeamLogo team={editTeamB} />
                            <div className="mp-edit-side__col">
                              <div className="mp-edit-team-select">
                                <OptionDropdown
                                  variant="teams"
                                  value={editDraft.teamBId}
                                  options={editTeamOptions}
                                  onChange={(key) => setEditDraft((d) => ({ ...d, teamBId: key }))}
                                />
                              </div>
                              <ComebackToggle
                                on={!!editDraft.comebackB}
                                canApply={editPreview.winner === 'B'}
                                onToggle={() => setEditDraft((d) => ({ ...d, comebackB: !d.comebackB }))}
                              />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="mp-td-center" data-label="Violation">
                        <div className="mp-edit-form">
                          <div className="mp-edit-form__score">
                            <EditTeamLogo team={editTeamA} />
                            <input type="number" min="0" value={editDraft.totalViolationsA} onChange={(e) => setEditDraft((d) => ({ ...d, totalViolationsA: e.target.value }))} />
                            <span className="mp-vs-mini">-</span>
                            <input type="number" min="0" value={editDraft.totalViolationsB} onChange={(e) => setEditDraft((d) => ({ ...d, totalViolationsB: e.target.value }))} />
                            <EditTeamLogo team={editTeamB} />
                          </div>
                        </div>
                      </td>
                      <td data-label="Duration / Score">
                        <div className="mp-edit-form">
                          {rowIsPoints ? (
                            <div className="mp-edit-form__score">
                              <EditTeamLogo team={editTeamA} />
                              <input className="mp-edit-time" type="number" min="0" placeholder="pts" value={editDraft.pointsA} onChange={(e) => setEditDraft((d) => ({ ...d, pointsA: e.target.value }))} />
                              <span className="mp-vs-mini">-</span>
                              <input className="mp-edit-time" type="number" min="0" placeholder="pts" value={editDraft.pointsB} onChange={(e) => setEditDraft((d) => ({ ...d, pointsB: e.target.value }))} />
                              <EditTeamLogo team={editTeamB} />
                            </div>
                          ) : (
                            <div className="mp-edit-form__score">
                              <EditTeamLogo team={editTeamA} />
                              <input className="mp-edit-time" type="text" placeholder="mins" value={editDraft.minutesA} onChange={(e) => setEditDraft((d) => ({ ...d, minutesA: e.target.value }))} />
                              <span className="mp-vs-mini">-</span>
                              <input className="mp-edit-time" type="text" placeholder="mins" value={editDraft.minutesB} onChange={(e) => setEditDraft((d) => ({ ...d, minutesB: e.target.value }))} />
                              <EditTeamLogo team={editTeamB} />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="mp-table__points" data-label="Final Points">
                        <div className="mp-edit-form__score mp-edit-form__score--auto" title="Recalculated automatically from violations/score above">
                          <EditTeamLogo team={editTeamA} />
                          <span>{fmtPts(editPreview.finalPointsA)}</span>
                          <span className="mp-vs-mini">-</span>
                          <span>{fmtPts(editPreview.finalPointsB)}</span>
                          <EditTeamLogo team={editTeamB} />
                        </div>
                      </td>
                      <td className="mp-td-center" data-label="Edit">
                        <div className="mp-edit-form__actions">
                          <button className="mp-edit-form__save" onClick={() => saveEdit(r)} disabled={savingEditId === r.id}>
                            {savingEditId === r.id ? 'Saving…' : 'Save'}
                          </button>
                          <button className="mp-edit-form__cancel" onClick={() => { setEditingId(null); setEditDraft(null); }} disabled={savingEditId === r.id}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.id} className={flashId === r.id ? 'mp-row-flash' : ''}>
                      <td data-label="Sports">{displayCategory(r.label || r.sportName || '').toUpperCase()}</td>
                      <td data-label="Team">
                        <div className="mp-team-cell">
                          <span className="mp-team-cell__side"><EditTeamLogo team={r.teamA} />{r.teamA.name}</span>
                          <span className="mp-team-cell__vs">vs</span>
                          <span className="mp-team-cell__side"><EditTeamLogo team={r.teamB} />{r.teamB.name}</span>
                        </div>
                      </td>
                      <td className="mp-td-center" data-label="Violation">{(r.teamA.totalViolations || r.teamB.totalViolations) ? `${r.teamA.totalViolations}-${r.teamB.totalViolations}` : '--'}</td>
                      <td data-label="Duration / Score">{rowIsPoints ? (r.teamA.points != null ? `${r.teamA.points} - ${r.teamB.points} pts` : '--') : (r.teamA.minutes != null ? `${minutesToDurationString(r.teamA.minutes)} - ${minutesToDurationString(r.teamB.minutes)}` : '--')}</td>
                      <td className="mp-table__points" data-label="Final Points">{fmtPts(r.teamA.finalPoints)} - {fmtPts(r.teamB.finalPoints)}</td>
                      <td className="mp-td-center" data-label="Edit"><button className="mp-table__edit-btn" onClick={() => startEdit(r)} aria-label="Edit"><FaEdit /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {formatPickerOpen && (
        <FormatPickerModal
          current={formatId}
          match={formatPickerFor}
          suggestedId={formatPickerFor
            ? (scoringModeForSport(formatPickerFor.sport) === 'time' ? '1v1-time' : '1v1-points')
            : null}
          onChoose={handleChooseFormat}
          onClose={() => { setFormatPickerOpen(false); setFormatPickerFor(null); }}
        />
      )}

      {violEntry && (
        <ViolationsModal
          sideLabel={`Team ${entries.findIndex((e) => e.id === violEntry.id) + 1}`}
          teamLabel={violTeam?.name || 'Select a team'}
          teamLogo={violTeam?.logo}
          initialRows={violEntry.violations}
          violationOptions={selectedSport?.violations || []}
          onClose={() => setViolModal(null)}
          onSubmit={(rowsIn) => { updateEntry(violEntry.id, { violations: rowsIn }); setViolModal(null); }}
        />
      )}

      {pending && (
        <ConfirmModal
          pending={pending}
          levelLabel={levelLabel}
          saving={saving}
          onCancel={() => setPending(null)}
          onConfirm={handleConfirm}
        />
      )}

      {successRecord && (
        <SuccessModal
          record={successRecord}
          onClose={() => setSuccessRecord(null)}
          onViewRanking={() => { setSuccessRecord(null); navigate('/ranking'); }}
        />
      )}

      {invalidReasons && (
        <InvalidModal reasons={invalidReasons} onClose={() => setInvalidReasons(null)} />
      )}

      {resetConfirmOpen && (
        <ResetConfirmModal
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => { resetInputs(); setResetConfirmOpen(false); }}
        />
      )}

      {requestModalOpen && (
        <RequestScheduleModal
          onClose={() => setRequestModalOpen(false)}
          onSubmit={handleSendScheduleRequest}
          submitting={requestSubmitting}
          sportOptions={requestSportOptions}
          sportId={requestSportId}
          onSportChange={(id) => { setRequestSportId(id); setRequestDivisionKey(''); setRequestTeamAId(''); setRequestTeamBId(''); setRequestExtraTeamIds([]); }}
          divisionOptions={requestDivisionOptions}
          divisionKey={requestDivisionKey}
          onDivisionChange={setRequestDivisionKey}
          divisionRequired={requestDivisionRequired}
          levelOptions={LEVELS}
          requestLevel={requestLevel}
          onLevelChange={(k) => { setRequestLevel(k); setRequestSportId(''); setRequestDivisionKey(''); setRequestTeamAId(''); setRequestTeamBId(''); setRequestExtraTeamIds([]); }}
          teamOptions={requestTeamOptions}
          teamAId={requestTeamAId}
          teamBId={requestTeamBId}
          extraTeamIds={requestExtraTeamIds}
          onExtraTeamsChange={setRequestExtraTeamIds}
          onTeamAChange={setRequestTeamAId}
          onTeamBChange={setRequestTeamBId}
          reason={requestReason}
          onReasonChange={setRequestReason}
          myRequests={myScheduleRequests}
        />
      )}

      {requestToast && (
        <div className="mp-toast" style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#1c2540', color: '#fff', padding: '10px 18px', borderRadius: 10,
          fontSize: '0.85rem', fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', zIndex: 9999,
        }}>
          {requestToast.text}
        </div>
      )}
    </div>
  );
}
