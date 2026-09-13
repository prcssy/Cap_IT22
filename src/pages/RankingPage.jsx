import React, { useState, useMemo, useEffect } from 'react';
import './RankingPage.css';
import { FaSearch, FaCrown, FaMedal } from 'react-icons/fa';
import Contact from '../components/Landing/Contact/Contact';
import LevelTabs from '../components/LevelTabs';
import { getSportsTeamsConfig, getTeamRankings, getMatchRecords } from '../services/firestoreService';

/* ── Sport filter tabs (shared by both tables) ──
   The actual sport names are derived from the same team.sportIds data used
   by TeamAndSportsPage, so unused hard-coded sports never appear here. */
const LEVELS = ['Elementary', 'High School', 'College'];
const LEVEL_KEY_BY_LABEL = { 'Elementary': 'elementary', 'High School': 'highSchool', 'College': 'college' };
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

/* The scope key Moderator writes rankings under. */
function scopeKeyFor(sportName, category) {
  return `${norm(sportName)}::${norm(displayCategory(category))}`;
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

/* Same flattening/labeling logic Admin's Sports & Teams and Moderator
   use — one row per division, group label (e.g. "MEN") prefixed onto
   the division name when they differ, so "MEN 5v5" / "WOMEN 5v5" stay
   distinguishable here too, matching how they're actually scored. */
function flatDivisions(sport) {
  return (sport?.categoryGroups || []).flatMap((g) => {
    const divs = g.divisions || [];
    if (divs.length === 0) return [{ id: `${g.id}_lbl`, name: g.label, groupLabel: g.label }];
    return divs.map((d) => ({ ...d, name: d.name || g.label, groupLabel: g.label }));
  });
}
function divisionOptionsForSport(sport) {
  if (!sport) return [];
  /* One option per real division. Two formats under the same group (MEN
     5v5 and MEN 3v3) collapse to a single "MEN", which is the level
     rankings are actually scored at. */
  const byLabel = new Map();
  flatDivisions(sport).forEach((d) => {
    const label = displayCategory((d.groupLabel || '').trim() || (d.name || '').trim());
    if (label && !byLabel.has(norm(label))) byLabel.set(norm(label), { key: d.id, label });
  });
  return [...byLabel.values()];
}

function divisionOptionsForSports(sports) {
  const byLabel = new Map();
  (sports || []).forEach((sport) => {
    divisionOptionsForSport(sport).forEach((division) => {
      if (!byLabel.has(norm(division.label))) byLabel.set(norm(division.label), division);
    });
  });
  return [...byLabel.values()];
}
/* Tolerant match for divisions saved before the group-label prefix
   existed (a bare old "5v5" is treated as matching "MEN 5v5" etc). */
function categoriesMatch(a, b) {
  const x = norm(displayCategory(a)), y = norm(displayCategory(b));
  if (x === y) return true;
  if (!x || !y) return false;
  return x.endsWith(` ${y}`) || y.endsWith(` ${x}`);
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

/* ── Sport tab row, reused by both tables ── */
function SportTabs({ active, onChange, sports }) {
  return (
    <div className="rk-sport-tabs">
      {sports.map(s => (
        <button
          key={s}
          className={`rk-sport-tab ${active === s ? 'rk-sport-tab--active' : ''}`}
          onClick={() => onChange(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}


/* ── Potential Champion table ── */
function ChampionTable({ data, search }) {
  /* Sorted highest rating first, then by win differential, then by name.
     The name tie-break is what makes the table static: teams sitting on
     the identical 1200 baseline keep the same order on every render
     instead of shuffling with whatever order Firestore returned.

     Rank is assigned here, over the FULL unfiltered data, before the search
     box ever narrows what's shown — so filtering the list for a search term
     can never renumber a team's actual position (e.g. BASA sitting at rank 4
     must still read "4" when you search "BASA", not jump to "1"). */
  const ranked = useMemo(
    () => [...data]
      .sort((a, b) =>
        b.rating - a.rating
        || (b.wins - b.losses) - (a.wins - a.losses)
        || b.wins - a.wins
        || a.team.localeCompare(b.team))
      .map((t, i) => ({ ...t, rank: i + 1 })),
    [data]
  );

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
function MedalTable({ data, search }) {
  /* Same rule as ChampionTable: rank is fixed over the full data before the
     search box filters what's displayed, so a filtered team keeps its real
     rank instead of being renumbered starting from 1. */
  const ranked = useMemo(
    () => [...data]
      .map(t => ({ ...t, total: t.gold + t.silver + t.bronze }))
      .sort((a, b) => b.gold - a.gold || b.total - a.total || b.silver - a.silver || a.team.localeCompare(b.team))
      .map((t, i) => ({ ...t, rank: i + 1 })),
    [data]
  );

  const visible = useMemo(() => {
    const q = norm(search);
    return q ? ranked.filter(t => norm(t.team).includes(q)) : ranked;
  }, [ranked, search]);

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
  const [levelLabel, setLevelLabel] = useState('High School');
  const [championSport, setChampionSport] = useState('All Sports');
  const [medalSport, setMedalSport] = useState('All Sports');
  const [medalDivision, setMedalDivision] = useState('All Divisions');
  const [search, setSearch] = useState('');
  const contactRef = React.useRef(null);

  const [teams, setTeams] = useState([]);
  const [sports, setSports] = useState([]);
  const [rankingPoints, setRankingPoints] = useState({}); // { [scopeKey]: { [teamName]: points } }
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [championDivision, setChampionDivision] = useState('All Divisions');

  const levelKey = LEVEL_KEY_BY_LABEL[levelLabel] || 'highSchool';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const [configR, ranksR, recsR] = await Promise.allSettled([
        getSportsTeamsConfig(levelKey),
        getTeamRankings(levelKey),
        getMatchRecords(levelKey),
      ]);
      if (cancelled) return;

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
  const championDivisionOptions = useMemo(() => {
    if (championSport === 'All Sports') return divisionOptionsForSports(sports);
    const sport = sports.find(s => norm(s.name) === norm(championSport));
    return divisionOptionsForSport(sport);
  }, [sports, championSport]);

  const medalDivisionOptions = useMemo(() => {
    if (medalSport === 'All Sports') return divisionOptionsForSports(sports);
    const sport = sports.find(s => norm(s.name) === norm(medalSport));
    return divisionOptionsForSport(sport);
  }, [sports, medalSport]);

  useEffect(() => {
    setChampionDivision('All Divisions');
  }, [championSport]);

  useEffect(() => {
    setMedalDivision('All Divisions');
  }, [medalSport]);

  /* TeamAndSportsPage displays team.sportIds. Use that same source for the
     ranking filters, deduplicated case-insensitively while preserving the
     configured display spelling from the first team that uses each sport. */
  const availableSports = useMemo(() => {
    const byName = new Map();
    teams.forEach((team) => {
      (team.sportIds || []).forEach((sportName) => {
        const label = (sportName || '').trim();
        if (label && !byName.has(norm(label))) byName.set(norm(label), label);
      });
    });
    return ['All Sports', ...byName.values()];
  }, [teams]);

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
        if (divisionPicked && !categoriesMatch(scope.category, championDivision)) return false;
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
        if (!categoriesMatch(r.category, championDivision)) return;
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
        if (divisionPicked && !categoriesMatch(r.category, championDivision)) return;

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
  }, [teams, rankingPoints, records, championSport, championDivision]);

  /* Medal tally is driven only by finalized records saved by Moderator.
     For a 1-vs-1 record, the selected winner receives gold and the other
     team receives silver. For a 1-vs-many record, the saved finishing place
     determines gold/silver/bronze. This is intentionally separate from
     championData so changing the medal tally cannot affect champion
     prediction/ranking calculations. */
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

    /* Same rule as the champion table: a division's roster is only knowable
       from what has been played there, so a picked division lists exactly
       those teams instead of padding the table with every registered team
       at 0-0-0. */
    const namesInDivision = new Set();
    if (divisionPicked) {
      records.forEach((record) => {
        if (medalSport !== 'All Sports' && norm(record.sportName) !== norm(medalSport)) return;
        if (!categoriesMatch(record.category, medalDivision)) return;
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

    records.forEach((record) => {
      if (medalSport !== 'All Sports' && norm(record.sportName) !== norm(medalSport)) return;
      if (divisionPicked && !categoriesMatch(record.category, medalDivision)) return;

      const participants = record.participants || [];
      if (participants.length > 2) {
        participants.forEach((participant) => {
          const row = ensureTeam(participant);
          if (!row) return;
          if (participant.place === 1) row.gold += 1;
          else if (participant.place === 2) row.silver += 1;
          else if (participant.place === 3) row.bronze += 1;
        });
        return;
      }

      const teamA = ensureTeam(record.teamA);
      const teamB = ensureTeam(record.teamB);
      if (!teamA && !teamB) return;
      if (record.draw || record.winner === 'DRAW') return;
      if (record.winner === 'A') {
        if (teamA) teamA.gold += 1;
        if (teamB) teamB.silver += 1;
      } else if (record.winner === 'B') {
        if (teamB) teamB.gold += 1;
        if (teamA) teamA.silver += 1;
      }
    });

    return [...byTeam.values()];
  }, [teams, records, medalSport, medalDivision]);

  return (
    <div className="rk-page">

      {/* ── Top header ── */}
      <header className="rk-dash-header">
        <h1 className="rk-dash-header__title">SANTA RITA COLLEGE OF PAMPANGA, INC</h1>
      </header>

      {/* ── Scrollable body ── */}
      <div className="rk-body">

        {/* Page intro — title/subtitle share the search bar's row */}
        <div className="rk-page-intro rk-top-row">
          <div>
            <h2 className="rk-page-title">Top Rankings</h2>
            <p className="rk-page-subtitle">Ranked by performance, not by chance. Every game counts. Every rank matters.</p>
          </div>
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

        <div className="rk-lvltabs-row">
          <LevelTabs
            levels={LEVELS}
            value={levelLabel}
            onChange={setLevelLabel}
            containerClassName="rk-lvltabs"
            tabClassName="rk-lvltab"
            activeClassName="rk-lvltab--active"
          />
        </div>

        {loadError && <p className="rk-load-error">{loadError}</p>}

        {/* Potential Champion */}
        <section className="rk-section">
          <div className="rk-section-header">
            <h3 className="rk-section-title">Potential Champion</h3>
            <p className="rk-section-subtitle">Performance based</p>
          </div>
          <SportTabs sports={availableSports} active={championSport} onChange={setChampionSport} />
          <div className="rk-division-row">
            <label className="rk-division-label">Division</label>
            <select
              className="rk-division-select"
              value={championDivision}
              onChange={(e) => setChampionDivision(e.target.value)}
            >
              <option value="All Divisions">All Divisions</option>
              {championDivisionOptions.map(d => (
                <option key={d.key} value={d.label}>{d.label}</option>
              ))}
            </select>
          </div>
          <div className="rk-card">
            {loading ? (
              <div className="rk-table-empty">Loading…</div>
            ) : (
              <ChampionTable data={championData} search={search} />
            )}
          </div>
        </section>

        {/* Medal Tally */}
        <section className="rk-section">
          <div className="rk-section-header">
            <h3 className="rk-section-title"><FaMedal className="rk-section-icon" /> Medal Tally</h3>
            <p className="rk-section-subtitle">Win and Loss</p>
          </div>
          <SportTabs sports={availableSports} active={medalSport} onChange={setMedalSport} />
          <div className="rk-division-row">
            <label className="rk-division-label">Division</label>
            <select
              className="rk-division-select"
              value={medalDivision}
              onChange={(e) => setMedalDivision(e.target.value)}
            >
              <option value="All Divisions">All Divisions</option>
              {medalDivisionOptions.map(d => (
                <option key={d.key} value={d.label}>{d.label}</option>
              ))}
            </select>
          </div>
          <div className="rk-card rk-card--light">
            <MedalTable data={medalData} search={search} />
          </div>
        </section>

        {/* Contact footer */}
        <Contact contactFooterRef={contactRef} />
      </div>
    </div>
  );
}
