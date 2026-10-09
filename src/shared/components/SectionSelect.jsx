import { LIMITS } from '../utils/validation';
import { sectionsForGrade } from '../utils/sections';

/**
 * Section field for the sign-up and player registration forms: a dropdown
 * of the Super Admin's sections for the chosen grade/year, or a plain text
 * box when that grade has none configured yet. `onChange` gets the native
 * change event either way, so it drops into each form's existing handler.
 */
export default function SectionSelect({ byGrade, gradeLevel, value, onChange, className, id, name, placeholder }) {
  const options = sectionsForGrade(byGrade, gradeLevel);
  // No grade picked yet: show a disabled dropdown if sections are set up
  // anywhere, so the field doesn't flip from text box to dropdown mid-form.
  const anyConfigured = Object.values(byGrade || {}).some((list) => Array.isArray(list) && list.length > 0);
  if (options.length === 0 && (gradeLevel || !anyConfigured)) {
    return (
      <input
        type="text"
        className={className}
        id={id}
        name={name}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        maxLength={LIMITS.section}
        required
      />
    );
  }
  return (
    <select
      className={className}
      id={id}
      name={name}
      value={options.includes(value) ? value : ''}
      onChange={onChange}
      disabled={!gradeLevel}
      required
    >
      <option value="">{gradeLevel ? 'Select Section' : 'Select Grade / Year first'}</option>
      {options.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}
