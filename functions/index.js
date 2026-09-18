const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore(); // ✅  LANG — sa labas ng function!

const STAFF_ROLE_COLLECTIONS = { admin: "admins", moderator: "moderators", superadmin: "superadmins" };
const STAFF_ROLE_LABELS = { admin: "Admin", moderator: "Moderator", superadmin: "Super Admin" };

function randomPassword() {
  return crypto.randomBytes(16).toString("base64url");
}

exports.createStaffAccount = onCall(async (request) => {
  const callerEmail = (request.auth?.token?.email || "").trim().toLowerCase();
  if (!request.auth || !callerEmail) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  // TIGNAN KUNG SUPER ADMIN — gamit ang tamang db
  const superAdminDoc = await db.collection("superadmins").doc(callerEmail).get();
  if (!superAdminDoc.exists) {
    throw new HttpsError("permission-denied", "Only a Super Admin can create staff accounts.");
  }

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

  //  Mag-log ng aktibidad
  await db.collection("activityLogs").add({
    actorUid: request.auth.uid,
    actorEmail: callerEmail,
    actorName: request.auth.token.name || "",
    actorRole: "superadmin",
    type: created ? "Staff Account Created" : "Staff Role Assigned",
    details: `${created ? "Created" : "Updated"} ${STAFF_ROLE_LABELS[role]} account for ${name || email}`,
    targetType: "user",
    targetId: userRecord.uid,
    targetLabel: email,
    timestamp: FieldValue.serverTimestamp(),
  });

  logger.info(`Staff account ${created ? "created" : "updated"} for ${email} as ${role} by ${callerEmail}`);

  return { uid: userRecord.uid, email, role, created, tempPassword };
});
