/* Maps Firebase Auth / Cloud Functions error codes to plain-language
   messages. Raw Firebase messages ("Firebase: Error (auth/invalid-credential).")
   mean nothing to a student, so every auth screen shows these instead. */

const MESSAGES = {
  'auth/invalid-credential': 'Incorrect email or password. Please try again.',
  'auth/wrong-password': 'Incorrect email or password. Please try again.',
  'auth/user-not-found': 'Incorrect email or password. Please try again.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/missing-email': 'Please enter your email address.',
  'auth/email-already-in-use': 'An account with this email already exists. Please log in instead.',
  'auth/weak-password': 'Password is too weak. Use at least 8 characters with uppercase, lowercase and a number.',
  'auth/password-does-not-meet-requirements': 'Password is too weak. Use at least 8 characters with uppercase, lowercase and a number.',
  'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
  'auth/user-disabled': 'This account has been disabled. Please contact the school administrator.',
  'auth/network-request-failed': 'Network error. Please check your internet connection and try again.',
  'auth/operation-not-allowed': 'This sign-in method is not available. Please contact the administrator.',
  // Every signup/staff Cloud Function enforces App Check; a request without
  // a valid App Check token (blocked reCAPTCHA, unregistered dev debug
  // token) is rejected as "unauthenticated" before any sign-in check.
  'functions/unauthenticated': 'We could not verify this browser (security check failed). Please refresh the page and try again. If it keeps happening, turn off ad/script blockers or try another browser.',
  'functions/unavailable': 'The server is temporarily unavailable. Please try again in a moment.',
  'functions/internal': 'Something went wrong on the server. Please try again.',
};

export function friendlyAuthError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback;
  if (error.code && MESSAGES[error.code]) return MESSAGES[error.code];
  // Our own errors (email-not-verified, Cloud Function HttpsErrors like
  // "already-exists") already carry a readable message.
  const msg = error.message || '';
  if (msg && !msg.startsWith('Firebase:') && !/^[a-z-]+\/[a-z-]+$/.test(msg)) return msg;
  return fallback;
}
