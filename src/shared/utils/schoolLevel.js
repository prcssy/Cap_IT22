import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';

const ELEMENTARY_GRADES = new Set(['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6']);
const HIGH_SCHOOL_GRADES = new Set(['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12']);
const COLLEGE_GRADES = new Set(['1st Year', '2nd Year', '3rd Year', '4th Year']);

export function getSchoolLevel(gradeLevel) {
  if (!gradeLevel) return null;
  if (ELEMENTARY_GRADES.has(gradeLevel)) return 'elementary';
  if (HIGH_SCHOOL_GRADES.has(gradeLevel)) return 'highSchool';
  if (COLLEGE_GRADES.has(gradeLevel)) return 'college';
  return null;
}

/* The school level a signed-in student is locked to (from the grade/year
   they picked at signup), or null for staff / accounts with no grade — those
   keep the level switcher. */
export function useLockedLevel() {
  const { userProfile } = useContext(AuthContext);
  if (!userProfile || (userProfile.role && userProfile.role !== 'student')) return null;
  return getSchoolLevel(userProfile.gradeLevel);
}
