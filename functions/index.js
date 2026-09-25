const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");
const matchMath = require("./matchMath");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore(); //  ISA LANG — sa labas ng function!

const STAFF_ROLE_COLLECTIONS = { admin: "admins", moderator: "moderators", superadmin: "superadmins" };
const STAFF_ROLE_LABELS = { admin: "Admin", moderator: "Moderator", superadmin: "Super Admin" };
const SCHOOL_LEVELS = ["elementary", "highSchool", "college"];
const DEFAULT_STAFF_LEVEL = "elementary";

/** Admins/moderators are scoped to one school level; superadmins span all (null). */
function levelForRole(role, docData) {
  if (role !== "admin" && role !== "moderator") return null;
  return SCHOOL_LEVELS.includes(docData?.level) ? docData.level : DEFAULT_STAFF_LEVEL;
}

/** Validates the `level` a Super Admin picked when granting admin/moderator. */
function levelFieldsForRole(role, level) {
  if (role === "admin" || role === "moderator") {
    if (!SCHOOL_LEVELS.includes(level)) {
      throw new HttpsError("invalid-argument", "level must be one of: elementary, highSchool, college");
    }
    return { level };
  }
  return { level: FieldValue.delete() };
}

function randomPassword() {
  return crypto.randomBytes(16).toString("base64url");
}

function randomId() {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Normalizes an email for duplicate-account detection: lowercases/trims,
 * and — for Gmail/Googlemail addresses only — strips dots from the local
 * part and truncates at the first "+", since Gmail treats
 * "student.name@gmail.com", "studentname@gmail.com" and
 * "studentname+1@gmail.com" as the exact same inbox even though Firebase
 * Auth treats them as three completely different accounts (each can sign
 * up separately, verify separately, and end up as a separate `users/{uid}`
 * doc — which is how one real student ends up with two rows in Super
 * Admin's Users Registration Details table). Every other provider's
 * address is only lowercased/trimmed — dots ARE significant outside Gmail.
 */
function normalizeEmailForDuplicateCheck(email) {
  const trimmed = (email || "").trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return trimmed;
  const withoutPlus = local.split("+")[0];
  const withoutDots = withoutPlus.replace(/\./g, "");
  return `${withoutDots}@gmail.com`;
}

/**
 * Sets (or clears, when role is null) the `role` custom claim on a Firebase
 * Auth user. This is the only place a role ever reaches the ID token —
 * setCustomUserClaims only exists on the Admin SDK, so there is no
 * client-reachable path that can grant or change one. Firestore
 * (admins/moderators/superadmins) stays the authoritative record; the claim
 * is just a cache of it that lets resolveCallerRole() below skip straight to
 * confirming ONE collection instead of reading all three every call.
 */
async function setStaffClaims(uid, role) {
  try {
    await getAuth().setCustomUserClaims(uid, role ? { role } : {});
  } catch (error) {
    // A stale users/{uid} profile can outlive its Auth account. The role
    // itself lives in the allowlist doc (already written), the claim is only
    // a cache, so don't fail the whole call over it.
    if (error.code !== "auth/user-not-found") throw error;
    logger.warn(`No Auth user for uid ${uid}; skipped setting role claim.`);
  }
}

/**
 * Resolves the caller's staff role the same way AuthContext.jsx does on the
 * client: superadmin > admin > moderator, first match wins, by looking up
 * their (lowercased) email across the three allowlist collections. Throws
 * unauthenticated/permission-denied the same way every callable function
 * below expects, so a request with no valid session or no staff role never
 * reaches any of the actual match-recording logic.
 *
 * If the caller's ID token already carries a `role` claim, that's only a
 * HINT for which collection to check — a claim is cached in the token for
 * up to ~1hr after a Super Admin revokes it, so it's never trusted by
 * itself. One fresh read against that single collection confirms it's still
 * current (the "fast path": 1 read instead of 3). Anyone without a
 * matching/valid claim falls back to checking all three collections, same
 * as before — this is never less correct than the original check, only
 * faster once a claim has been set via assignStaffRole/createStaffAccount.
 */
async function resolveCallerRole(request) {
  const email = (request.auth?.token?.email || "").trim().toLowerCase();
  if (!request.auth || !email) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const claimedRole = request.auth.token.role;
  const claimedCollection = STAFF_ROLE_COLLECTIONS[claimedRole];
  if (claimedCollection) {
    const snap = await db.collection(claimedCollection).doc(email).get();
    if (snap.exists) {
      return { email, role: claimedRole, level: levelForRole(claimedRole, snap.data()), uid: request.auth.uid, name: request.auth.token.name || "" };
    }
  }

  const [superadminDoc, adminDoc, moderatorDoc] = await Promise.all([
    db.collection("superadmins").doc(email).get(),
    db.collection("admins").doc(email).get(),
    db.collection("moderators").doc(email).get(),
  ]);
  const role = superadminDoc.exists ? "superadmin" : adminDoc.exists ? "admin" : moderatorDoc.exists ? "moderator" : null;
  if (!role) {
    throw new HttpsError("permission-denied", "Only staff accounts can do this.");
  }
  const roleDoc = role === "admin" ? adminDoc : role === "moderator" ? moderatorDoc : null;
  return { email, role, level: levelForRole(role, roleDoc?.data()), uid: request.auth.uid, name: request.auth.token.name || "" };
}

async function requireStaff(request) {
  return resolveCallerRole(request);
}

/** Same as requireStaff, but also rejects a caller whose resolved role isn't superadmin. */
async function requireSuperAdmin(request) {
  const actor = await resolveCallerRole(request);
  if (actor.role !== "superadmin") {
    throw new HttpsError("permission-denied", "Only a Super Admin can do this.");
  }
  return actor;
}

/**
 * Staff gate for anything that writes one school level's data: a Super Admin
 * may touch any level, an admin/moderator only the level on their own doc.
 */
async function requireStaffForLevel(request, level) {
  requireLevel(level);
  const actor = await resolveCallerRole(request);
  if (actor.role !== "superadmin" && actor.level !== level) {
    throw new HttpsError("permission-denied", "You can only manage your own school level.");
  }
  return actor;
}

function requireLevel(level) {
  if (!["elementary", "highSchool", "college"].includes(level)) {
    throw new HttpsError("invalid-argument", "level must be one of: elementary, highSchool, college");
  }
}

async function logActivity({ actorUid, actorEmail, actorName, actorRole, type, details, targetType, targetId, targetLabel }) {
  await db.collection("activityLogs").add({
    actorUid, actorEmail, actorName, actorRole, type, details, targetType, targetId, targetLabel,
    timestamp: FieldValue.serverTimestamp(),
  });
}

/**
 * Reserves a normalized email ahead of Firebase Auth account creation, so
 * two signups whose emails are cosmetically different but the SAME real
 * Gmail inbox (dots/plus tricks — see normalizeEmailForDuplicateCheck)
 * can't both get an account. Called by AuthContext.signup() BEFORE
 * createUserWithEmailAndPassword; if that Auth call then fails for any
 * reason, releaseEmail below frees the reservation back up so a bad
 * password or dropped connection doesn't permanently lock the address out.
 *
 * Public (no `request.auth`) since this runs before the person has any
 * session — App Check still gates it. Firebase Auth's own
 * "email-already-in-use" already blocks a second signup with the EXACT
 * SAME email string; this only adds protection for the Gmail-variant case
 * Firebase itself doesn't catch.
 */
exports.reserveEmail = onCall({ enforceAppCheck: true }, async (request) => {
  const email = (request.data?.email || "").trim();
  if (!email || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }
  const key = normalizeEmailForDuplicateCheck(email);
  const ref = db.collection("emailIndex").doc(key);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      throw new HttpsError(
        "already-exists",
        "An account already exists using this email address (or a variation of it, like a different placement of dots). Please sign in instead, or use a different email."
      );
    }
    tx.set(ref, { email: email.toLowerCase(), reservedAt: FieldValue.serverTimestamp() });
  });

  return { reserved: true };
});

/**
 * Frees a reservation reserveEmail made, when the Firebase Auth account
 * creation that was supposed to follow it never actually succeeded (bad
 * password, network error, etc.) — otherwise that normalized email would
 * stay permanently blocked with no real account behind it. Safe to call
 * even if nothing was reserved — just a no-op then.
 */
exports.releaseEmail = onCall({ enforceAppCheck: true }, async (request) => {
  const email = (request.data?.email || "").trim();
  if (!email) return { released: false };
  await db.collection("emailIndex").doc(normalizeEmailForDuplicateCheck(email)).delete();
  return { released: true };
});

exports.createStaffAccount = onCall({ enforceAppCheck: true }, async (request) => {
  const actor = await requireSuperAdmin(request);

  //  Kunin ang ipinadala mula sa website
  const email = (request.data?.email || "").trim().toLowerCase();
  const role = request.data?.role;
  const name = (request.data?.name || "").trim();

  if (!email || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }
  const collectionName = STAFF_ROLE_COLLECTIONS[role];
  if (!collectionName) {
    throw new HttpsError("invalid-argument", "role must be one of: admin, moderator, superadmin");
  }
  const levelFields = levelFieldsForRole(role, request.data?.level);

  const auth = getAuth();
  let userRecord;
  let created = false;
  let tempPassword = null;

  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    tempPassword = randomPassword();
    userRecord = await auth.createUser({
      email,
      password: tempPassword,
      emailVerified: true,
      displayName: name || undefined,
    });
    created = true;
  }

  //  Alisin ang ibang role, ilagay ang bago
  await Promise.all(
    Object.values(STAFF_ROLE_COLLECTIONS)
      .filter((collection) => collection !== collectionName)
      .map((collection) => db.collection(collection).doc(email).delete())
  );
  await db.collection(collectionName).doc(email).set(
    { email, ...levelFields, addedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  // Gumawa ng user profile
  await db.collection("users").doc(userRecord.uid).set(
    {
      name,
      email,
      role,
      isAdmin: role === "admin" || role === "superadmin",
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Set the `role` custom claim so this account's ID token itself carries
  // it from their next sign-in/token refresh onward (Admin SDK only — see
  // setStaffClaims above).
  await setStaffClaims(userRecord.uid, role);

  //  Mag-log ng aktibidad
  await db.collection("activityLogs").add({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: "superadmin",
    type: created ? "Staff Account Created" : "Staff Role Assigned",
    details: `${created ? "Created" : "Updated"} ${STAFF_ROLE_LABELS[role]}${levelFields.level && typeof levelFields.level === "string" ? ` (${levelFields.level})` : ""} account for ${name || email}`,
    targetType: "user",
    targetId: userRecord.uid,
    targetLabel: email,
    timestamp: FieldValue.serverTimestamp(),
  });

  logger.info(`Staff account ${created ? "created" : "updated"} for ${email} as ${role} by ${actor.email}`);

  return { uid: userRecord.uid, email, role, level: typeof levelFields.level === "string" ? levelFields.level : null, created, tempPassword };
});

/**
 * Changes an EXISTING user's staff role (the Roles & Permissions panel's
 * role buttons). Unlike createStaffAccount, this never creates a new
 * Firebase Auth user — only a Super Admin may call it, and never on their
 * own account (self-lockout guard). Moved server-side (this used to be a
 * direct client Firestore write, gated only by firestore.rules'
 * isSuperAdmin()) specifically so it can also set the `role` custom claim —
 * setCustomUserClaims only exists on the Admin SDK, so there was never a
 * way to do that from the browser.
 */
exports.assignStaffRole = onCall({ enforceAppCheck: true }, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const role = data.role;
  const email = (data.targetEmail || "").trim().toLowerCase();
  const targetName = (data.targetName || "").trim();

  const collectionName = STAFF_ROLE_COLLECTIONS[role];
  if (!collectionName) {
    throw new HttpsError("invalid-argument", "role must be one of: admin, moderator, superadmin");
  }
  if (!email) {
    throw new HttpsError("invalid-argument", "Target user's email is required.");
  }
  if (email === actor.email) {
    throw new HttpsError("failed-precondition", "You can't change your own role here.");
  }
  const levelFields = levelFieldsForRole(role, data.level);

  await Promise.all(
    Object.values(STAFF_ROLE_COLLECTIONS)
      .filter((collection) => collection !== collectionName)
      .map((collection) => db.collection(collection).doc(email).delete())
  );
  await db.collection(collectionName).doc(email).set(
    { email, ...levelFields, addedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  // Resolve the Auth uid from email when the client didn't already have one
  // on hand — needed to sync the profile doc and set the custom claim.
  let uid = data.targetUid || null;
  if (!uid) {
    try {
      uid = (await getAuth().getUserByEmail(email)).uid;
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  if (uid) {
    await db.collection("users").doc(uid).set(
      { role, isAdmin: role === "admin" || role === "superadmin" },
      { merge: true }
    ).catch((error) => logger.warn("Could not sync role onto user profile:", error));
    await setStaffClaims(uid, role);
  }

  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Role Assigned",
    details: `Assigned ${STAFF_ROLE_LABELS[role]} role to ${targetName || email}`,
    targetType: "user",
    targetId: uid || email,
    targetLabel: email,
  });

  return { role, email, level: typeof levelFields.level === "string" ? levelFields.level : null };
});

/**
 * Revokes an existing staff role — removes the allowlist doc from all three
 * collections, demotes the `users/{uid}` profile back to student, and
 * clears the custom claim. Same Super-Admin-only / never-self gate as
 * assignStaffRole above.
 */
exports.removeStaffRole = onCall({ enforceAppCheck: true }, async (request) => {
  const actor = await requireSuperAdmin(request);
  const data = request.data || {};
  const email = (data.targetEmail || "").trim().toLowerCase();
  const targetName = (data.targetName || "").trim();

  if (!email) {
    throw new HttpsError("invalid-argument", "Target user's email is required.");
  }
  if (email === actor.email) {
    throw new HttpsError("failed-precondition", "You can't change your own role here.");
  }

  await Promise.all(
    Object.values(STAFF_ROLE_COLLECTIONS).map((collection) => db.collection(collection).doc(email).delete())
  );

  let uid = data.targetUid || null;
  if (!uid) {
    try {
      uid = (await getAuth().getUserByEmail(email)).uid;
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }
  if (uid) {
    await db.collection("users").doc(uid).set(
      { role: "student", isAdmin: false },
      { merge: true }
    ).catch((error) => logger.warn("Could not sync role onto user profile:", error));
    await setStaffClaims(uid, null);
  }

  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Role Removed",
    details: `Removed staff role from ${targetName || email}`,
    targetType: "user",
    targetId: uid || email,
    targetLabel: email,
  });

  return { email };
});

/**
 * Permanently deletes a STUDENT account — the Firebase Auth user, their
 * `users/{uid}` profile doc, and any `registrations` doc(s) tied to that
 * uid. Built for Super Admin's "Users Registration Details" table (Login
 * Status column's "Manage" button) to clean up duplicate accounts — e.g. a
 * student who signed up twice under two different emails with the same
 * name. Super Admin can't approve/reject a registration (Admin-only), but
 * removing a genuinely duplicate ACCOUNT is a Super-Admin-level action,
 * same tier as the role-management functions above.
 *
 * Refuses to touch a staff account (this is student-account cleanup only —
 * use removeStaffRole for staff) or the caller's own account. No undo —
 * the client confirms with the person first.
 */
exports.deleteStudentAccount = onCall({ enforceAppCheck: true }, async (request) => {
  const actor = await requireSuperAdmin(request);
  const uid = (request.data?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("invalid-argument", "uid is required.");
  }
  if (uid === actor.uid) {
    throw new HttpsError("failed-precondition", "You can't delete your own account here.");
  }

  const profileRef = db.collection("users").doc(uid);
  const profileSnap = await profileRef.get();
  const profile = profileSnap.exists ? profileSnap.data() : null;
  if (profile && (profile.role || "student") !== "student") {
    throw new HttpsError(
      "failed-precondition",
      "This tool only removes student accounts — use Roles & Permissions to remove a staff account."
    );
  }

  const regsSnap = await db.collection("registrations").where("uid", "==", uid).get();
  const batch = db.batch();
  regsSnap.docs.forEach((doc) => batch.delete(doc.ref));
  if (profileSnap.exists) batch.delete(profileRef);
  await batch.commit();

  try {
    await getAuth().deleteUser(uid);
  } catch (error) {
    // Already gone from Auth (e.g. a retry after a partial earlier
    // failure) — the Firestore cleanup above still needs to happen, so
    // this isn't treated as a failure of the overall delete.
    if (error.code !== "auth/user-not-found") throw error;
  }

  const label = profile?.name || profile?.email || uid;
  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Student Account Deleted",
    details: `Deleted student account ${label} (${regsSnap.size} registration${regsSnap.size === 1 ? "" : "s"} removed with it)`,
    targetType: "user",
    targetId: uid,
    targetLabel: label,
  });

  return { uid, registrationsDeleted: regsSnap.size };
});

/**
 * Returns each requested account's REAL Firebase Auth sign-in history
 * (`metadata.lastSignInTime`), keyed by uid — backs Super Admin's "Users
 * Registration Details" table (Login Status column: Signed In / Not
 * Signed In Yet).
 *
 * This reads Firebase Auth directly rather than a Firestore mirror, so it's
 * correct for every account from the moment they first ever signed in, not
 * just logins that happen after some tracking code was added — there's no
 * way to backfill a Firestore-only counter for past logins Firebase Auth
 * already recorded, so this is the only source that's accurate right away.
 * Only the Admin SDK (used here) can read another user's Auth metadata —
 * there's no client-reachable way to do it, hence the callable. Staff-only,
 * not Super-Admin-only: any staff role may audit sign-in activity.
 */
exports.getUsersLastSignIn = onCall({ enforceAppCheck: true }, async (request) => {
  await requireStaff(request);
  const uids = Array.isArray(request.data?.uids)
    ? [...new Set(request.data.uids.filter((uid) => typeof uid === "string" && uid))]
    : [];
  if (uids.length === 0) return { lastSignIn: {}, deletedUids: [] };

  const auth = getAuth();
  const lastSignIn = {};
  const deletedUids = [];
  // getUsers() accepts at most 100 identifiers per call.
  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100).map((uid) => ({ uid }));
    const { users, notFound } = await auth.getUsers(batch);
    users.forEach((u) => { lastSignIn[u.uid] = u.metadata.lastSignInTime || null; });
    // A uid with a `users/{uid}` Firestore doc but no matching Firebase
    // Auth account is an orphan — most likely someone was deleted directly
    // from Authentication in the Firebase Console (which never touches
    // Firestore), rather than through this app's own Delete Account
    // action. Surfaced separately from "never signed in" so the table can
    // show "Account Deleted" instead of a misleading "Not Signed In Yet".
    notFound.forEach((identifier) => { deletedUids.push(identifier.uid); });
  }
  return { lastSignIn, deletedUids };
});

/**
 * Auto-cleanup for accounts deleted directly from Authentication in the
 * Firebase Console (or any other way that isn't this app's own
 * deleteStudentAccount) — that kind of deletion only removes the Auth
 * account and never touches Firestore, which is what let a deleted
 * account's `users/{uid}` doc keep showing up as a ghost row in Super
 * Admin's Users Registration Details table.
 *
 * This runs on a schedule rather than reacting to the deletion instantly:
 * Cloud Functions v2 has no auth-user-deleted EVENT trigger (only the
 * unrelated beforeCreate/beforeSignIn BLOCKING triggers) — that trigger
 * only exists on Cloud Functions Gen 1, which doesn't support this
 * project's Node 24 runtime. Between runs, the gap is already visible and
 * fixable by hand: getUsersLastSignIn (above) flags the same orphaned
 * uids immediately as "Account Deleted" in the table, with a "Clear
 * Leftover Data" button that does the same cleanup on demand.
 */
exports.cleanupOrphanedUserDocs = onSchedule("every 1 hours", async () => {
  const usersSnap = await db.collection("users").get();
  const uids = usersSnap.docs.map((d) => d.id);
  if (uids.length === 0) return;

  const auth = getAuth();
  const orphanUids = [];
  for (let i = 0; i < uids.length; i += 100) {
    const batch = uids.slice(i, i + 100).map((uid) => ({ uid }));
    const { notFound } = await auth.getUsers(batch);
    notFound.forEach((identifier) => orphanUids.push(identifier.uid));
  }
  if (orphanUids.length === 0) return;

  let registrationsRemoved = 0;
  // Firestore batched writes cap at 500 operations — chunk conservatively
  // in case one orphan has several registration docs.
  let batch = db.batch();
  let opsInBatch = 0;
  const flushIfNeeded = async () => {
    if (opsInBatch < 400) return;
    await batch.commit();
    batch = db.batch();
    opsInBatch = 0;
  };

  for (const uid of orphanUids) {
    batch.delete(db.collection("users").doc(uid));
    opsInBatch++;
    const regsSnap = await db.collection("registrations").where("uid", "==", uid).get();
    for (const doc of regsSnap.docs) {
      batch.delete(doc.ref);
      opsInBatch++;
      registrationsRemoved++;
      await flushIfNeeded();
    }
    await flushIfNeeded();
  }
  if (opsInBatch > 0) await batch.commit();

  logger.info("cleanupOrphanedUserDocs: removed Firestore data for deleted Auth users", {
    profilesRemoved: orphanUids.length,
    registrationsRemoved,
  });
});

/**
 * Confirms a match result (ModeratorPage's "Confirm update" — new record or
 * re-confirming an already-locked one). The client still runs its own copy
 * of buildComputation for the live confirmation-screen preview, but this is
 * the ONLY place a match record and its rating change is actually
 * persisted: prevPoints is looked up fresh from teamRankings/{level} (or
 * from the existing record being re-confirmed) inside a transaction, then
 * the same formula runs here from scratch. A client can send whatever score/
 * violations/comeback values it wants (those are just "what the moderator
 * observed," same trust level as before), but it can never make up a
 * prevPoints or finalPoints directly — those are only ever what this
 * function computes. Pairs with the Firestore rules change that denies
 * direct client writes to matchRecords/{level} and teamRankings/{level}.
 */
exports.submitMatchRecord = onCall({ enforceAppCheck: true }, async (request) => {
  const data = request.data || {};
  const actor = await requireStaffForLevel(request, data.level);
  const {
    level, recordId, scheduleId, mode, multi, formatId,
    sportId, sportName, category, format, yearLevel,
    winnerOverrideId, rows, createdAt,
  } = data;

  requireLevel(level);
  if (mode !== "points" && mode !== "time") {
    throw new HttpsError("invalid-argument", "mode must be 'points' or 'time'.");
  }
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new HttpsError("invalid-argument", "At least two teams are required.");
  }
  if (winnerOverrideId === "DRAW") {
    if (multi || rows.length !== 2 || rows[0].score !== rows[1].score) {
      throw new HttpsError("invalid-argument", "A draw needs exactly two teams with equal scores.");
    }
  }
  rows.forEach((r) => {
    if (!r || typeof r.id !== "string" || !r.name || typeof r.score !== "number" || Number.isNaN(r.score)) {
      throw new HttpsError("invalid-argument", "Each row needs an id, name, and numeric score.");
    }
  });
  if (!sportName || !category) {
    throw new HttpsError("invalid-argument", "sportName and category are required.");
  }

  const recordsRef = db.collection("matchRecords").doc(level);
  const rankingsRef = db.collection("teamRankings").doc(level);
  const schedulesRef = db.collection("matchSchedules").doc(level);

  const { record, records, rankings } = await db.runTransaction(async (tx) => {
    const [recordsSnap, rankingsSnap, schedulesSnap] = await Promise.all([tx.get(recordsRef), tx.get(rankingsRef), tx.get(schedulesRef)]);
    const orderOf = matchMath.scheduleOrder(schedulesSnap.exists ? (schedulesSnap.data().matches || []) : []);
    const existingRecords = recordsSnap.exists ? (recordsSnap.data().records || []) : [];
    const rankingsAll = rankingsSnap.exists ? (rankingsSnap.data().points || {}) : {};

    const existingRecord = recordId ? existingRecords.find((r) => r.id === recordId) : null;
    const scopeKey = matchMath.rankingScopeKey(sportName, category);
    const scoped = rankingsAll[scopeKey] || {};

    const rowsWithPrev = rows.map((r) => {
      let prevPoints = null;
      // Reopening an already-saved record: its own stored prevPoints is the
      // right baseline, since live rankings already include this match.
      if (existingRecord) {
        const all = existingRecord.participants && existingRecord.participants.length
          ? existingRecord.participants
          : [existingRecord.teamA, existingRecord.teamB];
        const hit = all.find((p) => p && matchMath.norm(p.name) === matchMath.norm(r.name));
        if (hit && hit.prevPoints != null) prevPoints = hit.prevPoints;
      }
      if (prevPoints == null) {
        const inScope = matchMath.pointsInScope(scoped, r.name);
        if (inScope != null) prevPoints = inScope;
      }
      // Ratings are per sport + division: no rating in this scope means the
      // baseline, whatever the team earned in other sports.
      if (prevPoints == null) prevPoints = matchMath.DEFAULT_POINTS;
      return {
        id: r.id,
        teamId: r.teamId || null,
        name: r.name,
        logo: r.logo || null,
        score: r.score,
        totalViolations: Number(r.totalViolations) || 0,
        violations: Array.isArray(r.violations) ? r.violations : [],
        comeback: !!r.comeback,
        prevPoints,
      };
    });

    const comp = matchMath.buildComputation({ rows: rowsWithPrev, mode, winnerOverrideId: winnerOverrideId || null });

    const asStored = (t) => ({
      id: t.teamId || t.id,
      name: t.name,
      logo: t.logo || null,
      minutes: mode === "time" ? t.score : null,
      points: mode === "points" ? t.score : null,
      totalViolations: t.totalViolations,
      violations: (t.violations || []).map((v) => ({
        id: v.id || randomId(),
        type: v.type || "",
        count: v.count === "" || v.count == null ? 0 : Number(v.count) || 0,
      })),
      comeback: !!t.comeback,
      prevPoints: matchMath.round4(t.prevPoints),
      expected: matchMath.round4(t.expected),
      f1: matchMath.round4(t.totalF1),
      change: matchMath.round4(t.change),
      finalPoints: matchMath.round4(t.finalPoints),
      place: t.place,
    });

    // Same order as the submitted `rows` (== the moderator's entries), NOT
    // sorted by place — matches handleConfirm in ModeratorPage.jsx exactly.
    const cTeams = comp.teams;
    const ordered = [...cTeams].sort((a, b) => a.place - b.place);
    const teamA = asStored(cTeams[0]);
    const teamB = asStored(cTeams[1]);
    const isDraw = comp.winnerId === "DRAW";
    const winnerSide = isDraw ? "DRAW" : (cTeams[0].id === comp.winnerId ? "A" : "B");
    const diff = Math.abs((cTeams[0].score ?? 0) - (cTeams[1].score ?? 0));

    const yearLevelLabel = yearLevel ? (matchMath.LEVEL_LABELS[yearLevel] || yearLevel) : "";
    const label = `${sportName} ${category}${yearLevelLabel ? ` · ${yearLevelLabel}` : ""}`.trim();

    const newRecord = {
      id: existingRecord?.id || recordId || randomId(),
      level,
      scheduleId: scheduleId || existingRecord?.scheduleId || null,
      mode,
      multi: !!multi,
      formatId: formatId || null,
      sportId: sportId || null,
      sportName,
      category,
      format: format || null,
      yearLevel: yearLevel || null,
      label,
      diff: matchMath.round4(diff),
      winner: winnerSide,
      draw: isDraw,
      teamA,
      teamB,
      participants: multi ? ordered.map(asStored) : [],
      createdAt: existingRecord?.createdAt || createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    const idx = existingRecords.findIndex((r) => r.id === newRecord.id);
    const withNew = idx >= 0
      ? existingRecords.map((r) => (r.id === newRecord.id ? newRecord : r))
      : [...existingRecords, newRecord];

    // Replay the whole scope so every later game of these teams picks up the
    // rating this save produced (and this game picks up earlier ones).
    const replay = matchMath.replayScope(withNew, scopeKey, orderOf);
    const nextRecords = replay.records;
    const savedRecord = nextRecords.find((r) => r.id === newRecord.id) || newRecord;

    const nextScope = { ...scoped, ...replay.latest };
    cTeams.forEach((t) => { if (!(t.name in replay.latest)) nextScope[t.name] = matchMath.round4(t.finalPoints); });
    const nextRankings = { ...rankingsAll, [scopeKey]: nextScope };

    tx.set(recordsRef, { records: nextRecords, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(rankingsRef, { points: nextRankings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return { record: savedRecord, records: nextRecords, rankings: nextRankings };
  });

  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Match Record Saved",
    details: `Saved the ${record.sportName || "match"} result for ${record.teamA?.name || "?"} vs ${record.teamB?.name || "?"}${record.draw ? " (draw)" : ""}`,
    targetType: "matchRecord",
    targetId: record.id,
    targetLabel: record.sportName,
  });

  return { record, records, rankings };
});

/**
 * The Updated Match Summary table's inline quick-edit (1v1 records only) —
 * mirrors computeEditFinalPoints in ModeratorPage.jsx. Like
 * submitMatchRecord, prevPoints always comes from the record already
 * stored in Firestore (never from the client), and finalPoints is always
 * recomputed here, never accepted as-is.
 */
exports.editMatchRecord = onCall({ enforceAppCheck: true }, async (request) => {
  const data = request.data || {};
  const actor = await requireStaffForLevel(request, data.level);
  const {
    level, recordId, teamA: teamAIn, teamB: teamBIn,
    totalViolationsA, totalViolationsB, pointsA, pointsB, minutesA, minutesB,
    comebackA: comebackAIn, comebackB: comebackBIn,
  } = data;

  requireLevel(level);
  if (!recordId) throw new HttpsError("invalid-argument", "recordId is required.");

  const recordsRef = db.collection("matchRecords").doc(level);
  const rankingsRef = db.collection("teamRankings").doc(level);
  const schedulesRef = db.collection("matchSchedules").doc(level);

  const { updated, records, rankings } = await db.runTransaction(async (tx) => {
    const [recordsSnap, rankingsSnap, schedulesSnap] = await Promise.all([tx.get(recordsRef), tx.get(rankingsRef), tx.get(schedulesRef)]);
    const orderOf = matchMath.scheduleOrder(schedulesSnap.exists ? (schedulesSnap.data().matches || []) : []);
    const existingRecords = recordsSnap.exists ? (recordsSnap.data().records || []) : [];
    const rankingsAll = rankingsSnap.exists ? (rankingsSnap.data().points || {}) : {};

    const record = existingRecords.find((r) => r.id === recordId);
    if (!record) throw new HttpsError("not-found", "That match record no longer exists.");

    const isPoints = record.mode === "points" || record.teamA.points != null;
    const ratingA = record.teamA.prevPoints ?? matchMath.DEFAULT_POINTS;
    const ratingB = record.teamB.prevPoints ?? matchMath.DEFAULT_POINTS;
    const violA = parseInt(totalViolationsA, 10) || 0;
    const violB = parseInt(totalViolationsB, 10) || 0;

    const pA = isPoints ? (pointsA === "" || pointsA == null ? record.teamA.points : Number(pointsA)) : null;
    const pB = isPoints ? (pointsB === "" || pointsB == null ? record.teamB.points : Number(pointsB)) : null;
    const mA = !isPoints ? (minutesA === "" || minutesA == null ? record.teamA.minutes : Number(minutesA)) : null;
    const mB = !isPoints ? (minutesB === "" || minutesB == null ? record.teamB.minutes : Number(minutesB)) : null;

    // Omitted → keep what was saved, so older clients don't wipe the flag.
    const comebackA = comebackAIn == null ? !!record.teamA.comeback : !!comebackAIn;
    const comebackB = comebackBIn == null ? !!record.teamB.comeback : !!comebackBIn;

    const { finalPointsA, finalPointsB, winner } = matchMath.computeEditFinalPoints({
      ratingA, ratingB, violA, violB,
      comebackA, comebackB,
      isPoints, pA, pB, mA, mB,
      fallbackWinner: record.winner,
    });

    const teamAObj = teamAIn || record.teamA;
    const teamBObj = teamBIn || record.teamB;

    const nextRecord = {
      ...record,
      winner,
      draw: winner === "DRAW",
      teamA: {
        ...record.teamA,
        id: teamAObj.id || record.teamA.id,
        name: teamAObj.name || record.teamA.name,
        logo: teamAObj.logo || null,
        totalViolations: violA,
        comeback: comebackA,
        minutes: isPoints ? record.teamA.minutes : mA,
        points: isPoints ? pA : record.teamA.points,
        finalPoints: finalPointsA,
      },
      teamB: {
        ...record.teamB,
        id: teamBObj.id || record.teamB.id,
        name: teamBObj.name || record.teamB.name,
        logo: teamBObj.logo || null,
        totalViolations: violB,
        comeback: comebackB,
        minutes: isPoints ? record.teamB.minutes : mB,
        points: isPoints ? pB : record.teamB.points,
        finalPoints: finalPointsB,
      },
      updatedAt: Date.now(),
    };

    const withEdit = existingRecords.map((r) => (r.id === recordId ? nextRecord : r));

    // Replay the scope so later games of these teams follow the edited result.
    const scopeKey = matchMath.rankingScopeKey(nextRecord.sportName, nextRecord.category);
    const replay = matchMath.replayScope(withEdit, scopeKey, orderOf);
    const nextRecords = replay.records;
    const savedRecord = nextRecords.find((r) => r.id === recordId) || nextRecord;

    const nextScope = { ...(rankingsAll[scopeKey] || {}), ...replay.latest };
    if (!(nextRecord.teamA.name in replay.latest)) nextScope[nextRecord.teamA.name] = finalPointsA;
    if (!(nextRecord.teamB.name in replay.latest)) nextScope[nextRecord.teamB.name] = finalPointsB;
    const nextRankings = { ...rankingsAll, [scopeKey]: nextScope };

    tx.set(recordsRef, { records: nextRecords, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(rankingsRef, { points: nextRankings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return { updated: savedRecord, records: nextRecords, rankings: nextRankings };
  });

  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Match Record Edited",
    details: `Edited the ${updated.sportName || "match"} result for ${updated.teamA?.name || "?"} vs ${updated.teamB?.name || "?"}`,
    targetType: "matchRecord",
    targetId: updated.id,
    targetLabel: updated.sportName,
  });

  return { record: updated, records, rankings };
});

/**
 * Rebuilds every rating of one level from its match records: each sport +
 * division is replayed in game order from the 1200 baseline, the records get
 * their prevPoints/finalPoints rewritten, and teamRankings is replaced with
 * exactly what the records produce — so leftover ratings (from deleted
 * records or an older baseline) disappear. Used by the Moderator page's
 * "Recalculate ratings" button.
 */
exports.recalculateRatings = onCall({ enforceAppCheck: true }, async (request) => {
  const { level } = request.data || {};
  const actor = await requireStaffForLevel(request, level);

  const recordsRef = db.collection("matchRecords").doc(level);
  const rankingsRef = db.collection("teamRankings").doc(level);
  const schedulesRef = db.collection("matchSchedules").doc(level);

  const { records, rankings } = await db.runTransaction(async (tx) => {
    const [recordsSnap, schedulesSnap] = await Promise.all([tx.get(recordsRef), tx.get(schedulesRef)]);
    const orderOf = matchMath.scheduleOrder(schedulesSnap.exists ? (schedulesSnap.data().matches || []) : []);
    let next = recordsSnap.exists ? (recordsSnap.data().records || []) : [];

    const rankingsOut = {};
    const scopeKeys = new Set(next.map((r) => matchMath.rankingScopeKey(r.sportName, r.category)));
    scopeKeys.forEach((scopeKey) => {
      const replay = matchMath.replayScope(next, scopeKey, orderOf);
      next = replay.records;
      rankingsOut[scopeKey] = replay.latest;
    });

    tx.set(recordsRef, { records: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    // No merge: the whole `points` map is replaced so orphaned scopes vanish.
    tx.set(rankingsRef, { points: rankingsOut, updatedAt: FieldValue.serverTimestamp() });
    return { records: next, rankings: rankingsOut };
  });

  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Ratings Recalculated",
    details: `Recalculated all ratings for ${level} from ${records.length} match record${records.length === 1 ? "" : "s"}`,
    targetType: "teamRankings",
    targetId: level,
    targetLabel: level,
  });

  return { records, rankings };
});

/**
 * Cascade-delete used by AdminSchedulePage when a fixture or a whole
 * generated schedule set is removed, so a deleted fixture doesn't leave a
 * stale confirmed record behind (deleteMatchSchedule / deleteScheduleSet in
 * firestoreService.js). Pure removal — never adds or modifies a record —
 * but still has to run here once matchRecords/{level} denies direct client
 * writes, same as the two functions above.
 */
exports.removeScheduledMatchRecords = onCall({ enforceAppCheck: true }, async (request) => {
  const data = request.data || {};
  const { level, scheduleIds } = data;
  await requireStaffForLevel(request, level);

  requireLevel(level);
  if (!Array.isArray(scheduleIds) || scheduleIds.length === 0) {
    return { records: null };
  }

  const ids = new Set(scheduleIds.map(String));
  const recordsRef = db.collection("matchRecords").doc(level);
  const rankingsRef = db.collection("teamRankings").doc(level);
  const schedulesRef = db.collection("matchSchedules").doc(level);

  const { records, rankings } = await db.runTransaction(async (tx) => {
    const [snap, rankingsSnap, schedulesSnap] = await Promise.all([
      tx.get(recordsRef), tx.get(rankingsRef), tx.get(schedulesRef),
    ]);
    const existing = snap.exists ? (snap.data().records || []) : [];
    const rankingsAll = rankingsSnap.exists ? (rankingsSnap.data().points || {}) : {};
    const orderOf = matchMath.scheduleOrder(schedulesSnap.exists ? (schedulesSnap.data().matches || []) : []);

    const isRemoved = (r) => r.scheduleId && ids.has(String(r.scheduleId));
    const removed = existing.filter(isRemoved);
    let next = existing.filter((r) => !isRemoved(r));

    // Ratings are derived from records, so deleting records must also roll
    // the ratings back: replay each affected scope from what is left, or
    // drop the scope entirely when nothing remains (teams return to baseline).
    const nextRankings = { ...rankingsAll };
    const affected = new Set(removed.map((r) => matchMath.rankingScopeKey(r.sportName, r.category)));
    affected.forEach((scopeKey) => {
      const stillThere = next.some((r) => matchMath.rankingScopeKey(r.sportName, r.category) === scopeKey);
      if (!stillThere) {
        delete nextRankings[scopeKey];
        return;
      }
      const replay = matchMath.replayScope(next, scopeKey, orderOf);
      next = replay.records;
      nextRankings[scopeKey] = replay.latest;
    });

    tx.set(recordsRef, { records: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (affected.size && rankingsSnap.exists) {
      // update() replaces the whole `points` field. set(..., { merge: true })
      // would deep-merge the nested maps and keep a deleted scope's old ratings.
      tx.update(rankingsRef, { points: nextRankings, updatedAt: FieldValue.serverTimestamp() });
    }
    return { records: next, rankings: nextRankings };
  });

  return { records, rankings };
});

/**
 * Follows a sport delete or rename from Sports & Teams (SportsTeamsManager)
 * through everything that references the sport by NAME: match schedules,
 * match records, team rankings and schedule requests. matchRecords and
 * teamRankings deny direct client writes, so this has to run here.
 *
 *  - delete (no `newName`): removes the sport's fixtures, its records (by
 *    scheduleId, and by sportName for records saved without a fixture), the
 *    `<sport>::*` ranking scopes and its schedule requests.
 *  - rename (`newName`): rewrites the name on all of those instead.
 *
 * Registrations are never touched. They hold personal data and carry no
 * school level of their own, so the admin UI flags a removed sport instead.
 */
exports.applySportChange = onCall({ enforceAppCheck: true }, async (request) => {
  const data = request.data || {};
  const level = data.level;
  const sportName = String(data.sportName || "").trim();
  const newName = data.newName == null ? null : String(data.newName).trim();
  const actor = await requireStaffForLevel(request, level);

  if (!sportName) throw new HttpsError("invalid-argument", "sportName is required.");
  if (newName !== null && !newName) throw new HttpsError("invalid-argument", "newName cannot be empty.");

  const target = matchMath.norm(sportName);
  const isRename = newName !== null;
  const isTarget = (name) => matchMath.norm(name) === target;
  const scopePrefix = `${target}::`;

  const schedulesRef = db.collection("matchSchedules").doc(level);
  const recordsRef = db.collection("matchRecords").doc(level);
  const rankingsRef = db.collection("teamRankings").doc(level);
  const requestsRef = db.collection("scheduleRequests").doc("all");

  const counts = await db.runTransaction(async (tx) => {
    const [schedulesSnap, recordsSnap, rankingsSnap, requestsSnap] = await Promise.all([
      tx.get(schedulesRef), tx.get(recordsRef), tx.get(rankingsRef), tx.get(requestsRef),
    ]);
    const schedules = schedulesSnap.exists ? (schedulesSnap.data().matches || []) : [];
    const records = recordsSnap.exists ? (recordsSnap.data().records || []) : [];
    const points = rankingsSnap.exists ? (rankingsSnap.data().points || {}) : {};
    const requests = requestsSnap.exists ? (requestsSnap.data().requests || []) : [];

    // A schedule request carries the level it was filed for; older ones may not.
    const isTargetRequest = (r) => isTarget(r.sport) && (!r.level || r.level === level);
    const scopeKeys = Object.keys(points).filter((k) => k.startsWith(scopePrefix));

    const result = {
      matches: schedules.filter((m) => isTarget(m.sport)).length,
      records: 0,
      rankingScopes: scopeKeys.length,
      requests: 0,
    };

    if (isRename) {
      const renamedPoints = { ...points };
      // Delete every old key before adding the new ones: a case-only rename
      // ("basketball" -> "Basketball") maps a key onto itself.
      scopeKeys.forEach((k) => { delete renamedPoints[k]; });
      scopeKeys.forEach((k) => {
        renamedPoints[`${matchMath.norm(newName)}::${k.slice(scopePrefix.length)}`] = points[k];
      });
      result.records = records.filter((r) => isTarget(r.sportName)).length;
      result.requests = requests.filter(isTargetRequest).length;

      if (result.matches) {
        tx.set(schedulesRef, {
          matches: schedules.map((m) => (isTarget(m.sport) ? { ...m, sport: newName } : m)),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      if (result.records) {
        tx.set(recordsRef, {
          records: records.map((r) => (isTarget(r.sportName) ? { ...r, sportName: newName } : r)),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      if (scopeKeys.length) {
        // update() replaces the whole `points` map; set(..., { merge: true })
        // would deep-merge and leave the old scope keys behind.
        tx.update(rankingsRef, { points: renamedPoints, updatedAt: FieldValue.serverTimestamp() });
      }
      if (result.requests) {
        tx.set(requestsRef, {
          requests: requests.map((r) => (isTargetRequest(r) ? { ...r, sport: newName } : r)),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return result;
    }

    const removedMatches = schedules.filter((m) => isTarget(m.sport));
    const removedScheduleIds = new Set(removedMatches.map((m) => String(m.id)));
    const removedRequestIds = new Set(removedMatches.map((m) => m.requestId).filter(Boolean).map(String));
    const isRemovedRecord = (r) => isTarget(r.sportName)
      || (r.scheduleId && removedScheduleIds.has(String(r.scheduleId)));
    const isRemovedRequest = (r) => isTargetRequest(r) || removedRequestIds.has(String(r.id));

    result.records = records.filter(isRemovedRecord).length;
    result.requests = requests.filter(isRemovedRequest).length;

    if (result.matches) {
      tx.set(schedulesRef, {
        matches: schedules.filter((m) => !isTarget(m.sport)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (result.records) {
      tx.set(recordsRef, {
        records: records.filter((r) => !isRemovedRecord(r)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (scopeKeys.length) {
      const nextPoints = { ...points };
      scopeKeys.forEach((k) => { delete nextPoints[k]; });
      tx.update(rankingsRef, { points: nextPoints, updatedAt: FieldValue.serverTimestamp() });
    }
    if (result.requests) {
      tx.set(requestsRef, {
        requests: requests.filter((r) => !isRemovedRequest(r)),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return result;
  });

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const summary = [
    plural(counts.matches, "match", "matches"),
    plural(counts.records, "result", "results"),
    plural(counts.rankingScopes, "ranking scope", "ranking scopes"),
    plural(counts.requests, "schedule request", "schedule requests"),
  ].join(", ");
  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: isRename ? "Sport Renamed" : "Sport Deleted",
    details: isRename
      ? `Renamed ${sportName} to ${newName} in ${level}; updated ${summary}`
      : `Deleted ${sportName} from ${level}; removed ${summary}`,
    targetType: "sport",
    targetId: `${level}::${sportName}`,
    targetLabel: sportName,
  });

  return counts;
});
