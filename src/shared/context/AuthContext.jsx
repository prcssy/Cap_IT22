import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { auth, db } from '../firebase';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
  updatePassword as firebaseUpdatePassword,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { createUserProfile, getUserProfile, logActivity } from '../services/firestoreService';

// ════════════════════════════════════════════════════════════════════════════════
// STAFF ACCOUNTS CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════════
// Staff roles are managed through Firestore. To grant a role to an account, go to
// Firebase Console → Firestore Database → and add a document using the staff
// member's email (lowercase) as the Document ID, inside one of these collections:
//   • "superadmins"  → Super Admin access
//   • "admins"       → Admin access
//   • "moderators"   → Moderator access
// Anyone whose email is not present in any of these collections is treated as a
// regular student/player account.
// ════════════════════════════════════════════════════════════════════════════════

const ROLE_COLLECTIONS = [
  { role: 'superadmin', collection: 'superadmins' },
  { role: 'admin', collection: 'admins' },
  { role: 'moderator', collection: 'moderators' },
];

export const AuthContext = createContext({
  authModal: { isOpen: false, screen: 'login' },
  openAuthModal: () => {},
  closeAuthModal: () => {},
  switchScreen: () => {},
  currentUser: null,
  userProfile: null,
  userRole: 'guest',
  isAdmin: false,
  authLoading: false,
  login: async () => {},
  signup: async () => {},
  resendVerificationEmail: async () => {},
  resetPassword: async () => {},
  updatePassword: async () => {},
  logout: async () => {},
});

/**
 * Check the "superadmins", "admins", and "moderators" Firestore collections
 * (document ID = lowercase email) to resolve a staff role for this email.
 * Returns 'superadmin' | 'admin' | 'moderator' | 'student'.
 * This is the single source of truth for role/security checks — a user
 * cannot claim a privileged role unless their email exists in Firestore.
 *
 * Module-level rather than defined inside AuthProvider: it only ever reads
 * the module-scoped `db`, never any component state, so keeping it outside
 * means `login`/`signup` below can depend on a reference that never changes,
 * instead of a fresh closure every render.
 */
async function resolveStaffRole(email) {
  if (!db || !email) return 'student';
  const lower = email.toLowerCase();
  // The 3 checks are independent reads (different docs, different
  // collections) — firing them in parallel instead of one-at-a-time in a
  // for-loop turns "up to 3 sequential round trips" into 1, which matters
  // a lot here since this runs at least twice on every login (once inside
  // login() itself, once again from the onAuthStateChanged handler below).
  // Priority (superadmin > admin > moderator) is preserved by picking the
  // highest-priority collection that came back `exists`, regardless of
  // which promise happened to settle first.
  const results = await Promise.all(
    ROLE_COLLECTIONS.map(async ({ role, collection }) => {
      try {
        const snap = await getDoc(doc(db, collection, lower));
        return snap.exists() ? role : null;
      } catch (error) {
        console.warn(`Failed to check ${collection} status:`, error);
        return null;
      }
    })
  );
  return results.find(Boolean) || 'student';
}

export function AuthProvider({ children }) {
  const [authModal, setAuthModal] = useState({
    isOpen: false,
    screen: 'login',
  });
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Mirrors whether the signed-in user's email currently has a doc in each
  // staff allowlist collection. Kept live (via onSnapshot below) so a role
  // granted/revoked by a Super Admin reaches an already-open session
  // immediately — resolveStaffRole() below is only a ONE-SHOT lookup used
  // for the initial login/signup decision, it never re-fires on its own.
  const [staffDocs, setStaffDocs] = useState({ admin: false, moderator: false, superadmin: false });
  // Bumped on every onAuthStateChanged invocation so a slow-resolving
  // earlier call (e.g. the initial sign-in during an unverified login,
  // which login() then immediately signs back out) can detect it's been
  // superseded and skip overwriting the newer/correct state with stale data.
  const authCallIdRef = useRef(0);

  useEffect(() => {
    if (!auth) {
      console.warn('Firebase Auth not initialized. Auth features unavailable.');
      setAuthLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const callId = ++authCallIdRef.current;
      setCurrentUser(user);
      if (user && db) {
        try {
          const profile = await getUserProfile(user.uid);
          // Resolve staff role from Firestore (superadmins / admins / moderators)
          const staffRole = await resolveStaffRole(user.email);
          // A newer auth event (e.g. login()'s forced sign-out of an
          // unverified account, or signup()'s forced sign-out after
          // account creation) has already fired and set the correct state
          // — don't let this now-stale lookup overwrite it.
          if (callId !== authCallIdRef.current) return;
          const isAdminRole = staffRole === 'admin' || staffRole === 'superadmin';

          // Seed the live-listener state from this same lookup, so the
          // recompute effect below doesn't start from all-false and briefly
          // flash a demoted role before its own onSnapshot listeners land.
          setStaffDocs({
            admin: staffRole === 'admin',
            moderator: staffRole === 'moderator',
            superadmin: staffRole === 'superadmin',
          });

          if (profile) {
            setUserProfile({
              ...profile,
              role: staffRole !== 'student' ? staffRole : (profile.role || 'student'),
              isAdmin: isAdminRole,
            });
          } else if (staffRole !== 'student') {
            // No `users/{uid}` profile doc (e.g. it was deleted, or this
            // account never went through the sign-up flow that creates
            // one) — but their email IS listed in admins/moderators/
            // superadmins, so they're still staff. Don't demote them to
            // a guest just because the profile doc is missing.
            setUserProfile({
              role: staffRole,
              isAdmin: isAdminRole,
              email: user.email,
              name: user.displayName || '',
            });
          } else {
            // No profile doc and not on any staff allowlist either — most
            // likely signup() was interrupted between creating the Auth
            // account and writing the users/{uid} doc (e.g. a transient
            // Firestore error). Treat them as a plain student instead of
            // permanently stranding them as userRole 'guest' with no
            // self-heal path.
            const fallbackProfile = { role: 'student', isAdmin: false, email: user.email, name: user.displayName || '' };
            setUserProfile(fallbackProfile);
            // Actually write the missing doc back to Firestore (fire-and-
            // forget — doesn't block the UI) so this account starts
            // showing up in Firestore-backed listings like Super Admin's
            // "Users Registration Details" table, which reads the `users`
            // collection rather than the Firebase Auth user list. Without
            // this, an account that lost its profile doc at signup would
            // silently stay invisible there forever, even after logging
            // in again.
            createUserProfile(user.uid, fallbackProfile).catch((err) => {
              console.warn('Failed to self-heal missing user profile doc:', err);
            });
          }
        } catch (error) {
          if (callId !== authCallIdRef.current) return;
          console.warn('Failed to load user profile:', error);
          setUserProfile(null);
        }
      } else {
        setUserProfile(null);
      }
      if (callId === authCallIdRef.current) setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  /* Live role propagation: subscribe to the signed-in user's own docs in
     all three staff allowlist collections, so a role a Super Admin grants
     or revokes from the new Roles & Permissions panel reaches THIS
     already-open session immediately — no refresh/re-login required. */
  useEffect(() => {
    if (!db || !currentUser?.email) {
      setStaffDocs({ admin: false, moderator: false, superadmin: false });
      return;
    }
    const lower = currentUser.email.toLowerCase();
    const unsubs = ROLE_COLLECTIONS.map(({ role, collection: collectionName }) => {
      const key = role === 'superadmin' ? 'superadmin' : role === 'admin' ? 'admin' : 'moderator';
      return onSnapshot(doc(db, collectionName, lower), (snap) => {
        setStaffDocs((prev) => (prev[key] === snap.exists() ? prev : { ...prev, [key]: snap.exists() }));
      }, (error) => {
        console.warn(`Role listener failed for ${collectionName}:`, error);
      });
    });
    return () => unsubs.forEach((unsub) => unsub());
  }, [currentUser?.email]);

  /* Recomputes the effective role every time the live staffDocs flags
     change (same superadmin > admin > moderator > student priority as
     resolveStaffRole), and merges it onto the existing profile. Sidebar
     visibility, ProtectedRoute redirects and the per-page `isAdmin`/`role`
     guards all read userProfile/userRole, so this one state update is what
     makes every one of them react live. */
  useEffect(() => {
    const role = staffDocs.superadmin ? 'superadmin' : staffDocs.admin ? 'admin' : staffDocs.moderator ? 'moderator' : 'student';
    const isAdminRole = role === 'admin' || role === 'superadmin';
    setUserProfile((prev) => {
      if (prev) {
        if (prev.role === role && prev.isAdmin === isAdminRole) return prev;
        return { ...prev, role, isAdmin: isAdminRole };
      }
      // No profile loaded (yet, or ever) — only worth promoting to a
      // bare staff profile if there's actually a signed-in user and a
      // staff role to show, same fallback shape used above.
      if (role === 'student' || !currentUser) return prev;
      return { role, isAdmin: isAdminRole, email: currentUser.email, name: currentUser.displayName || '' };
    });
  }, [staffDocs, currentUser]);

  const openAuthModal = useCallback((screen = 'login') => {
    setAuthModal({ isOpen: true, screen });
  }, []);

  const closeAuthModal = useCallback(() => {
    setAuthModal({ isOpen: false, screen: 'login' });
  }, []);

  const switchScreen = useCallback((screen) => {
    setAuthModal({ isOpen: true, screen });
  }, []);

  /**
   * @param {string} email
   * @param {string} password
   * Signs the person in and automatically resolves their *real* role by
   * checking Firestore (superadmins / admins / moderators / else student).
   * The person never has to pick a role — the system already knows it.
   * Returns { user, role }.
   */
  const login = useCallback(async (email, password) => {
    if (!auth) throw new Error('Firebase Auth not configured. Please add Firebase credentials to .env');
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const user = credential.user;

    // Every account signs up with a gmail address, and every sign-up
    // gets a verification link sent to it. Don't let anyone in until
    // that link has been clicked.
    if (!user.emailVerified) {
      await signOut(auth);
      const error = new Error(
        `Please verify your email before logging in. We sent a verification link to ${email} — check your gmail inbox (and spam folder).`
      );
      error.code = 'auth/email-not-verified';
      throw error;
    }

    const resolvedRole = await resolveStaffRole(user.email);
    // Fire-and-forget, like every other logActivity call in the app
    // (logActivity already swallows its own errors) — the person shouldn't
    // wait an extra network round trip for an audit-log write before they
    // see the post-login redirect.
    logActivity({ actorRole: resolvedRole, type: 'Login', details: `${user.email} logged in` });
    return { user, role: resolvedRole };
  }, []);

  /**
   * @param {string} name
   * @param {string} email
   * @param {string} password
   * @param {object} [extra] Optional player/student details captured at sign-up:
   *   { gender, gradeLevel, section }
   */
  const signup = useCallback(async (name, email, password, extra = {}) => {
    if (!auth) throw new Error('Firebase Auth not configured. Please add Firebase credentials to .env');
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    const user = credential.user;

    // Send the gmail verification link right away. The account exists
    // in Firebase Auth already, but login() will refuse access until
    // the person clicks the link.
    try {
      await sendEmailVerification(user);
    } catch (error) {
      console.warn('Failed to send verification email:', error);
    }

    if (db) {
      const staffRole = await resolveStaffRole(email);
      const profileData = {
        name,
        email,
        gender: extra.gender || '',
        gradeLevel: extra.gradeLevel || '',
        section: extra.section || '',
        role: staffRole,
        isAdmin: staffRole === 'admin' || staffRole === 'superadmin',
      };
      try {
        await createUserProfile(user.uid, profileData);
      } catch (error) {
        // Don't let this abort signup() — the Auth account already exists
        // and the verification email was already sent, so the forced
        // sign-out below must still run rather than stranding the account
        // signed-in/unverified with no profile doc and no retry path. The
        // missing users/{uid} doc is covered by onAuthStateChanged's own
        // fallback profile once they verify and log in.
        console.warn('Failed to create user profile after signup:', error);
      }
    }

    // Sign back out immediately — createUserWithEmailAndPassword leaves
    // the new account signed in, but we don't want a freshly-created,
    // unverified account to have live access. They'll log back in
    // (via login(), which enforces the verified-email check) once
    // they've clicked the gmail link.
    setUserProfile(null);
    await signOut(auth);

    return user;
  }, []);

  /**
   * Signs in just long enough to re-send the gmail verification link,
   * then signs back out. Used by the "Resend verification email" link
   * shown after a login attempt fails because the account isn't
   * verified yet.
   */
  const resendVerificationEmail = useCallback(async (email, password) => {
    if (!auth) throw new Error('Firebase Auth not configured. Please add Firebase credentials to .env');
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const user = credential.user;
    if (user.emailVerified) {
      await signOut(auth);
      throw new Error('This email is already verified — please log in.');
    }
    await sendEmailVerification(user);
    await signOut(auth);
  }, []);

  const resetPassword = useCallback(async (email) => {
    if (!auth) throw new Error('Firebase Auth not configured. Please add Firebase credentials to .env');
    await sendPasswordResetEmail(auth, email);
  }, []);

  const updatePassword = useCallback(async (newPassword) => {
    if (!auth) throw new Error('Firebase Auth not configured. Please add Firebase credentials to .env');
    const user = auth.currentUser;
    if (!user) throw new Error('No authenticated user available. Please log in first.');
    await firebaseUpdatePassword(user, newPassword);
  }, []);

  const logout = useCallback(async () => {
    if (!auth) return;
    // Called (not awaited) BEFORE signOut: logActivity reads
    // auth.currentUser synchronously as soon as it's invoked, before its
    // own first `await` — calling it here still captures a still-valid
    // session even though we don't wait for the write to finish, same as
    // every other fire-and-forget logActivity call in the app (it already
    // swallows its own errors).
    logActivity({ actorRole: userProfile?.role || 'student', type: 'Logout' });
    await signOut(auth);
    setUserProfile(null);
  }, [userProfile]);

  // Memoized so consumers only re-render when a field they actually read
  // changes — without this, every AuthContext consumer app-wide (Sidebar,
  // every page/ProtectedRoute) re-rendered on every AuthProvider state
  // change, including ones unrelated to auth (e.g. the login modal opening).
  const contextValue = useMemo(() => ({
    authModal,
    openAuthModal,
    closeAuthModal,
    switchScreen,
    currentUser,
    userProfile,
    userRole: userProfile?.role ?? 'guest',
    isAdmin: userProfile?.isAdmin ?? false,
    authLoading,
    login,
    signup,
    resendVerificationEmail,
    resetPassword,
    updatePassword,
    logout,
  }), [
    authModal, openAuthModal, closeAuthModal, switchScreen,
    currentUser, userProfile, authLoading,
    login, signup, resendVerificationEmail, resetPassword, updatePassword, logout,
  ]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}