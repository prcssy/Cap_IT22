import { FaTrophy } from 'react-icons/fa';
import { ordinal } from '../../utils/raceFormat';
import './RaceDiagram.css';

/* Single-Race diagram, drawn in the same style as the other bracket formats
   (team boxes on the left, elbow connector lines, trophy + "Champion" on the
   right): every team joins one line that leads to a single Champion.
   `standings` (from raceStandingsFromRecord) adds a finishing-place badge to
   each team once a result is recorded, and `championName` fills the Champion
   slot. */

const PALETTE = ['#c0392b', '#8d6e63', '#c9a300', '#27ae60', '#8e44ad', '#e67e22', '#800000', '#2c3e50', '#2980b9', '#16a085'];
function colorFor(name) {
  if (!name) return '#95a5a6';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

const LEAF_W = 200;
const LEAF_H = 40;
const ROW_H = 56;
const TOP = 26;
const SPINE_GAP = 60;
const CHAMP_GAP = 80;
const CHAMP_W = 150;
const key = (v) => String(v ?? '').trim().toLowerCase();

export default function RaceDiagram({ teams, standings = [], championName = null, showTba = true }) {
  const n = teams.length;
  if (n === 0) return null;

  const placeByTeam = new Map(standings.filter((s) => s.place).map((s) => [key(s.name), s.place]));
  const cy = (i) => TOP + i * ROW_H + ROW_H / 2;
  const spineX = LEAF_W + SPINE_GAP;
  const championX = spineX + CHAMP_GAP;
  const midY = (cy(0) + cy(n - 1)) / 2;
  const height = TOP + n * ROW_H + 10;
  const width = championX + CHAMP_W;

  const championTeam = championName ? teams.find((t) => key(t.name) === key(championName)) : null;
  const championLogo = championTeam?.logo || null;

  const paths = [
    ...teams.map((_, i) => `M ${LEAF_W} ${cy(i)} H ${spineX}`),
    n > 1 ? `M ${spineX} ${cy(0)} V ${cy(n - 1)}` : '',
    `M ${spineX} ${midY} H ${championX}`,
  ].filter(Boolean);

  return (
    <div className="race-diagram">
      <div className="race-diagram__scroll">
        <div className="race-diagram__canvas" style={{ width, height }}>
          <svg width={width} height={height} className="race-diagram__lines">
            {paths.map((d, i) => <path key={i} d={d} />)}
          </svg>

          <div className="race-diagram__headers" style={{ top: 0 }}>
            <div style={{ width: LEAF_W }}>Race</div>
          </div>

          {teams.map((t, i) => {
            const place = placeByTeam.get(key(t.name));
            return (
              <div
                key={`${t.name}-${i}`}
                className={`race-diagram__team${place === 1 ? ' race-diagram__team--winner' : ''}`}
                style={{ top: cy(i) - LEAF_H / 2, left: 0, height: LEAF_H, width: LEAF_W }}
                title={t.name}
              >
                {t.logo
                  ? <img src={t.logo} alt="" className="race-diagram__avatar" />
                  : <span className="race-diagram__avatar race-diagram__avatar--fallback" style={{ background: t.color || colorFor(t.name) }}>{(t.name || '?').charAt(0).toUpperCase()}</span>}
                <span className="race-diagram__name">{t.name}</span>
                {place && <span className={`race-diagram__place race-diagram__place--${place <= 3 ? place : 'n'}`}>{ordinal(place)}</span>}
              </div>
            );
          })}

          <div className={`race-diagram__champion${!championName && !showTba ? " race-diagram__champion--bare" : ""}`} style={{ left: championX, top: midY, width: CHAMP_W }}>
            <div className="race-diagram__champion-head">
              <FaTrophy className="race-diagram__trophy" />
              <span className="race-diagram__champion-label">Champion</span>
            </div>
            <div className="race-diagram__champion-box">
              {championName ? (
                <>
                  {championLogo
                    ? <img src={championLogo} alt="" className="race-diagram__champion-avatar" />
                    : <span className="race-diagram__champion-avatar race-diagram__champion-avatar--fallback" style={{ background: colorFor(championName) }}>{championName.charAt(0).toUpperCase()}</span>}
                  <span className="race-diagram__champion-name">{championName}</span>
                </>
              ) : (
                <span className="race-diagram__champion-tba">TBA</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Finishing order (1st, 2nd, …) once a moderator has recorded the race. */
export function RaceResults({ standings }) {
  if (!standings.length) return null;
  return (
    <div className="race-results">
      <h4 className="race-results__title">Race results</h4>
      {standings.map((s, i) => (
        <div key={`${s.name}-${i}`} className={`race-results__row${s.place === 1 ? ' race-results__row--first' : ''}`}>
          <span className="race-results__place">{s.place ? ordinal(s.place) : '—'}</span>
          <span className="race-results__team">{s.name}</span>
          <span className="race-results__score">{s.scoreLabel || ''}</span>
        </div>
      ))}
    </div>
  );
}

/* Numbered list of the teams entered in a race (before there's a result). */
export function RaceLanes({ teams, title }) {
  return (
    <div className="race-lanes">
      <div className="race-lanes__head">{title}</div>
      {teams.map((t, i) => (
        <div key={`${t.name}-${i}`} className="race-lanes__row">
          <span className="race-lanes__num">{i + 1}</span>
          <span className="race-lanes__team">{t.name}</span>
        </div>
      ))}
    </div>
  );
}
