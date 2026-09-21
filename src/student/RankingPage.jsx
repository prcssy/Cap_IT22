import React, { useState, useMemo, useEffect, useRef, useContext } from 'react';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import './RankingPage.css';
import { FaSearch, FaCrown, FaMedal, FaChevronDown } from 'react-icons/fa';
import Contact from '../public/Landing/Contact/Contact';
import LevelTabs from '../shared/components/LevelTabs';
import { useLockedLevel } from '../shared/utils/schoolLevel';
import { getSportsTeamsConfig, getTeamRankings, getMatchRecords, getMatchSchedules } from '../shared/services/firestoreService';
import { applyPointDifferentialTieBreakers } from '../shared/utils/tieBreakers';

/* ── Sport filter tabs (shared by both tables) ──
   The actual sport names are derived from the same team.sportIds data used
   by TeamAndSportsPage, so unused hard-coded sports never appear here. */
const DEFAULT_POINTS = 1200; // must match Moderator's baseline rating for a brand-new team

function norm(str) {
  return (str || '').trim().toLowerCase();
}

/* Admin saves a division's child format into the category, e.g. "MEN 5v5".
   Moderator strips that suffix before it builds a ranking scope key, so a
   Basketball MEN 5v5 result is stored under `basketball::men`. This page
   MUST strip it the same way — labelling the dropdown "MEN 5v5" while the
   saved scope says "men" is why picking a division showed every team back
   at the 1200 baseline instead of its real points. */
function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

function numericRankingValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['finalPoints', 'rating', 'points', 'value']) {
      const parsed = numericRankingValue(value[key]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function savedPointsForTeam(teamMap, team) {
  if (!teamMap || typeof teamMap !== 'object') return null;
  const match = Object.entries(teamMap).find(([key]) => (
    norm(key) === norm(team.name) || String(key) === String(team.id)
  ));
  return match ? numericRankingValue(match[1]) : null;
}

/* Medal Tally needs finer options than the ranking scope: a group with two
   divisions (MEN → Senior / Junior) is two separate competitions, each with
   its own gold/silver/bronze, so they're listed as "MEN (Senior)" and
   "MEN (Junior)". A group with a single division stays a plain "MEN". */
function medalDivisionLabel(group, division) {
  const label = displayCategory((group.label || division?.name || '').trim());
  const dName = (division?.name || '').trim();
  const multi = (group.divisions || []).length > 1;
  return multi && dName && norm(dName) !== norm(label) ? `${label} (${dName})` : label;
}
/* A plain pick ("MEN") covers every division of that group; a full pick
   ("MEN (Senior)") covers only that one. */
function matchesPick(label, pick) {
  if (norm(label) === norm(pick)) return true;
  return !/\(/.test(pick) && norm(baseDivision(label)) === norm(pick);
}
/* Category (group: MEN, WOMEN) and Division (Senior, Junior, …) are separate
   filters. Categories come from every group of the chosen sport; divisions
   only exist within one sport + category that has more than one division. */
function categoryOptionsFor(sports, sportName) {
  const list = sportName === 'All Sports'
    ? sports
    : sports.filter((s) => norm(s.name) === norm(sportName));
  const byLabel = new Map();
  list.forEach((sport) => {
    (sport.categoryGroups || []).forEach((g) => {
      const label = displayCategory((g.label || '').trim());
      if (label && !byLabel.has(norm(label))) byLabel.set(norm(label), { key: g.id, label });
    });
  });
  return [...byLabel.values()];
}
function divisionNamesFor(sports, sportName, category) {
  if (sportName === 'All Sports' || category === 'All Categories') return [];
  const sport = sports.find((s) => norm(s.name) === norm(sportName));
  const byName = new Map();
  (sport?.categoryGroups || []).forEach((g) => {
    if (norm(displayCategory(g.label)) !== norm(category)) return;
    const divs = g.divisions || [];
    if (divs.length < 2) return;
    divs.forEach((d) => {
      const name = (d.name || '').trim();
      if (name && !byName.has(norm(name))) byName.set(norm(name), { key: d.id, label: name });
    });
  });
  return [...byName.values()];
}
/* Category + division → the single label the filters below understand
   ("All Divisions", "MEN" or "MEN (Senior)"). */
function combineDivision(category, divisionName) {
  if (category === 'All Categories') return 'All Divisions';
  return divisionName === 'All Divisions' ? category : `${category} (${divisionName})`;
}

/* "MEN (Senior)" → "MEN" — the plain category that records/tie-breakers use. */
function baseDivision(label) {
  return (label || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/* True when a saved record belongs to the picked division label
   ("MEN (Senior)" or plain "MEN"). Uses the record's schedule divisionId when
   it has one; records without it match on the plain group label. */
function recordInDivision(record, pick, sports, schedules) {
  const sched = record.scheduleId
    ? schedules.find((s) => String(s.id) === String(record.scheduleId))
    : null;
  const divisionId = record.divisionId || sched?.divisionId;
  const sport = sports.find((s) => norm(s.name) === norm(record.sportName));
  const group = divisionId
    ? (sport?.categoryGroups || []).find((g) => (g.divisions || []).some((d) => d.id === divisionId))
    : null;
  const div = group?.divisions.find((d) => d.id === divisionId);
  if (group && div) return matchesPick(medalDivisionLabel(group, div), pick);
  return matchesPick(displayCategory(record.category), pick) || categoriesMatch(record.category, baseDivision(pick));
}

/* Tolerant match for divisions saved before the group-label prefix
   existed (a bare old "5v5" is treated as matching "MEN 5v5" etc). */
function categoriesMatch(a, b) {
  const x = norm(displayCategory(a)), y = norm(displayCategory(b));
  if (x === y) return true;
  if (!x || !y) return false;
  return x.endsWith(` ${y}`) || y.endsWith(` ${x}`);
}

/* ── Elo tie-breaker system ──
   Ratings are averaged/rolled-up floats (see championData below), so an
   exact tie is rare but real — two teams that never lost a rated match
   under the same scope, or a fresh sport/division where nobody has played
   yet, can land on the identical number. When that happens:
     - exactly 2 teams tied        -> most recent head-to-head result
     - 3+ teams tied                -> head-to-head point differential
                                        among the tied teams only, then
                                        total points scored among them,
                                        then head-to-head
   Elo itself is never touched by any of this — it only decides display
   order among teams that already have the same rating.

   The actual reorder logic lives in shared/utils/tieBreakers.js — the
   public Landing page's Potential Champion spotlight uses the exact same
   rules (scoped to "All Sports"/"All Divisions") so the two pages never
   crown different teams out of a tie. */

function applyEloTieBreakers(sortedByRatingDesc, records, sportFilter, divisionFilter) {
  return applyPointDifferentialTieBreakers(
    sortedByRatingDesc, records, sportFilter, divisionFilter,
    (a, b) => a.rating === b.rating,
  );
}

function applyMedalTieBreakers(sortedByMedalsDesc, records, sportFilter, divisionFilter) {
  return applyPointDifferentialTieBreakers(
    sortedByMedalsDesc, records, sportFilter, divisionFilter,
    (a, b) => a.gold === b.gold && a.total === b.total && a.silver === b.silver,
  );
}

/* Deterministic fallback color per team name, since real teams (unlike
   the old mock data) don't carry a stored `color` field — keeps each
   team's initials chip visually stable across reloads without needing
   a new Firestore field. */
const FALLBACK_PALETTE = ['#FCBF19', '#3FA34D', '#D43A2F', '#8D6E47', '#7B4FA0', '#2F6FD4', '#1A9457', '#C2410C'];
function colorForTeam(name) {
  const str = name || '';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

/* ── Team logo placeholder (real logo if the team has one, initials chip otherwise) ── */
function TeamLogo({ team, color, logo }) {
  const initials = team.split(' ').map(w => w[0]).join('').slice(0, 2);
  if (logo) {
    return (
      <span className="rk-team-logo rk-team-logo--img">
        <img src={logo} alt="" />
      </span>
    );
  }
  return (
    <span className="rk-team-logo" style={{ background: color }}>
      {initials}
    </span>
  );
}

/* ── Sport dropdown, reused by both tables ──
   Was a row of individual tab buttons (one per sport), which grew wider
   than the page as more sports got added. Rebuilt as a dropdown using
   the exact same classes as DivisionSelect below, so it reads as the
   same control, just for "Sport" instead of "Division". */
function SportSelect({ value, onChange, sports }) {
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

  return (
    <div className="rk-division-dropdown" ref={wrapRef}>
      <button
        type="button"
        className="rk-division-btn"
        onClick={() => setOpen(prev => !prev)}
      >
        {value}
        <FaChevronDown className={`rk-division-chevron ${open ? 'rk-division-chevron--open' : ''}`} />
      </button>
      <ul className={`rk-division-menu ${open ? 'rk-division-menu--open' : ''}`}>
        {sports.map(label => (
          <li
            key={label}
            className={`rk-division-item ${value === label ? 'rk-division-item--active' : ''}`}
            onClick={() => { onChange(label); setOpen(false); }}
          >
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}


/* ── Division dropdown, reused by both tables ──
   A native <select>'s closed pill can be themed, but its open option
   list is rendered by the OS/browser and ignores almost all CSS — it
   showed up as a plain white/gray box no matter what was set on
   `option`. Built as a custom button + list instead (same pattern as
   the landing page's Levels dropdown), so the open menu can actually
   match the site's dark navy / gold theme. */
function DivisionSelect({ value, onChange, options, allLabel = 'All Divisions' }) {
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

  const allLabels = [allLabel, ...options.map(d => d.label)];

  return (
    <div className="rk-division-dropdown" ref={wrapRef}>
      <button
        type="button"
        className="rk-division-btn"
        onClick={() => setOpen(prev => !prev)}
      >
        {value}
        <FaChevronDown className={`rk-division-chevron ${open ? 'rk-division-chevron--open' : ''}`} />
      </button>
      <ul className={`rk-division-menu ${open ? 'rk-division-menu--open' : ''}`}>
        {allLabels.map(label => (
          <li
            key={label}
            className={`rk-division-item ${value === label ? 'rk-division-item--active' : ''}`}
            onClick={() => { onChange(label); setOpen(false); }}
          >
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Potential Champion table ── */
function ChampionTable({ data, search, records, sportFilter, divisionFilter }) {
  /* Sorted highest rating first. Teams that land on the exact same rating
     (common at the shared 1200 baseline, or after a scope where nobody has
     played yet) are resolved by applyEloTieBreakers per the CLAUDE.md
     tie-breaker rules — head-to-head for a 2-team tie, point differential
     (then total points, then head-to-head) for a 3+-team tie — falling
     back to team name so the table still renders in a stable order when
     no match history exists to break the tie.

     Rank is assigned here, over the FULL unfiltered data, before the search
     box ever narrows what's shown — so filtering the list for a search term
     can never renumber a team's actual position (e.g. BASA sitting at rank 4
     must still read "4" when you search "BASA", not jump to "1"). */
  const ranked = useMemo(() => {
    const byRating = [...data].sort((a, b) => b.rating - a.rating || a.team.localeCompare(b.team));
    return applyEloTieBreakers(byRating, records, sportFilter, divisionFilter)
      .map((t, i) => ({ ...t, rank: i + 1 }));
  }, [data, records, sportFilter, divisionFilter]);

  const visible = useMemo(() => {
    const q = norm(search);
    return q ? ranked.filter(t => norm(t.team).includes(q)) : ranked;
  }, [ranked, search]);

  if (visible.length === 0) {
    return <div className="rk-table-empty">No teams found for this sport/level yet.</div>;
  }

  return (
    <div className="rk-table-wrap" role="table">
      <div className="rk-row rk-row--head" role="row">
        <div className="rk-cell rk-cell-rank" role="columnheader">RANK</div>
        <div className="rk-cell rk-cell-logo" role="columnheader">LOGO</div>
        <div className="rk-cell rk-cell-team" role="columnheader">TEAMS</div>
        <div className="rk-cell rk-cell-num" role="columnheader">RATING</div>
        <div className="rk-cell rk-cell-num" role="columnheader">WIN-LOSS</div>
      </div>
      {visible.map((t) => {
        const rank = t.rank;
        const rankClass = rank <= 3 ? `rk-row--rank-${rank}` : '';
        return (
          <div className={`rk-row ${rankClass}`} role="row" key={t.id}>
            <div className="rk-cell rk-cell-rank" role="cell">
              {rank === 1 ? <FaCrown className="rk-crown" /> : rank}
            </div>
            <div className="rk-cell rk-cell-logo" role="cell"><TeamLogo team={t.team} color={t.color} logo={t.logo} /></div>
            <div className="rk-cell rk-cell-team" role="cell">{t.team}</div>
            <div className="rk-cell rk-cell-num" role="cell" data-label="Rating">
              {t.rating}
              {t.carriedOver && (
                <span
                  title="Carried over from this team's other divisions — no match played here yet"
                  style={{ marginLeft: 4, fontSize: '0.72em', opacity: 0.55 }}
                >
                  *
                </span>
              )}
            </div>
            <div className="rk-cell rk-cell-num" role="cell" data-label="Win-Loss">{t.wins}-{t.losses}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Medal Tally table ── */
function MedalTable({ data, search, records, sportFilter, divisionFilter }) {
  /* Same rule as ChampionTable: rank is fixed over the full data before the
     search box filters what's displayed, so a filtered team keeps its real
     rank instead of being renumbered starting from 1. Teams tied on
     gold/total/silver are resolved by applyMedalTieBreakers — the same
     head-to-head/point-differential rules ChampionTable uses for rating
     ties — so a team that already wins the tie-break there (e.g. by
     point differential) doesn't fall back to alphabetical order here and
     disagree with its own Potential Champion ranking. */
  const ranked = useMemo(() => {
    const byMedals = [...data]
      .map(t => ({ ...t, total: t.gold + t.silver + t.bronze }))
      .sort((a, b) => b.gold - a.gold || b.total - a.total || b.silver - a.silver || a.team.localeCompare(b.team));
    return applyMedalTieBreakers(byMedals, records, sportFilter, divisionFilter)
      .map((t, i) => ({ ...t, rank: i + 1 }));
  }, [data, records, sportFilter, divisionFilter]);

  const visible = useMemo(() => {
    const q = norm(search);
    return q ? ranked.filter(t => norm(t.team).includes(q)) : ranked;
  }, [ranked, search]);

  if (visible.length === 0) {
    return <div className="rk-table-empty">No teams found for this sport/level yet.</div>;
  }

  return (
    <div className="rk-table-wrap" role="table">
      <div className="rk-row rk-row--head rk-row--medal" role="row">
        <div className="rk-cell rk-cell-rank" role="columnheader">RANK</div>
        <div className="rk-cell rk-cell-logo" role="columnheader">LOGO</div>
        <div className="rk-cell rk-cell-team" role="columnheader">TEAMS</div>
        <div className="rk-cell rk-cell-num">GOLD</div>
        <div className="rk-cell rk-cell-num">SILVER</div>
        <div className="rk-cell rk-cell-num">BRONZE</div>
        <div className="rk-cell rk-cell-num">TOTAL</div>
      </div>
      {visible.map((t) => {
        const rank = t.rank;
        const rankClass = rank <= 3 ? `rk-row--rank-${rank}` : '';
        return (
          <div className={`rk-row rk-row--medal ${rankClass}`} role="row" key={t.id}>
            <div className="rk-cell rk-cell-rank" role="cell">{rank}</div>
            <div className="rk-cell rk-cell-logo" role="cell"><TeamLogo team={t.team} color={t.color} logo={t.logo} /></div>
            <div className="rk-cell rk-cell-team" role="cell">{t.team}</div>
            <div className="rk-cell rk-cell-num" role="cell" data-label="Gold">{t.gold}</div>
            <div className="rk-cell rk-cell-num" role="cell" data-label="Silver">{t.silver}</div>
            <div className="rk-cell rk-cell-num" role="cell" data-label="Bronze">{t.bronze}</div>
            <div className="rk-cell rk-cell-num rk-cell-total" role="cell" data-label="Total">{t.total}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function RankingPage() {
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  const LEVELS = useMemo(() => [
    { key: 'elementary', label: levelLabels.elementary },
    { key: 'highSchool', label: levelLabels.highSchool },
    { key: 'college', label: levelLabels.college },
  ], [levelLabels]);
  const lockedLevel = useLockedLevel();
  const [pickedLevel, setLevelKey] = useState('elementary');
  const levelKey = lockedLevel || pickedLevel;
  const [championSport, setChampionSport] = useState('All Sports');
  const [medalSport, setMedalSport] = useState('All Sports');
  const [medalCategory, setMedalCategory] = useState('All Categories');
  const [medalDivName, setMedalDivName] = useState('All Divisions');
  const medalDivision = combineDivision(medalCategory, medalDivName);
  const [search, setSearch] = useState('');
  const contactRef = React.useRef(null);

  const [teams, setTeams] = useState([]);
  const [sports, setSports] = useState([]);
  const [rankingPoints, setRankingPoints] = useState({}); // { [scopeKey]: { [teamName]: points } }
  const [records, setRecords] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [championCategory, setChampionCategory] = useState('All Categories');
  const [championDivName, setChampionDivName] = useState('All Divisions');
  const championDivision = combineDivision(championCategory, championDivName);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const [configR, ranksR, recsR, schedR] = await Promise.allSettled([
        getSportsTeamsConfig(levelKey),
        getTeamRankings(levelKey),
        getMatchRecords(levelKey),
        getMatchSchedules(levelKey),
      ]);
      if (cancelled) return;
      // Schedules only gate when medals are handed out; if they fail to load
      // we fall back to the old behaviour rather than hiding every medal.
      setSchedules(schedR.status === 'fulfilled' ? (schedR.value || []) : []);

      if (configR.status === 'fulfilled') {
        setTeams(configR.value.teams || []);
        setSports(configR.value.sports || []);
      } else {
        console.error('Failed to load teams:', configR.reason);
        setTeams([]);
        setSports([]);
      }
      if (ranksR.status === 'fulfilled') {
        const loadedRankings = ranksR.value || {};
        setRankingPoints(loadedRankings.rankings || loadedRankings.scopes || loadedRankings);
      } else {
        console.error('Failed to load team rankings:', ranksR.reason);
        setRankingPoints({});
      }
      if (recsR.status === 'fulfilled') {
        setRecords(recsR.value || []);
      } else {
        console.error('Failed to load match records:', recsR.reason);
        setRecords([]);
      }

      if ([configR, ranksR, recsR].some(r => r.status === 'rejected')) {
        setLoadError("Couldn't load some ranking data — check your connection and try refreshing.");
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [levelKey]);

  /* Divisions available for the currently selected sport tab — hidden
     entirely under "All Sports", since a division only means something
     within one specific sport. Resets to "All Divisions" whenever the
     sport changes, so you're never stuck on a division that doesn't
     exist for the newly selected sport. */
  const championCategoryOptions = useMemo(() => categoryOptionsFor(sports, championSport), [sports, championSport]);
  const championDivisionOptions = useMemo(
    () => divisionNamesFor(sports, championSport, championCategory),
    [sports, championSport, championCategory],
  );
  const medalCategoryOptions = useMemo(() => categoryOptionsFor(sports, medalSport), [sports, medalSport]);
  const medalDivisionOptions = useMemo(
    () => divisionNamesFor(sports, medalSport, medalCategory),
    [sports, medalSport, medalCategory],
  );

  // Changing a parent filter clears the ones under it.
  const pickChampionSport = (v) => { setChampionSport(v); setChampionCategory('All Categories'); setChampionDivName('All Divisions'); };
  const pickChampionCategory = (v) => { setChampionCategory(v); setChampionDivName('All Divisions'); };
  const pickMedalSport = (v) => { setMedalSport(v); setMedalCategory('All Categories'); setMedalDivName('All Divisions'); };
  const pickMedalCategory = (v) => { setMedalCategory(v); setMedalDivName('All Divisions'); };

  /* TeamAndSportsPage displays team.sportIds. Use that same source for the
     ranking filters, deduplicated case-insensitively while preserving the
     configured display spelling from the first team that uses each sport. */
  const availableSports = useMemo(() => {
    const byName = new Map();
    // Every sport the admin created, even one no team has been assigned to yet.
    sports.forEach((sport) => {
      const label = (sport?.name || '').trim();
      if (label && !byName.has(norm(label))) byName.set(norm(label), label);
    });
    teams.forEach((team) => {
      (team.sportIds || []).forEach((sportName) => {
        const label = (sportName || '').trim();
        if (label && !byName.has(norm(label))) byName.set(norm(label), label);
      });
    });
    return ['All Sports', ...byName.values()];
  }, [teams, sports]);

  useEffect(() => {
    if (!availableSports.includes(championSport)) setChampionSport('All Sports');
    if (!availableSports.includes(medalSport)) setMedalSport('All Sports');
  }, [availableSports, championSport, medalSport]);

  /* Every team registered for this level, deduplicated by name (Admin's
     Sports & Teams roster is the source of truth for who even exists —
     a team shows up here with default rating/0-0 record even before its
     first match is recorded, same as Moderator's default-1200 baseline). */
  const championData = useMemo(() => {
    const divisionPicked = championDivision !== 'All Divisions';

    /* Which saved scopes the current tab + division actually cover. Every
       rating below is read from these and nothing else, so Basketball MEN
       can never borrow a point from Chess or from Basketball WOMEN. */
    const scopesInView = Object.entries(rankingPoints)
      .map(([key, teamMap]) => {
        const [scopeSport, scopeCategory] = String(key).split('::');
        return { key, sport: scopeSport, category: scopeCategory, teamMap };
      })
      .filter((scope) => {
        if (championSport !== 'All Sports' && norm(scope.sport) !== norm(championSport)) return false;
        // Moderator rates each division of a multi-division group in its own
        // scope ("men (senior)"), so the full label matches the saved key.
        if (divisionPicked && !matchesPick(scope.category, championDivision)
          && !categoriesMatch(scope.category, championDivision)) return false;
        return true;
      });

    /* A division isn't part of a team's registration — Sports & Teams only
       says which sports it plays. So when a division is picked, the teams
       that belong in that table are exactly the ones that have been scored
       or played there. Without this, every women's team appeared in the
       MEN table sitting on the 1200 baseline. */
    const namesInDivision = new Set();
    if (divisionPicked) {
      scopesInView.forEach((scope) => {
        Object.keys(scope.teamMap || {}).forEach((name) => namesInDivision.add(norm(name)));
      });
      records.forEach((r) => {
        if (championSport !== 'All Sports' && norm(r.sportName) !== norm(championSport)) return;
        if (!recordInDivision(r, championDivision, sports, schedules)) return;
        const roster = r.participants?.length ? r.participants : [r.teamA, r.teamB];
        roster.forEach((p) => { if (p?.name) namesInDivision.add(norm(p.name)); });
      });
    }

    const bySport = championSport === 'All Sports'
      ? teams
      : teams.filter(t => (t.sportIds || []).some(s => norm(s) === norm(championSport)));

    const inDivision = divisionPicked
      ? bySport.filter(t => namesInDivision.has(norm(t.name)))
      : bySport;

    /* Search is applied later, inside ChampionTable, AFTER rank is computed —
       narrowing the roster here would shrink the field a team is ranked
       against and shift its rank whenever a search term is typed. */
    return inDivision.map((t) => {
      /* A rating is an Elo value, not a score you can bank. Ratings from
         several sports/divisions are therefore AVERAGED (within one sport)
         or reduced to their CHANGE from the 1200 baseline (across sports),
         never summed outright. Summing raw ratings was the bug behind "why
         is Basa on top?" — a team merely registered in five sports collected
         5 × 1200 = 6000 and outranked every team that had actually won
         matches. */
      /* Each scope contributes its own rating; scopes of the same sport are
         averaged into one sport rating first, and only then are the sports
         averaged together. That two-step roll-up is what keeps the tabs
         separate: under "All Sports" a sport counts once no matter how many
         divisions it happens to have, so Basketball with MEN + WOMEN can't
         outweigh Chess with one division. */
      const bySportRatings = new Map();
      scopesInView.forEach((scope) => {
        const savedPoints = savedPointsForTeam(scope.teamMap, t);
        if (savedPoints == null) return;
        if (!bySportRatings.has(scope.sport)) bySportRatings.set(scope.sport, []);
        bySportRatings.get(scope.sport).push(savedPoints);
      });

      const sportAverages = [...bySportRatings.values()]
        .map((points) => points.reduce((sum, p) => sum + p, 0) / points.length);

      /* Nothing recorded in THIS scope yet. Rather than dropping the team
         to a flat 1200, carry over the standing it already holds in another
         DIVISION OF THE SAME SPORT — that is exactly the rating Moderator
         will use as its "previous points" when this team finally plays
         here, so the two pages never disagree about where a team starts.
         Must stay scoped to championSport: without that filter, picking the
         Tennis tab for a team that has only ever played Badminton pulled in
         its Badminton rating instead of showing the untouched 1200 baseline.
         Only a team with no rating anywhere (or none in this sport, when a
         specific sport tab is active) shows the new-team baseline. */
      const carried = [];
      if (!sportAverages.length) {
        const bySportAll = new Map();
        Object.entries(rankingPoints).forEach(([scopeKey, teamMap]) => {
          const [scopeSport] = String(scopeKey).split('::');
          if (championSport !== 'All Sports' && norm(scopeSport) !== norm(championSport)) return;
          const savedPoints = savedPointsForTeam(teamMap, t);
          if (savedPoints == null) return;
          if (!bySportAll.has(scopeSport)) bySportAll.set(scopeSport, []);
          bySportAll.get(scopeSport).push(savedPoints);
        });
        bySportAll.forEach((list) => carried.push(list.reduce((sum, p) => sum + p, 0) / list.length));
      }

      /* Each individual sport keeps its own 1200 baseline (Men's Badminton
         1200 -> 1230 stays 1230 on that tab). "All Sports" must NOT average
         those absolute values together — a team strong in one sport and
         untouched (1200) in another would get dragged toward 1200 forever.
         Instead it accumulates each sport's CHANGE from 1200, so Badminton
         +30 and Chess +0 combine into 1200 + 30 = 1230 overall. */
      const source = sportAverages.length ? sportAverages : carried;
      const rating = source.length
        ? (championSport === 'All Sports'
          ? Math.round(DEFAULT_POINTS + source.reduce((sum, avg) => sum + (avg - DEFAULT_POINTS), 0))
          : Math.round(source.reduce((sum, avg) => sum + avg, 0) / source.length))
        : DEFAULT_POINTS;
      const played = [...bySportRatings.values()].reduce((n, points) => n + points.length, 0);
      /* True when the number above was inherited from another sport or
         division rather than earned in the one being viewed. */
      const carriedOver = !sportAverages.length && carried.length > 0;

      // Win/loss: count from actual saved match records for this team,
      // narrowed to the selected sport tab and division (if chosen).
      let wins = 0, losses = 0;
      records.forEach((r) => {
        if (championSport !== 'All Sports' && norm(r.sportName) !== norm(championSport)) return;
        if (divisionPicked && !recordInDivision(r, championDivision, sports, schedules)) return;

        // 1-vs-many events save every participant with its finishing place,
        // so a 4-team race counts as one win for the placer and a loss for
        // everyone else — not just for the top two.
        const field = r.participants || [];
        if (field.length > 2) {
          const me = field.find((p) => norm(p.name) === norm(t.name));
          if (!me) return;
          if (me.place === 1) wins++; else losses++;
          return;
        }

        const isA = norm(r.teamA?.name) === norm(t.name);
        const isB = norm(r.teamB?.name) === norm(t.name);
        if (!isA && !isB) return;
        if (r.draw || r.winner === 'DRAW') return; // a draw is neither a win nor a loss
        const won = (isA && r.winner === 'A') || (isB && r.winner === 'B');
        if (won) wins++; else losses++;
      });

      return {
        id: t.id, team: (t.name || '').toUpperCase(), logo: t.logo || null,
        color: colorForTeam(t.name), rating, wins, losses, played, carriedOver,
      };
    });
  }, [teams, sports, schedules, rankingPoints, records, championSport, championDivision]);

  /* Medal tally is driven only by finalized records saved by Moderator.
     For a 1-vs-many record, the saved finishing place determines
     gold/silver/bronze straight away — each race is its own event.

     For 1-vs-1 (head-to-head) records, a medal is NOT handed out per match
     won — a team that goes 5-0 in a round robin used to rack up 5 golds for
     one sport/division, which is wrong: only one gold/silver/bronze exists
     per sport+division. Instead, every head-to-head match in a sport+
     division is rolled up into that scope's overall win-loss standings
     (same participants a team would face across a round robin or bracket),
     and exactly one gold/silver/bronze is awarded there — to whichever team
     holds the best win-loss record, 2nd best, 3rd best. Ties on win-loss
     reuse the same head-to-head/point-differential tie-breakers as the
     Potential Champion and Medal tables elsewhere on this page, scoped to
     that match's own sport/category so a tie-break never pulls in results
     from an unrelated sport.

     This is intentionally separate from championData so changing the medal
     tally cannot affect champion prediction/ranking calculations. */
  const medalData = useMemo(() => {
    const byTeam = new Map();

    const ensureTeam = (team) => {
      if (!team?.name) return null;
      const key = norm(team.name);
      if (!byTeam.has(key)) {
        byTeam.set(key, {
          id: team.id || `medal-${key}`,
          team: team.name.toUpperCase(),
          color: colorForTeam(team.name),
          logo: team.logo || null,
          gold: 0,
          silver: 0,
          bronze: 0,
        });
      }
      return byTeam.get(key);
    };

    const divisionPicked = medalDivision !== 'All Divisions';

    /* Resolve the division a match belongs to ("MEN (Senior)" vs "MEN
       (Junior)") from its divisionId; records point at their schedule via
       scheduleId. Older data without a divisionId falls back to the plain
       category, which matches any division sharing that group label. */
    const schedById = new Map(schedules.map((s) => [String(s.id), s]));
    const labelFor = (sportName, category, divisionId) => {
      const sport = sports.find((s) => norm(s.name) === norm(sportName));
      const groups = sport?.categoryGroups || [];
      if (divisionId) {
        const group = groups.find((g) => (g.divisions || []).some((d) => d.id === divisionId));
        const div = group?.divisions.find((d) => d.id === divisionId);
        if (group && div) return { label: medalDivisionLabel(group, div), exact: true };
      }
      return { label: displayCategory(category), exact: false };
    };
    const recordLabel = (record) => {
      const sched = record.scheduleId ? schedById.get(String(record.scheduleId)) : null;
      return labelFor(record.sportName, record.category, record.divisionId || sched?.divisionId);
    };
    const inPickedDivision = (record) => {
      if (!divisionPicked) return true;
      const { label, exact } = recordLabel(record);
      if (matchesPick(label, medalDivision)) return true;
      return !exact && norm(label) === norm(baseDivision(medalDivision));
    };

    /* Same rule as the champion table: a division's roster is only knowable
       from what has been played there, so a picked division lists exactly
       those teams instead of padding the table with every registered team
       at 0-0-0. */
    const namesInDivision = new Set();
    if (divisionPicked) {
      records.forEach((record) => {
        if (medalSport !== 'All Sports' && norm(record.sportName) !== norm(medalSport)) return;
        if (!inPickedDivision(record)) return;
        const roster = record.participants?.length ? record.participants : [record.teamA, record.teamB];
        roster.forEach((p) => { if (p?.name) namesInDivision.add(norm(p.name)); });
      });
    }

    /* Search is applied later, inside MedalTable, AFTER rank is computed —
       narrowing the roster here would shrink the field a team is ranked
       against and shift its rank whenever a search term is typed. */
    // Keep registered teams visible even before they have a recorded win.
    teams.forEach((team) => {
      if (medalSport !== 'All Sports' && !(team.sportIds || []).some((s) => norm(s) === norm(medalSport))) return;
      if (divisionPicked && !namesInDivision.has(norm(team.name))) return;
      ensureTeam({ id: team.id, name: team.name, logo: team.logo });
    });

    const relevantRecords = records.filter((record) => (
      (medalSport === 'All Sports' || norm(record.sportName) === norm(medalSport))
      && inPickedDivision(record)
    ));

    // 1-vs-many events (races): each record is its own event, so the saved
    // finishing place awards its medal immediately, one race at a time.
    relevantRecords.forEach((record) => {
      const participants = record.participants || [];
      if (participants.length <= 2) return;
      participants.forEach((participant) => {
        const row = ensureTeam(participant);
        if (!row) return;
        if (participant.place === 1) row.gold += 1;
        else if (participant.place === 2) row.silver += 1;
        else if (participant.place === 3) row.bronze += 1;
      });
    });

    // 1-vs-1 matches: roll every decided head-to-head result up into its
    // sport+division's overall win-loss standings, then award exactly one
    // gold/silver/bronze per scope to the top 3 records.
    const scopes = new Map(); // scopeKey -> { sportName, category, standings: Map }
    relevantRecords.forEach((record) => {
      const participants = record.participants || [];
      if (participants.length > 2) return;
      if (record.draw || record.winner === 'DRAW') return;
      const winnerTeam = record.winner === 'A' ? record.teamA : record.winner === 'B' ? record.teamB : null;
      const loserTeam = record.winner === 'A' ? record.teamB : record.winner === 'B' ? record.teamA : null;
      if (!winnerTeam?.name || !loserTeam?.name) return;

      const divLabel = recordLabel(record).label;
      const scopeKey = `${norm(record.sportName)}::${norm(divLabel)}`;
      if (!scopes.has(scopeKey)) {
        scopes.set(scopeKey, {
          sportName: record.sportName, category: record.category, divLabel, standings: new Map(),
        });
      }
      const { standings } = scopes.get(scopeKey);
      [winnerTeam, loserTeam].forEach((t) => {
        const key = norm(t.name);
        if (!standings.has(key)) standings.set(key, { name: t.name, logo: t.logo || null, wins: 0, losses: 0 });
      });
      standings.get(norm(winnerTeam.name)).wins += 1;
      standings.get(norm(loserTeam.name)).losses += 1;
    });

    // A sport+division's medals are only handed out once EVERY scheduled
    // match in it has a saved record — before that the standings are still
    // moving, so nobody holds gold/silver/bronze yet. Scopes with no
    // schedule at all (manually entered records) count as complete.
    const scopeIsComplete = (sportName, divLabel) => {
      const scopeSchedules = schedules.filter((s) => (
        norm(s.sport) === norm(sportName)
        && norm(labelFor(s.sport, s.category, s.divisionId).label) === norm(divLabel)
      ));
      if (!scopeSchedules.length) return true;
      return scopeSchedules.every((s) => records.some((r) => (
        r.scheduleId
          ? String(r.scheduleId) === String(s.id)
          : norm(r.sportName) === norm(s.sport)
            && norm(r.teamA?.name) === norm(s.teamA) && norm(r.teamB?.name) === norm(s.teamB)
      )));
    };

    scopes.forEach(({ sportName, category, divLabel, standings }) => {
      if (!scopeIsComplete(sportName, divLabel)) return;
      const sorted = [...standings.values()]
        .map((s) => ({ ...s, team: s.name }))
        .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.team.localeCompare(b.team));
      const ranked = applyPointDifferentialTieBreakers(
        sorted, records, sportName, category,
        (a, b) => a.wins === b.wins && a.losses === b.losses,
      );
      const medalKeys = ['gold', 'silver', 'bronze'];
      [ranked[0], ranked[1], ranked[2]].forEach((entry, idx) => {
        if (!entry) return;
        const row = ensureTeam({ name: entry.name, logo: entry.logo });
        if (row) row[medalKeys[idx]] += 1;
      });
    });

    return [...byTeam.values()];
  }, [teams, sports, records, schedules, medalSport, medalDivision]);

  return (
    <div className="rk-page">

      {/* ── Top header ── */}
      <header className="rk-dash-header">
        <h1 className="rk-dash-header__title">{schoolName}</h1>
      </header>

      {/* ── Scrollable body ── */}
      <div className="rk-body">

        {/* Page intro — title/level tabs/search bar share one row */}
        <div className="rk-page-intro rk-top-row">
          <div>
            <h2 className="rk-page-title">Top Rankings</h2>
            <p className="rk-page-subtitle">Ranked by performance, not by chance. Every game counts. Every rank matters.</p>
          </div>
          {/* Level tabs + search bar are grouped so they can be kept on one
              row together on mobile (see .rk-controls-row), while the
              title above them still gets its own line. */}
          <div className="rk-controls-row">
          {!lockedLevel && (
          <LevelTabs
            levels={LEVELS}
            value={levelKey}
            onChange={setLevelKey}
            containerClassName="rk-lvltabs"
            tabClassName="rk-lvltab"
            activeClassName="rk-lvltab--active"
          />
          )}
          <div className="rk-search-wrap">
            <FaSearch className="rk-search-icon" />
            <input
              type="text"
              className="rk-search-input"
              placeholder="Search team"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          </div>
        </div>

        {loadError && <p className="rk-load-error">{loadError}</p>}

        {/* Potential Champion */}
        <section className="rk-section">
          <div className="rk-section-header">
            <h3 className="rk-section-title">Potential Champion</h3>
            <p className="rk-section-subtitle">Performance based</p>
          </div>
          {/* Each label+dropdown grouped so flex-wrap wraps them as a pair
              instead of stranding "Division" on one line and its dropdown
              alone on the next. */}
          <div className="rk-division-row">
            <div className="rk-division-group">
              <label className="rk-division-label">Sport</label>
              <SportSelect sports={availableSports} value={championSport} onChange={pickChampionSport} />
            </div>
            <div className="rk-division-group">
              <label className="rk-division-label">Category</label>
              <DivisionSelect
                value={championCategory}
                onChange={pickChampionCategory}
                options={championCategoryOptions}
                allLabel="All Categories"
              />
            </div>
            <div className="rk-division-group">
              <label className="rk-division-label">Division</label>
              <DivisionSelect
                value={championDivName}
                onChange={setChampionDivName}
                options={championDivisionOptions}
              />
            </div>
          </div>
          <div className="rk-card">
            {loading ? (
              <div className="rk-table-empty">Loading…</div>
            ) : (
              <ChampionTable
                data={championData}
                search={search}
                records={records}
                sportFilter={championSport}
                divisionFilter={championDivision === 'All Divisions' ? championDivision : baseDivision(championDivision)}
              />
            )}
          </div>
        </section>

        {/* Medal Tally */}
        <section className="rk-section">
          <div className="rk-section-header">
            <h3 className="rk-section-title"><FaMedal className="rk-section-icon" /> Medal Tally</h3>
            <p className="rk-section-subtitle">Win and Loss</p>
          </div>
          <div className="rk-division-row">
            <div className="rk-division-group">
              <label className="rk-division-label">Sport</label>
              <SportSelect sports={availableSports} value={medalSport} onChange={pickMedalSport} />
            </div>
            <div className="rk-division-group">
              <label className="rk-division-label">Category</label>
              <DivisionSelect
                value={medalCategory}
                onChange={pickMedalCategory}
                options={medalCategoryOptions}
                allLabel="All Categories"
              />
            </div>
            <div className="rk-division-group">
              <label className="rk-division-label">Division</label>
              <DivisionSelect
                value={medalDivName}
                onChange={setMedalDivName}
                options={medalDivisionOptions}
              />
            </div>
          </div>
          <div className="rk-card rk-card--light">
            <MedalTable
              data={medalData}
              search={search}
              records={records}
              sportFilter={medalSport}
              divisionFilter={medalDivision === 'All Divisions' ? medalDivision : baseDivision(medalDivision)}
            />
          </div>
        </section>

        {/* Contact footer */}
        <Contact contactFooterRef={contactRef} />
      </div>
    </div>
  );
}
