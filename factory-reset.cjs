/**
 * factory-reset.cjs
 *
 * Full "test from scratch" wipe: sports/teams, venues, match schedules,
 * match records (+ embedded violations), team rankings, schedule
 * requests, activity logs, every player registration, every user
 * profile, and every staff allowlist doc (admins/moderators/superadmins)
 * — plus, unlike reset-sports-schedules.cjs, the actual Firebase Auth
 * login accounts behind all of that.
 *
 * ONE account is deliberately spared so there's still a way into the app
 * afterwards: --keep-email (default cesynarciso@gmail.com) keeps its
 * Firebase Auth login and is re-written as the sole superadmins/{email}
 * doc + users/{uid} profile. Everything else — every other Auth user,
 * every other users/admins/moderators/superadmins doc — is deleted.
 *
 * Collections touched:
 *   sportsTeamsConfig/{elementary,highSchool,college} -> { sports: [], teams: [] }
 *   matchSchedules/{elementary,highSchool,college}    -> deleted
 *   matchRecords/{elementary,highSchool,college}      -> deleted (violations live inside these)
 *   teamRankings/{elementary,highSchool,college}      -> deleted
 *   venuesConfig/global                               -> { venues: [] }
 *   siteCounters/liveCounters                         -> deleted
 *   registrations/*                                   -> ALL deleted
 *   scheduleRequests/*                                -> ALL deleted
 *   activityLogs/*                                    -> ALL deleted
 *   users/*                                           -> ALL deleted except keep-email's uid
 *   admins/*, moderators/*                            -> ALL deleted
 *   superadmins/*                                     -> ALL deleted except keep-email
 *   Firebase Auth users                                -> ALL deleted except keep-email
 *
 * NOT touched: Firebase Storage files (uploaded photos/waivers/logos),
 * siteConfig (branding), Cloud Functions/Firestore rules/indexes.
 *
 * ─── SETUP ───────────────────────────────────────────────────────
 * Same as reset-sports-schedules.cjs / create-staff-account.cjs:
 * needs serviceAccountKey.json in this folder (gitignored).
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *   node factory-reset.cjs                                   # dry run
 *   node factory-reset.cjs --keep-email=someone@gmail.com     # dry run, different email to keep
 *   node factory-reset.cjs --yes                              # actually performs the reset
 */

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

function parseArgs() {
  const args = { yes: false };
  for (const raw of process.argv.slice(2)) {
    if (raw === '--yes') { args.yes = true; continue; }
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const args = parseArgs();
const DRY_RUN = !args.yes;
const KEEP_EMAIL = (args['keep-email'] || 'cesynarciso@gmail.com').trim().toLowerCase();
const LEVELS = ['elementary', 'highSchool', 'college'];

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const auth = getAuth();

async function deleteAllDocs(collectionName, { exceptId } = {}) {
  const snapshot = await db.collection(collectionName).get();
  const docs = snapshot.docs.filter((d) => d.id !== exceptId);
  if (docs.length === 0) return 0;

  const CHUNK_SIZE = 450; // Firestore batch limit is 500
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + CHUNK_SIZE).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

async function main() {
  console.log(DRY_RUN
    ? '🔍 DRY RUN — no data will change (pass --yes to actually reset)\n'
    : '⚠️  LIVE RUN — this will permanently modify Firestore and Firebase Auth\n');
  console.log(`Preserving as sole superadmin: ${KEEP_EMAIL}\n`);

  // Look up the Auth account to keep, so we know which uid survives in
  // `users` and which uid to skip when deleting Auth accounts.
  let keepUid = null;
  try {
    const keepUser = await auth.getUserByEmail(KEEP_EMAIL);
    keepUid = keepUser.uid;
    console.log(`Found existing Auth account for ${KEEP_EMAIL} (uid: ${keepUid}) — this one will be kept.\n`);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    console.log(`⚠️  No existing Auth account for ${KEEP_EMAIL}. It will NOT be created by this script — `
      + `run create-staff-account.cjs afterwards (--role=superadmin) or you'll have no way to log in.\n`);
  }

  // ── Config docs (reset to empty shape, not deleted — matches how the
  // app already treats "never configured") ──────────────────────────
  for (const level of LEVELS) {
    console.log(`sportsTeamsConfig/${level}  ->  { sports: [], teams: [] }`);
    console.log(`matchSchedules/${level}     ->  deleted`);
    console.log(`matchRecords/${level}       ->  deleted`);
    console.log(`teamRankings/${level}       ->  deleted`);
    if (!DRY_RUN) {
      await db.collection('sportsTeamsConfig').doc(level).set({
        sports: [],
        teams: [],
        updatedAt: FieldValue.serverTimestamp(),
      });
      await db.collection('matchSchedules').doc(level).delete();
      await db.collection('matchRecords').doc(level).delete();
      await db.collection('teamRankings').doc(level).delete();
    }
  }

  console.log(`venuesConfig/global          ->  { venues: [] }`);
  if (!DRY_RUN) {
    await db.collection('venuesConfig').doc('global').set({
      venues: [],
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  console.log(`siteCounters/liveCounters    ->  deleted`);
  if (!DRY_RUN) {
    await db.collection('siteCounters').doc('liveCounters').delete();
  }

  // ── Whole collections ───────────────────────────────────────────
  for (const name of ['registrations', 'scheduleRequests', 'activityLogs', 'admins', 'moderators']) {
    const snapshot = await db.collection(name).get();
    console.log(`${name.padEnd(28)} ->  ${snapshot.size} document(s) deleted`);
    if (!DRY_RUN) await deleteAllDocs(name);
  }

  // superadmins: delete everything except KEEP_EMAIL, then make sure
  // KEEP_EMAIL's doc exists.
  {
    const snapshot = await db.collection('superadmins').get();
    const toDelete = snapshot.docs.filter((d) => d.id !== KEEP_EMAIL);
    console.log(`superadmins                  ->  ${toDelete.length} document(s) deleted, ${KEEP_EMAIL} kept/ensured`);
    if (!DRY_RUN) {
      await deleteAllDocs('superadmins', { exceptId: KEEP_EMAIL });
      await db.collection('superadmins').doc(KEEP_EMAIL).set({
        email: KEEP_EMAIL,
        addedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  // users: delete everything except the kept uid, then rewrite a clean
  // profile for it.
  {
    const snapshot = await db.collection('users').get();
    const toDelete = snapshot.docs.filter((d) => d.id !== keepUid);
    console.log(`users                         ->  ${toDelete.length} document(s) deleted${keepUid ? `, users/${keepUid} kept/reset` : ''}`);
    if (!DRY_RUN) {
      await deleteAllDocs('users', { exceptId: keepUid || undefined });
      if (keepUid) {
        await db.collection('users').doc(keepUid).set({
          email: KEEP_EMAIL,
          role: 'superadmin',
          isAdmin: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
  }

  // ── Firebase Auth: delete every user except the kept one ──────────
  let authDeletedCount = 0;
  let pageToken;
  const uidsToDelete = [];
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.uid !== keepUid) uidsToDelete.push(user.uid);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(`Firebase Auth users          ->  ${uidsToDelete.length} account(s) deleted${keepUid ? ' (1 kept)' : ''}`);
  if (!DRY_RUN && uidsToDelete.length > 0) {
    // deleteUsers caps at 1000 per call.
    for (let i = 0; i < uidsToDelete.length; i += 1000) {
      const result = await auth.deleteUsers(uidsToDelete.slice(i, i + 1000));
      authDeletedCount += result.successCount;
      if (result.failureCount > 0) {
        console.warn(`  ⚠️  ${result.failureCount} account(s) failed to delete:`, result.errors.slice(0, 5));
      }
    }
  }

  if (!DRY_RUN && keepUid) {
    await auth.setCustomUserClaims(keepUid, { role: 'superadmin' });
    console.log(`✅ custom claim { role: 'superadmin' } set on ${keepUid}`);
  }

  console.log(DRY_RUN
    ? '\nNothing was changed. Re-run with --yes to apply.'
    : `\n✅ Done. Factory reset complete. ${KEEP_EMAIL} remains as the sole superadmin.`);
}

main().catch((err) => {
  console.error('❌ Factory reset failed:', err.message);
  process.exit(1);
});
