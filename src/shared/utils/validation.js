/* ── Shared input validation ──
   One place for the "is this a real value?" checks used by the sign-up form
   and the player registration form, so a name like "dlashdasd" or "asdf"
   is flagged the same way everywhere. Each validator returns an error
   message string, or null when the value is acceptable. Length limits here
   mirror the ones enforced server-side in firestore.rules. */

export const LIMITS = {
  name: 100,
  section: 50,
  message: 500,
  // Street/house no. only — the full composed address (street + barangay +
  // city + province) stays under the 255-character cap in firestore.rules.
  street: 100,
};

const VOWELS = /[aeiouy]/i;
// Letters incl. accented (ñ, é …), spaces, and the punctuation real names use
// (comma for the "Last Name, First Name" order the registration form asks for).
const NAME_CHARS = /^[\p{L}][\p{L}\s.,'-]*$/u;

/* Heuristic gibberish check for a single word: real names in English/
   Filipino almost always have a vowel, never 5+ consonants in a row, and
   never the same letter 3+ times in a row. Short words (initials like "D.",
   "Jr") are skipped. */
function wordLooksLikeGibberish(word) {
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (letters.length < 3) return false;
  if (!VOWELS.test(letters)) return true;
  if (/(\p{L})\1\1/iu.test(letters)) return true;
  if (/[^aeiouy\s]{5,}/i.test(letters)) return true;
  // Typed entirely on the keyboard's home row ("dlashdasd", "sadjkl").
  // Its only vowel is "a", so real names this long never fit in it.
  if (letters.length >= 6 && /^[asdfghjkl]+$/i.test(letters)) return true;
  return false;
}

/* Keyboard-mash strings that pass the vowel checks ("asdf", "qwerty"). */
const KEYBOARD_MASH = /(asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|uiop|zxcv|xcvb|cvbn|vbnm|jkl;)/i;

export function looksLikeGibberish(text) {
  const value = (text || '').trim();
  if (!value) return false;
  if (KEYBOARD_MASH.test(value.replace(/\s/g, ''))) return true;
  return value.split(/\s+/).some(wordLooksLikeGibberish);
}

export const NAME_FORMAT_HINT = 'Last Name, First Name, Middle Name';

/* A person's full name: letters only (plus space , . ' -), at least a first
   and last name, no gibberish. `label` customizes the message.
   With `lastNameFirst`, the name must follow NAME_FORMAT_HINT: a last name,
   a comma, then the first name (the middle name, after an optional second
   comma, may be left out), e.g. "Dela Cruz, Juan Santos". */
export function validatePersonName(value, label = 'Full name', { lastNameFirst = false } = {}) {
  const name = (value || '').trim().replace(/\s+/g, ' ').replace(/,(?=\S)/g, ', ');
  if (!name) return `${label} is required`;
  if (name.length > LIMITS.name) return `${label} must be ${LIMITS.name} characters or fewer`;
  if (!NAME_CHARS.test(name)) return `${label} can only contain letters, spaces, commas, periods, apostrophes and hyphens`;
  if (lastNameFirst) {
    const parts = name.split(',').map((p) => p.trim());
    const hasLetters = (p) => /\p{L}/u.test(p || '');
    if (parts.length < 2 || parts.length > 3 || !hasLetters(parts[0]) || !hasLetters(parts[1])
        || (parts.length === 3 && parts[2] && !hasLetters(parts[2]))) {
      return `Please use the format "${NAME_FORMAT_HINT}" (e.g. Dela Cruz, Juan Santos)`;
    }
  }
  const words = name.split(' ').filter((w) => w.replace(/[^\p{L}]/gu, '').length > 0);
  if (words.length < 2) return `Please enter a complete ${label.toLowerCase()} (first and last name)`;
  if (looksLikeGibberish(name)) return `${label} doesn't look like a real name — please check the spelling`;
  return null;
}

/* Class section: short, letters/digits/space/hyphen ("St. Luke", "A", "12-B").
   `checkGibberish: false` skips the typo heuristic — used for sections a
   Super Admin sets up, which are often vowel-less acronyms ("CBS", "CCS"). */
export function validateSection(value, { checkGibberish = true } = {}) {
  const section = (value || '').trim();
  if (!section) return 'Please enter a section';
  if (section.length > LIMITS.section) return `Section must be ${LIMITS.section} characters or fewer`;
  if (!/^[\p{L}\d][\p{L}\d\s.'-]*$/u.test(section)) return 'Section can only contain letters, numbers, spaces, periods and hyphens';
  if (checkGibberish && looksLikeGibberish(section.replace(/\d/g, ' '))) return "Section doesn't look valid — please check the spelling";
  return null;
}

/* Optional free-text message: only length-limited. */
export function validateMessage(value) {
  return (value || '').length > LIMITS.message ? `Message must be ${LIMITS.message} characters or fewer` : null;
}

export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'number', label: 'A number', test: (p) => /\d/.test(p) },
];

export function validatePassword(password) {
  const failed = PASSWORD_RULES.filter((r) => !r.test(password || ''));
  if (!failed.length) return null;
  return `Password needs: ${failed.map((r) => r.label.toLowerCase()).join(', ')}`;
}
