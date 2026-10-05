import React, { useEffect, useRef, useState } from 'react';
import { FaChevronDown } from 'react-icons/fa';
import './SetPicker.css';

function norm(value) {
  return (value || '').trim().toLowerCase();
}

/* ONE dropdown for Sport → Category → Division, as a hover menu: hovering a
   sport shows its categories beside it, hovering a category shows its
   divisions beside that, and clicking a division selects that set and
   closes. On touch screens (no hover) tapping a sport/category opens the
   next column instead. A level with nothing named to choose is skipped — a
   sport or category with nothing further under it is selected by clicking
   it. Columns sit side by side inside one panel (no nested flyouts that
   could run off-screen). A custom button + list (not a native <select>) so
   it follows the page's navy / gold theme.

   `tree`: [{ sport, groups: [{ group, divisions: [division, …] }] }] — ''
   stands for "no named category/division". `value`/`onChange` use
   { sport, group, division }. Shared by Game Schedules and Home. */
export default function SetPicker({ tree, value, onChange, showPath = false }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ sport: null, group: null });
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groupsOf = (sport) => tree.find((n) => norm(n.sport) === norm(sport))?.groups || [];
  const named = (list) => list.filter(Boolean);
  // A sport "has categories" when any is named; otherwise its single unnamed
  // group's divisions are shown straight after the sport.
  const namedGroups = (sport) => groupsOf(sport).filter((g) => g.group);
  const divisionsOf = (sport, group) => groupsOf(sport).find((g) => norm(g.group) === norm(group))?.divisions || [];
  const sportHasMore = (sport) => namedGroups(sport).length > 0 || groupsOf(sport).some((g) => named(g.divisions).length > 0);

  const commit = (sport, group, division) => {
    onChange({ sport, group, division });
    setOpen(false);
  };
  const toggle = () => {
    // Open on the current selection's path, so its columns are already showing.
    setHover({ sport: value.sport, group: namedGroups(value.sport).length ? value.group : '' });
    setOpen((o) => !o);
  };

  const showSport = (sport) => setHover({ sport, group: namedGroups(sport).length ? null : '' });
  const clickSport = (sport) => {
    if (!sportHasMore(sport)) commit(sport, groupsOf(sport)[0]?.group || '', '');
    else showSport(sport); // touch: tap opens the next column
  };
  const clickGroup = (group) => {
    if (named(divisionsOf(hover.sport, group)).length === 0) commit(hover.sport, group, '');
    else setHover((h) => ({ ...h, group }));
  };

  const hs = hover.sport;
  const groupCol = hs && namedGroups(hs).length > 0 ? namedGroups(hs) : null;
  const divisionCol = hs && hover.group != null && named(divisionsOf(hs, hover.group)).length > 0
    ? divisionsOf(hs, hover.group) : null;
  const isCurrent = (sport, group, division) => norm(sport) === norm(value.sport)
    && (group === undefined || norm(group) === norm(value.group))
    && (division === undefined || norm(division) === norm(value.division));

  const current = [value.sport, value.group, value.division].filter(Boolean);

  const item = ({ key, label, active, path, more, onEnter, onClick }) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={active}
      className={`ms-select__option${active ? ' ms-select__option--active' : ''}${path ? ' ms-select__option--path' : ''}`}
      onMouseEnter={onEnter}
      onFocus={onEnter}
      onClick={onClick}
    >
      <span>{label}</span>
      {more && <span className="ms-select__more" aria-hidden="true">›</span>}
    </button>
  );

  return (
    <div className="ms-select" ref={wrapRef}>
      <div className="ms-select__dd">
        <button
          type="button"
          className="ms-select__trigger"
          onClick={toggle}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Showing ${current.join(', ')}. Change sport, category or division`}
        >
          {/* Just the sport here — the category/division show in the set's
              title below, and in the menu once it's open. */}
          <span className="ms-select__value">
            <span className="ms-select__part ms-select__part--sport">{value.sport}</span>
            {/* `showPath`: also show the picked category/division in the box,
                for pages with no set title below to show them (Home). */}
            {showPath && current.slice(1).map((part) => (
              <React.Fragment key={part}>
                <span className="ms-select__sep" aria-hidden="true">›</span>
                <span className="ms-select__part">{part}</span>
              </React.Fragment>
            ))}
          </span>
          <FaChevronDown className={`ms-select__arrow ${open ? 'ms-select__arrow--open' : ''}`} />
        </button>
        {open && (
          <div className="ms-select__panel ms-select__panel--cols">
            <div className="ms-select__col" role="listbox" aria-label="Sport">
              <span className="ms-select__step">Sport</span>
              {tree.map((n) => item({
                key: n.sport,
                label: n.sport,
                active: isCurrent(n.sport),
                path: norm(n.sport) === norm(hs),
                more: sportHasMore(n.sport),
                onEnter: () => showSport(n.sport),
                onClick: () => clickSport(n.sport),
              }))}
            </div>
            {groupCol && (
              <div className="ms-select__col" role="listbox" aria-label="Category">
                <span className="ms-select__step">Category</span>
                {groupCol.map((g) => item({
                  key: g.group,
                  label: g.group,
                  active: isCurrent(hs, g.group),
                  path: norm(g.group) === norm(hover.group),
                  more: named(g.divisions).length > 0,
                  onEnter: () => setHover((h) => ({ ...h, group: g.group })),
                  onClick: () => clickGroup(g.group),
                }))}
              </div>
            )}
            {divisionCol && (
              <div className="ms-select__col" role="listbox" aria-label="Division">
                <span className="ms-select__step">Division</span>
                {divisionCol.map((d) => item({
                  key: d || '__general',
                  label: d || 'General',
                  active: isCurrent(hs, hover.group, d),
                  path: false,
                  more: false,
                  onEnter: undefined,
                  onClick: () => commit(hs, hover.group, d),
                }))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
