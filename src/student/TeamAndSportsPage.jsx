import React, { useState, useEffect, useMemo, useContext } from 'react';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import './TeamAndSportsPage.css';
import Contact from '../public/Landing/Contact/Contact';
import { subscribeSportsTeamsConfig, subscribeCoaches } from '../shared/services/firestoreService';
import { FaUserTie, FaPhoneAlt } from 'react-icons/fa';
import LevelTabs from '../shared/components/LevelTabs';
import { useLockedLevel } from '../shared/utils/schoolLevel';

/* ── Team logo placeholder ── */
function TeamLogo({ name, logo }) {
  if (logo) {
    return <img src={logo} alt={name} className="ts-team-logo" />;
  }
  const initials = (name || '')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .slice(0, 2) || '—';
  return (
    <div className="ts-team-logo ts-team-logo--placeholder">
      <span>{initials}</span>
    </div>
  );
}

const norm = (v) => String(v || '').trim().toLowerCase();

/* Every category/division of one sport, as display rows:
   { category: 'MALE', division: '5 V 5' }.
   A division named like its group ("MEN" in MEN) shows just the category. */
function divisionRows(sport) {
  return (sport?.categoryGroups || []).flatMap((g) => {
    const category = (g.label || '').trim();
    const divs = g.divisions || [];
    if (divs.length === 0) return [{ category, division: '' }];
    return divs.map((d) => {
      const name = (d.name || '').trim();
      return { category, division: name && norm(name) !== norm(category) ? name : '' };
    });
  });
}

/* A sport pill; hovering (or tapping/focusing, on touch screens and for
   keyboard users) shows that sport's categories and divisions. */
function SportTag({ name, sport }) {
  const rows = divisionRows(sport);
  if (rows.length === 0) return <span className="ts-sport-tag">{name}</span>;
  return (
    <span className="ts-sport-tag ts-sport-tag--has-pop" tabIndex={0} aria-label={`${name} divisions`}>
      {name}
      <span className="ts-sport-pop" role="tooltip">
        <span className="ts-sport-pop__title">{name} · Divisions</span>
        {rows.map((r, i) => (
          <span className="ts-sport-pop__row" key={i}>
            <span className="ts-sport-pop__name">
              {r.category}{r.division && <span className="ts-sport-pop__div"> · {r.division}</span>}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

/* Who's in charge of a team — one row per coach assigned to it. */
function TeamCoaches({ coaches }) {
  if (!coaches.length) return null;
  return (
    <div className="ts-coaches">
      {coaches.map((c) => (
        <div className="ts-coach" key={c.id}>
          <span className="ts-coach__avatar">
            {c.photoURL ? <img src={c.photoURL} alt="" /> : <FaUserTie />}
          </span>
          <span className="ts-coach__text">
            <span className="ts-coach__label">Coach{c.sports?.length ? ` · ${c.sports.join(', ')}` : ''}</span>
            <span className="ts-coach__name">{c.name || c.id}</span>
            {c.contactNumber && (
              <a className="ts-coach__phone" href={`tel:${c.contactNumber.replace(/[^+0-9]/g, '')}`}>
                <FaPhoneAlt /> {c.contactNumber}
              </a>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Single team card ── */
function TeamCard({ team, index, levelLabels, sportsByName, coaches = [] }) {
  const sports = team.sportIds || [];
  return (
    <div className="ts-team-card" style={{ animationDelay: `${index * 0.07}s` }}>
      <div className="ts-card-sport-count">{sports.length} SPORT{sports.length === 1 ? '' : 'S'}</div>
      <div className="ts-card-top">
        <TeamLogo name={team.name} logo={team.logo} />
        <div className="ts-card-info">
          <h3 className="ts-card-name">{team.name}</h3>
          <p className="ts-card-year">{(levelLabels[team.level] || '').toUpperCase()}</p>
          <p className="ts-card-status">SPORTS PARTICIPATING</p>
        </div>
      </div>
      {sports.length > 0 ? (
        <div className="ts-sports-tags">
          {sports.map((sport, i) => (
            <SportTag key={i} name={sport} sport={sportsByName.get(norm(sport))} />
          ))}
        </div>
      ) : (
        <p className="ts-card-empty">No sports assigned to this team yet.</p>
      )}
      <TeamCoaches coaches={coaches} />
    </div>
  );
}

export default function TeamsAndSportsPage() {
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  const LEVELS = useMemo(() => [
    { label: levelLabels.elementary, key: 'elementary' },
    { label: levelLabels.highSchool, key: 'highSchool' },
    { label: levelLabels.college, key: 'college' },
  ], [levelLabels]);
  const lockedLevel = useLockedLevel();
  const [pickedLevel, setLevelKey] = useState('elementary');
  const levelKey = lockedLevel || pickedLevel;
  const level = LEVELS.find(l => l.key === levelKey) || LEVELS[0];
  const [loading, setLoading] = useState(true);
  const [teamsByLevel, setTeamsByLevel] = useState({ elementary: [], highSchool: [], college: [] });
  const [sportsByLevel, setSportsByLevel] = useState({ elementary: [], highSchool: [], college: [] });
  const contactRef = React.useRef(null);
  const [coaches, setCoaches] = useState([]);

  useEffect(() => subscribeCoaches(null, setCoaches, () => setCoaches([])), []);

  /* ── Live data from Firestore for every level ──
     Listeners, so a team or sport the admin adds/edits shows up here
     without a page refresh. */
  useEffect(() => {
    const LEVEL_KEYS = ['elementary', 'highSchool', 'college'];
    const pending = new Set(LEVEL_KEYS);

    const tag = (levelKey, cfg) =>
      (cfg.teams || [])
        .filter(t => t && t.name && t.name.trim())
        .map(t => ({ ...t, level: levelKey }));

    const unsubs = LEVEL_KEYS.map((levelKey) => {
      const setLevelTeams = (cfg) => {
        setTeamsByLevel(prev => ({ ...prev, [levelKey]: tag(levelKey, cfg) }));
        setSportsByLevel(prev => ({ ...prev, [levelKey]: cfg.sports || [] }));
        if (pending.delete(levelKey) && pending.size === 0) setLoading(false);
      };
      return subscribeSportsTeamsConfig(levelKey, setLevelTeams, (e) => {
        console.error('Failed to load teams & sports:', e);
        setLevelTeams({ teams: [] });
      });
    });
    return () => unsubs.forEach(u => u());
  }, []);

  /* ── Teams visible for the selected level filter ── */
  const visibleTeams = useMemo(() => teamsByLevel[level.key] || [], [level, teamsByLevel]);
  // Sport name → its Sports & Teams entry, for each pill's division popover.
  const sportsByName = useMemo(
    () => new Map((sportsByLevel[level.key] || []).map((s) => [norm(s.name), s])),
    [level, sportsByLevel],
  );

  // "level::team name" → the coaches assigned to that team.
  const coachesByTeam = useMemo(() => {
    const map = new Map();
    coaches.forEach((c) => (c.teams || []).forEach((t) => {
      const key = `${c.level}::${t}`;
      map.set(key, [...(map.get(key) || []), c]);
    }));
    return map;
  }, [coaches]);

  /* ── Stats always reflect the currently selected level ── */
  const totalTeams = visibleTeams.length;
  const totalSports = useMemo(
    () => new Set(visibleTeams.flatMap(t => t.sportIds || [])).size,
    [visibleTeams]
  );

  return (
    <div className="ts-page">

      {/* ── Top header — same pattern as Profile & Registration ── */}
      <header className="ts-dash-header">
        <h1 className="ts-dash-header__title">{schoolName}</h1>
      </header>

      {/* ── Page intro — same pattern as Profile & Registration ── */}
      <div className="ts-page-intro">
        <h2 className="ts-page-title">Team and Sports</h2>
        <p className="ts-page-subtitle">View all participating teams and their sports events</p>
      </div>

      {/* ── Scrollable body ── */}
      <div className="ts-body">

        {/* Sub-header bar */}
        <div className="ts-subheader">
          <div className="ts-subheader-stats">
            <span className="ts-stat">{totalTeams} TEAM{totalTeams === 1 ? '' : 'S'}</span>
            <span className="ts-stat-divider">|</span>
            <span className="ts-stat">{totalSports} SPORT{totalSports === 1 ? '' : 'S'}</span>
          </div>

          {/* Level filter */}
          {!lockedLevel && (
          <LevelTabs
            levels={LEVELS}
            value={levelKey}
            onChange={setLevelKey}
            containerClassName="ts-lvltabs"
            tabClassName="ts-lvltab"
            activeClassName="ts-lvltab--active"
          />
          )}
        </div>

        {/* Section title */}
        <h2 className="ts-section-title">PARTICIPATING TEAMS</h2>

        {/* Team cards / states */}
        {loading ? (
          <p className="ts-state-note">Loading teams…</p>
        ) : visibleTeams.length === 0 ? (
          <p className="ts-state-note">
            No teams have been added yet for {level.label}. Once an admin sets up teams and sports, they'll appear here.
          </p>
        ) : (
          <div className="ts-cards-list">
            {visibleTeams.map((team, i) => (
              <TeamCard key={`${team.level}-${team.id}`} team={team} index={i} levelLabels={levelLabels} sportsByName={sportsByName} coaches={coachesByTeam.get(`${team.level}::${team.name}`) || []} />
            ))}
          </div>
        )}

        {/* Contact footer — reusing existing component, no new CSS needed */}
        <Contact contactFooterRef={contactRef} />
      </div>
    </div>
  );
}