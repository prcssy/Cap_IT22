import React, { useState, useEffect, useMemo, useContext } from 'react';
import { BrandingContext } from '../components/BrandingContext';
import './MatchSchedulesPage.css';
import Contact from '../components/Landing/Contact/Contact';
import { FaSearch, FaTrophy } from 'react-icons/fa';
import { getMatchSchedules, getMatchRecords } from '../services/firestoreService';
import LevelTabs from '../components/LevelTabs';

/* ═══════════════════════════════════════════════════════════
   This page is fully data-driven: every match shown here comes
   from what an admin actually saved in the Schedule Manager
   (matchSchedules/{level} in Firestore). If the admin hasn't
   generated or added anything yet, nothing renders except an
   empty-state message — no placeholder/sample data.
   ═══════════════════════════════════════════════════════════ */

const LEVELS = [
  { label: 'All Levels', key: 'all' },
  { label: 'Elementary', key: 'elementary' },
  { label: 'High School', key: 'highSchool' },
  { label: 'College', key: 'college' },
];

const LEVEL_TAG = {
  elementary: 'ELEMENTARY',
  highSchool: 'HIGH SCHOOL',
  college: 'COLLEGE',
};

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
  if (record.winner === 'A') return record.teamA?.name || null;
  if (record.winner === 'B') return record.teamB?.name || null;
  return null;
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

/* ── Schedule table for a single day ── */
function ScheduleDayTable({ day, matches, resultFor }) {
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
            <div className="ms-cell ms-cell-time" role="cell" data-label="Time">{formatTime(m.time)}</div>
            <div className="ms-cell ms-cell-sport" role="cell" data-label="Sport">{categoryOf(m).label}</div>
            <div className="ms-cell ms-cell-venue" role="cell" data-label="Venue">{m.location || '—'}</div>
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
                    <span style={bold(m.teamA)}>{m.teamA}</span>
                    <span className="ms-team-vs">vs</span>
                    <span style={bold(m.teamB)}>{m.teamB}</span>
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
  const [levelKey, setLevelKey] = useState(LEVELS[0].key);
  const level = LEVELS.find(l => l.key === levelKey) || LEVELS[0];
  const [category, setCategory] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [matchesByLevel, setMatchesByLevel] = useState({ elementary: [], highSchool: [], college: [] });
  const [records, setRecords] = useState([]); // Moderator results, all levels
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
  const levelMatches = useMemo(() => {
    if (level.key === 'all') {
      return [...matchesByLevel.elementary, ...matchesByLevel.highSchool, ...matchesByLevel.college];
    }
    return matchesByLevel[level.key] || [];
  }, [level, matchesByLevel]);

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

  /* ── Schedule table only shows matches an admin has actually pinned
     to a real date + time — a freshly generated match with blank
     date/time doesn't belong on the "real-time schedule" yet ── */
  const scheduledMatches = useMemo(
    () => levelMatches.filter(m => m.date && m.time),
    [levelMatches]
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
            const q = search.toLowerCase();
            return (
              m.teamA.toLowerCase().includes(q) ||
              m.teamB.toLowerCase().includes(q) ||
              categoryOf(m).label.toLowerCase().includes(q) ||
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
      const hit = records.find((record, index) =>
        !used.has(index) && recordMatchesSchedule(record, match)) || null;
      if (hit) used.add(records.indexOf(hit));
      byScheduleId.set(match.id, hit);
      return hit;
    };
  }, [records]);

  /* The champion is whoever won the last stage of this category's bracket
     — filled in only once that final actually has a saved result. */
  const champion = useMemo(() => {
    if (generatedMatches.length === 0) return null;
    const finals = generatedMatches.filter((m) => {
      const stage = (m.stage || '').toLowerCase();
      return stage.includes('final') || stage.includes('champion');
    });
    const maxRound = Math.max(...generatedMatches.map(m => (m.round != null ? m.round : -1)));
    const lastRound = maxRound >= 0 ? generatedMatches.filter(m => m.round === maxRound) : [];
    const candidates = finals.length ? finals : lastRound;
    for (const match of candidates) {
      const winner = winnerNameOf(resultFor(match));
      if (winner) return winner.toUpperCase();
    }
    return null;
  }, [generatedMatches, resultFor]);

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
        <LevelTabs
          levels={LEVELS}
          value={levelKey}
          onChange={setLevelKey}
          containerClassName="ms-lvltabs"
          tabClassName="ms-lvltab"
          activeClassName="ms-lvltab--active"
        />

        {loading ? (
          <p className="ms-state-note">Loading schedules…</p>
        ) : !hasAnyData ? (
          <p className="ms-state-note">
            No game schedules have been posted yet{level.key !== 'all' ? ` for ${level.label}` : ''}. Once an admin generates or adds a schedule, it will appear here.
          </p>
        ) : (
          <>
            {/* Category selector + search */}
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
              <div className="ms-search-wrap">
                <FaSearch className="ms-search-icon" />
                <input
                  type="text"
                  className="ms-search-input"
                  placeholder="Search team, sport, or venue"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Bracket / rounds section */}
            <div className="ms-bracket-card">
              <h3 className="ms-bracket-title">{category?.label || ''}</h3>
              {generatedMatches.length > 0 ? (
                <RoundsView matches={generatedMatches} resultFor={resultFor} champion={champion} />
              ) : (
                <p className="ms-bracket-empty">No bracket or rounds generated yet for {category?.label}.</p>
              )}
            </div>

            {/* Section title */}
            <h2 className="ms-section-title">MATCH SCHEDULES</h2>

            {/* Schedule tables grouped by day */}
            <div className="ms-schedule-list">
              {filteredSchedule.length > 0 ? (
                filteredSchedule.map(day => (
                  <ScheduleDayTable key={day.day} day={day.day} matches={day.matches} resultFor={resultFor} />
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
