/* Shared segmented-control tab list for switching between school levels
   (elementary/highSchool/college). Each page passes in its own class names
   so the visual theme (colors, font, active state) stays exactly as it was
   before this was extracted — only the repeated markup/behavior is shared. */
export default function LevelTabs({
  levels,
  value,
  onChange,
  containerClassName,
  tabClassName,
  activeClassName,
  wrapperClassName,
}) {
  const options = levels.map((l) => (typeof l === 'string' ? { key: l, label: l } : l));

  const tabs = (
    <div className={containerClassName} role="tablist" aria-label="School level">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          role="tab"
          aria-selected={value === opt.key}
          className={`${tabClassName} ${value === opt.key ? activeClassName : ''}`}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );

  return wrapperClassName ? <div className={wrapperClassName}>{tabs}</div> : tabs;
}
