import React, { useState, useEffect, useMemo, useContext } from 'react';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import './TeamAndSportsPage.css';
import Contact from '../public/Landing/Contact/Contact';
import { getSportsTeamsConfig } from '../shared/services/firestoreService';
import LevelTabs from '../shared/components/LevelTabs';

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

/* ── Single team card ── */
function TeamCard({ team, index, levelLabels }) {
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
            <span key={i} className="ts-sport-tag">{sport}</span>
          ))}
        </div>
      ) : (
        <p className="ts-card-empty">No sports assigned to this team yet.</p>
      )}
    </div>
  );
}

export default function TeamsAndSportsPage() {
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);
  const LEVELS = useMemo(() => [
    { label: 'All Levels', key: 'all' },
    { label: levelLabels.elementary, key: 'elementary' },
    { label: levelLabels.highSchool, key: 'highSchool' },
    { label: levelLabels.college, key: 'college' },
  ], [levelLabels]);
  const [levelKey, setLevelKey] = useState('all');
  const level = LEVELS.find(l => l.key === levelKey) || LEVELS[0];
  const [loading, setLoading] = useState(true);
  const [teamsByLevel, setTeamsByLevel] = useState({ elementary: [], highSchool: [], college: [] });
  const contactRef = React.useRef(null);

  /* ── Load real data from Firestore for every level ── */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [elementary, highSchool, college] = await Promise.all([
          getSportsTeamsConfig('elementary'),
          getSportsTeamsConfig('highSchool'),
          getSportsTeamsConfig('college'),
        ]);

        if (cancelled) return;

        const tag = (levelKey, cfg) =>
          (cfg.teams || [])
            .filter(t => t && t.name && t.name.trim())
            .map(t => ({ ...t, level: levelKey }));

        setTeamsByLevel({
          elementary: tag('elementary', elementary),
          highSchool: tag('highSchool', highSchool),
          college: tag('college', college),
        });
      } catch (e) {
        console.error('Failed to load teams & sports:', e);
        if (!cancelled) setTeamsByLevel({ elementary: [], highSchool: [], college: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  /* ── Teams visible for the selected level filter ── */
  const visibleTeams = useMemo(() => {
    if (level.key === 'all') {
      return [
        ...teamsByLevel.elementary,
        ...teamsByLevel.highSchool,
        ...teamsByLevel.college,
      ];
    }
    return teamsByLevel[level.key] || [];
  }, [level, teamsByLevel]);

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
          <LevelTabs
            levels={LEVELS}
            value={levelKey}
            onChange={setLevelKey}
            containerClassName="ts-lvltabs"
            tabClassName="ts-lvltab"
            activeClassName="ts-lvltab--active"
          />
        </div>

        {/* Section title */}
        <h2 className="ts-section-title">PARTICIPATING TEAMS</h2>

        {/* Team cards / states */}
        {loading ? (
          <p className="ts-state-note">Loading teams…</p>
        ) : visibleTeams.length === 0 ? (
          <p className="ts-state-note">
            No teams have been added yet{level.key !== 'all' ? ` for ${level.label}` : ''}. Once an admin sets up teams and sports, they'll appear here.
          </p>
        ) : (
          <div className="ts-cards-list">
            {visibleTeams.map((team, i) => (
              <TeamCard key={`${team.level}-${team.id}`} team={team} index={i} levelLabels={levelLabels} />
            ))}
          </div>
        )}

        {/* Contact footer — reusing existing component, no new CSS needed */}
        <Contact contactFooterRef={contactRef} />
      </div>
    </div>
  );
}