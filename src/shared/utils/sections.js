import { useEffect, useState } from 'react';
import { subscribeSectionOptions } from '../services/firestoreService';
import { validateSection } from './validation';

/* Live { [gradeLevel]: string[] } from siteConfig/sections — the sections
   a Super Admin set up in Web Customization → Sections. */
export function useSectionOptions() {
  const [byGrade, setByGrade] = useState({});
  const [loading, setLoading] = useState(true);
  useEffect(() => subscribeSectionOptions((data) => {
    setByGrade(data);
    setLoading(false);
  }), []);
  return { byGrade, loading };
}

/* The sections offered for one grade/year — [] means none configured, in
   which case the form falls back to typing the section in. */
export function sectionsForGrade(byGrade, gradeLevel) {
  return (gradeLevel && Array.isArray(byGrade?.[gradeLevel])) ? byGrade[gradeLevel] : [];
}

/* Validates the Section field on the sign-up / player registration forms.
   When the grade has a configured list, the value just has to be one of
   them (catches a stale section carried over from an old profile, or one
   left behind after changing grade) — those were already checked when the
   Super Admin saved them, and the typo heuristic would wrongly reject
   acronyms like "CBS". Otherwise it's free text and gets the full check. */
export function validateSectionField(byGrade, gradeLevel, value) {
  const options = sectionsForGrade(byGrade, gradeLevel);
  if (options.length === 0) return validateSection(value);
  return options.includes((value || '').trim()) ? null : 'Please select your section';
}
