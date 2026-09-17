import React, { useState, useRef, useEffect, useCallback, useMemo, useContext } from 'react';
import { FiAlertTriangle, FiChevronLeft, FiChevronRight, FiChevronDown, FiTrendingUp, FiClock, FiMapPin, FiCheckCircle } from 'react-icons/fi';
import { FaCrown } from 'react-icons/fa';
import './DashboardPage.css';
import Contact from '../public/Landing/Contact/Contact';
import { BrandingContext } from '../shared/context/BrandingContext';
import LevelTabs from '../shared/components/LevelTabs';
import { subscribeMatchSchedules, getMatchRecords, getSportsTeamsConfig } from '../shared/services/firestoreService';

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
  /* Only the details the dashboard is meant to show: final score, violation
     count, comeback flag, and each team's chance of winning (who won is
     already conveyed by the WIN/LOSE badge above). */
  const stat = (p, other) => ({
    score: p.points != null ? String(p.points) : (formatMinutes(p.minutes) ?? '—'),
    violation: p.totalViolations ?? 0,
    comeback: !!p.comeback,
    winChance: winChance(p, other),
  });
  return {
    id: `${schedule.id}-${record.id}`,
    sport: (schedule.sport || record.sportName || '').toUpperCase(),
    gender: displayCategory(schedule.category || record.category || '').toUpperCase(),
    date: formatDatePill(schedule.date),
    time: formatTimePill(schedule.date, schedule.time),
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

/* Full-width callout bar for a single team's notable stat (comeback or
   violation count) — a bold colored banner naming the team, instead of
   the old plain "Yes/No" or "3 | 2" two-column comparison row. Only
   rendered for a team that actually has something to call out (no
   "No"/"0" line for the side with nothing to show). */
function HighlightBar({ tone, icon: Icon, team, text }) {
  return (
    <div className={`fc-highlight fc-highlight--${tone}`}>
      <span className="fc-highlight-icon"><Icon /></span>
      <span className="fc-highlight-text">
        <strong>{team}</strong> {text}
      </span>
    </div>
  );
}

function FinishedCard({ match, isActive, width }) {
  const drawn = match.winner === 'DRAW' || match.winner == null;
  const winnerA = match.winner === 'A';
  const winnerB = match.winner === 'B';
  const resultLabel = (isWinner) => (drawn ? 'DRAW' : isWinner ? 'WIN' : 'LOSE');
  const resultClass = (isWinner) => (drawn ? 'fc-result--draw' : isWinner ? 'fc-result--win' : 'fc-result--lose');
  const hasTime = match.time && match.time !== 'TBA';

  return (
    <div
      className={`finished-card ${isActive ? 'finished-card--active' : 'finished-card--side'}`}
      style={{ width }}
    >
      {/* Ambient glow blobs sit behind everything else on the card (see
          .finished-card__glow in CSS) — .fc-content is the actual layout,
          kept in its own stacking layer above them. */}
      <span className="finished-card__glow finished-card__glow--a" aria-hidden="true" />
      <span className="finished-card__glow finished-card__glow--b" aria-hidden="true" />

      <div className="fc-content">
        <div className="fc-header">
          <span className="fc-sport">{match.sport} {match.gender}</span>
          <span className="fc-status"><FiCheckCircle className="fc-status-icon" />Finished</span>
        </div>
        <div className="fc-datetime">{match.date}{hasTime ? ` · ${match.time}` : ''}</div>

        <div className="fc-match">
          <div className={`fc-team ${winnerA ? 'fc-team--winner' : !drawn ? 'fc-team--loser' : ''}`}>
            <div className="fc-banner-wrap">
              {winnerA && <span className="fc-crown"><FaCrown /></span>}
              <TeamBanner team={match.teamA} size={isActive ? 'fc' : 'fc-small'} />
            </div>
            <span className="fc-team-name">{match.teamA.label}</span>
            <span className={`fc-result ${resultClass(winnerA)}`}>{resultLabel(winnerA)}</span>
          </div>
          <div className="fc-score">
            <span className={`fc-score-val ${winnerA ? 'fc-score-val--win' : !drawn ? 'fc-score-val--lose' : ''}`}>{match.teamAStats.score}</span>
            <span className="fc-score-sep">–</span>
            <span className={`fc-score-val ${winnerB ? 'fc-score-val--win' : !drawn ? 'fc-score-val--lose' : ''}`}>{match.teamBStats.score}</span>
          </div>
          <div className={`fc-team ${winnerB ? 'fc-team--winner' : !drawn ? 'fc-team--loser' : ''}`}>
            <div className="fc-banner-wrap">
              {winnerB && <span className="fc-crown"><FaCrown /></span>}
              <TeamBanner team={match.teamB} size={isActive ? 'fc' : 'fc-small'} />
            </div>
            <span className="fc-team-name">{match.teamB.label}</span>
            <span className={`fc-result ${resultClass(winnerB)}`}>{resultLabel(winnerB)}</span>
          </div>
        </div>

        {(match.teamAStats.comeback || match.teamBStats.comeback
          || match.teamAStats.violation > 0 || match.teamBStats.violation > 0) && (
          <div className="fc-highlights">
            {match.teamAStats.comeback && (
              <HighlightBar tone="comeback" icon={FiTrendingUp} team={match.teamA.label} text="ULTIMATE COMEBACK" />
            )}
            {match.teamBStats.comeback && (
              <HighlightBar tone="comeback" icon={FiTrendingUp} team={match.teamB.label} text="ULTIMATE COMEBACK" />
            )}
            {match.teamAStats.violation > 0 && (
              <HighlightBar
                tone="violation"
                icon={FiAlertTriangle}
                team={match.teamA.label}
                text={`${match.teamAStats.violation} VIOLATION${match.teamAStats.violation > 1 ? 'S' : ''}`}
              />
            )}
            {match.teamBStats.violation > 0 && (
              <HighlightBar
                tone="violation"
                icon={FiAlertTriangle}
                team={match.teamB.label}
                text={`${match.teamBStats.violation} VIOLATION${match.teamBStats.violation > 1 ? 'S' : ''}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FinishedCarousel({ matches, emptyText }) {
  const total = matches.length;
  // `center` is the displayed active index (can be fractional during anim — we use it as integer)
  const [center, setCenter] = useState(0);
  const lockRef = useRef(false);
  const prevCenterRef = useRef(center);

  // The carousel is built around a fixed 400px card (CARD_W) so the
  // coverflow peek effect has consistent geometry on desktop. On a phone
  // that's wider than the viewport, so the active card gets clipped by
  // the section's overflow: hidden and never reaches the screen edge.
  // Below the same mobile breakpoint used elsewhere in this file (600px),
  // shrink the card to the measured container width so the active slide
  // fills the screen; above it, always keep the desktop/laptop CARD_W
  // untouched regardless of how the container happens to measure.
  const containerRef = useRef(null);
  const [cardW, setCardW] = useState(CARD_W);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      if (window.innerWidth > 600) { setCardW(CARD_W); return; }
      setCardW(Math.min(CARD_W, el.clientWidth || CARD_W));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const step = cardW + GAP;

  // The list this carousel shows can change identity whenever the global
  // sport filter changes (a fresh, shorter/longer array). Without this, an
  // index picked under "All Sports" could point past the end of a smaller
  // filtered list, leaving no slide marked active.
  useEffect(() => {
    setCenter(0);
    prevCenterRef.current = 0;
  }, [matches]);

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
        {total > 0 && (
          <div className="scroll-arrows">
            <button className="arrow-btn" onClick={() => go(-1)} aria-label="Scroll left"><FiChevronLeft /></button>
            <button className="arrow-btn" onClick={() => go(1)}  aria-label="Scroll right"><FiChevronRight /></button>
          </div>
        )}
      </div>

      {total === 0 ? <p className="dash-empty">{emptyText}</p> : (
      <div className="finished-carousel" ref={containerRef}>
        <div className="finished-carousel__track" style={{ width: cardW }}>
          {matches.map((match, matchIdx) => {
            const pos = wrapSigned(matchIdx - center);
            const ps = POS_STYLE[String(pos)] || {
              scale: 0.62, opacity: 0, brightness: 0.4, grayscale: 0.5, z: 0,
            };
            const tx = pos * step;
            const prevPos = wrapSigned(matchIdx - prevCenterRef.current);
            const isWrapped = Math.abs(pos - prevPos) > 2;

            const style = {
              width:     cardW,
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
                  width={cardW}
                />
              </div>
            );
          })}
        </div>
      </div>
      )}
    </section>
  );
}

function ScrollRow({ children, label, variant, isEmpty, emptyText }) {
  const ref = React.useRef(null);
  const scroll = (dir) => {
    if (!ref.current) return;
    // On mobile, Upcoming shows one full-width match per view (CSS scroll-snap
    // makes swipe land on it too) — advance by a whole card, not the desktop
    // peek-next-card 180px nudge, so the arrow lands on the same match a swipe would.
    const step = variant === 'upcoming' && window.innerWidth <= 600 ? ref.current.clientWidth : 180;
    ref.current.scrollBy({ left: dir * step, behavior: 'smooth' });
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

/* Global Dashboard-wide sport filter — lives beside the level tabs in the
   header so it reads as "this controls the whole page", not just one
   section. Every section below (Ongoing/Upcoming/Finished) filters off
   the same `value`, so switching sports here can never leave one section
   showing a different sport than the others.
   Styled to match the landing page's Levels dropdown (compact glass
   pill trigger, translucent blurred panel with text list options)
   instead of a native <select>, so the sizing/arrangement reads the
   same way as the public homepage. */
function SportFilter({ sports, value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    const onClick = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const options = [{ key: 'ALL SPORTS', label: 'All Sports' }, ...sports.map((sport) => ({ key: sport, label: sport }))];
  const selected = options.find((o) => o.key === value);

  return (
    <div className="dash-sport-filter" ref={wrapRef}>
      <span className="dash-sport-filter__label">Sport</span>
      <div className="dash-sport-filter__dd">
        <button
          type="button"
          className="dash-sport-filter__trigger"
          onClick={() => setOpen((p) => !p)}
          aria-label="Filter the whole dashboard by sport"
        >
          <span>{selected ? selected.label : 'All Sports'}</span>
          <FiChevronDown className={`dash-sport-filter__arrow ${open ? 'dash-sport-filter__arrow--open' : ''}`} />
        </button>

        <div className={`dash-sport-filter__panel ${open ? 'dash-sport-filter__panel--open' : ''}`}>
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`dash-sport-filter__option ${o.key === value ? 'dash-sport-filter__option--active' : ''}`}
              onClick={() => { onChange(o.key); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


export default function DashboardPage() {
  const { schoolName } = useContext(BrandingContext);
  const contactFooterRef = useRef(null);

  const [levelLabel, setLevelLabel] = useState('High School');
  const [matches, setMatches] = useState([]);
  const [records, setRecords] = useState([]);
  const [teamsByName, setTeamsByName] = useState({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  // Global, page-wide sport filter — every section (Ongoing/Upcoming/
  // Finished) reads from this same value, so there is exactly one source
  // of truth for "which sport am I looking at" across the whole Dashboard.
  const [sportFilter, setSportFilter] = useState('ALL SPORTS');
  const [availableSports, setAvailableSports] = useState([]);
  const [now, setNow] = useState(() => new Date());

  const levelKey = LEVEL_KEY_BY_LABEL[levelLabel];

  // Reload whenever the selected level changes (or the 30s poll below
  // ticks). `matches` itself is NOT fetched here — the live listener right
  // below already keeps it current from the moment it subscribes (onSnapshot
  // fires immediately with the current data, then again on every change),
  // so re-fetching schedules here on every poll would just be the exact
  // same read the listener already made, twice over for every user, every
  // 30 seconds.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const cfg = await getSportsTeamsConfig(levelKey);
        if (cancelled) return;
        let matchRecords = [];
        try {
          matchRecords = await getMatchRecords(levelKey);
        } catch (recordError) {
          // A schedule should remain visible even when records are unavailable
          // because of permissions, an older service build, or a transient error.
          console.warn('Finished match records unavailable:', recordError);
        }
        setRecords(matchRecords || []);
        const byName = {};
        (cfg.teams || []).forEach(t => { byName[t.name] = t; });
        setTeamsByName(byName);
        setAvailableSports((cfg.sports || []).map(sport => (sport.name || '').trim().toUpperCase()).filter(Boolean).sort());
      } catch (e) {
        console.error('Failed to load dashboard data:', e);
        if (!cancelled) {
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

  // The sole source of `matches` — an admin deleting/editing a schedule (or
  // fulfilling a moderator's request) drops off the dashboard right away
  // rather than waiting for the next 30s poll.
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

  // The dropdown's options: every sport configured for this level, plus any
  // sport that only shows up in a match/record (older data, or a sport
  // since removed from config) so nothing silently becomes unfilterable.
  const filterSports = useMemo(
    () => Array.from(new Set([
      ...availableSports,
      ...ongoing.map(match => match.sport),
      ...upcoming.map(match => match.sport),
      ...finished.map(match => match.sport),
    ])).filter(Boolean).sort(),
    [availableSports, ongoing, upcoming, finished],
  );

  // Switching level can change which sports exist — fall back to "All
  // Sports" rather than silently filtering everything out on a sport that
  // no longer applies to the newly selected level.
  useEffect(() => {
    if (sportFilter !== 'ALL SPORTS' && !filterSports.includes(sportFilter)) {
      setSportFilter('ALL SPORTS');
    }
  }, [sportFilter, filterSports]);

  const visibleOngoing = useMemo(
    () => sportFilter === 'ALL SPORTS' ? ongoing : ongoing.filter(match => match.sport === sportFilter),
    [ongoing, sportFilter],
  );
  const visibleUpcoming = useMemo(
    () => sportFilter === 'ALL SPORTS' ? upcoming : upcoming.filter(match => match.sport === sportFilter),
    [upcoming, sportFilter],
  );
  const visibleFinished = useMemo(
    () => sportFilter === 'ALL SPORTS' ? finished : finished.filter(match => match.sport === sportFilter),
    [finished, sportFilter],
  );

  const sportSuffix = sportFilter === 'ALL SPORTS' ? '' : ` ${sportFilter}`;

  return (
    <div className="user-dashboard">
      <header className="dash-header">
        <h1 className="dash-header__title">{schoolName}</h1>
      </header>
      <div className="profile-page-intro dash-intro-row">
        <div>
          <h2 className="profile-page-title">Home</h2>
          <p className="profile-page-subtitle">Browse for matches informations</p>
        </div>
        <div className="dash-filters-row">
          <LevelTabs
            levels={LEVELS}
            value={levelLabel}
            onChange={setLevelLabel}
            containerClassName="dash-lvltabs"
            tabClassName="dash-lvltab"
            activeClassName="dash-lvltab--active"
          />
          <SportFilter sports={filterSports} value={sportFilter} onChange={setSportFilter} />
        </div>
      </div>
      <div className="dash-body">
        {loadError && <p className="dash-empty">{loadError}</p>}
        {loading && <p className="dash-empty">Loading matches…</p>}
        <ScrollRow
          label="ONGOING MATCHES"
          variant="ongoing"
          isEmpty={!loading && visibleOngoing.length === 0}
          emptyText={`No${sportSuffix} matches are ongoing right now.`}
        >
          {visibleOngoing.map(m => <OngoingCard key={m.id} match={m} />)}
        </ScrollRow>
        <ScrollRow
          label="UPCOMING MATCHES"
          variant="upcoming"
          isEmpty={!loading && visibleUpcoming.length === 0}
          emptyText={`No upcoming${sportSuffix} matches scheduled yet.`}
        >
          {visibleUpcoming.map(m => <UpcomingCard key={m.id} match={m} />)}
        </ScrollRow>
        {finished.length > 0 && (
          <FinishedCarousel
            matches={visibleFinished}
            emptyText={`No finished${sportSuffix} matches yet.`}
          />
        )}
        <Contact contactFooterRef={contactFooterRef} />
      </div>
    </div>
  );
}
