const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
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

function randomPassword() {
  return crypto.randomBytes(16).toString("base64url");
}

function randomId() {
  return crypto.randomBytes(6).toString("hex");
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
  await getAuth().setCustomUserClaims(uid, role ? { role } : {});
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
      return { email, role: claimedRole, uid: request.auth.uid, name: request.auth.token.name || "" };
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
  return { email, role, uid: request.auth.uid, name: request.auth.token.name || "" };
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

exports.createStaffAccount = onCall(async (request) => {
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
    { email, addedAt: FieldValue.serverTimestamp() },
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
    details: `${created ? "Created" : "Updated"} ${STAFF_ROLE_LABELS[role]} account for ${name || email}`,
    targetType: "user",
    targetId: userRecord.uid,
    targetLabel: email,
    timestamp: FieldValue.serverTimestamp(),
  });

  logger.info(`Staff account ${created ? "created" : "updated"} for ${email} as ${role} by ${actor.email}`);

  return { uid: userRecord.uid, email, role, created, tempPassword };
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
exports.assignStaffRole = onCall(async (request) => {
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

  await Promise.all(
    Object.values(STAFF_ROLE_COLLECTIONS)
      .filter((collection) => collection !== collectionName)
      .map((collection) => db.collection(collection).doc(email).delete())
  );
  await db.collection(collectionName).doc(email).set(
    { email, addedAt: FieldValue.serverTimestamp() },
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

  return { role, email };
});

/**
 * Revokes an existing staff role — removes the allowlist doc from all three
 * collections, demotes the `users/{uid}` profile back to student, and
 * clears the custom claim. Same Super-Admin-only / never-self gate as
 * assignStaffRole above.
 */
exports.removeStaffRole = onCall(async (request) => {
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
exports.submitMatchRecord = onCall(async (request) => {
  const actor = await requireStaff(request);
  const data = request.data || {};
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

  const { record, records, rankings } = await db.runTransaction(async (tx) => {
    const [recordsSnap, rankingsSnap] = await Promise.all([tx.get(recordsRef), tx.get(rankingsRef)]);
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
      if (prevPoints == null) {
        const carried = matchMath.overallRating(rankingsAll, r.name);
        prevPoints = carried != null ? matchMath.round4(carried) : matchMath.DEFAULT_POINTS;
      }
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
    const winnerSide = cTeams[0].id === comp.winnerId ? "A" : "B";
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
      teamA,
      teamB,
      participants: multi ? ordered.map(asStored) : [],
      createdAt: existingRecord?.createdAt || createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    const idx = existingRecords.findIndex((r) => r.id === newRecord.id);
    const nextRecords = idx >= 0
      ? existingRecords.map((r) => (r.id === newRecord.id ? newRecord : r))
      : [...existingRecords, newRecord];

    const nextScope = { ...scoped };
    cTeams.forEach((t) => { nextScope[t.name] = matchMath.round4(t.finalPoints); });
    const nextRankings = { ...rankingsAll, [scopeKey]: nextScope };

    tx.set(recordsRef, { records: nextRecords, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(rankingsRef, { points: nextRankings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return { record: newRecord, records: nextRecords, rankings: nextRankings };
  });

  await logActivity({
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorName: actor.name,
    actorRole: actor.role,
    type: "Match Record Saved",
    details: `Saved the ${record.sportName || "match"} result for ${record.teamA?.name || "?"} vs ${record.teamB?.name || "?"}`,
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
exports.editMatchRecord = onCall(async (request) => {
  const actor = await requireStaff(request);
  const data = request.data || {};
  const {
    level, recordId, teamA: teamAIn, teamB: teamBIn,
    totalViolationsA, totalViolationsB, pointsA, pointsB, minutesA, minutesB,
  } = data;

  requireLevel(level);
  if (!recordId) throw new HttpsError("invalid-argument", "recordId is required.");

  const recordsRef = db.collection("matchRecords").doc(level);
  const rankingsRef = db.collection("teamRankings").doc(level);

  const { updated, records, rankings } = await db.runTransaction(async (tx) => {
    const [recordsSnap, rankingsSnap] = await Promise.all([tx.get(recordsRef), tx.get(rankingsRef)]);
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

    const { finalPointsA, finalPointsB, winner } = matchMath.computeEditFinalPoints({
      ratingA, ratingB, violA, violB,
      comebackA: !!record.teamA.comeback, comebackB: !!record.teamB.comeback,
      isPoints, pA, pB, mA, mB,
      fallbackWinner: record.winner,
    });

    const teamAObj = teamAIn || record.teamA;
    const teamBObj = teamBIn || record.teamB;

    const nextRecord = {
      ...record,
      winner,
      teamA: {
        ...record.teamA,
        id: teamAObj.id || record.teamA.id,
        name: teamAObj.name || record.teamA.name,
        logo: teamAObj.logo || null,
        totalViolations: violA,
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
        minutes: isPoints ? record.teamB.minutes : mB,
        points: isPoints ? pB : record.teamB.points,
        finalPoints: finalPointsB,
      },
      updatedAt: Date.now(),
    };

    const nextRecords = existingRecords.map((r) => (r.id === recordId ? nextRecord : r));

    const scopeKey = matchMath.rankingScopeKey(nextRecord.sportName, nextRecord.category);
    const nextScope = { ...(rankingsAll[scopeKey] || {}) };
    nextScope[nextRecord.teamA.name] = finalPointsA;
    nextScope[nextRecord.teamB.name] = finalPointsB;
    const nextRankings = { ...rankingsAll, [scopeKey]: nextScope };

    tx.set(recordsRef, { records: nextRecords, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(rankingsRef, { points: nextRankings, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

    return { updated: nextRecord, records: nextRecords, rankings: nextRankings };
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
 * Cascade-delete used by AdminSchedulePage when a fixture or a whole
 * generated schedule set is removed, so a deleted fixture doesn't leave a
 * stale confirmed record behind (deleteMatchSchedule / deleteScheduleSet in
 * firestoreService.js). Pure removal — never adds or modifies a record —
 * but still has to run here once matchRecords/{level} denies direct client
 * writes, same as the two functions above.
 */
exports.removeScheduledMatchRecords = onCall(async (request) => {
  await requireStaff(request);
  const data = request.data || {};
  const { level, scheduleIds } = data;

  requireLevel(level);
  if (!Array.isArray(scheduleIds) || scheduleIds.length === 0) {
    return { records: null };
  }

  const ids = new Set(scheduleIds.map(String));
  const recordsRef = db.collection("matchRecords").doc(level);

  const records = await db.runTransaction(async (tx) => {
    const snap = await tx.get(recordsRef);
    const existing = snap.exists ? (snap.data().records || []) : [];
    const next = existing.filter((r) => !r.scheduleId || !ids.has(String(r.scheduleId)));
    tx.set(recordsRef, { records: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });

  return { records };
});
