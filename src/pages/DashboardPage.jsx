import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FiAward, FiAlertTriangle, FiChevronLeft, FiChevronRight, FiStar, FiTrendingUp, FiZap, FiClock, FiMapPin } from 'react-icons/fi';
import './DashboardPage.css';
import Contact from '../components/Landing/Contact/Contact';
import LevelTabs from '../components/LevelTabs';
import { getMatchSchedules, subscribeMatchSchedules, getMatchRecords, getSportsTeamsConfig } from '../services/firestoreService';

/* ═══════════════════════════════════════════
   LIVE MATCH STATUS
   A saved match only has a start time (date + time), not a duration,
   so "ongoing" needs an assumed match length to know when it ends.
   Matches created by the schedule generator but not yet assigned a
   date/time (round-robin/bracket placeholders) are skipped entirely —
   they have nothing to compare against the clock yet.
═══════════════════════════════════════════ */
const ASSUMED_MATCH_MINUTES = 120; // 2 hours, matching the original mock's "7:00–9:00 AM" style windows

const LEVEL_KEY_BY_LABEL = { 'Elementary': 'elementary', 'High School': 'highSchool', 'College': 'college' };

function matchWindow(match) {
  if (!match.date || !match.time) return null;
  const start = new Date(`${match.date}T${match.time}`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + ASSUMED_MATCH_MINUTES * 60000);
  return { start, end };
}

function norm(value) {
  return (value || '').trim().toLowerCase();
}

/* Categories used to be saved as values such as "MEN 5v5". The dashboard
   shows the sport and division, not the child match format. */
function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

function sameTeam(a, b) {
  return !!a && !!b && norm(a) === norm(b);
}

function recordIdentity(record) {
  if (record?.id) return `id:${record.id}`;
  const participants = record?.participants?.length ? record.participants : [record?.teamA, record?.teamB];
  const teams = participants.map(p => norm(p?.name)).filter(Boolean).sort().join('|');
  return [norm(record?.sportName), norm(record?.category), teams].join('::');
}

/* New Moderator records store scheduleId, making the schedule fixture the
   source of truth. The team fallback keeps older records readable. */
function recordMatchesSchedule(record, schedule) {
  if (!record || !schedule) return false;
  if (record.scheduleId) return String(record.scheduleId) === String(schedule.id);
  if (norm(record.sportName) !== norm(schedule.sport)) return false;
  const recordCategory = norm(displayCategory(record.category));
  const scheduleCategory = norm(displayCategory(schedule.category));
  if (recordCategory && scheduleCategory && recordCategory !== scheduleCategory
      && !recordCategory.endsWith(` ${scheduleCategory}`)
      && !scheduleCategory.endsWith(` ${recordCategory}`)) return false;
  const participants = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const names = participants.map(p => p?.name).filter(Boolean);
  return names.length >= 2
    && names.some(name => sameTeam(name, schedule.teamA))
    && names.some(name => sameTeam(name, schedule.teamB));
}

function finishedCardFrom(schedule, record, teamsByName) {
  const participants = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const a = participants.find(p => sameTeam(p?.name, schedule.teamA)) || record.teamA || {};
  const b = participants.find(p => sameTeam(p?.name, schedule.teamB)) || record.teamB || {};
  const team = (name, scheduleLogo, saved) => ({
    label: (name || '').toUpperCase(),
    banner: saved?.logo || scheduleLogo || teamsByName[name]?.logo || null,
  });
  const winner = record.draw || record.winner === 'DRAW'
    ? 'DRAW'
    : record.winner === 'A' || record.winner === 'B'
      ? record.winner
      : (a.place === 1 ? 'A' : b.place === 1 ? 'B' : null);
  /* Only the five details the dashboard is meant to show: the Elo rating
     points, the score, the violations, who won (the WIN/LOSE badge above),
     and each team's chance of winning. */
  const stat = (p, other) => ({
    eloPoints: formatRating(p.finalPoints ?? p.prevPoints),
    eloChange: p.change == null ? null : `${p.change >= 0 ? '+' : ''}${Math.round(p.change * 100) / 100}`,
    score: p.points != null ? String(p.points) : (formatMinutes(p.minutes) ?? '—'),
    violation: p.totalViolations ?? 0,
    winChance: winChance(p, other),
  });
  return {
    id: `${schedule.id}-${record.id}`,
    sport: (schedule.sport || record.sportName || '').toUpperCase(),
    gender: displayCategory(schedule.category || record.category || '').toUpperCase(),
    date: formatDatePill(schedule.date),
    teamA: team(schedule.teamA, schedule.teamALogo, a),
    teamB: team(schedule.teamB, schedule.teamBLogo, b),
    winner,
    teamAStats: stat(a, b),
    teamBStats: stat(b, a),
  };
}

/* A time-scored record stores minutes as a float; show it the way the
   moderator typed it (mm:ss / hh:mm:ss) rather than as a raw decimal. */
function formatMinutes(mins) {
  if (mins == null || Number.isNaN(Number(mins))) return null;
  const totalSeconds = Math.round(Number(mins) * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function formatRating(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return String(Math.round(Number(value) * 100) / 100);
}

/* "Chance of winning" is the Elo expected score the moderator's own
   computation already saved with the record — the same E used in
   K(S − E). Older records without it are recomputed from both ratings. */
function winChance(team, opponent) {
  if (team?.expected != null && !Number.isNaN(Number(team.expected))) {
    return `${(Number(team.expected) * 100).toFixed(1)}%`;
  }
  const own = Number(team?.prevPoints);
  const opp = Number(opponent?.prevPoints);
  if (!Number.isFinite(own) || !Number.isFinite(opp)) return '—';
  const expected = 1 / (1 + Math.pow(10, (opp - own) / 400));
  return `${(expected * 100).toFixed(1)}%`;
}

function formatDatePill(dateStr) {
  const d = new Date(`${dateStr}T00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }).toUpperCase();
}

function formatTimePill(dateStr, timeStr) {
  if (!dateStr || !timeStr) return 'TBA';
  const d = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(d.getTime())) return timeStr;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}


const LEVELS = ['Elementary', 'High School', 'College'];

const CARD_W = 400;
const GAP    = 24;
const STEP   = CARD_W + GAP; // 424px per position slot

// Visual config per position index (-2 … +2)
const POS_STYLE = {
  '-2': { scale: 0.72, opacity: 0.20, brightness: 0.40, grayscale: 0.50, z: 1  },
  '-1': { scale: 0.82, opacity: 0.40, brightness: 0.55, grayscale: 0.30, z: 5  },
   '0': { scale: 1.00, opacity: 1.00, brightness: 1.00, grayscale: 0.00, z: 10 },
   '1': { scale: 0.82, opacity: 0.40, brightness: 0.55, grayscale: 0.30, z: 5  },
   '2': { scale: 0.72, opacity: 0.20, brightness: 0.40, grayscale: 0.50, z: 1  },
};

function TeamBanner({ team, size }) {
  const cls = `team-banner team-banner--${size}`;
  if (team.banner) {
    return (
      <div className={cls}>
        <img src={team.banner} alt={team.label} className="team-banner__img" draggable={false} />
      </div>
    );
  }
  return (
    <div className={`${cls} team-banner--placeholder`}>
      <span className="team-banner__label">{team.label}</span>
    </div>
  );
}

function OngoingCard({ match }) {
  return (
    <div className="ongoing-card">
      <div className="oc-banners">
        {match.matchLabel && (
          <div className="match-label-row"><span className="match-label-pill">{match.matchLabel}</span></div>
        )}
        <TeamBanner team={match.teamA} size="oc" />
        <TeamBanner team={match.teamB} size="oc" />
      </div>
      <div className="oc-footer">
        <div className="oc-date-row"><span className="date-pill">{match.date}</span></div>
        <div className="oc-teams-row">
          <span className="ft-label">{match.teamA.label}</span>
          <span className="ft-vs">VS</span>
          <span className="ft-label">{match.teamB.label}</span>
        </div>
        <div className="ft-venue">{match.sport} | {match.venue}</div>
      </div>
    </div>
  );
}

function UpcomingCard({ match }) {
  return (
    <div className="upcoming-card" tabIndex={0}>
      <div className="uc-banners">
        {match.matchLabel && (
          <div className="match-label-row"><span className="match-label-pill">{match.matchLabel}</span></div>
        )}
        <TeamBanner team={match.teamA} size="uc" />
        {match.teamB ? <TeamBanner team={match.teamB} size="uc" /> : <div className="tbd-slot" />}
      </div>
      <div className="uc-date-row"><span className="date-pill">{match.date}</span></div>
      <div className="uc-teams-row">
        <span className="ft-label">{match.teamA.label}</span>
        <span className="ft-vs">VS</span>
        {match.teamB && <span className="ft-label">{match.teamB.label}</span>}
      </div>
      <div className="uc-sport-row"><span className="sport-pill">{match.sport}</span></div>

      <div className="uc-hover-info">
        <div className="uc-hover-info__teams">
          {match.teamA.label}{match.teamB ? ` VS ${match.teamB.label}` : ''}
        </div>
        <div className="uc-hover-info__row"><FiClock /> {match.date} &middot; {match.time}</div>
        <div className="uc-hover-info__row"><FiMapPin /> {match.venue}</div>
        <span className="uc-hover-info__sport">{match.sport}</span>
      </div>
    </div>
  );
}

function FinishedCard({ match, isActive }) {
  const drawn = match.winner === 'DRAW' || match.winner == null;
  const winnerA = match.winner === 'A';
  const winnerB = match.winner === 'B';
  const resultLabel = (isWinner) => (drawn ? 'DRAW' : isWinner ? 'WIN' : 'LOSE');
  const resultClass = (isWinner) => (drawn ? 'fc-result--draw' : isWinner ? 'fc-result--win' : 'fc-result--lose');

  const StatRow = ({ label, icon: Icon, aVal, bVal, aWin, bWin }) => (
    <div className="fc-stat-row">
      <span className={`fc-stat-val ${aWin ? 'fc-stat-val--win' : ''}`}>{aVal}</span>
      <span className="fc-stat-label"><span className="fc-stat-icon"><Icon /></span>{label}</span>
      <span className={`fc-stat-val ${bWin ? 'fc-stat-val--win' : ''}`}>{bVal}</span>
    </div>
  );

  return (
    <div className={`finished-card ${isActive ? 'finished-card--active' : 'finished-card--side'}`}>
      <div className="fc-header">
        <div className="fc-sport">{match.sport} {match.gender}</div>
        <div className="fc-date">{match.date}</div>
      </div>
      <div className="fc-match">
        <div className="fc-team">
          <TeamBanner team={match.teamA} size={isActive ? 'fc' : 'fc-small'} />
          <span className="fc-team-name">{match.teamA.label}</span>
          <span className={`fc-result ${resultClass(winnerA)}`}>{resultLabel(winnerA)}</span>
        </div>
        <div className="fc-vs">VS</div>
        <div className="fc-team">
          <TeamBanner team={match.teamB} size={isActive ? 'fc' : 'fc-small'} />
          <span className="fc-team-name">{match.teamB.label}</span>
          <span className={`fc-result ${resultClass(winnerB)}`}>{resultLabel(winnerB)}</span>
        </div>
      </div>
      <div className="fc-stats">
        <StatRow label="Elo Rating"     icon={FiZap}           aVal={match.teamAStats.eloPoints}  bVal={match.teamBStats.eloPoints}  aWin={winnerA} bWin={winnerB} />
        <StatRow label="Points Gained"  icon={FiTrendingUp}    aVal={match.teamAStats.eloChange ?? '—'} bVal={match.teamBStats.eloChange ?? '—'} aWin={winnerA} bWin={winnerB} />
        <StatRow label="Score"          icon={FiStar}          aVal={match.teamAStats.score}      bVal={match.teamBStats.score}      aWin={winnerA} bWin={winnerB} />
        <StatRow label="Violation"      icon={FiAlertTriangle} aVal={match.teamAStats.violation}  bVal={match.teamBStats.violation}  aWin={winnerA} bWin={winnerB} />
        <StatRow label="Win Chance"     icon={FiAward}         aVal={match.teamAStats.winChance}  bVal={match.teamBStats.winChance}  aWin={winnerA} bWin={winnerB} />
      </div>
    </div>
  );
}

function FinishedCarousel({ matches }) {
  const total = matches.length;
  // `center` is the displayed active index (can be fractional during anim — we use it as integer)
  const [center, setCenter] = useState(0);
  const lockRef = useRef(false);
  const prevCenterRef = useRef(center);

  const wrapIdx = useCallback((i) => ((i % total) + total) % total, [total]);
  const wrapSigned = useCallback((i) => {
    const wrapped = ((i % total) + total) % total;
    return wrapped > total / 2 ? wrapped - total : wrapped;
  }, [total]);

  const go = useCallback((dir) => {
    if (lockRef.current) return;
    lockRef.current = true;
    setCenter(prev => {
      prevCenterRef.current = prev;
      return wrapIdx(prev + dir);
    });
    setTimeout(() => { lockRef.current = false; }, 420);
  }, [wrapIdx]);

  return (
    <section className="dash-section dash-section--finished">
      <div className="section-header">
        <h2 className="section-title">FINISHED MATCHES</h2>
        <div className="scroll-arrows">
          <button className="arrow-btn" onClick={() => go(-1)} aria-label="Scroll left"><FiChevronLeft /></button>
          <button className="arrow-btn" onClick={() => go(1)}  aria-label="Scroll right"><FiChevronRight /></button>
        </div>
      </div>

      <div className="finished-carousel">
        <div className="finished-carousel__track">
          {matches.map((match, matchIdx) => {
            const pos = wrapSigned(matchIdx - center);
            const ps = POS_STYLE[String(pos)] || {
              scale: 0.62, opacity: 0, brightness: 0.4, grayscale: 0.5, z: 0,
            };
            const tx = pos * STEP;
            const prevPos = wrapSigned(matchIdx - prevCenterRef.current);
            const isWrapped = Math.abs(pos - prevPos) > 2;

            const style = {
              transform: `translateX(${tx}px) scale(${ps.scale})`,
              opacity:   ps.opacity,
              filter:    `brightness(${ps.brightness}) grayscale(${ps.grayscale})`,
              zIndex:    ps.z,
              transition: isWrapped ? 'none' : undefined,
            };

            return (
              <div
                key={`slide-${match.id}`}
                className="finished-carousel__slide"
                style={style}
              >
                <FinishedCard
                  match={match}
                  isActive={matchIdx === center}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ScrollRow({ children, label, variant, isEmpty, emptyText }) {
  const ref = React.useRef(null);
  const scroll = (dir) => {
    if (ref.current) ref.current.scrollBy({ left: dir * 180, behavior: 'smooth' });
  };
  return (
    <section className={`dash-section dash-section--${variant}`}>
      <div className="section-header">
        <h2 className="section-title">{label}</h2>
        <div className="scroll-arrows">
          <button className="arrow-btn" onClick={() => scroll(-1)} aria-label="Scroll left">&#8249;</button>
          <button className="arrow-btn" onClick={() => scroll(1)}  aria-label="Scroll right">&#8250;</button>
        </div>
      </div>
      {isEmpty ? <p className="dash-empty">{emptyText}</p> : <div className="scroll-row" ref={ref}>{children}</div>}
    </section>
  );
}

function FinishedSportButtons({ sports, value, onChange }) {
  return (
    <label className="finished-sport-selector" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', margin: '0 0 1rem', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.78rem', fontWeight: 800, letterSpacing: '0.04em' }}>SPORT:</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Choose a sport for finished matches"
        style={{
          appearance: 'auto',
          border: '1px solid #f5b400',
          borderRadius: '999px',
          background: '#fff',
          color: '#333',
          cursor: 'pointer',
          fontSize: '0.82rem',
          fontWeight: 700,
          minHeight: '2.4rem',
          minWidth: '12rem',
          maxWidth: '100%',
          padding: '0.55rem 1rem',
        }}
      >
        <option value="ALL SPORTS">ALL SPORTS</option>
        {sports.map((sport) => <option key={sport} value={sport}>{sport}</option>)}
      </select>
    </label>
  );
}


export default function DashboardPage() {
  const contactFooterRef = useRef(null);

  const [levelLabel, setLevelLabel] = useState('High School');
  const [matches, setMatches] = useState([]);
  const [records, setRecords] = useState([]);
  const [teamsByName, setTeamsByName] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [finishedSport, setFinishedSport] = useState('ALL SPORTS');
  const [availableSports, setAvailableSports] = useState([]);
  const [now, setNow] = useState(() => new Date());

  const levelKey = LEVEL_KEY_BY_LABEL[levelLabel];

  // Reload whenever the selected level changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const [scheduleMatches, cfg] = await Promise.all([
          getMatchSchedules(levelKey),
          getSportsTeamsConfig(levelKey),
        ]);
        if (cancelled) return;
        let matchRecords = [];
        try {
          matchRecords = await getMatchRecords(levelKey);
        } catch (recordError) {
          // A schedule should remain visible even when records are unavailable
          // because of permissions, an older service build, or a transient error.
          console.warn('Finished match records unavailable:', recordError);
        }
        setMatches(scheduleMatches);
        setRecords(matchRecords || []);
        const byName = {};
        (cfg.teams || []).forEach(t => { byName[t.name] = t; });
        setTeamsByName(byName);
        setAvailableSports((cfg.sports || []).map(sport => (sport.name || '').trim().toUpperCase()).filter(Boolean).sort());
      } catch (e) {
        console.error('Failed to load matches for dashboard:', e);
        if (!cancelled) {
          setMatches([]);
          setRecords([]);
          setTeamsByName({});
          setAvailableSports([]);
          setLoadError('Unable to load the match schedule. Please refresh and try again.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [levelKey, refreshKey]);

  // Live on top of the fetch above — an admin deleting/editing a schedule
  // (or fulfilling a moderator's request) should drop off the dashboard
  // right away rather than waiting for the next 30s poll.
  useEffect(() => {
    const unsubscribe = subscribeMatchSchedules(levelKey, setMatches);
    return unsubscribe;
  }, [levelKey]);

  // Re-check the clock periodically so a match flips from Upcoming to
  // Ongoing (and out of Ongoing once it's over) without a page refresh.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // Moderator saves records independently from the schedule page. Refresh
  // both sources periodically so a newly finished match appears promptly.
  useEffect(() => {
    const t = setInterval(() => setRefreshKey(value => value + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const toCardTeam = (name, logo) => ({ label: (name || '').toUpperCase(), banner: logo || teamsByName[name]?.logo || null });

  const { ongoing, upcoming, finished } = useMemo(() => {
    const withWindow = matches
      .map(m => ({ m, w: matchWindow(m) }))
      .filter(x => x.w); // skip matches that have no date/time yet (generated but not scheduled)

    // The schedule is the source of truth. Walk scheduled fixtures first,
    // then attach at most one Moderator result to each fixture. This prevents
    // one record from being reused for several schedule cards.
    const uniqueRecords = Array.from(
      new Map(records.map(record => [recordIdentity(record), record])).values(),
    );
    const usedRecordKeys = new Set();
    const finishedMatches = withWindow
      .map(({ m, w }) => {
        const record = uniqueRecords.find(candidate => {
          const key = recordIdentity(candidate);
          return !usedRecordKeys.has(key) && recordMatchesSchedule(candidate, m);
        });
        if (!record) return null;
        usedRecordKeys.add(recordIdentity(record));
        return { m, w, record };
      })
      .filter(Boolean);
    const recordedIds = new Set(finishedMatches.map(({ m }) => m.id));

    const ongoingList = withWindow
      .filter(({ w }) => now >= w.start && now < w.end)
      .filter(({ m }) => !recordedIds.has(m.id))
      .sort((a, b) => a.w.start - b.w.start)
      .map(({ m }) => ({
        id: m.id,
        date: formatDatePill(m.date),
        teamA: toCardTeam(m.teamA, m.teamALogo),
        teamB: toCardTeam(m.teamB, m.teamBLogo),
        sport: (m.sport || '').toUpperCase(),
        venue: (m.location || 'TBA').toUpperCase(),
        matchLabel: m.matchLabel || null,
      }));

    const upcomingList = withWindow
      .filter(({ w }) => now < w.start)
      .filter(({ m }) => !recordedIds.has(m.id))
      .sort((a, b) => a.w.start - b.w.start)
      .map(({ m }) => ({
        id: m.id,
        date: formatDatePill(m.date),
        time: formatTimePill(m.date, m.time),
        venue: (m.location || 'TBA').toUpperCase(),
        teamA: toCardTeam(m.teamA, m.teamALogo),
        teamB: toCardTeam(m.teamB, m.teamBLogo),
        sport: (m.sport || '').toUpperCase(),
        matchLabel: m.matchLabel || null,
      }));

    const finishedList = finishedMatches
      .filter(({ record }) => !!record)
      .sort((a, b) => b.w.start - a.w.start)
      .map(({ m, record }) => finishedCardFrom(m, record, teamsByName));

    return { ongoing: ongoingList, upcoming: upcomingList, finished: finishedList };
  }, [matches, records, now, teamsByName]);

  const finishedSports = useMemo(
    () => Array.from(new Set([...availableSports, ...finished.map(match => match.sport)])).sort(),
    [availableSports, finished],
  );

  useEffect(() => {
    if (finishedSport !== 'ALL SPORTS' && !finishedSports.includes(finishedSport)) {
      setFinishedSport('ALL SPORTS');
    }
  }, [finishedSport, finishedSports]);

  const visibleFinished = useMemo(
    () => finishedSport === 'ALL SPORTS'
      ? finished
      : finished.filter(match => match.sport === finishedSport),
    [finished, finishedSport],
  );

  return (
    <div className="user-dashboard">
      <header className="dash-header">
        <h1 className="dash-header__title">SANTA RITA COLLEGE OF PAMPANGA, INC</h1>
      </header>
      <div className="profile-page-intro dash-intro-row">
        <div>
          <h2 className="profile-page-title">Home</h2>
          <p className="profile-page-subtitle">Browse for matches informations</p>
        </div>
        <LevelTabs
          levels={LEVELS}
          value={levelLabel}
          onChange={setLevelLabel}
          containerClassName="dash-lvltabs"
          tabClassName="dash-lvltab"
          activeClassName="dash-lvltab--active"
        />
      </div>
      <div className="dash-body">
        {loadError && <p className="dash-empty">{loadError}</p>}
        {loading && <p className="dash-empty">Loading matches…</p>}
        <ScrollRow
          label="ONGOING MATCHES"
          variant="ongoing"
          isEmpty={!loading && ongoing.length === 0}
          emptyText="No matches are ongoing right now."
        >
          {ongoing.map(m => <OngoingCard key={m.id} match={m} />)}
        </ScrollRow>
        <ScrollRow
          label="UPCOMING MATCHES"
          variant="upcoming"
          isEmpty={!loading && upcoming.length === 0}
          emptyText="No upcoming matches scheduled yet."
        >
          {upcoming.map(m => <UpcomingCard key={m.id} match={m} />)}
        </ScrollRow>
        {finished.length > 0 && (
          <>
            <div className="finished-sport-filter-wrap">
              <FinishedSportButtons
                sports={finishedSports}
                value={finishedSport}
                onChange={setFinishedSport}
              />
            </div>
            {visibleFinished.length > 0 && <FinishedCarousel matches={visibleFinished} />}
          </>
        )}
        <Contact contactFooterRef={contactFooterRef} />
      </div>
    </div>
  );
}
