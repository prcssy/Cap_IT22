import { useContext } from 'react';
import { AuthContext } from '../context/AuthContext';

// Every grade/year a student can pick, grouped by the school level it belongs to.
export const GRADES_BY_LEVEL = {
  elementary: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'],
  highSchool: ['Grade 7', 'Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'],
  college: ['1st Year', '2nd Year', '3rd Year', '4th Year'],
};

const ELEMENTARY_GRADES = new Set(GRADES_BY_LEVEL.elementary);
const HIGH_SCHOOL_GRADES = new Set(GRADES_BY_LEVEL.highSchool);
const COLLEGE_GRADES = new Set(GRADES_BY_LEVEL.college);

export function getSchoolLevel(gradeLevel) {
  if (!gradeLevel) return null;
  if (ELEMENTARY_GRADES.has(gradeLevel)) return 'elementary';
  if (HIGH_SCHOOL_GRADES.has(gradeLevel)) return 'highSchool';
  if (COLLEGE_GRADES.has(gradeLevel)) return 'college';
  return null;
}

/* The school level a signed-in user is locked to: a student's level (from the
   grade/year they picked at signup), or an admin/moderator's assigned level
   (`staffLevel`), or the level a coach is assigned to (also `staffLevel`).
   null for Super Admins / accounts with no grade — those keep
   the level switcher. */
export function useLockedLevel() {
  const { userProfile } = useContext(AuthContext);
  if (!userProfile) return null;
  if (userProfile.role === 'admin' || userProfile.role === 'moderator' || userProfile.role === 'coach') return userProfile.staffLevel || null;
  if (userProfile.role && userProfile.role !== 'student') return null;
  return getSchoolLevel(userProfile.gradeLevel);
}
