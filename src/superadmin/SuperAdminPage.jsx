import { useState, useEffect, useCallback, useContext, useMemo, useRef } from 'react';
import { AuthContext } from '../shared/context/AuthContext';
import { BrandingContext } from '../shared/context/BrandingContext';
import { LevelLabelsContext } from '../shared/context/LevelLabelsContext';
import { db } from '../shared/firebase';
import { getAllUsers, getAllRegistrations, getSportsTeamsConfig, getMatchSchedules, getMatchRecords, getActivityLogs } from '../shared/services/firestoreService';
import LevelTabs from '../shared/components/LevelTabs';
import ActivityLogsAndRoles from './ActivityLogsAndRoles';
import StudentRegistrationDetails from './StudentRegistrationDetails';
import BrandingSettings from './BrandingSettings';
import LandingPageSettings from './LandingPageSettings';
import LevelLabelsSettings from './LevelLabelsSettings';
import './SuperAdminPage.css';
import {
  FaUsers, FaRunning, FaUsersCog, FaCalendarAlt, FaUserCheck, FaClock,
  FaSync, FaDownload, FaChartPie, FaRegCalendarAlt, FaChevronDown, FaCheck,
} from 'react-icons/fa';

/* ═══════════════════════════════════════════════════════════════
   DATA ANALYTICS — super admin only

   Everything here is DERIVED at read time from collections that
   already exist (users, registrations, sportsTeamsConfig,
   matchSchedules). Nothing new is written to Firestore, so there's
   no analytics data to keep in sync and no way for these figures to
   drift away from the real records.

   Charts are hand-drawn SVG rather than a charting library — the
   project has no chart dependency, and the shapes needed here are
   simple enough not to justify one.
   ═══════════════════════════════════════════════════════════════ */

const LEVELS = ['elementary', 'highSchool', 'college'];

const ELEMENTARY_GRADES = new Set(['Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6']);
const HIGH_SCHOOL_GRADES = new Set(['Grade 7','Grade 8','Grade 9','Grade 10','Grade 11','Grade 12']);
const COLLEGE_GRADES = new Set(['1st Year','2nd Year','3rd Year','4th Year']);

function getSchoolLevel(gradeLevel) {
  if (!gradeLevel) return null;
  if (ELEMENTARY_GRADES.has(gradeLevel)) return 'elementary';
  if (HIGH_SCHOOL_GRADES.has(gradeLevel)) return 'highSchool';
  if (COLLEGE_GRADES.has(gradeLevel)) return 'college';
  return null;
}

/* Firestore returns a Timestamp; older or hand-edited docs might hold
   a string or a plain Date. Accept all three, and treat anything
   unparseable as "no date" rather than letting it crash a chart. */
function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(date) {
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function formatDay(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const RANGES = [
  { key: '7d',  label: 'This Week',      days: 7   },
  { key: '30d', label: 'Last 30 Days',   days: 30  },
  { key: '90d', label: 'Last 90 Days',   days: 90  },
  { key: '12m', label: 'Last 12 Months', days: 365 },
  { key: 'all', label: 'All Time',       days: null },
];

/* Custom-themed dropdown for the range picker — a native <select>'s open
   option list is OS-rendered and can't be restyled cross-browser, so this
   swaps in a button + absolutely-positioned menu that follows the panel's
   own design tokens instead. */
function RangeDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const selected = options.find(o => o.key === value) || options[0];

  return (
    <div className="sa-dropdown" ref={rootRef}>
      <button
        type="button"
        className={`sa-select${open ? ' sa-select--open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected.label}
        <FaChevronDown className="sa-select__chevron" />
      </button>
      {open && (
        <div className="sa-dropdown__menu" role="listbox">
          {options.map(opt => (
            <button
              key={opt.key}
              type="button"
              role="option"
              aria-selected={value === opt.key}
              className={`sa-dropdown__item${value === opt.key ? ' sa-dropdown__item--active' : ''}`}
              onClick={() => { onChange(opt.key); setOpen(false); }}
            >
              {opt.label}
              {value === opt.key && <FaCheck className="sa-dropdown__check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* A saved match only ever gets `status: 'scheduled'` at creation time —
   nothing in the app ever patches it to "ongoing"/"finished" afterwards
   (that only happens implicitly, via date/time + a matching matchRecords
   entry). Bucketing on the raw `status` field made this donut permanently
   report 100% Upcoming. Classify matches the same way DashboardPage.jsx
   already does — by assumed match window vs. the current time, and by
   whether a moderator-confirmed record exists for the fixture — so this
   summary agrees with what students actually see on the Dashboard. */
const STATUS_BUCKETS = [
  { key: 'finished', label: 'Finished', color: '#7c3aed' },
  { key: 'ongoing',  label: 'Ongoing',  color: '#16a34a' },
  { key: 'upcoming', label: 'Upcoming', color: '#f5a623' },
];

const ASSUMED_MATCH_MINUTES = 120; // same assumption as DashboardPage.jsx

function normText(value) {
  return (value || '').trim().toLowerCase();
}

function sameTeamName(a, b) {
  return !!a && !!b && normText(a) === normText(b);
}

/* Categories used to be saved as values such as "MEN 5v5" — strip the
   child match format so a record's category still lines up with its
   schedule's, same trimming DashboardPage.jsx applies. */
function displayCategory(category) {
  return (category || '')
    .trim()
    .replace(/\s+\d+\s*[v×x]\s*\d+\s*$/i, '')
    .replace(/\s+$/, '')
    .trim();
}

function matchWindow(match) {
  if (!match.date || !match.time) return null;
  const start = new Date(`${match.date}T${match.time}`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + ASSUMED_MATCH_MINUTES * 60000);
  return { start, end };
}

/* Same matching rule as DashboardPage.jsx's recordMatchesSchedule: prefer
   the explicit scheduleId link, falling back to sport/category/team-name
   matching for older records saved before that link existed. */
function recordMatchesSchedule(record, schedule) {
  if (!record || !schedule) return false;
  if (record.scheduleId) return String(record.scheduleId) === String(schedule.id);
  if (normText(record.sportName) !== normText(schedule.sport)) return false;
  const recordCategory = normText(displayCategory(record.category));
  const scheduleCategory = normText(displayCategory(schedule.category));
  if (recordCategory && scheduleCategory && recordCategory !== scheduleCategory
      && !recordCategory.endsWith(` ${scheduleCategory}`)
      && !scheduleCategory.endsWith(` ${recordCategory}`)) return false;
  const participants = record.participants?.length ? record.participants : [record.teamA, record.teamB];
  const names = participants.map(p => p?.name).filter(Boolean);
  return names.length >= 2
    && names.some(name => sameTeamName(name, schedule.teamA))
    && names.some(name => sameTeamName(name, schedule.teamB));
}

/* finished (has a confirmed record) beats ongoing/upcoming; otherwise a
   match not yet at its start time is upcoming, and anything else
   (currently in its assumed window, OR past it with no result recorded
   yet) reads as ongoing — closer to reality than silently vanishing. */
function classifyMatch(match, records, now) {
  const hasRecord = records.some(r => recordMatchesSchedule(r, match));
  if (hasRecord) return 'finished';
  const window = matchWindow(match);
  if (window && now < window.start) return 'upcoming';
  return 'ongoing';
}

/* ── SVG chart primitives ────────────────────────────────────── */

function polarPoint(cx, cy, radius, angleDeg) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function donutArcPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const a = polarPoint(cx, cy, rOuter, startAngle);
  const b = polarPoint(cx, cy, rOuter, endAngle);
  const c = polarPoint(cx, cy, rInner, endAngle);
  const d = polarPoint(cx, cy, rInner, startAngle);
  return [
    `M ${a.x} ${a.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${b.x} ${b.y}`,
    `L ${c.x} ${c.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${d.x} ${d.y}`,
    'Z',
  ].join(' ');
}

/* No center total here on purpose — that number already appears in the
   stat tile row above (Total Users / Total Matches / Total Players), so
   repeating it here would just be the same statistic shown twice. The
   ring + legend below are what this chart adds that the tiles don't:
   how that total splits across categories. */
function Donut({ segments, showPercent = true }) {
  const data  = segments.filter(s => Number(s.value) > 0);
  const total = data.reduce((sum, s) => sum + Number(s.value), 0);

  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 64;
  const rInner = 43;

  if (total === 0) {
    return (
      <div className="sa-empty">
        <FaChartPie />
        <span>No data yet</span>
      </div>
    );
  }

  // A single 100% segment can't be drawn as an arc — its start and end
  // points are identical, so the path collapses. Draw a ring instead.
  const isSingle = data.length === 1;
  let cursor = 0;

  return (
    <div className="sa-donut-row">
      <svg viewBox={`0 0 ${size} ${size}`} className="sa-donut__svg" role="img">
        {isSingle ? (
          <circle
            cx={cx} cy={cy} r={(rOuter + rInner) / 2}
            fill="none"
            stroke={data[0].color}
            strokeWidth={rOuter - rInner}
          />
        ) : (
          data.map((seg) => {
            const sweep = (Number(seg.value) / total) * 360;
            const path  = donutArcPath(cx, cy, rOuter, rInner, cursor, cursor + sweep);
            cursor += sweep;
            return <path key={seg.label} d={path} fill={seg.color} />;
          })
        )}
      </svg>

      <ul className="sa-legend">
        {data.map((seg) => (
          <li key={seg.label}>
            <span className="sa-legend__dot" style={{ background: seg.color }} />
            <span className="sa-legend__label">{seg.label}</span>
            <span className="sa-legend__value">
              {seg.value.toLocaleString()}
              {showPercent && (
                <em className="sa-legend__pct">
                  {Math.round((seg.value / total) * 100)}%
                </em>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BarChart({ bars }) {
  if (bars.length === 0) {
    return (
      <div className="sa-empty">
        <FaChartPie />
        <span>No registrations yet</span>
      </div>
    );
  }

  const width = 520;
  const height = 212;
  const padLeft = 30;
  const padBottom = 34;
  const padTop = 10;

  const plotW = width - padLeft - 10;
  const plotH = height - padTop - padBottom;

  const maxValue = Math.max(1, ...bars.map(b => b.value));
  const ticks = 4;
  const slotW = plotW / bars.length;
  const barW = Math.min(30, slotW * 0.5);

  return (
    <div className="sa-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="sa-chart__svg" role="img">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const value = Math.round((maxValue / ticks) * (ticks - i));
          const y = padTop + (plotH / ticks) * i;
          return (
            <g key={i}>
              <line x1={padLeft} y1={y} x2={width - 10} y2={y} className="sa-gridline" />
              <text x={padLeft - 7} y={y + 3.5} className="sa-axis" textAnchor="end">{value}</text>
            </g>
          );
        })}

        {bars.map((bar, i) => {
          const barH = (bar.value / maxValue) * plotH;
          const x = padLeft + slotW * i + (slotW - barW) / 2;
          const y = padTop + plotH - barH;
          return (
            <g key={bar.label}>
              <rect
                x={x} y={y}
                width={barW}
                height={Math.max(barH, bar.value > 0 ? 2 : 0)}
                rx="3"
                fill={i % 2 === 0 ? '#4f7ce8' : '#a9c0f5'}
              >
                <title>{`${bar.label}: ${bar.value}`}</title>
              </rect>
              <text
                x={padLeft + slotW * i + slotW / 2}
                y={height - padBottom + 14}
                className="sa-axis sa-axis--x"
                textAnchor="middle"
              >
                {bar.label.length > 9 ? `${bar.label.slice(0, 8)}…` : bar.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LineChart({ points, seriesNames, colors }) {
  if (points.length === 0) {
    return (
      <div className="sa-empty">
        <FaChartPie />
        <span>No activity in this range</span>
      </div>
    );
  }

  const width = 520;
  const height = 212;
  const padLeft = 30;
  const padBottom = 34;
  const padTop = 10;

  const plotW = width - padLeft - 10;
  const plotH = height - padTop - padBottom;

  const maxValue = Math.max(1, ...points.flatMap(p => p.values));
  const ticks = 4;
  const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
  const offsetX = points.length === 1 ? plotW / 2 : 0;

  const coordsFor = (seriesIndex) => points.map((p, i) => ({
    x: padLeft + stepX * i + offsetX,
    y: padTop + plotH - (p.values[seriesIndex] / maxValue) * plotH,
  }));

  /* Catmull-Rom style smoothing, so the lines curve like the design
     instead of reading as sharp zig-zags. */
  const smoothPath = (coords) => {
    if (coords.length < 2) return '';
    let d = `M ${coords[0].x} ${coords[0].y}`;
    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[i === 0 ? 0 : i - 1];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  };

  return (
    <div className="sa-chart">
      <ul className="sa-legend sa-legend--row sa-legend--top">
        {seriesNames.map((name, i) => (
          <li key={name}>
            <span className="sa-legend__dot" style={{ background: colors[i] }} />
            <span className="sa-legend__label">{name}</span>
          </li>
        ))}
      </ul>

      <svg viewBox={`0 0 ${width} ${height}`} className="sa-chart__svg" role="img">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const value = Math.round((maxValue / ticks) * (ticks - i));
          const y = padTop + (plotH / ticks) * i;
          return (
            <g key={i}>
              <line x1={padLeft} y1={y} x2={width - 10} y2={y} className="sa-gridline" />
              <text x={padLeft - 7} y={y + 3.5} className="sa-axis" textAnchor="end">{value}</text>
            </g>
          );
        })}

        {seriesNames.map((name, si) => {
          const coords = coordsFor(si);
          return (
            <g key={name}>
              <path d={smoothPath(coords)} fill="none" stroke={colors[si]} strokeWidth="2.5" strokeLinecap="round" />
              {coords.map((c, i) => (
                <circle key={i} cx={c.x} cy={c.y} r="3.5" fill="#fff" stroke={colors[si]} strokeWidth="2">
                  <title>{`${points[i].label} — ${name}: ${points[i].values[si]}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

        {points.map((p, i) => (
          <text
            key={p.label + i}
            x={padLeft + stepX * i + offsetX}
            y={height - padBottom + 14}
            className="sa-axis sa-axis--x"
            textAnchor="middle"
          >
            {p.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

/* ── Time bucketing ──────────────────────────────────────────── */

/* A week gets a point per day (MON…SUN), a few months get weekly
   points, a year gets monthly ones — so the x-axis stays readable
   whichever range is selected. */
function buildTimeSeries(seriesA, seriesB, days) {
  const now = new Date();
  const mode = days === null ? 'month' : days <= 7 ? 'day' : days <= 90 ? 'week' : 'month';

  // 'All Time' (days === null) can't use the fixed 12-month window the
  // '12m' range uses — that would silently drop anything older than a
  // year while still showing the "All Time" label. Instead span from the
  // earliest createdAt actually present in the charted data through the
  // current month, capped so a single corrupt/far-past timestamp can't
  // blow up the number of buckets rendered.
  let count;
  if (mode === 'day') {
    count = 7;
  } else if (mode === 'week') {
    count = Math.ceil(days / 7);
  } else if (days === null) {
    const allDates = [...seriesA, ...seriesB];
    if (allDates.length === 0) {
      count = 1;
    } else {
      const earliest = allDates.reduce((min, d) => (d < min ? d : min), allDates[0]);
      const monthsSpan = (now.getFullYear() - earliest.getFullYear()) * 12
        + (now.getMonth() - earliest.getMonth()) + 1;
      count = Math.min(120, Math.max(1, monthsSpan));
    }
  } else {
    count = 12;
  }

  const buckets = Array.from({ length: count }, (_, i) => {
    const offset = count - 1 - i;

    if (mode === 'day') {
      const start = new Date(now);
      start.setDate(start.getDate() - offset);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return {
        start, end, values: [0, 0],
        label: start.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      };
    }

    if (mode === 'week') {
      const end = new Date(now);
      end.setDate(end.getDate() - offset * 7);
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      return {
        start, end, values: [0, 0],
        label: `${start.toLocaleString(undefined, { month: 'short' })} ${start.getDate()}`,
      };
    }

    const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const end   = new Date(now.getFullYear(), now.getMonth() - offset + 1, 0, 23, 59, 59);
    return {
      start, end, values: [0, 0],
      label: start.toLocaleString(undefined, { month: 'short' }).toUpperCase(),
    };
  });

  const place = (date, seriesIndex) => {
    if (!date) return;
    const bucket = buckets.find(b => date >= b.start && date <= b.end);
    if (bucket) bucket.values[seriesIndex]++;
  };

  seriesA.forEach(d => place(d, 0));
  seriesB.forEach(d => place(d, 1));

  return buckets.map(({ label, values }) => ({ label, values }));
}


/* ── Page ────────────────────────────────────────────────────── */

export default function SuperAdminPage() {
  const { userProfile, authLoading } = useContext(AuthContext);
  const { schoolName } = useContext(BrandingContext);
  const levelLabels = useContext(LevelLabelsContext);

  const LEVEL_OPTIONS = useMemo(() => [
    { key: 'all',        label: 'All Levels' },
    { key: 'elementary', label: levelLabels.elementary },
    { key: 'highSchool', label: levelLabels.highSchool },
    { key: 'college',    label: levelLabels.college },
  ], [levelLabels]);

  const [users, setUsers]                 = useState([]);
  const [registrations, setRegistrations] = useState([]);
  const [configsByLevel, setConfigsByLevel]     = useState({});
  const [schedulesByLevel, setSchedulesByLevel] = useState({});
  const [recordsByLevel, setRecordsByLevel]     = useState({});
  // Re-render periodically so a match's bucket (ongoing -> finished, or
  // upcoming -> ongoing) updates on its own while this page stays open,
  // same idea as DashboardPage.jsx's own clock tick.
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [rangeKey, setRangeKey]           = useState('12m');
  const [levelKey, setLevelKey]           = useState('all');

  // Which top-level tab is showing — Data Analytics (existing) or the new
  // Roles & Permissions section. Logs are fetched lazily, the first time
  // that tab is opened, rather than on every page load.
  const [sectionTab, setSectionTab]       = useState('analytics');
  // Sub-tab within "Web Customization" — School (branding) or Landing Page.
  const [webTab, setWebTab]               = useState('branding');
  const [logs, setLogs]                   = useState([]);
  const [logsLoading, setLogsLoading]     = useState(false);
  const [logsError, setLogsError]         = useState('');
  const [logsLoaded, setLogsLoaded]       = useState(false);

  const range = RANGES.find(r => r.key === rangeKey) || RANGES[3];

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError('');
    try {
      setLogs(await getActivityLogs());
    } catch (err) {
      console.error(err);
      setLogsError('Failed to load activity logs.');
    } finally {
      setLogsLoading(false);
      setLogsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (sectionTab === 'roles' && !logsLoaded) fetchLogs();
  }, [sectionTab, logsLoaded, fetchLogs]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const fetchAnalytics = useCallback(async () => {
    if (!db) {
      setError('Firestore not connected.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // getAllUsers/getAllRegistrations share an in-flight de-dupe cache
      // with the embedded StudentRegistrationDetails table's own fetch of
      // the same 2 collections, so loading this tab doesn't double them up.
      const [users, registrations, configs, schedules, records] = await Promise.all([
        getAllUsers(),
        getAllRegistrations(),
        Promise.all(LEVELS.map(l => getSportsTeamsConfig(l).catch(() => ({ sports: [], teams: [] })))),
        Promise.all(LEVELS.map(l => getMatchSchedules(l).catch(() => []))),
        Promise.all(LEVELS.map(l => getMatchRecords(l).catch(() => []))),
      ]);

      setUsers(users);
      setRegistrations(registrations);

      const configMap = {};
      const scheduleMap = {};
      const recordMap = {};
      LEVELS.forEach((l, i) => {
        configMap[l] = configs[i];
        scheduleMap[l] = schedules[i];
        recordMap[l] = records[i];
      });
      setConfigsByLevel(configMap);
      setSchedulesByLevel(scheduleMap);
      setRecordsByLevel(recordMap);
      setNow(new Date());
    } catch (err) {
      console.error(err);
      setError('Failed to load analytics data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  /* Sports / teams / matches are per-level config docs, so the level tabs
     filter them by selecting which level(s) to read from rather than by
     date — "all" just merges the three levels together. */
  const levelsForConfig = useMemo(
    () => (levelKey === 'all' ? LEVELS : [levelKey]),
    [levelKey],
  );

  const sportNames = useMemo(() => {
    const names = new Set();
    levelsForConfig.forEach((l) => {
      (configsByLevel[l]?.sports || []).forEach(s => { if (s?.name) names.add(s.name.trim()); });
    });
    return [...names];
  }, [configsByLevel, levelsForConfig]);

  const teamCount = useMemo(
    () => levelsForConfig.reduce((sum, l) => sum + (configsByLevel[l]?.teams || []).length, 0),
    [configsByLevel, levelsForConfig],
  );

  const matches = useMemo(
    () => levelsForConfig.flatMap(l => schedulesByLevel[l] || []),
    [schedulesByLevel, levelsForConfig],
  );

  /* Classified per-level (a schedule only ever matches records from its
     OWN level's matchRecords doc) then flattened, so "All Levels" can't
     accidentally cross-match a college fixture against an elementary
     record that happens to share a sport/team name. */
  const matchBuckets = useMemo(
    () => levelsForConfig.flatMap(l => {
      const records = recordsByLevel[l] || [];
      return (schedulesByLevel[l] || []).map(m => classifyMatch(m, records, now));
    }),
    [schedulesByLevel, recordsByLevel, levelsForConfig, now],
  );

  /* Users and registrations carry createdAt and a grade level, so they
     answer to both filters. */
  const cutoff = useMemo(() => {
    if (range.days === null) return null;
    const date = new Date();
    date.setDate(date.getDate() - range.days);
    date.setHours(0, 0, 0, 0);
    return date;
  }, [range]);

  const matchesFilters = useCallback((record) => {
    if (levelKey !== 'all' && getSchoolLevel(record.gradeLevel) !== levelKey) return false;
    if (!cutoff) return true;
    const created = toDate(record.createdAt);
    // Records with no timestamp predate the field — keep them visible
    // rather than making them vanish from every filtered view.
    if (!created) return true;
    return created >= cutoff;
  }, [cutoff, levelKey]);

  const rangedUsers = useMemo(() => users.filter(matchesFilters), [users, matchesFilters]);
  const rangedRegs  = useMemo(() => registrations.filter(matchesFilters), [registrations, matchesFilters]);

  /* A student account that has submitted a registration is a Player;
     one that hasn't is an Audience member. That's the only honest way
     to split the two from the data — there's no `audience` role. */
  const registeredUids = useMemo(
    () => new Set(registrations.map(r => r.uid).filter(Boolean)),
    [registrations],
  );

  const roleOf = useCallback((user) => {
    const role = (user.role || 'student').toLowerCase();
    if (role !== 'student') return role;
    return registeredUids.has(user.id) ? 'player' : 'audience';
  }, [registeredUids]);

  /* ── Tiles ── */
  const pendingCount = useMemo(
    () => rangedRegs.filter(r => (r.status || 'pending') === 'pending').length,
    [rangedRegs]
  );
  // A rejected registration no longer holds a spot, so it shouldn't keep
  // counting toward Total Players once an admin has rejected it.
  const activePlayerCount = useMemo(
    () => rangedRegs.filter(r => r.status !== 'rejected').length,
    [rangedRegs]
  );

  const tiles = [
    { icon: FaUsers,       label: 'Total Users',        value: rangedUsers.length,   color: '#6d28d9' },
    { icon: FaRunning,     label: 'Total Sports',       value: sportNames.length,    color: '#f5a623' },
    { icon: FaUsersCog,    label: 'Total Teams',        value: teamCount,            color: '#16a34a' },
    { icon: FaCalendarAlt, label: 'Total Matches',      value: matches.length,       color: '#1d4ed8' },
    { icon: FaUserCheck,   label: 'Total Players',      value: activePlayerCount,    color: '#db2777' },
    { icon: FaClock,       label: 'Pending Review',     value: pendingCount,         color: '#ea580c' },
  ];

  /* ── Sports participation ── */
  const sportBars = useMemo(() => {
    const map = {};
    rangedRegs.forEach((r) => {
      if (!r.sport) return;
      const name = r.sport.trim();
      map[name] = (map[name] || 0) + 1;
    });
    return Object.entries(map)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [rangedRegs]);

  /* ── Registration over time ── */
  const timeSeries = useMemo(() => buildTimeSeries(
    rangedUsers.map(u => toDate(u.createdAt)).filter(Boolean),
    rangedRegs.map(r => toDate(r.createdAt)).filter(Boolean),
    range.days,
  ), [rangedUsers, rangedRegs, range.days]);

  /* ── Donuts ── */
  const statusSegments = useMemo(() => {
    const counts = { finished: 0, ongoing: 0, upcoming: 0 };
    matchBuckets.forEach((bucket) => { counts[bucket]++; });
    return STATUS_BUCKETS.map(b => ({ label: b.label, value: counts[b.key], color: b.color }));
  }, [matchBuckets]);

  const roleSegments = useMemo(() => {
    const counts = { audience: 0, player: 0, moderator: 0, admin: 0, superadmin: 0 };
    rangedUsers.forEach((u) => {
      const role = roleOf(u);
      if (counts[role] !== undefined) counts[role]++;
    });
    return [
      { label: 'Audiences',   value: counts.audience,   color: '#1d4ed8' },
      { label: 'Players',     value: counts.player,     color: '#f5a623' },
      { label: 'Moderators',  value: counts.moderator,  color: '#16a34a' },
      { label: 'Admins',      value: counts.admin,      color: '#dc2626' },
      { label: 'Super Admins', value: counts.superadmin, color: '#7c3aed' },
    ];
  }, [rangedUsers, roleOf]);

  const genderSegments = useMemo(() => {
    const counts = { Male: 0, Female: 0, Others: 0 };
    rangedRegs.forEach((r) => {
      const gender = (r.gender || '').toLowerCase();
      if (gender === 'male') counts.Male++;
      else if (gender === 'female') counts.Female++;
      else counts.Others++;
    });
    return [
      { label: 'Male',   value: counts.Male,   color: '#1d4ed8' },
      { label: 'Female', value: counts.Female, color: '#db2777' },
      { label: 'Others', value: counts.Others, color: '#94a3b8' },
    ];
  }, [rangedRegs]);

  const rangeCaption = useMemo(() => {
    if (!cutoff) return 'All time';
    return `${formatDay(cutoff)} — ${formatDay(new Date())}`;
  }, [cutoff]);

  const handleExport = () => {
    const header = ['Name', 'Email', 'Gender', 'Grade/Year', 'Section', 'Sport', 'Team', 'Event', 'Status', 'Registered On'];
    const rows = rangedRegs.map(r => [
      r.fullName || '', r.email || r.studentEmail || '', r.gender || '',
      r.gradeLevel || '', r.section || '', r.sport || '', r.teamName || '',
      r.event || '', r.status || '', formatDateTime(toDate(r.createdAt)),
    ]);

    // Quote every field and double any embedded quotes, so names with
    // commas ("Dela Torre, Leslie") don't split into extra columns.
    const csv = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `registrations-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // ProtectedRoute already gates this route, but bail out of the render
  // itself too, so analytics never paints for a non-super-admin even
  // for the instant before a redirect lands.
  if (authLoading) return <div className="sa-page"><p className="sa-loading">Loading…</p></div>;
  if (userProfile?.role !== 'superadmin') return null;

  return (
    <div className="sa-page">

      <header className="sa-header">
        <h1 className="sa-header__title">{schoolName}</h1>
      </header>

      <div className="sa-body">
        <div className="sa-panel">

          <LevelTabs
            levels={[
              { key: 'analytics', label: 'Data Analytics' },
              { key: 'roles', label: 'Roles & Permissions' },
              { key: 'branding', label: 'Web Customization' },
            ]}
            value={sectionTab}
            onChange={setSectionTab}
            containerClassName="sa-lvltabs"
            tabClassName="sa-lvltab"
            activeClassName="sa-lvltab--active"
          />

          {sectionTab === 'roles' ? (
            <>
              <div className="sa-panel__head">
                <div>
                  <h2 className="sa-panel__title">Activity Logs &amp; Roles Management</h2>
                  <p className="sa-panel__sub">
                    Manage user roles, permissions, account status, and review activity logs to monitor actions performed throughout the system.
                  </p>
                </div>
              </div>
              <ActivityLogsAndRoles
                users={users}
                logs={logs}
                loading={logsLoading}
                error={logsError}
                onRefresh={fetchLogs}
                onUserRoleChanged={fetchAnalytics}
                actorRole={userProfile?.role}
              />
            </>
          ) : sectionTab === 'branding' ? (
            <>
              <LevelTabs
                levels={[
                  { key: 'branding', label: 'Branding' },
                  { key: 'landingPage', label: 'Landing Page' },
                  { key: 'levels', label: 'School Levels' },
                ]}
                value={webTab}
                onChange={setWebTab}
                containerClassName="sa-lvltabs"
                tabClassName="sa-lvltab"
                activeClassName="sa-lvltab--active"
              />
              {webTab === 'landingPage'
                ? <LandingPageSettings actorEmail={userProfile?.email} actorRole={userProfile?.role} />
                : webTab === 'levels'
                ? <LevelLabelsSettings actorEmail={userProfile?.email} actorRole={userProfile?.role} />
                : <BrandingSettings actorEmail={userProfile?.email} actorRole={userProfile?.role} />}
            </>
          ) : (
          <>
          {/* ── Panel head ── */}
          <div className="sa-panel__head">
            <div>
              <h2 className="sa-panel__title">Data Analytics</h2>
              <p className="sa-panel__sub">
                Welcome back{userProfile?.name ? `, ${userProfile.name}` : ''}. Here's what's happening in the system
              </p>
            </div>
            <div className="sa-panel__actions">
              <LevelTabs
                levels={LEVEL_OPTIONS}
                value={levelKey}
                onChange={setLevelKey}
                containerClassName="sa-lvltabs"
                tabClassName="sa-lvltab"
                activeClassName="sa-lvltab--active"
              />
              <span className="sa-daterange" title={rangeCaption}>
                <FaRegCalendarAlt />
                {rangeCaption}
              </span>
              <RangeDropdown value={rangeKey} options={RANGES} onChange={setRangeKey} />
              <button className="sa-icon-btn" onClick={fetchAnalytics} disabled={loading} title="Refresh">
                <FaSync className={loading ? 'sa-spin' : ''} />
              </button>
              <button className="sa-export" onClick={handleExport} disabled={loading || rangedRegs.length === 0}>
                <FaDownload /> Export Data
              </button>
            </div>
          </div>

          {error && <div className="sa-alert">{error}</div>}

          {/* ── Stat tiles ── */}
          <div className="sa-tiles">
            {tiles.map(({ icon: Icon, label, value, color }) => (
              <div className="sa-tile" key={label}>
                <span className="sa-tile__icon" style={{ background: color }}><Icon /></span>
                <div className="sa-tile__text">
                  <span className="sa-tile__label">{label}</span>
                  <span className="sa-tile__num">{loading ? '…' : value.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ── Row 1 ── */}
          <div className="sa-grid sa-grid--2">
            <div className="sa-card">
              <div className="sa-card__head">
                <h3>Sports Participation</h3>
                <span className="sa-card__tag">Top 8</span>
              </div>
              {loading ? <p className="sa-loading">Loading…</p> : <BarChart bars={sportBars} />}
            </div>

            <div className="sa-card">
              <div className="sa-card__head">
                <h3>User Registration Over Time</h3>
                <span className="sa-card__tag">{range.label}</span>
              </div>
              {loading
                ? <p className="sa-loading">Loading…</p>
                : <LineChart
                    points={timeSeries}
                    seriesNames={['New Users', 'Player Registrations']}
                    colors={['#1d4ed8', '#f5a623']}
                  />}
            </div>
          </div>

          {/* ── Row 2 ── */}
          <div className="sa-grid sa-grid--3">
            <div className="sa-card">
              <div className="sa-card__head"><h3>Event Status</h3></div>
              {loading
                ? <p className="sa-loading">Loading…</p>
                : <Donut segments={statusSegments} />}
            </div>

            <div className="sa-card">
              <div className="sa-card__head"><h3>User Distribution by Role</h3></div>
              {loading
                ? <p className="sa-loading">Loading…</p>
                : <Donut segments={roleSegments} />}
            </div>

            <div className="sa-card">
              <div className="sa-card__head"><h3>Gender Distribution</h3></div>
              {loading
                ? <p className="sa-loading">Loading…</p>
                : <Donut segments={genderSegments} />}
            </div>
          </div>

          <p className="sa-footnote">
            Sports, Teams and Matches show current totals — they're configuration rather than
            dated events, so the date range doesn't apply to them.
          </p>

          {/* ── Student Registration Details ── */}
          {/* Moved here from the Admin page's Registration tab — same
              component, filters, table and modal, just relocated.
              scope="allUsers": Super Admin sees every signed-up student
              account (registered as a player or not), unlike the Admin
              page which only lists actual registration submissions. */}
          {/* Patch the local registrations state instead of a full
              fetchAnalytics refetch — rangedRegs/tiles/charts below are all
              derived from it reactively, so a rejection or delete updates
              Total Players (and the sport/gender breakdowns) right away
              without re-hitting Firestore for sports configs/schedules/
              records too. */}
          <StudentRegistrationDetails
            scope="allUsers"
            onStatusChange={(regId, status) => setRegistrations(prev => prev.map(r => (
              r.id === regId ? { ...r, status } : r
            )))}
            onDeleted={(regId) => setRegistrations(prev => prev.filter(r => r.id !== regId))}
          />
          </>
          )}

        </div>
      </div>
    </div>
  );
}