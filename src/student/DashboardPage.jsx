import React, { useState, useRef, useEffect, useCallback, useMemo, useContext, Children, isValidElement, cloneElement } from 'react';
import {
  parsePhoneNumberFromString,
  getCountries,
  getCountryCallingCode,
  validatePhoneNumberLength,
} from 'libphonenumber-js';
import {
  getAllProvinces,
  getProvinceByCode,
  getMunicipalitiesByProvince,
  getMunicipalityByCode,
  getBarangaysByMunicipality,
  getBarangayByCode,
} from '@aivangogh/ph-address';
import { FiAlertTriangle, FiChevronLeft, FiChevronRight, FiChevronDown, FiTrendingUp, FiClock, FiMapPin, FiCheckCircle } from 'react-icons/fi';
import { FaCrown } from 'react-icons/fa';
import './DashboardPage.css';
import Contact from '../public/Landing/Contact/Contact';
import { AuthContext } from '../shared/context/AuthContext';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import LevelTabs from '../shared/components/LevelTabs';
import { useLockedLevel, getSchoolLevel } from '../shared/utils/schoolLevel';
import { resizeImageToBlob } from '../shared/utils/resizeImage';
import { isRaceMatch, raceParticipants, raceStandingsFromRecord, recordCoversRace } from '../shared/utils/raceFormat';
import {
  resolveGrade,
  resolveRegistration,
  readRegistrationWorkbook,
  downloadRegistrationTemplate,
} from './registrationImport';
import {
  subscribeMatchSchedules,
  getMatchRecords,
  getSportsTeamsConfig,
  createRegistration,
  getEventRegistrationCounts,
  getEventKey,
} from '../shared/services/firestoreService';

/* ═══════════════════════════════════════════
   LIVE MATCH STATUS
   A saved match only has a start time (date + time), not a duration,
   so "ongoing" needs an assumed match length to know when it ends.
   Matches created by the schedule generator but not yet assigned a
   date/time (round-robin/bracket placeholders) are skipped entirely —
   they have nothing to compare against the clock yet.
═══════════════════════════════════════════ */
const ASSUMED_MATCH_MINUTES = 120; // 2 hours, matching the original mock's "7:00–9:00 AM" style windows

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
  if (isRaceMatch(schedule)) return recordCoversRace(record, schedule);
  const participants = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const names = participants.map(p => p?.name).filter(Boolean);
  return names.length >= 2
    && names.some(name => sameTeam(name, schedule.teamA))
    && names.some(name => sameTeam(name, schedule.teamB));
}

function finishedCardFrom(schedule, record, teamsByName) {
  const participants = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  /* A race has many teams but the card has two slots, so it shows the race's
     top two finishers (1st on the left) rather than an arbitrary pair. */
  const race = isRaceMatch(schedule);
  const podium = race ? raceStandingsFromRecord(record) : [];
  const byName = (name) => participants.find(p => sameTeam(p?.name, name));
  const nameA = race ? podium[0]?.name : schedule.teamA;
  const nameB = race ? podium[1]?.name : schedule.teamB;
  const a = (race ? byName(nameA) : byName(schedule.teamA)) || record.teamA || {};
  const b = (race ? byName(nameB) : byName(schedule.teamB)) || record.teamB || {};
  const team = (name, scheduleLogo, saved) => ({
    label: (name || '').toUpperCase(),
    banner: saved?.logo || scheduleLogo || teamsByName[name]?.logo || null,
  });
  const winner = race
    ? (podium[0] && podium[1] && podium[0].place === podium[1].place ? 'DRAW' : 'A')
    : record.draw || record.winner === 'DRAW'
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
    round: race
      ? `${raceParticipants(schedule).length}-TEAM RACE`
      : (schedule.stage || (schedule.round != null ? `Round ${schedule.round}` : '')).toUpperCase(),
    race,
    date: formatDatePill(schedule.date),
    time: formatTimePill(schedule.date, schedule.time),
    teamA: race ? team(nameA, null, a) : team(schedule.teamA, schedule.teamALogo, a),
    teamB: race ? team(nameB, null, b) : team(schedule.teamB, schedule.teamBLogo, b),
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

/* Times are wider than a points score, and hh:mm:ss wider still — shrink the
   score chip so both values stay between the two team discs. */
function scoreSizeClass(...scores) {
  const colons = Math.max(...scores.map((v) => (String(v ?? '').match(/:/g) || []).length));
  if (colons >= 2) return ' fc-score--time fc-score--long';
  return colons === 1 ? ' fc-score--time' : '';
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

/* Extra card fields for a Single-Race fixture: how many teams are in it and
   who they are (the card itself only has room for two banners). */
function raceCardFields(schedule, toCardTeam) {
  if (!isRaceMatch(schedule)) return {};
  const field = raceParticipants(schedule);
  const names = field.map(p => p.name.toUpperCase());
  return {
    raceCount: names.length,
    raceTeams: names,
    // One banner per team, so the card shows the whole field, not just two teams.
    raceBanners: field.map(p => toCardTeam(p.name, p.logo)),
  };
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

/* Every team in a race, joined with VS the same way a two-team card reads
   "RED DOORS VS GREEN PEAS". */
function RaceTeamNames({ names }) {
  return names.map((name, i) => (
    <React.Fragment key={`${name}-${i}`}>
      {i > 0 && <span className="ft-vs">VS</span>}
      <span className="ft-label">{name}</span>
    </React.Fragment>
  ));
}

function OngoingCard({ match }) {
  return (
    <div className={`ongoing-card${match.raceCount ? " ongoing-card--race" : ""}`} style={match.raceCount ? { "--race-n": match.raceCount } : undefined}>
      <div className="oc-banners">
        {match.matchLabel && (
          <div className="match-label-row"><span className="match-label-pill">{match.matchLabel}</span></div>
        )}
        {match.raceBanners ? (
          match.raceBanners.map((team, i) => <TeamBanner key={`${team.label}-${i}`} team={team} size="oc" />)
        ) : (
          <>
            <TeamBanner team={match.teamA} size="oc" />
            <TeamBanner team={match.teamB} size="oc" />
          </>
        )}
      </div>
      <div className="oc-footer">
        <div className="oc-date-row"><span className="date-pill">{match.date}</span></div>
        <div className="oc-teams-row">
          {match.raceCount ? (
            <RaceTeamNames names={match.raceTeams} />
          ) : (
            <>
              <span className="ft-label">{match.teamA.label}</span>
              <span className="ft-vs">VS</span>
              <span className="ft-label">{match.teamB.label}</span>
            </>
          )}
        </div>
        <div className="ft-venue">{match.sport} | {match.venue}</div>
      </div>
    </div>
  );
}

function UpcomingCard({ match }) {
  return (
    <div className={`upcoming-card${match.raceCount ? " upcoming-card--race" : ""}`} style={match.raceCount ? { "--race-n": match.raceCount } : undefined} tabIndex={0}>
      <div className="uc-banners">
        {match.matchLabel && (
          <div className="match-label-row"><span className="match-label-pill">{match.matchLabel}</span></div>
        )}
        {match.raceBanners ? (
          match.raceBanners.map((team, i) => <TeamBanner key={`${team.label}-${i}`} team={team} size="uc" />)
        ) : (
          <>
            <TeamBanner team={match.teamA} size="uc" />
            {match.teamB ? <TeamBanner team={match.teamB} size="uc" /> : <div className="tbd-slot" />}
          </>
        )}
      </div>
      <div className="uc-date-row"><span className="date-pill">{match.date}</span></div>
      <div className="uc-teams-row">
        {match.raceCount ? (
          <RaceTeamNames names={match.raceTeams} />
        ) : (
          <>
            <span className="ft-label">{match.teamA.label}</span>
            <span className="ft-vs">VS</span>
            {match.teamB && <span className="ft-label">{match.teamB.label}</span>}
          </>
        )}
      </div>
      <div className="uc-sport-row"><span className="sport-pill">{match.sport}</span></div>

      <div className="uc-hover-info">
        <div className="uc-hover-info__teams">
          {match.raceTeams
            ? match.raceTeams.join(', ')
            : `${match.teamA.label}${match.teamB ? ` VS ${match.teamB.label}` : ''}`}
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
  const resultLabel = (isWinner) => (match.race
    ? (drawn ? 'TIE' : isWinner ? '1ST' : '2ND')
    : (drawn ? 'DRAW' : isWinner ? 'WIN' : 'LOSE'));
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
        {match.round && <div className="fc-round">{match.round}</div>}

        <div className="fc-match">
          <div className={`fc-team ${winnerA ? 'fc-team--winner' : !drawn ? 'fc-team--loser' : ''}`}>
            <div className="fc-banner-wrap">
              {winnerA && <span className="fc-crown"><FaCrown /></span>}
              <TeamBanner team={match.teamA} size={isActive ? 'fc' : 'fc-small'} />
            </div>
            <span className="fc-team-name">{match.teamA.label}</span>
            <span className={`fc-result ${resultClass(winnerA)}`}>{resultLabel(winnerA)}</span>
          </div>
          <div className={`fc-score${scoreSizeClass(match.teamAStats.score, match.teamBStats.score)}`}>
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

// Coverflow shows 5 distinct slots (-2..2 in POS_STYLE); anything outside
// that range is hidden (opacity 0). The slot count below is padded well
// past 5 so the point where a card's position wraps from one side of 0 to
// the other (the "seam") always falls while that card is deep in hidden
// territory on both sides of the jump — see the `slots` comment for why
// that matters.
const MIN_SLOTS_TOTAL = 12;

function FinishedCarousel({ matches, emptyText }) {
  const total = matches.length;
  // With fewer than MIN_SLOTS_TOTAL real finished matches, cycling through
  // `matches` alone gives the position math too little room: the wrap seam
  // (see below) would sit right next to, or inside, the visible window,
  // so crossing it either leaves a peek slot empty or pops a card into
  // view with no slide animation. Repeat the real matches until there's
  // enough padding (each repetition gets its own id suffix so it's a
  // distinct, independently animatable slide) — content still only ever
  // cycles through the same real matches, just with enough copies that
  // every position is filled and the seam stays buried in hidden slots.
  const slots = useMemo(() => {
    if (total === 0 || total >= MIN_SLOTS_TOTAL) return matches;
    const repeatCount = Math.ceil(MIN_SLOTS_TOTAL / total);
    const out = [];
    for (let r = 0; r < repeatCount; r++) {
      matches.forEach(m => out.push({ ...m, id: `${m.id}__r${r}` }));
    }
    return out;
  }, [matches, total]);
  const slotsTotal = slots.length;
  // `center` only ever changes by ±1 per click; it's never wrapped back into
  // [0, slotsTotal) because each card's `pos` below is always recomputed
  // fresh from `center` via a bounded modulo, so it can't drift.
  const [center, setCenter] = useState(0);
  const lockRef = useRef(false);
  // Tracks each card's position as of the last render (match.id -> pos), so
  // we can tell which card just crossed the wrap seam and skip animating
  // it (a straight CSS transition would otherwise slide it visibly across
  // the whole carousel). An earlier version of this tried to avoid ever
  // recomputing a card's "true" wrapped position by always choosing
  // whichever representative was nearest to its own previous frame — but
  // with the arrows only ever moving `center` by 1, that just tracked the
  // true unwrapped raw index forever and never wrapped at all, so after
  // enough clicks in one direction every card drifted out of the visible
  // window for good (an empty carousel). Recomputing `pos` fresh each
  // render via a real bounded wrap (nearest-to-zero, not nearest-to-prev)
  // is what actually keeps the loop infinite; `prevPosRef` here is only
  // used to detect the seam crossing for the animation, not to derive pos.
  const prevPosRef = useRef(new Map());

  // The carousel is built around a fixed 400px card (CARD_W) so the
  // coverflow peek effect has consistent geometry on desktop. On a phone
  // that's wider than the viewport, so the active card gets clipped by
  // the section's overflow: hidden and never reaches the screen edge.
  // Below the same mobile breakpoint used elsewhere in this file (600px),
  // shrink the card to the measured container width so the active slide
  // fills the screen; above it, always keep the desktop/laptop CARD_W
  // untouched regardless of how the container happens to measure.
  // A plain useRef + mount-only effect would only ever observe whichever
  // DOM node existed the first time this ran. `.finished-carousel` unmounts
  // and remounts every time the sport filter toggles the match list between
  // empty and non-empty (see the `total === 0` branch below), which detaches
  // the observer from a node that's no longer in the DOM — cardW then stays
  // stuck at whatever it last measured instead of re-measuring the new node,
  // so the card visibly resizes wrong the next time matches reappear. A
  // callback ref stored in state makes the effect re-run (and reattach the
  // observer) every time the node itself is attached or detached.
  const [containerEl, setContainerEl] = useState(null);
  const containerRef = useCallback((node) => setContainerEl(node), []);
  const [cardW, setCardW] = useState(CARD_W);

  useEffect(() => {
    if (!containerEl) return;
    const update = () => {
      if (window.innerWidth > 600) { setCardW(CARD_W); return; }
      setCardW(Math.min(CARD_W, containerEl.clientWidth || CARD_W));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerEl);
    return () => ro.disconnect();
  }, [containerEl]);

  const step = cardW + GAP;

  // The list this carousel shows can change identity whenever the global
  // sport filter changes (a fresh, shorter/longer array). Without this, an
  // index picked under "All Sports" could point past the end of a smaller
  // filtered list, leaving no slide marked active.
  useEffect(() => {
    setCenter(0);
    prevPosRef.current = new Map();
  }, [matches]);

  const go = useCallback((dir) => {
    if (lockRef.current) return;
    lockRef.current = true;
    setCenter(prev => prev + dir);
    setTimeout(() => { lockRef.current = false; }, 420);
  }, []);

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
          {slots.map((match, matchIdx) => {
            const raw = matchIdx - center;
            const mod = ((raw % slotsTotal) + slotsTotal) % slotsTotal; // in [0, slotsTotal)
            const pos = mod > slotsTotal / 2 ? mod - slotsTotal : mod; // bounded, nearest to 0
            const prevPos = prevPosRef.current.has(match.id) ? prevPosRef.current.get(match.id) : pos;
            prevPosRef.current.set(match.id, pos);
            // The one card crossing the wrap seam this frame jumps by roughly
            // `slotsTotal`, not by 1 — skip its transition so it doesn't try
            // to slide across the whole carousel. Thanks to MIN_SLOTS_TOTAL's
            // padding, that card is already hidden (|pos| > 2) on both sides
            // of the jump, so skipping the animation there is invisible.
            const isWrapped = Math.abs(pos - prevPos) > 2;

            const ps = POS_STYLE[String(pos)] || {
              scale: 0.62, opacity: 0, brightness: 0.4, grayscale: 0.5, z: 0,
            };
            const tx = pos * step;

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
                  isActive={pos === 0}
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
  // Ongoing's arrows only nudged by a fixed 180px regardless of card width,
  // so seeing a whole card meant clicking several times. Dropped the
  // buttons here in favor of touch swipe (native on .scroll-row's
  // overflow-x), which now snaps one full card at a time on mobile — see
  // .dash-section--ongoing .ongoing-card's scroll-snap-align below.
  const showArrows = variant !== 'ongoing';
  return (
    <section className={`dash-section dash-section--${variant}`}>
      <div className="section-header">
        <h2 className="section-title">{label}</h2>
        {showArrows && (
          <div className="scroll-arrows">
            <button className="arrow-btn" onClick={() => scroll(-1)} aria-label="Scroll left">&#8249;</button>
            <button className="arrow-btn" onClick={() => scroll(1)}  aria-label="Scroll right">&#8250;</button>
          </div>
        )}
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


function HomeView({ onOpenRegistration }) {
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  const contactFooterRef = useRef(null);

  const LEVELS = useMemo(() => [
    { key: 'elementary', label: levelLabels.elementary },
    { key: 'highSchool', label: levelLabels.highSchool },
    { key: 'college', label: levelLabels.college },
  ], [levelLabels]);

  const lockedLevel = useLockedLevel();
  const [pickedLevel, setLevelKey] = useState('elementary');
  const levelKey = lockedLevel || pickedLevel;
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
        ...raceCardFields(m, toCardTeam),
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
        ...raceCardFields(m, toCardTeam),
      }));

    const finishedList = finishedMatches
      .filter(({ record }) => !!record)
      // Grouped by sport + division, each starting at Round 1 (the first
      // card) and running in round order; games without a round follow by time.
      .sort((a, b) => (
        String(a.m.sport || '').localeCompare(String(b.m.sport || ''))
        || String(a.m.category || '').localeCompare(String(b.m.category || ''))
        || ((a.m.round ?? Infinity) === (b.m.round ?? Infinity) ? 0 : (a.m.round ?? Infinity) < (b.m.round ?? Infinity) ? -1 : 1)
        || a.w.start - b.w.start
      ))
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
          <button type="button" className="dash-register-btn" onClick={onOpenRegistration}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
            Player Registration
          </button>
          {!lockedLevel && (
          <LevelTabs
            levels={LEVELS}
            value={levelKey}
            onChange={setLevelKey}
            containerClassName="dash-lvltabs"
            tabClassName="dash-lvltab"
            activeClassName="dash-lvltab--active"
          />
          )}
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
        <FinishedCarousel
          matches={visibleFinished}
          emptyText={`No finished${sportSuffix} matches yet.`}
        />
        <Contact contactFooterRef={contactFooterRef} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PLAYER REGISTRATION
   Moved here from the old /registration page. Opened from the
   "Player Registration" button on Home; form, validation and
   submission are unchanged.
═══════════════════════════════════════════ */
const GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12',
  '1st Year', '2nd Year', '3rd Year', '4th Year'];

/* Sport & Team options aren't hardcoded here — they come from whatever
   the admin has configured for the student's school level in the
   "Sports & Teams" manager (see SportsTeamsManager.jsx /
   getSportsTeamsConfig). Same source, same shape, for both dropdowns. */
function gradeLevelDisplayLabel(gradeLevel, levelLabels) {
  const label = levelLabels[getSchoolLevel(gradeLevel)];
  return label ? `${gradeLevel} (${label})` : gradeLevel;
}

// Region code ("PH", "US") -> display name ("Philippines", "United
// States"), via the browser's own locale data — no separate country-name
// dependency needed. Falls back to the bare code on older browsers.
const regionNamer = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;
function regionName(code) {
  if (!code) return '';
  try { return regionNamer ? regionNamer.of(code) : code; } catch { return code; }
}

// Country list for the phone-number Country dropdown below. There is no
// separate "countries API" anywhere in this project — this reuses
// libphonenumber-js (already installed for phone validation/formatting,
// see the numvalidate.com note further down), which ships every country's
// ISO code and calling code it supports (245 total), entirely offline —
// no network fetch, so no loading/error state actually applies here the
// way it would for a real remote API. Kept defensive anyway (empty-list
// fallback below) in case that ever changes.
const COUNTRY_OPTIONS = getCountries()
  .map((code) => ({ code, name: regionName(code), callingCode: getCountryCallingCode(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const DEFAULT_PHONE_COUNTRY = 'PH';

const SCHOOL_LEVEL_KEYS = ['elementary', 'highSchool', 'college'];

// Per-country phone number rules (length, validity) come from
// libphonenumber-js's own metadata via validatePhoneNumberLength — the
// same Google libphonenumber data numvalidate.com's now-retired free API
// used to wrap — instead of one fixed digit count for every country.
// Returns undefined when the length is fine, or 'TOO_SHORT' / 'TOO_LONG' /
// etc. otherwise (see libphonenumber-js docs for the full reason list).
function usePhoneFieldCheck(nationalNumber, country) {
  return useMemo(() => {
    if (!nationalNumber) return { lengthIssue: null, valid: null };

    const lengthIssue = validatePhoneNumberLength(nationalNumber, country);
    if (lengthIssue) return { lengthIssue, valid: false };

    const parsed = parsePhoneNumberFromString(nationalNumber, country);
    return {
      lengthIssue: null,
      valid: !!parsed && parsed.isValid(),
      internationalFormat: parsed?.formatInternational(),
    };
  }, [nationalNumber, country]);
}

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — keep in sync with storage.rules

const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const WAIVER_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function validateUpload(file, allowedTypes) {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return 'File is too large — max 5 MB.';
  }
  if (!allowedTypes.includes(file.type)) {
    return 'Unsupported file type.';
  }
  return null;
}

const INITIAL = {
  event: '',
  fullName: '', dob: '', age: '',
  gender: '',
  // `phoneCountry` is shared by Contact Number and Emergency Contact — one
  // Country dropdown drives both, since the two are almost always in the
  // same country and a second selector would just be more UI to keep in
  // sync. `contactNumber`/`emergencyContactPhone` are the derived E.164
  // strings (see composedContactNumber/composedEmergencyPhone) built from
  // phoneCountry + the national-number digits actually typed.
  phoneCountry: DEFAULT_PHONE_COUNTRY,
  contactNumberNational: '', contactNumber: '',
  address: '', emergencyContact: '',
  emergencyContactName: '', emergencyContactNational: '', emergencyContactPhone: '',
  gradeLevel: '', section: '',
  teamName: '', sport: '', position: '',
  message: '',
};

// Address is built from these PSGC picks (see @aivangogh/ph-address) plus a
// free-text street line, then joined into the single `form.address` string
// that Firestore/AdminSchedulePage already expect — see composedAddress below.
const ADDR_INITIAL = {
  provinceCode: '', municipalityCode: '', barangayCode: '', street: '',
};

// NCR is the one region in the PSGC dataset with no provinces — its 17
// cities (Manila, Quezon City, Makati, etc.) are filed directly under the
// region's own code. Modeled as one extra "province" entry so the whole
// country is reachable from a single Province dropdown.
const METRO_MANILA_CODE = '1300000000';
const METRO_MANILA_PSEUDO_PROVINCE = { name: 'Metro Manila', psgcCode: METRO_MANILA_CODE };

// Unfinished registrations are auto-saved to localStorage (per logged-in
// user, so two students on the same browser never see each other's draft)
// so a refresh or an accidental Back never loses what was already typed.
// This never touches Firestore — only the actual Save Registration submit
// does that — so there's no risk of a draft "save" ever creating a
// duplicate registration doc.
const DRAFT_KEY_PREFIX = 'stritas:registrationDraft:v1:';

function loadRegistrationDraft(uid) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + uid);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveRegistrationDraft(uid, draft) {
  try {
    localStorage.setItem(DRAFT_KEY_PREFIX + uid, JSON.stringify(draft));
  } catch {
    // Storage full/blocked (e.g. private browsing) — draft autosave is a
    // convenience, not a requirement, so fail silently.
  }
}

function clearRegistrationDraft(uid) {
  try {
    localStorage.removeItem(DRAFT_KEY_PREFIX + uid);
  } catch {
    // ignore
  }
}

function PlayerRegistration({ onBack }) {

  const { currentUser, userProfile } = useContext(AuthContext);
  const { schoolName, events } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  const [form, setForm] = useState(INITIAL);
  const [addr, setAddr] = useState(ADDR_INITIAL);
  const [photo, setPhoto]         = useState(null);
  const [waiver, setWaiver]       = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors]       = useState({});
  const [showNotice, setShowNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Set when the student attached a photo/waiver but the saved registration
  // doc came back without the matching URL — see handleSave's post-save
  // check below. Shown as a banner on the success screen, since the
  // registration itself did save.
  const [uploadIssues, setUploadIssues] = useState([]);
  // Excel template: which action is running ('download' | 'upload' | ''), and
  // the outcome of the last upload ({ filled, warnings } or { error }).
  const [excelBusy, setExcelBusy] = useState('');
  const [excelResult, setExcelResult] = useState(null);
  const excelInputRef = useRef(null);

  // Sport / Team options, sourced live from the admin's Sports & Teams
  // config for whichever school level the selected Grade/Year falls in.
  // Full objects are kept (not just names) so Team Name, Sport/Event, and
  // Position can be cross-filtered: a team only offers the sports in its
  // own sportIds, a sport only offers the teams that list it, and the
  // Position choices come from that sport's own configured position list.
  const [sportsConfig, setSportsConfig] = useState([]);
  const [teamsConfig, setTeamsConfig]   = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);

  // How many players have registered per event so far. Read from the
  // public siteCounters doc — students can't read the registrations
  // collection itself, so the count is published there instead.
  const [eventCounts, setEventCounts]     = useState({});
  const [countsLoading, setCountsLoading] = useState(true);

  // `minimums` guards the moment right after a submit: the counter is
  // bumped in the background, so a refresh that lands first would show
  // the pre-registration number and make the count appear to jump back.
  const loadEventCounts = useCallback((minimums) => {
    setCountsLoading(true);
    return getEventRegistrationCounts(events)
      .then((counts) => {
        const merged = { ...counts };
        Object.entries(minimums || {}).forEach(([key, value]) => {
          merged[key] = Math.max(Number(merged[key]) || 0, Number(value) || 0);
        });
        setEventCounts(merged);
      })
      .catch((error) => {
        console.error('Failed to load event registration counts:', error);
        setEventCounts({});
      })
      .finally(() => setCountsLoading(false));
  }, [events]);

  useEffect(() => { loadEventCounts(); }, [loadEventCounts]);

  const photoRef         = useRef(null);
  const waiverRef        = useRef(null);
  const contactFooterRef = useRef(null);
  const cardRef          = useRef(null);

  // ── Draft autosave/restore ────────────────────────────────────────────
  // `hydrated` flips true once we've attempted to restore a saved draft for
  // this user (found one or not) — the autosave effect below waits for that
  // so it never overwrites a real draft with the still-blank INITIAL state
  // while currentUser is resolving. `restoringDraftRef` tells the
  // schoolLevel-driven "clear team/sport/position" effect further down to
  // skip once right after a restore, so restoring a draft that already has
  // a grade level picked doesn't immediately wipe its team/sport/position.
  const [hydrated, setHydrated] = useState(false);
  const restoringDraftRef = useRef(false);
  // Files can't be persisted to localStorage (no way to reconstruct a real
  // File after a reload), so a restored draft that had one attached just
  // remembers its name and asks the student to re-attach it.
  const [restoredFileNames, setRestoredFileNames] = useState(null);

  useEffect(() => {
    // Wait for the profile too, so the sign-up details are available to
    // pre-fill below (AuthContext always sets one once a user is signed in).
    if (hydrated || !currentUser?.uid || !userProfile) return;
    const draft = loadRegistrationDraft(currentUser.uid);
    if (draft?.form) {
      restoringDraftRef.current = true;
      setForm(prev => ({ ...prev, ...draft.form }));
      if (draft.addr) setAddr(prev => ({ ...prev, ...draft.addr }));
      if (draft.pendingFileNames?.photo || draft.pendingFileNames?.waiver) {
        setRestoredFileNames(draft.pendingFileNames);
      }
    }
    // Pre-fill whatever the student already gave at sign-up (name, gender,
    // grade/year, section). Only fills fields still blank, so a restored
    // draft's own edits always win.
    const fromSignup = {
      fullName: userProfile.name,
      gender: ['Male', 'Female', 'Others'].includes(userProfile.gender) ? userProfile.gender : '',
      gradeLevel: GRADE_LEVELS.includes(userProfile.gradeLevel) ? userProfile.gradeLevel : '',
      section: userProfile.section,
    };
    setForm(prev => {
      const next = { ...prev };
      Object.entries(fromSignup).forEach(([k, v]) => {
        if (v && !next[k]) next[k] = v;
      });
      return next;
    });
    setHydrated(true);
  }, [currentUser?.uid, userProfile, hydrated]);

  useEffect(() => {
    if (!hydrated || !currentUser?.uid || submitted) return;
    const timer = setTimeout(() => {
      saveRegistrationDraft(currentUser.uid, {
        form,
        addr,
        pendingFileNames: { photo: photo?.name || null, waiver: waiver?.name || null },
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [form, addr, photo, waiver, hydrated, currentUser?.uid, submitted]);

  const set = (k) => (e) => {
    setForm(prev => ({ ...prev, [k]: e.target.value }));
    setErrors(prev => {
      if (!prev[k]) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });
  };

  // One Country dropdown drives both phone fields below it — changing it
  // re-validates whichever national numbers are already typed against the
  // newly selected country's rules (via contactNumberCheck/
  // emergencyPhoneCheck, which take phoneCountry as a dependency).
  const onPhoneCountryChange = (e) => {
    const phoneCountry = e.target.value;
    setForm(prev => ({ ...prev, phoneCountry }));
    setErrors(prev => {
      if (!prev.contactNumber && !prev.emergencyContact) return prev;
      const next = { ...prev };
      delete next.contactNumber;
      delete next.emergencyContact;
      return next;
    });
  };

  // Digits-only national number, capped at the selected country's own max
  // length (validatePhoneNumberLength) — typing a digit that would push
  // the number past what that country allows is simply rejected, rather
  // than silently accepted and only flagged as an error later. Backspacing
  // (or pasting something shorter) always goes through, so users can
  // always fix a number rather than getting stuck.
  const onNationalNumberChange = (nationalKey, errorKey) => (e) => {
    const digits = e.target.value.replace(/\D/g, '');
    setForm(prev => {
      if (digits.length > prev[nationalKey].length
          && validatePhoneNumberLength(digits, prev.phoneCountry) === 'TOO_LONG') {
        return prev;
      }
      return { ...prev, [nationalKey]: digits };
    });
    setErrors(prev => {
      if (!prev[errorKey]) return prev;
      const next = { ...prev };
      delete next[errorKey];
      return next;
    });
  };

  const onContactNationalChange = onNationalNumberChange('contactNumberNational', 'contactNumber');
  const onEmergencyNationalChange = onNationalNumberChange('emergencyContactNational', 'emergencyContact');

  // Emergency Contact is a name plus a phone number, entered as two
  // separate inputs but saved as the single "Name - +<number>" string
  // AdminSchedulePage/Firestore already expect (see composedEmergencyContact
  // below) — same split-inputs-compose-into-one-string approach as address.
  const onEmergencyNameChange = (e) => {
    const emergencyContactName = e.target.value;
    setForm(prev => ({ ...prev, emergencyContactName }));
    setErrors(prev => {
      if (!prev.emergencyContact) return prev;
      const next = { ...prev };
      delete next.emergencyContact;
      return next;
    });
  };

  const contactNumberCheck  = usePhoneFieldCheck(form.contactNumberNational, form.phoneCountry);
  const emergencyPhoneCheck = usePhoneFieldCheck(form.emergencyContactNational, form.phoneCountry);

  // Age is derived from Date of Birth rather than typed in directly —
  // keeps the two fields from disagreeing with each other.
  const calculateAge = (dobStr) => {
    if (!dobStr) return '';
    const dob = new Date(dobStr);
    if (Number.isNaN(dob.getTime())) return '';
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
    return age >= 0 ? String(age) : '';
  };

  const onDobChange = (e) => {
    const dob = e.target.value;
    setForm(prev => ({ ...prev, dob, age: calculateAge(dob) }));
    setErrors(prev => {
      if (!prev.dob && !prev.age) return prev;
      const next = { ...prev };
      delete next.dob;
      delete next.age;
      return next;
    });
  };

  // ── Address: cascading PSGC province -> city/municipality -> barangay,
  // plus a free-text street line. All lookups are synchronous and in-memory
  // (no network/loading state needed, unlike the sport/team config fetch
  // below).
  const provinceOptions = useMemo(() => {
    return [...getAllProvinces(), METRO_MANILA_PSEUDO_PROVINCE]
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const municipalityOptions = useMemo(
    () => (addr.provinceCode ? getMunicipalitiesByProvince(addr.provinceCode) : []),
    [addr.provinceCode]
  );

  const barangayOptions = useMemo(
    () => (addr.municipalityCode ? getBarangaysByMunicipality(addr.municipalityCode) : []),
    [addr.municipalityCode]
  );

  // The City of Manila itself carries no barangays directly in PSGC — its
  // districts (Binondo, Ermita, etc.) do, one level further down, which this
  // form doesn't model. Rather than block submission for that one city,
  // treat "no barangays for this municipality" as N/A, same as the old
  // province fallback.
  const noBarangaysForMunicipality = Boolean(addr.municipalityCode) && barangayOptions.length === 0;

  const composedAddress = useMemo(() => {
    const province = addr.provinceCode === METRO_MANILA_CODE
      ? METRO_MANILA_PSEUDO_PROVINCE
      : (addr.provinceCode ? getProvinceByCode(addr.provinceCode) : null);
    const municipality = addr.municipalityCode ? getMunicipalityByCode(addr.municipalityCode) : null;
    const barangay      = addr.barangayCode ? getBarangayByCode(addr.barangayCode) : null;

    return [
      addr.street.trim(),
      barangay ? `Brgy. ${barangay.name}` : '',
      municipality ? municipality.name : '',
      province ? province.name : '',
    ].filter(Boolean).join(', ');
  }, [addr]);

  // Keep form.address (what actually gets saved) in sync with the picks
  // above — createRegistration/firestoreService only know about a single
  // `address` string, same as before this feature existed.
  useEffect(() => {
    setForm(prev => (prev.address === composedAddress ? prev : { ...prev, address: composedAddress }));
  }, [composedAddress]);

  // Contact Number saved as a full E.164 string — phoneCountry's calling
  // code plus whatever national digits were typed. Empty until the user
  // actually types a national number, same as every other derived field
  // here (address, emergencyContact).
  const composedContactNumber = useMemo(() => (
    form.contactNumberNational
      ? `+${getCountryCallingCode(form.phoneCountry)}${form.contactNumberNational}`
      : ''
  ), [form.phoneCountry, form.contactNumberNational]);

  useEffect(() => {
    setForm(prev => (prev.contactNumber === composedContactNumber
      ? prev
      : { ...prev, contactNumber: composedContactNumber }));
  }, [composedContactNumber]);

  const composedEmergencyPhone = useMemo(() => (
    form.emergencyContactNational
      ? `+${getCountryCallingCode(form.phoneCountry)}${form.emergencyContactNational}`
      : ''
  ), [form.phoneCountry, form.emergencyContactNational]);

  useEffect(() => {
    setForm(prev => (prev.emergencyContactPhone === composedEmergencyPhone
      ? prev
      : { ...prev, emergencyContactPhone: composedEmergencyPhone }));
  }, [composedEmergencyPhone]);

  const composedEmergencyContact = useMemo(() => {
    const name  = form.emergencyContactName.trim();
    const phone = form.emergencyContactPhone;
    return [name, phone].filter(Boolean).join(' - ');
  }, [form.emergencyContactName, form.emergencyContactPhone]);

  // Same single-string requirement as address: createRegistration/
  // AdminSchedulePage only know about one `emergencyContact` field.
  useEffect(() => {
    setForm(prev => (prev.emergencyContact === composedEmergencyContact
      ? prev
      : { ...prev, emergencyContact: composedEmergencyContact }));
  }, [composedEmergencyContact]);

  const clearAddrError = (key) => setErrors(prev => {
    if (!prev[key]) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });

  const onProvinceChange = (e) => {
    setAddr(prev => ({ ...prev, provinceCode: e.target.value, municipalityCode: '', barangayCode: '' }));
    clearAddrError('province');
  };
  const onMunicipalityChange = (e) => {
    setAddr(prev => ({ ...prev, municipalityCode: e.target.value, barangayCode: '' }));
    clearAddrError('municipality');
  };
  const onBarangayChange = (e) => {
    setAddr(prev => ({ ...prev, barangayCode: e.target.value }));
    clearAddrError('barangay');
  };
  const onStreetChange = (e) => setAddr(prev => ({ ...prev, street: e.target.value }));

  const schoolLevel = getSchoolLevel(form.gradeLevel);

  useEffect(() => {
    let cancelled = false;

    if (!schoolLevel) {
      setSportsConfig([]);
      setTeamsConfig([]);
      return;
    }

    setLoadingOptions(true);
    getSportsTeamsConfig(schoolLevel)
      .then(({ sports, teams }) => {
        if (cancelled) return;
        setSportsConfig((sports || []).filter(s => s.name).slice().sort((a, b) => a.name.localeCompare(b.name)));
        setTeamsConfig((teams || []).filter(t => t.name).slice().sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch((error) => {
        console.error('Failed to load sports/teams config:', error);
        if (!cancelled) { setSportsConfig([]); setTeamsConfig([]); }
      })
      .finally(() => { if (!cancelled) setLoadingOptions(false); });

    return () => { cancelled = true; };
  }, [schoolLevel]);

  // Selected grade level changed school levels — clear any team/sport/
  // position pick that no longer belongs to the newly loaded options.
  // Skipped once right after a draft restore (see restoringDraftRef above),
  // so restoring a draft that already had a grade level + team/sport/
  // position picked doesn't immediately wipe them out again.
  useEffect(() => {
    if (restoringDraftRef.current) {
      restoringDraftRef.current = false;
      return;
    }
    setForm(prev => ({ ...prev, teamName: '', sport: '', position: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolLevel]);

  // Belt-and-suspenders: if the restored draft's grade level didn't actually
  // change schoolLevel (e.g. it was blank), the effect above never runs and
  // never gets a chance to consume the flag — clear it here instead so it
  // can't linger and swallow a later, genuine grade-level change.
  useEffect(() => {
    if (hydrated) restoringDraftRef.current = false;
  }, [hydrated]);

  const selectedTeamConfig = useMemo(
    () => teamsConfig.find(t => t.name === form.teamName) || null,
    [teamsConfig, form.teamName]
  );
  const selectedSportConfig = useMemo(
    () => sportsConfig.find(s => s.name === form.sport) || null,
    [sportsConfig, form.sport]
  );

  // Team Name and Sport cross-filter each other via each team's
  // sportIds (the sports that team actually plays, set by the admin in
  // Sports & Teams): picking one narrows the other down to a compatible
  // pick instead of letting the two disagree.
  const sportOptions = useMemo(() => {
    const names = sportsConfig.map(s => s.name);
    if (!selectedTeamConfig || !(selectedTeamConfig.sportIds || []).length) return names;
    const allowed = new Set(selectedTeamConfig.sportIds);
    return names.filter(n => allowed.has(n));
  }, [sportsConfig, selectedTeamConfig]);

  const teamOptions = useMemo(() => {
    const names = teamsConfig.map(t => t.name);
    if (!selectedSportConfig) return names;
    return names.filter(n => {
      const team = teamsConfig.find(t => t.name === n);
      return !(team?.sportIds || []).length || team.sportIds.includes(selectedSportConfig.name);
    });
  }, [teamsConfig, selectedSportConfig]);

  // Positions come from the selected sport's own admin-configured list
  // (Sports & Teams -> edit sport -> Positions). SportsTeamsManager tells
  // admins a sport with no positions set "falls back to a default list for
  // this sport" (see its "No positions set" note) — that fallback needs to
  // actually exist here, otherwise Position is a required field with zero
  // options and the sport becomes permanently unregistrable (e.g. an
  // individual sport like Track or Chess that nobody bothered to add
  // per-position labels to).
  const positionOptions = useMemo(() => {
    const configured = selectedSportConfig?.positions || [];
    if (configured.length) return configured;
    return selectedSportConfig ? ['Player'] : [];
  }, [selectedSportConfig]);

  const handleTeamChange = (e) => {
    const teamName = e.target.value;
    const team = teamsConfig.find(t => t.name === teamName);
    setForm(prev => {
      const sportStillValid = !team || !(team.sportIds || []).length || !prev.sport || team.sportIds.includes(prev.sport);
      return { ...prev, teamName, sport: sportStillValid ? prev.sport : '' };
    });
    setErrors(prev => {
      if (!prev.teamName) return prev;
      const next = { ...prev };
      delete next.teamName;
      return next;
    });
  };

  const handleSportChange = (e) => {
    const sportName = e.target.value;
    setForm(prev => {
      const team = teamsConfig.find(t => t.name === prev.teamName);
      const teamStillValid = !team || !(team.sportIds || []).length || !sportName || team.sportIds.includes(sportName);
      return { ...prev, sport: sportName, teamName: teamStillValid ? prev.teamName : '', position: '' };
    });
    setErrors(prev => {
      if (!prev.sport) return prev;
      const next = { ...prev };
      delete next.sport;
      return next;
    });
  };

  const handleFile = (setter, key, allowedTypes) => async (e) => {
    let file = e.target.files?.[0];
    if (!file) return;

    // Photos are recompressed client-side before every other check — a
    // phone-camera original easily runs 3-8 MB, well past the 5 MB rule
    // cap, and at full size 1,400 registrants' worth would blow past this
    // project's storage budget. Shrinking to a ~1000px JPEG here keeps
    // each upload in the tens-to-low-hundreds of KB instead.
    if (key === 'photo') {
      try {
        const blob = await resizeImageToBlob(file, { maxWidth: 1000, maxHeight: 1000, format: 'jpeg', quality: 0.75 });
        if (blob.size < file.size) {
          file = new File([blob], file.name, { type: blob.type });
        }
      } catch {
        // Compression failed (corrupt/unreadable image) — fall back to the
        // original file so the normal size/type validation below can
        // still catch it and show a proper error.
      }
    }

    const validationError = validateUpload(file, allowedTypes);
    if (validationError) {
      setter(null);
      e.target.value = ''; // let the user re-pick the same filename after fixing it
      setErrors(prev => ({ ...prev, [key]: validationError }));
      return;
    }

    setter(file);
    setErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setRestoredFileNames(prev => (prev?.[key] ? { ...prev, [key]: null } : prev));
  };

  const removeFile = (e, setter, key, ref) => {
    e.preventDefault();
    e.stopPropagation();
    setter(null);
    setErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setRestoredFileNames(prev => (prev?.[key] ? { ...prev, [key]: null } : prev));
    if (ref.current) ref.current.value = '';
  };

  const handleReset = () => {
    setForm(INITIAL);
    setAddr(ADDR_INITIAL);
    setPhoto(null);
    setWaiver(null);
    setSubmitted(false);
    setErrors({});
    setShowNotice(false);
    setRestoredFileNames(null);
    setExcelResult(null);
    if (photoRef.current)  photoRef.current.value  = '';
    if (waiverRef.current) waiverRef.current.value = '';
    if (currentUser?.uid) clearRegistrationDraft(currentUser.uid);
  };

  // ── Excel template: download a blank, upload a filled one ─────────────
  // Uploading never submits — it only pre-fills the form above, so the
  // student can review it, attach a photo/waiver, and press Save themselves
  // (all the normal validation still runs).
  const gradeOptions = useMemo(
    () => GRADE_LEVELS.map(g => ({ value: g, label: gradeLevelDisplayLabel(g, levelLabels) })),
    [levelLabels]
  );

  const sortedByName = (list) => (list || []).filter(x => x.name).slice().sort((a, b) => a.name.localeCompare(b.name));

  const handleDownloadTemplate = async () => {
    setExcelBusy('download');
    setExcelResult(null);
    try {
      // Every level's teams/sports go on a reference tab, since which ones a
      // player may pick depends on the grade they'll write in.
      const levels = await Promise.all(SCHOOL_LEVEL_KEYS.map(async (level) => {
        const label = levelLabels[level] || level;
        try {
          const { sports, teams } = await getSportsTeamsConfig(level);
          return { key: level, label, sports: sortedByName(sports), teams: sortedByName(teams) };
        } catch {
          return { key: level, label, sports: [], teams: [] };
        }
      }));
      await downloadRegistrationTemplate({
        events: events.map(ev => ev.label),
        grades: gradeOptions.map(g => ({ label: g.label, level: getSchoolLevel(g.value) })),
        countries: COUNTRY_OPTIONS.map(c => `${c.name} (+${c.callingCode})`),
        address: {
          provinces: provinceOptions,
          municipalitiesOf: getMunicipalitiesByProvince,
          barangaysOf: getBarangaysByMunicipality,
        },
        levels,
      });
    } catch (error) {
      console.error('Failed to build registration template:', error);
      setExcelResult({ error: "Couldn't create the template. Please try again." });
    } finally {
      setExcelBusy('');
    }
  };

  const handleExcelUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again after fixing it
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      setExcelResult({ error: 'Please upload the .xlsx template (Excel workbook).' });
      return;
    }

    setExcelBusy('upload');
    setExcelResult(null);
    try {
      const { raw, extraRows } = await readRegistrationWorkbook(file);

      // Team / Sport / Position depend on the grade's school level, which the
      // form may not have loaded yet — use what's loaded if the level matches,
      // otherwise fetch that level's config.
      const sheetGrade = raw.gradeLevel ? resolveGrade(raw.gradeLevel, gradeOptions) : '';
      const grade = sheetGrade || form.gradeLevel;
      const level = getSchoolLevel(grade);
      let sports = [], teams = [];
      if (level && level === schoolLevel) {
        sports = sportsConfig; teams = teamsConfig;
      } else if (level) {
        const cfg = await getSportsTeamsConfig(level);
        sports = sortedByName(cfg.sports); teams = sortedByName(cfg.teams);
      }

      const { form: f, addr: a, warnings } = resolveRegistration(raw, {
        events,
        gradeOptions,
        countries: COUNTRY_OPTIONS,
        address: {
          provinces: provinceOptions,
          municipalitiesOf: getMunicipalitiesByProvince,
          barangaysOf: getBarangaysByMunicipality,
        },
        sports,
        teams,
        currentGrade: form.gradeLevel,
        currentCountry: form.phoneCountry,
      });

      // The school-level effect above wipes team/sport/position whenever the
      // level changes; it has to skip this one change or it would erase what
      // was just imported. Anything the sheet didn't supply is cleared here
      // instead, since it belonged to the old level.
      const levelChanged = !!f.gradeLevel && getSchoolLevel(f.gradeLevel) !== schoolLevel;
      if (levelChanged) restoringDraftRef.current = true;

      setForm(prev => {
        const next = { ...prev, ...f };
        if (levelChanged) {
          next.teamName = f.teamName || '';
          next.sport = f.sport || '';
          next.position = f.position || '';
        } else if (f.sport && f.sport !== prev.sport && !f.position) {
          next.position = '';
        }
        if (f.dob) next.age = calculateAge(f.dob);
        return next;
      });

      // Same rule down the address chain: a new parent invalidates the old child.
      setAddr(prev => {
        const next = { ...prev };
        if (a.provinceCode !== undefined) {
          if (a.provinceCode !== prev.provinceCode) { next.municipalityCode = ''; next.barangayCode = ''; }
          next.provinceCode = a.provinceCode;
        }
        if (a.municipalityCode !== undefined) {
          if (a.municipalityCode !== next.municipalityCode) next.barangayCode = '';
          next.municipalityCode = a.municipalityCode;
        }
        if (a.barangayCode !== undefined) next.barangayCode = a.barangayCode;
        if (a.street !== undefined) next.street = a.street;
        return next;
      });

      setErrors({});
      setShowNotice(false);
      if (extraRows) warnings.push(`Your file has ${extraRows} more filled row${extraRows === 1 ? '' : 's'} — only the first one is used (one player per file).`);
      setExcelResult({ filled: Object.keys(f).length + Object.keys(a).length, warnings });
    } catch (error) {
      console.error('Failed to read registration workbook:', error);
      setExcelResult({ error: error.message || "Couldn't read that file. Make sure it's the registration template saved as .xlsx." });
    } finally {
      setExcelBusy('');
    }
  };

  const validate = () => {
    const errs = {};
    if (!form.event)                  errs.event            = 'Please select an event to register for';
    if (!form.fullName.trim())        errs.fullName        = 'Full name is required';
    if (!form.dob)                    errs.dob              = 'Date of birth is required';
    if (!form.age)                    errs.age              = 'Age is required';
    else if (Number(form.age) <= 0)   errs.age              = 'Enter a valid age';
    else if (Number(form.age) < 5 || Number(form.age) > 40)
                                       errs.age              = 'Age must be between 5 and 40';
    if (!form.gender)                 errs.gender           = 'Please select a gender';

    const phoneCountryName = COUNTRY_OPTIONS.find(c => c.code === form.phoneCountry)?.name || form.phoneCountry;
    const phoneFieldError = (check) => {
      if (check.lengthIssue === 'TOO_SHORT') return `Too short for ${phoneCountryName} — check the number`;
      if (check.lengthIssue === 'TOO_LONG')  return `Too long for ${phoneCountryName} — check the number`;
      if (check.lengthIssue)                 return 'Enter a valid phone number';
      if (!check.valid)                      return `Not a valid ${phoneCountryName} phone number`;
      return null;
    };

    if (!form.contactNumberNational)  errs.contactNumber    = 'Contact number is required';
    else {
      const err = phoneFieldError(contactNumberCheck);
      if (err) errs.contactNumber = err;
    }
    if (!addr.provinceCode)           errs.province         = 'Please select a province';
    if (!addr.municipalityCode)       errs.municipality     = 'Please select a city / municipality';
    if (!noBarangaysForMunicipality && !addr.barangayCode)
                                       errs.barangay         = 'Please select a barangay';
    if (!form.emergencyContactName.trim())
                                       errs.emergencyContact = 'Emergency contact name is required';
    else if (!form.emergencyContactNational)
                                       errs.emergencyContact = 'Emergency contact number is required';
    else {
      const err = phoneFieldError(emergencyPhoneCheck);
      if (err) errs.emergencyContact = err;
    }
    if (!form.gradeLevel)             errs.gradeLevel       = 'Please select a grade / year level';
    if (!form.section.trim())         errs.section          = 'Please enter a section';
    if (!form.teamName)               errs.teamName         = 'Please select a team';
    if (!form.sport)                  errs.sport            = 'Please select a sport';
    if (!form.position)               errs.position         = 'Please select a position';
    // Waiver upload is temporarily optional: Firebase Storage isn't
    // provisioned on the project yet (requires the Blaze plan), so there's
    // nowhere to save the file. Re-add this check once Storage is enabled.
    return errs;
  };

 const handleSave = async (e) => {
    e.preventDefault();

    // Guards a fast double-click/double-Enter in case the disabled
    // attribute on the submit button doesn't catch it in time.
    if (submitting) return;

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      setShowNotice(true);
      if (cardRef.current) {
        cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    setShowNotice(false);

    try {

        if (!currentUser) {
            alert("Please login first.");
            return;
        }

        setSubmitting(true);

        // form.contactNumber and form.emergencyContact are already kept in
        // sync by the compose effects above (phoneCountry + national
        // digits -> full E.164 / "Name - +<number>"), so `form` itself is
        // already submission-ready — no extra normalization needed here.
        const result = await createRegistration(
            currentUser.uid,
            currentUser.email,
            form,
            photo,
            waiver,
            userProfile?.role || 'student',
            events
        );

        // createRegistration uploads the photo/waiver to Storage but never
        // lets an upload failure fail the registration itself (see
        // uploadFile in firestoreService.js) — it just saves a null URL.
        // createRegistration now returns those URLs directly (alongside the
        // doc ref) so the success screen can flag a failed attachment
        // without reading the saved doc back — students can't read their
        // own registration (firestore.rules only allows staff to read
        // `registrations`), so a read-back here would always fail closed.
        const attachedIssues = [];
        if (photo && !result.photoURL) attachedIssues.push('photo');
        if (waiver && !result.waiverURL) attachedIssues.push('waiver');
        setUploadIssues(attachedIssues);

        setSubmitted(true);
        clearRegistrationDraft(currentUser.uid);
        setRestoredFileNames(null);

        // Show the new number straight away, then re-sync with the
        // server so the displayed count matches what was actually saved.
        const chosenKey = getEventKey(form.event, events);
        if (chosenKey) {
          const next = (Number(eventCounts[chosenKey]) || 0) + 1;
          setEventCounts(prev => ({ ...prev, [chosenKey]: next }));
          loadEventCounts({ [chosenKey]: next });
        } else {
          loadEventCounts();
        }

    } catch (error) {
        console.error(error);
        alert(error.message);
    } finally {
        setSubmitting(false);
    }
};

  if (submitted) {
    return (
      <div className="reg-page">
        <header className="reg-dash-header">
          <h1 className="reg-dash-header__title">{schoolName}</h1>
        </header>
        <div className="reg-page-intro">
          <button type="button" className="reg-back-btn" onClick={onBack}>&larr; Back to Home</button>
          <h2 className="reg-page-title">Player Registration</h2>
          <p className="reg-page-subtitle">Submit your player details to join a team and sport event</p>
        </div>
        <div className="reg-body">
          <div className="reg-card reg-card--success">
            <div className="reg-card__head">
              <div className="reg-card__icon">
                <svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 20.6 7.4 19.2 6z"/></svg>
              </div>
              <h2 className="reg-card__title">Registration Submitted</h2>
            </div>

            <p className="reg-success__text">
              Your registration for <strong>{form.event || 'the event'}</strong> has been received.
              You'll be notified once it's reviewed.
            </p>

            {uploadIssues.length > 0 && (
              <div className="reg-notice" role="alert">
                <svg className="reg-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2 1 21h22L12 2zm0 5.5 6.9 12H5.1L12 7.5zM11 10v5h2v-5h-2zm0 6.5V18h2v-1.5h-2z"/>
                </svg>
                <span>
                  Your registration was saved, but your {uploadIssues.join(' and ')} did not upload
                  successfully. Please contact the registration desk, or a staff member will follow up with you.
                </span>
              </div>
            )}

            <div className="reg-event-counts">
              <span className="reg-event-counts__title">Players Registered per Event</span>
              <div className="reg-event-counts__chips">
                {events.map(ev => (
                  <div
                    key={ev.key}
                    className={`reg-event-chip${form.event === ev.label ? ' reg-event-chip--active' : ''}`}
                  >
                    <span className="reg-event-chip__num">
                      {countsLoading ? '…' : (Number(eventCounts[ev.key]) || 0)}
                    </span>
                    <span className="reg-event-chip__label">{ev.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="reg-divider" />

            <button className="reg-btn-save" onClick={onBack}>
              &larr; Back to Home
            </button>
          </div>
          <Contact contactFooterRef={contactFooterRef} />
        </div>
      </div>
    );
  }

  return (
    <div className="reg-page">
      <header className="reg-dash-header">
        <h1 className="reg-dash-header__title">{schoolName}</h1>
      </header>

      <div className="reg-page-intro">
        <button type="button" className="reg-back-btn" onClick={onBack}>&larr; Back to Home</button>
        <h2 className="reg-page-title">Player Registration</h2>
        <p className="reg-page-subtitle">Submit your player details to join a team and sport event</p>
      </div>

      <div className="reg-body">
        <div className="reg-card" ref={cardRef}>
          <div className="reg-card__head">
            <div className="reg-card__icon">
              <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
            </div>
            <h2 className="reg-card__title">Player Registration</h2>
          </div>

          {showNotice && Object.keys(errors).length > 0 && (
            <div className="reg-notice" role="alert">
              <svg className="reg-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 1 21h22L12 2zm0 5.5 6.9 12H5.1L12 7.5zM11 10v5h2v-5h-2zm0 6.5V18h2v-1.5h-2z"/>
              </svg>
              <span>Please fill in all required fields marked with <strong>*</strong> before submitting.</span>
            </div>
          )}

          {(restoredFileNames?.photo || restoredFileNames?.waiver) && (
            <div className="reg-notice" role="status">
              <svg className="reg-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 1 21h22L12 2zm0 5.5 6.9 12H5.1L12 7.5zM11 10v5h2v-5h-2zm0 6.5V18h2v-1.5h-2z"/>
              </svg>
              <span>
                We restored your unfinished registration, but attached files can't be restored after a
                refresh — please re-attach {[
                  restoredFileNames.photo && `your photo (${restoredFileNames.photo})`,
                  restoredFileNames.waiver && `your waiver (${restoredFileNames.waiver})`,
                ].filter(Boolean).join(' and ')}.
              </span>
            </div>
          )}

          <div className="reg-import">
            <div className="reg-import__text">
              <strong>Prefer Excel?</strong>
              <span>
                Download the template, fill it in, then upload it — the form below fills itself in
                for you to review. Your photo and waiver are still attached here.
              </span>
            </div>
            <div className="reg-import__actions">
              <button type="button" className="reg-btn-reset" onClick={handleDownloadTemplate} disabled={!!excelBusy}>
                {excelBusy === 'download' ? 'Preparing…' : 'Download Template'}
              </button>
              <button type="button" className="reg-btn-save" onClick={() => excelInputRef.current?.click()} disabled={!!excelBusy}>
                {excelBusy === 'upload' ? 'Reading…' : 'Upload Filled Template'}
              </button>
              <input
                type="file"
                accept=".xlsx"
                ref={excelInputRef}
                onChange={handleExcelUpload}
                hidden
              />
            </div>
          </div>

          {excelResult?.error && (
            <div className="reg-notice" role="alert">
              <svg className="reg-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 1 21h22L12 2zm0 5.5 6.9 12H5.1L12 7.5zM11 10v5h2v-5h-2zm0 6.5V18h2v-1.5h-2z"/>
              </svg>
              <span>{excelResult.error}</span>
            </div>
          )}

          {excelResult && !excelResult.error && (
            <div className="reg-notice reg-notice--ok" role="status">
              <svg className="reg-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 20.6 7.4 19.2 6z"/>
              </svg>
              <span>
                Filled in {excelResult.filled} field{excelResult.filled === 1 ? '' : 's'} from your Excel file.
                Please review everything below before saving.
                {excelResult.warnings.length > 0 && (
                  <>
                    {' '}These need your attention:
                    <ul className="reg-notice__list">
                      {excelResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </>
                )}
              </span>
            </div>
          )}

          <form className="reg-form" onSubmit={handleSave} noValidate>

            {/* Row 0: Which event is this registration for?
                Intramurals, Sportsfest and Prisaa all use this exact
                same form — the dropdown just tags the registration. */}
            <div className="reg-event-block">
              <div className="reg-event-block__grid">
                <Field label="Register For Event" required error={errors.event}>
                  <select className="reg-select" value={form.event} onChange={set('event')} required>
                    <option value="">Select Event</option>
                    {events.map(ev => (
                      <option key={ev.key} value={ev.label}>{ev.label}</option>
                    ))}
                  </select>
                  <span className="reg-event-hint">
                    All events use this same registration form — pick the one you're joining.
                  </span>
                </Field>

                <div className="reg-event-counts">
                  <span className="reg-event-counts__title">Players Registered per Event</span>
                  <div className="reg-event-counts__chips">
                    {events.map(ev => (
                      <div
                        key={ev.key}
                        className={`reg-event-chip${form.event === ev.label ? ' reg-event-chip--active' : ''}`}
                      >
                        <span className="reg-event-chip__num">
                          {countsLoading ? '…' : (Number(eventCounts[ev.key]) || 0)}
                        </span>
                        <span className="reg-event-chip__label">{ev.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Row 1: Full Name / DOB / Age */}
            <div className="reg-row reg-row--3">
              <Field label="Full Name" required error={errors.fullName}>
                <input className="reg-input" placeholder="Last Name, First Name, Middle Name"
                  value={form.fullName} onChange={set('fullName')} required />
              </Field>
              <Field label="Date of Birth" required error={errors.dob}>
                <input className="reg-input" type="date"
                  value={form.dob} onChange={onDobChange} required />
              </Field>
              <Field label="Age" required error={errors.age}>
                <input className="reg-input" type="number" placeholder="Enter Age" min={5} max={40}
                  value={form.age} readOnly required />
              </Field>
            </div>

            {/* Row 2: Contact Number / Emergency Contact / Gender —
                every "how to reach the student or family" field in one row. */}
            <div className="reg-row reg-row--3eq">
              <Field label="Contact Number" required error={errors.contactNumber}>
                <select className="reg-select" value={form.phoneCountry} onChange={onPhoneCountryChange} required>
                  {COUNTRY_OPTIONS.length === 0 ? (
                    <option value="">No countries available</option>
                  ) : (
                    COUNTRY_OPTIONS.map(c => (
                      <option key={c.code} value={c.code}>{c.name} (+{c.callingCode})</option>
                    ))
                  )}
                </select>
                <span className="reg-phone-hint">Country also applies to Emergency Contact below</span>
                <div className="reg-phone-row">
                  <span className="reg-phone-prefix">+{getCountryCallingCode(form.phoneCountry)}</span>
                  <input className="reg-input" type="tel" inputMode="numeric" placeholder="National number"
                    value={form.contactNumberNational} onChange={onContactNationalChange} required />
                </div>
                <PhoneHint value={form.contactNumberNational} check={contactNumberCheck} />
              </Field>
              <Field label="Emergency Contact" required error={errors.emergencyContact}>
                <input className="reg-input" placeholder="Contact person's name"
                  value={form.emergencyContactName} onChange={onEmergencyNameChange} required />
                <div className="reg-phone-row">
                  <span className="reg-phone-prefix">+{getCountryCallingCode(form.phoneCountry)}</span>
                  <input className="reg-input" type="tel" inputMode="numeric" placeholder="National number"
                    value={form.emergencyContactNational} onChange={onEmergencyNationalChange} required />
                </div>
                <PhoneHint value={form.emergencyContactNational} check={emergencyPhoneCheck} />
              </Field>
              <Field label="Gender" required error={errors.gender}>
                <div className="reg-radio-group">
                  {['Male', 'Female', 'Others'].map(g => (
                    <label className="reg-radio-label" key={g}>
                      <input type="radio" name="gender" value={g}
                        checked={form.gender === g} onChange={set('gender')} />
                      {g}
                    </label>
                  ))}
                </div>
              </Field>
            </div>

            {/* Row 3: Address — Province / City-Municipality / Barangay / Street,
                kept together as one self-contained row. */}
            <div className="reg-row reg-row--4">
              <Field label="Province" required error={errors.province}>
                <select className="reg-select" value={addr.provinceCode} onChange={onProvinceChange} required>
                  <option value="">Select Province</option>
                  {provinceOptions.map(p => (
                    <option key={p.psgcCode} value={p.psgcCode}>{p.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="City / Municipality" required error={errors.municipality}>
                <select
                  className="reg-select"
                  value={addr.municipalityCode}
                  onChange={onMunicipalityChange}
                  disabled={!addr.provinceCode}
                  required
                >
                  <option value="">
                    {!addr.provinceCode ? 'Select Province first' : 'Select City / Municipality'}
                  </option>
                  {municipalityOptions.map(m => (
                    <option key={m.psgcCode} value={m.psgcCode}>{m.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Barangay" required={!noBarangaysForMunicipality} error={errors.barangay}>
                <select
                  className="reg-select"
                  value={noBarangaysForMunicipality ? '' : addr.barangayCode}
                  onChange={onBarangayChange}
                  disabled={!addr.municipalityCode || noBarangaysForMunicipality}
                  required={!noBarangaysForMunicipality}
                >
                  <option value="">
                    {!addr.municipalityCode
                      ? 'Select City / Municipality first'
                      : noBarangaysForMunicipality
                        ? 'N/A for this city'
                        : 'Select Barangay'}
                  </option>
                  {barangayOptions.map(b => (
                    <option key={b.psgcCode} value={b.psgcCode}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="House No. / Street / Unit">
                <input className="reg-input" placeholder="e.g. 123 Rizal St., Purok 2 (optional)"
                  value={addr.street} onChange={onStreetChange} />
              </Field>
            </div>

            {/* Row 4: Grade / Section */}
            <div className="reg-row reg-row--2">
              <Field label="Grade / Year Level" required error={errors.gradeLevel}>
                <select className="reg-select" value={form.gradeLevel} onChange={set('gradeLevel')} required>
                  <option value="">Select Grade / Year Level</option>
                  {GRADE_LEVELS.map(g => <option key={g} value={g}>{gradeLevelDisplayLabel(g, levelLabels)}</option>)}
                </select>
              </Field>
              <Field label="Section" required error={errors.section}>
                <input
                  className="reg-input"
                  placeholder="e.g. Section A"
                  value={form.section}
                  onChange={set('section')}
                  required
                />
              </Field>
            </div>

            {/* Row 5: Team / Sport / Position */}
            <div className="reg-row reg-row--3eq">
              <Field label="Team Name" required error={errors.teamName}>
                <select
                  className="reg-select"
                  value={form.teamName}
                  onChange={handleTeamChange}
                  disabled={!schoolLevel || loadingOptions}
                  required
                >
                  <option value="">
                    {!schoolLevel
                      ? 'Select Grade / Year Level first'
                      : loadingOptions
                        ? 'Loading teams…'
                        : teamOptions.length === 0
                          ? 'No teams configured yet'
                          : 'Select Team'}
                  </option>
                  {teamOptions.map(t => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Sport" required error={errors.sport}>
                <select
                  className="reg-select"
                  value={form.sport}
                  onChange={handleSportChange}
                  disabled={!schoolLevel || loadingOptions}
                  required
                >
                  <option value="">
                    {!schoolLevel
                      ? 'Select Grade / Year Level first'
                      : loadingOptions
                        ? 'Loading sports…'
                        : sportOptions.length === 0
                          ? 'No sports configured yet'
                          : 'Select Sport'}
                  </option>
                  {sportOptions.map(s => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Position" required error={errors.position}>
                <select
                  className="reg-select"
                  value={form.position}
                  onChange={set('position')}
                  disabled={!form.sport || positionOptions.length === 0}
                  required
                >
                  <option value="">
                    {!form.sport
                      ? 'Select Sport first'
                      : positionOptions.length === 0
                        ? 'No positions configured for this sport yet'
                        : 'Select Position'}
                  </option>
                  {positionOptions.map(p => <option key={p}>{p}</option>)}
                </select>
              </Field>
            </div>

            {/* Row 6: Uploads + Message */}
            <div className="reg-uploads-row">
              <Field label="Upload Photo" error={errors.photo}>
                <label className={`reg-upload-box${photo ? ' reg-upload-box--filled' : ''}`}>
                  <input type="file" accept="image/*" ref={photoRef} onChange={handleFile(setPhoto, 'photo', PHOTO_MIME_TYPES)} disabled={!!photo} />
                  <div className="reg-upload-icon">👤</div>
                  {photo
                    ? (
                      <span className="reg-upload-preview">
                        {photo.name}
                        <button type="button" className="reg-upload-remove" onClick={(e) => removeFile(e, setPhoto, 'photo', photoRef)} aria-label="Remove photo" />
                      </span>
                    )
                    : (
                      <>
                        <span className="reg-upload-caption">Click to upload photo</span>
                        <span className="reg-upload-sub">JPG, PNG, max 5 MB</span>
                      </>
                    )
                  }
                </label>
              </Field>

              <Field label="Upload Waiver / Consent Form" error={errors.waiver}>
                <label className={`reg-upload-box${waiver ? ' reg-upload-box--filled' : ''}`}>
                  <input type="file" accept=".pdf,.doc,.docx" ref={waiverRef} onChange={handleFile(setWaiver, 'waiver', WAIVER_MIME_TYPES)} disabled={!!waiver} />
                  <div className="reg-upload-icon">📄</div>
                  {waiver
                    ? (
                      <span className="reg-upload-preview">
                        {waiver.name}
                        <button type="button" className="reg-upload-remove" onClick={(e) => removeFile(e, setWaiver, 'waiver', waiverRef)} aria-label="Remove waiver" />
                      </span>
                    )
                    : (
                      <>
                        <span className="reg-upload-caption">Click to upload waiver</span>
                        <span className="reg-upload-sub">PDF, DOC, max 5 MB (optional for now)</span>
                      </>
                    )
                  }
                </label>
              </Field>

              <Field label="Message">
                <textarea className="reg-textarea"
                  placeholder="Any additional information (optional)"
                  value={form.message} onChange={set('message')}
                  rows={4} />
              </Field>
            </div>

            <div className="reg-divider" />

            <div className="reg-footer">
              <span className="reg-footer__note">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="#5a6a7a"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                Fields marked with <strong style={{ color: '#C0392B' }}>*</strong> are required
              </span>
              <div className="reg-footer__actions">
                <button type="button" className="reg-btn-reset" onClick={handleReset}>
                  Reset ↺
                </button>
                <button type="submit" className="reg-btn-save" disabled={submitting}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
                  {submitting ? 'Saving...' : 'Save Registration'}
                </button>
              </div>
            </div>

          </form>
        </div>

        <Contact contactFooterRef={contactFooterRef} />

      </div>
    </div>
  );
}



// Slugifies a Field's label into a stable id fallback ("City / Municipality"
// -> "reg-field-city-municipality") so every Field gets a working
// label/input pairing without having to pass an explicit id at each call
// site below.
function slugify(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

const LABELABLE_TAGS = new Set(['input', 'select', 'textarea']);

function Field({ label, required, error, id, children }) {
  const fieldId = id || `reg-field-${slugify(label)}`;

  // Field is invoked with either a single input/select/textarea, or that
  // control plus extra siblings (hint text, a second phone input, upload
  // captions, PhoneHint, ...). Only the first child is ever the field's own
  // primary control, so only it gets the id the <label>'s htmlFor points
  // to — cloned in automatically rather than needing an id prop threaded
  // through every call site below.
  const [firstChild, ...restChildren] = Children.toArray(children);
  const canLabelFirstChild = isValidElement(firstChild) && LABELABLE_TAGS.has(firstChild.type);
  const labeledFirstChild = canLabelFirstChild
    ? cloneElement(firstChild, { id: firstChild.props.id || fieldId })
    : firstChild;

  return (
    <div className={`reg-field${error ? ' reg-field--error' : ''}`}>
      <label className="reg-label" htmlFor={canLabelFirstChild ? fieldId : undefined}>
        {label}{required && <span>*</span>}
      </label>
      {labeledFirstChild}
      {restChildren}
      {error && <span className="reg-field__error">{error}</span>}
    </div>
  );
}

// Live feedback from usePhoneFieldCheck — shows either why the number
// doesn't fit the selected country's rules yet, or its formatted
// international form once it does.
function PhoneHint({ value, check }) {
  if (!value) return null;
  if (check.lengthIssue === 'TOO_SHORT') return <span className="reg-phone-hint reg-phone-hint--bad">Too short for this country</span>;
  if (check.lengthIssue === 'TOO_LONG')  return <span className="reg-phone-hint reg-phone-hint--bad">Too long for this country</span>;
  if (check.lengthIssue)                 return <span className="reg-phone-hint reg-phone-hint--bad">✗ Not a valid number</span>;
  if (check.valid) {
    return <span className="reg-phone-hint reg-phone-hint--ok">✓ {check.internationalFormat}</span>;
  }
  if (check.valid === false) {
    return <span className="reg-phone-hint reg-phone-hint--bad">✗ Not a valid number for this country</span>;
  }
  return null;
}

export default function DashboardPage() {
  const [registering, setRegistering] = useState(false);
  return registering
    ? <PlayerRegistration onBack={() => setRegistering(false)} />
    : <HomeView onOpenRegistration={() => setRegistering(true)} />;
}
