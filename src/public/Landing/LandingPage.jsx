import React, { useState, useEffect, useContext, useRef } from "react";
import { FaCalendarAlt, FaTrophy, FaPaperPlane, FaChevronLeft, FaChevronRight, FaChevronDown } from "react-icons/fa";
import "./LandingPage.css";
import HeaderWithLines from './HeaderWithLines';
import HighlightsBanner from './HighlightsBanner';
import ImageCarousel from './ImageCarousel';
import { AuthContext } from '../../shared/context/AuthContext';
import { BrandingContext } from '../../shared/context/BrandingContext';
import { FaArrowRightLong } from "react-icons/fa6";
import { fetchCollectionData, getMatchSchedules, subscribeSportsTeamsConfig, subscribeMatchSchedules, subscribeLiveStatsCounters, subscribeLandingPageConfig, DEFAULT_LANDING_PAGE } from '../../shared/services/firestoreService';
import Contact from './Contact/Contact';

/* ── NEW — additional icons for the scrollable content sections ── */
import {
  FaArrowRight,
  FaBullseye,
  FaUsers,
  FaUserFriends,
  FaRunning,
  FaChess,
  FaBasketballBall,
  FaVolleyballBall,
  FaGamepad,
  FaClipboardList,
  FaFileSignature,
  FaCheckCircle,
} from "react-icons/fa";
import { GiShuttlecock, GiPingPongBat } from "react-icons/gi";

const LEVELS = ["Elementary", "High School", "College"];

/* Maps the dropdown's display labels to the level keys used everywhere
   else in the app (Admin's schedule builder, Moderator's record screen) —
   this is how the hero card knows which level's schedule to read. */
const LEVEL_KEY_MAP = { Elementary: 'elementary', 'High School': 'highSchool', College: 'college' };

/* Every level's Firestore key, for stats that sum across the whole
   school (Elementary + High School + College) rather than one level. */
const ALL_LEVEL_KEYS = ['elementary', 'highSchool', 'college'];

/* Reverse of LEVEL_KEY_MAP — turns a Firestore level key back into the
   display label shown in the Sports Available hover ("Available in:
   Elementary • College"). */
const LEVEL_KEY_TO_LABEL = { elementary: 'Elementary', highSchool: 'High School', college: 'College' };

/* Case/whitespace-insensitive compare, for deduping sport names that
   Admin may have entered with different capitalization per level. */
function norm(str) {
  return (str || '').trim().toLowerCase();
}

/* Same assumed match length Admin/Moderator use to decide whether a
   scheduled match is "over" — there's no real end-time saved per match,
   so a match counts as finished once this long has passed its start. */
const ASSUMED_MATCH_MINUTES = 120;

function scheduleStart(schedule) {
  if (!schedule.date || !schedule.time) return null;
  const d = new Date(`${schedule.date}T${schedule.time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* True only while the match is actually in progress right now — same
   [start, start+120min) window Dashboard's own Ongoing section uses.
   The previous version only checked "hasn't finished yet", which is
   also true for a match that hasn't started — so a future/upcoming
   fixture (tomorrow, next week) showed up in this "Ongoing Matches"
   card right alongside — or instead of — the one Dashboard actually
   shows as ongoing. */
function scheduleIsOngoing(schedule) {
  const start = scheduleStart(schedule);
  if (!start) return false; // no date/time set yet — nothing to compare against the clock
  const now = Date.now();
  return now >= start.getTime() && now < start.getTime() + ASSUMED_MATCH_MINUTES * 60000;
}

function formatScheduleDate(dateStr) {
  if (!dateStr) return 'Date TBA';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatScheduleTime(timeStr) {
  if (!timeStr) return 'Time TBA';
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return timeStr;
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${(mStr || '00').padStart(2, '0')} ${suffix}`;
}

const TEAM_BADGE_COLORS = ['#d0021b', '#1a6bbd', '#f5a623', '#7b2d8b', '#1d9e75', '#c04828', '#0f6e56'];
function colorForTeamName(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return TEAM_BADGE_COLORS[hash % TEAM_BADGE_COLORS.length];
}
function initialsForTeamName(name) {
  return (name || '?').split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}
function buildTeamBadge(name, logo) {
  return { name: name || 'TBD', logo: logo || null, initials: initialsForTeamName(name), color: colorForTeamName(name) };
}

/* Turns a Sports & Teams / Admin schedule row into the shape the hero
   match card already renders. `_start` is kept only for sorting. */
function mapScheduleToCardMatch(schedule) {
  return {
    id: schedule.id,
    sport: schedule.sport || '',
    date: formatScheduleDate(schedule.date),
    time: formatScheduleTime(schedule.time),
    venue: schedule.location || 'Venue TBA',
    teamA: buildTeamBadge(schedule.teamA, schedule.teamALogo),
    teamB: buildTeamBadge(schedule.teamB, schedule.teamBLogo),
    _start: scheduleStart(schedule),
  };
}

/* ── NEW — data for the scrollable content sections ──
   Feature cards, "How to Join" steps, the hero subtitle, the highlights
   gallery, and the bottom CTA are all editable from Super Admin's Web
   Customization → Landing Page tab (siteConfig/landingPage, subscribed
   live below) — DEFAULT_LANDING_PAGE is only the fallback shape before
   that first snapshot arrives / while Firestore is unavailable. */

const STATS = [
  { icon: FaTrophy, value: 120, label: "Total Matches" },
  { icon: FaBullseye, value: 8, label: "Sports" },
  { icon: FaUsers, value: 15, label: "Teams" },
  { icon: FaUserFriends, value: 350, label: "Players" },
];

const SPORTS = [
  { name: "Athletics", icon: FaRunning, levels: [] },
  { name: "Badminton", icon: GiShuttlecock, levels: [] },
  { name: "Basketball", icon: FaBasketballBall, levels: [] },
  { name: "Chess", icon: FaChess, levels: [] },
  { name: "Mobile Legends", icon: FaGamepad, levels: [] },
  { name: "Sepak Takraw", icon: FaVolleyballBall, levels: [] },
  { name: "Table Tennis", icon: GiPingPongBat, levels: [] },
  { name: "Volleyball", icon: FaVolleyballBall, levels: [] },
];

/* Name → icon, for sports pulled live from Admin's per-level config
   (sportsTeamsConfig/{level}.sports) rather than the hardcoded list
   above. Matched case/whitespace-insensitively via `norm` so an admin
   typing "basketball" still gets the basketball icon. Anything not in
   this map (a sport an admin adds that isn't one of the defaults, e.g.
   Swimming or Archery) falls back to DEFAULT_SPORT_ICON rather than
   being left iconless. */
const SPORT_ICON_MAP = {
  athletics: FaRunning,
  badminton: GiShuttlecock,
  basketball: FaBasketballBall,
  chess: FaChess,
  'mobile legends': FaGamepad,
  'sepak takraw': FaVolleyballBall,
  'table tennis': GiPingPongBat,
  volleyball: FaVolleyballBall,
};
const DEFAULT_SPORT_ICON = FaTrophy;
function iconForSportName(name) {
  return SPORT_ICON_MAP[norm(name)] || DEFAULT_SPORT_ICON;
}

/* Icons/order for the 3 "How to Join" steps are fixed — only each step's
   title/description text is editable in the CMS. */
const STEP_ICONS = [FaFileSignature, FaClipboardList, FaCheckCircle];

/* Bundled fallback gallery images, used until a Super Admin uploads real
   highlight photos via the CMS (siteConfig/landingPage.gallery.images). */
const DEFAULT_GALLERY_IMAGES = [
  'src/shared/img/hi-1.jpg',
  'src/shared/img/hi-2.jpg',
  'src/shared/img/hi-3.jpg',
  'src/shared/img/hi-4.jpg',
  'src/shared/img/hi-5.jpg',
  'src/shared/img/hi-6.jpg',
  'src/shared/img/hi-7.jpg',
  'src/shared/img/hi-8.jpg',
];

const MATCHES = [
  {
    id: 1,
    sport: "Basketball",
    date: "June 9, 2026",
    time: "3:00 PM",
    venue: "Covered Court",
    teamA: {
      name: "Yellow Vipers",
      logo: null, // TODO: set to "/src/assets/teams/yellow-vipers.png"
      initials: "YV",
      color: "#f5a623",
    },
    teamB: {
      name: "Purple Jaguars",
      logo: null, // TODO: set to "/src/assets/teams/purple-jaguars.png"
      initials: "PJ",
      color: "#7b2d8b",
    },
  },
  {
    id: 2,
    sport: "Volleyball",
    date: "June 9, 2026",
    time: "5:00 PM",
    venue: "Main Gym",
    teamA: {
      name: "Red Eagles",
      logo: null, // TODO: set to "/src/assets/teams/red-eagles.png"
      initials: "RE",
      color: "#d0021b",
    },
    teamB: {
      name: "Blue Sharks",
      logo: null, // TODO: set to "/src/assets/teams/blue-sharks.png"
      initials: "BS",
      color: "#1a6bbd",
    },
  },
];

function TeamBadge({ team }) {
  return (
    <div className="team-badge">
      {team.logo ? (
        // Real logo — place file in src/assets/teams/ and set team.logo above
        <img src={team.logo} alt={team.name} className="team-logo-img" />
      ) : (
        // Fallback colored circle until real logos are provided
        <div className="team-logo-placeholder" style={{ background: team.color }}>
          {team.initials}
        </div>
      )}
      <span className="team-name">{team.name}</span>
    </div>
  );
}

function LandingPage() {
  const [levelOpen, setLevelOpen] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState("Levels");
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchDirection, setMatchDirection] = useState("next");
  const [matchAnimKey, setMatchAnimKey] = useState(0);
  const [stats, setStats] = useState(STATS);
  const [sports, setSports] = useState(SPORTS);
  const [matches, setMatches] = useState(MATCHES);
  const [landingContent, setLandingContent] = useState(DEFAULT_LANDING_PAGE);
  const [hoveredSportKey, setHoveredSportKey] = useState(null);

  const { openAuthModal = () => {} } = useContext(AuthContext);
  const { schoolName, tagline, motto, logo } = useContext(BrandingContext);
  const contactFooterRef = useRef(null);
  const levelDropdownRef = useRef(null);

  /* Closes the level dropdown on an outside click. Deliberately not a
     full-screen overlay div (the previous approach) — an overlay sitting
     as a sibling of `.hero` ends up painted above `.hero-topbar`'s own
     internal stacking context regardless of z-index, silently swallowing
     clicks meant for the menu items themselves. A ref + document listener
     sidesteps that class of bug entirely. */
  useEffect(() => {
    if (!levelOpen) return undefined;
    const onClickOutside = (e) => {
      if (levelDropdownRef.current && !levelDropdownRef.current.contains(e.target)) {
        setLevelOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [levelOpen]);

  useEffect(() => {
    const loadFirestoreData = async () => {
      try {
        const fireStats = await fetchCollectionData('stats').catch(() => null);

        // Only accept `stats` docs shaped like the cards this section
        // actually renders (icon + label) — a stray/malformed document
        // in that collection (wrong shape) used to crash the whole page
        // trying to render it as a stat card; now it's just skipped.
        if (Array.isArray(fireStats)) {
          const validStats = fireStats.filter((s) => s && typeof s.label === 'string' && typeof s.icon === 'function');
          if (validStats.length) setStats(validStats);
        }
      } catch {
        console.log('Firestore not available, using default data.');
      }
    };

    loadFirestoreData();
  }, []);

  /* Hero subtitle / feature cards / "How to Join" steps / highlights
     gallery / bottom CTA — all editable from Super Admin's Landing Page
     CMS. Subscribed (not fetched once) so an edit reaches every open
     tab of this page immediately, same as the sports/schedules/counters
     subscriptions above. */
  useEffect(() => {
    const unsubscribe = subscribeLandingPageConfig(setLandingContent);
    return unsubscribe;
  }, []);

  /* Sports Statistics row + Sports Available cards — both driven by the
     SAME live read of Admin's per-level Sports & Teams config and match
     schedules (summed/deduped across all 3 levels), instead of typed-in
     numbers or the old standalone `sports` collection (which had no
     connection to what Admin actually configures per level).
     - "Sports" / Sports Available: one entry per sport name, normalized
       (trim + lowercase) so "Basketball" saved under two levels — or
       typed with different casing — still counts and displays once,
       tagged with every level it's actually offered in (for the hover).
     - "Teams" is likewise deduped by normalized name — the same team
       name entered under two levels no longer counts twice.
     - "Players" is read from siteCounters/liveCounters (a single public
       counter AdminSchedulePage keeps updated) rather than computed
       here, because the only source for a real count, `registrations`,
       deliberately isn't public-readable (it holds each registrant's
       address, phone number, emergency contact, etc.); see
       setLivePlayerCount's comment in firestoreService.js.
     Uses a functional update for `stats` so it only touches the 3
     entries it computes and never clobbers "Players" (set from the
     separate counter above) or any other entry another source added.

     Subscribes (rather than fetching once) to each level's config,
     each level's schedules, and the public counters doc, so an Admin
     adding/editing/deleting a sport, team, or match — or a fresh
     Players count being published — recomputes these cards immediately
     for anyone already on the homepage, not just on next page load. */
  useEffect(() => {
    const configsByLevel = {};
    const schedulesByLevel = {};
    let liveCounters = {};

    const recompute = () => {
      const sportsByKey = new Map();
      const teamNames = new Set();
      ALL_LEVEL_KEYS.forEach((levelKey) => {
        const cfg = configsByLevel[levelKey] || { sports: [], teams: [] };
        (cfg.sports || []).forEach((s) => {
          if (!s?.name) return;
          const key = norm(s.name);
          const existing = sportsByKey.get(key);
          if (existing) existing.levels.add(levelKey);
          else sportsByKey.set(key, { name: s.name.trim(), levels: new Set([levelKey]) });
        });
        (cfg.teams || []).forEach((t) => { if (t?.name) teamNames.add(norm(t.name)); });
      });
      const matchCount = ALL_LEVEL_KEYS.reduce(
        (sum, levelKey) => sum + (schedulesByLevel[levelKey] || []).length, 0,
      );

      const sportEntries = [...sportsByKey.values()]
        .map((entry) => ({
          name: entry.name,
          icon: iconForSportName(entry.name),
          levels: ALL_LEVEL_KEYS.filter((lvl) => entry.levels.has(lvl)).map((lvl) => LEVEL_KEY_TO_LABEL[lvl]),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const computed = { 'Total Matches': matchCount, Sports: sportEntries.length, Teams: teamNames.size };
      if (typeof liveCounters.players === 'number') computed.Players = liveCounters.players;
      setStats((prev) => prev.map((s) => (s.label in computed ? { ...s, value: computed[s.label] } : s)));
      setSports(sportEntries);
    };

    const unsubscribers = ALL_LEVEL_KEYS.flatMap((levelKey) => [
      subscribeSportsTeamsConfig(levelKey, (cfg) => { configsByLevel[levelKey] = cfg; recompute(); }),
      subscribeMatchSchedules(levelKey, (matches) => { schedulesByLevel[levelKey] = matches; recompute(); }),
    ]);
    unsubscribers.push(subscribeLiveStatsCounters((counters) => { liveCounters = counters; recompute(); }));

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  /* "Ongoing matches" card, wired straight to what the Administrator has
     actually put on the schedule (matchSchedules/{level}) — not sample
     data. Re-runs whenever the visitor switches level in the dropdown.
     No level picked yet ("Levels" placeholder) used to silently default
     to High School, so a visitor saw a real match before ever touching
     the dropdown with no way to tell which level it belonged to. Now it
     shows nothing (and the card prompts "Pick a level…") until a level
     is actually chosen. */
  const activeLevelKey = LEVEL_KEY_MAP[selectedLevel] || null;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeLevelKey) {
        if (!cancelled) { setMatches([]); setMatchIndex(0); }
        return;
      }
      try {
        const schedules = await getMatchSchedules(activeLevelKey);
        const upcoming = (schedules || [])
          .filter((s) => s.teamA && s.teamB && scheduleIsOngoing(s))
          .map(mapScheduleToCardMatch)
          .sort((a, b) => {
            if (!a._start && !b._start) return 0;
            if (!a._start) return 1;
            if (!b._start) return -1;
            return a._start - b._start;
          });
        if (cancelled) return;
        setMatches(upcoming);
        setMatchIndex(0);
      } catch (error) {
        console.error('Failed to load match schedules for the landing page:', error);
        if (!cancelled) { setMatches([]); setMatchIndex(0); }
      }
    })();
    return () => { cancelled = true; };
  }, [activeLevelKey]);

  const currentMatch = matches[matchIndex] || matches[0] || null;
  const prevMatch = () => {
    setMatchDirection("prev");
    setMatchIndex((i) => {
      if (!matches.length) return 0;
      return (i - 1 + matches.length) % matches.length;
    });
    setMatchAnimKey((k) => k + 1);
  };
  const nextMatch = () => {
    setMatchDirection("next");
    setMatchIndex((i) => {
      if (!matches.length) return 0;
      return (i + 1) % matches.length;
    });
    setMatchAnimKey((k) => k + 1);
  };

  const handleInfoCardArrowClick = () => {
    openAuthModal('login');
  };

  const handleCtaButtonClick = () => {
    openAuthModal('login');
  };

  const handleSendButtonClick = () => {
    if (contactFooterRef.current) {
      contactFooterRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }
  };

  return (
    <div className="landing-wrapper">

      {/* ── Hero — full viewport, no separate navbar ── */}
      <section
        className="hero"
        style={landingContent.hero.backgroundImageURL ? {
          backgroundImage: `url(${landingContent.hero.backgroundImageURL})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
        } : undefined}
      >
        <div className="hero-overlay" />

        {/* ── Top bar — floats inside hero ── */}
        <div className="hero-topbar">
          {/* School identity — logo + name inside hero */}

          {/* Right controls */}
          <div className="header-controls">
            {/* Message / suggestions */}
            <button
              className="icon-btn"
              aria-label="Send suggestion"
              onClick={handleSendButtonClick}
            >
              <FaPaperPlane />
            </button>
          </div>
        </div>

        {/* ── Hero body ── */}
        <div className="hero-body">
          <div className="hero-left">
            <h1 className="hero-headline">
              <div className="school-identity">
            <img src={logo} alt="School logo" className="school-logo" />
            <div className="school-name">
              <span className="school-name-main">{schoolName}</span>

            </div>
          </div>
          <div className="hero-headline">{tagline}</div>

            </h1>

            <div className="line"></div>
            <p className="hero-tagline">{motto}</p>
            <p className="hero-copy">
              {landingContent.hero.subtitle.split('\n').map((line, i, arr) => (
                <React.Fragment key={i}>
                  {line}
                  {i < arr.length - 1 && <br />}
                </React.Fragment>
              ))}
            </p>
            <div className="hero-cta-row">
              <button className="cta-btn cta-primary" onClick={handleCtaButtonClick}>
                <FaCalendarAlt /> VIEW MATCHES
              </button>
              <button className="cta-btn cta-secondary" onClick={handleCtaButtonClick}>
                <FaTrophy /> VIEW RANKINGS
              </button>
            </div>
          </div>

          {/* Right — ongoing match card */}
          <div className="match-card">
            <div className="match-card-header">
              <p className="match-card-label">ONGOING MATCHES</p>

              {/* Level dropdown — filters the matches shown in this card */}
              <div className="level-dropdown" ref={levelDropdownRef}>
                <button
                  className="level-btn"
                  onClick={() => setLevelOpen((prev) => !prev)}
                >
                  {selectedLevel} <FaChevronDown className={`level-chevron ${levelOpen ? "open" : ""}`} />
                </button>
                <ul className={`level-menu ${levelOpen ? "open" : ""}`}>
                  {LEVELS.map((lvl) => (
                    <li
                      key={lvl}
                      className={`level-item ${selectedLevel === lvl ? "active" : ""}`}
                      onClick={() => { setSelectedLevel(lvl); setLevelOpen(false); }}
                    >
                      {lvl}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {currentMatch ? (
              <>
                <div
                  className={`match-card-body match-anim-${matchDirection}`}
                  key={matchAnimKey}
                >
                  <div className="match-teams">
                    <TeamBadge team={currentMatch.teamA} />
                    <span className="vs-label">VS</span>
                    <TeamBadge team={currentMatch.teamB} />
                  </div>
                    <div className="linespace">
                      
                    </div>
                  <div className="match-info">
                    <FaCalendarAlt className="match-info-icon" />
                    <span>{currentMatch.date}</span>
                    <span className="dot">·</span>
                    <span>{currentMatch.time}</span>
                    <span className="dot">·</span>
                    <span>{currentMatch.venue}</span>
                  </div>
                </div>

                <div className="match-card-footer">
                  <span
                    className={`match-sport match-anim-${matchDirection}`}
                    key={`sport-${matchAnimKey}`}
                  >
                    {currentMatch.sport.toUpperCase()}
                  </span>
                  {matches.length > 1 && (
                    <div className="match-nav-btns">
                      <button className="nav-btn" onClick={prevMatch} aria-label="Previous match">
                        <FaChevronLeft />
                      </button>
                      <button className="nav-btn" onClick={nextMatch} aria-label="Next match">
                        <FaChevronRight />
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="match-card-empty">
                {selectedLevel === 'Levels'
                  ? 'Pick a level above to see ongoing matches.'
                  : `No matches scheduled for ${selectedLevel} yet — check back soon.`}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════
          NEW — Scrollable content below the hero
          ══════════════════════════════════════════════ */}
      <div className="content-section">

        {/* ── Info cards ── */}
        <div className="info-cards-row">
          {landingContent.featureCards.map((card, i) => (
            <div key={i} className="info-card">
              <h3 className="info-card-title">{card.title}</h3>
              <p className="info-card-desc">{card.description}</p>
              <button className="info-card-arrow" aria-label={`Go to ${card.title}`} onClick={handleInfoCardArrowClick}>
                <FaArrowRight />
              </button>
            </div>
          ))}
        </div>

        {/* ── Sports statistics ── */}
        <div className="section-heading">
          <span className="heading-line" />
          <h2 className="heading-text">Sports Statistics</h2>
          <span className="heading-line" />
        </div>

        <div className="stats-row">
          {stats.map((stat, i) => (
            <React.Fragment key={stat.label || i}>
              <div className="stat-item">
                <div className="stat-icon-circle">
                  {stat.icon ? <stat.icon /> : null}
                </div>
                <div className="stat-text">
                  <span className="stat-value">{stat.value}</span>
                  <span className="stat-label">{(stat.label || '').toUpperCase()}</span>
                </div>
              </div>
              {i < stats.length - 1 && <span className="stat-divider" />}
            </React.Fragment>
          ))}
        </div>

        {/* ── Sports available ── */}
        <div className="section-heading">
          <span className="heading-line" />
          <h2 className="heading-text">Sports Available</h2>
          <span className="heading-line" />
        </div>

        <div className="sports-row">
          {sports.map((sport) => {
            const sportKey = norm(sport.name);
            const isHovered = hoveredSportKey === sportKey;
            const availableLevels = sport.levels || [];
            return (
              <div
                key={sport.name}
                className="sport-tile"
                onMouseEnter={() => setHoveredSportKey(sportKey)}
                onMouseLeave={() => setHoveredSportKey((k) => (k === sportKey ? null : k))}
                onClick={() => setHoveredSportKey((k) => (k === sportKey ? null : sportKey))}
              >
                <sport.icon className="sport-tile-icon" />
                <span className="sport-tile-name">{sport.name.toUpperCase()}</span>
                {isHovered && availableLevels.length > 0 && (
                  <div className="sport-tile-tooltip" role="tooltip">
                    Available in: {availableLevels.join(' • ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── How to join as a player ── */}
        <div className="section-heading">
          <span className="heading-line" />
          <h2 className="heading-text">How to Join as a Player</h2>
          <span className="heading-line" />
        </div>

        <div className="steps-row">
          {landingContent.howToJoin.map((step, i) => {
            const StepIcon = STEP_ICONS[i] || FaCheckCircle;
            return (
              <React.Fragment key={i}>
                <div className="step-item">
                  <div className="step-icon-circle">
                    <span className="step-number">{i + 1}</span>
                    <StepIcon className="step-icon" />
                  </div>
                  <span className="step-title">{(step.title || '').toUpperCase()}</span>
                  <p className="step-desc">{step.description}</p>
                </div>
                {i < landingContent.howToJoin.length - 1 && (
                  <FaArrowRightLong className="step-arrow" aria-hidden="true" />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* ── Sports Moments — highlights carousel ── */}
        <div style={{ marginTop: '2.25rem' }}>
          <div className="sports-moments">
            <div className="linegroup1">
            <div className="line1"></div>
            <div className="line2"></div>
            <div className="line5"></div>
            </div>
            <HeaderWithLines text={landingContent.gallery.title} />
            <div className="linegroup2">
              <div className="line3"></div>
              <div className="line4"></div>
              <div className="line6"></div>
            </div>
          </div>
          <div className="carousel-stage">
            <HighlightsBanner />
            <ImageCarousel
              images={landingContent.gallery.images.length ? landingContent.gallery.images : DEFAULT_GALLERY_IMAGES}
              duration={20} // loop duration in seconds (smaller = faster)
            />
          </div>
        </div>

        {/* ── Bottom CTA banner — editable in Web Customization → Landing Page ── */}
        <div className="landing-cta">
          <h2 className="landing-cta-title">{landingContent.bottomSection.title}</h2>
          <p className="landing-cta-desc">{landingContent.bottomSection.description}</p>
          <button className="landing-cta-btn" onClick={handleCtaButtonClick}>
            <FaCalendarAlt /> {landingContent.bottomSection.buttonText}
          </button>
        </div>

        {/* ── Contact us footer strip ── */}
  <Contact contactFooterRef={contactFooterRef} />

      </div>
    </div>
  );
}

export default LandingPage;