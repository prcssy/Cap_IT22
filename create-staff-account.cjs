/**
 * create-staff-account.cjs
 *
 * Provisions a staff (Admin / Moderator / Super Admin) account:
 *   1. Creates the Firebase Auth user directly (Admin SDK), pre-verified.
 *   2. Adds the admins/moderators/superadmins allowlist doc (doc id =
 *      lowercase email) that AuthContext already uses to resolve roles.
 *   3. Writes a matching users/{uid} profile doc.
 *
 * Why this exists instead of the public sign-up form letting people
 * pick "Admin"/"Moderator"/"Super Admin": that form used to create the
 * Firebase Auth account for ANY email typed in, as long as the email
 * was already on the allowlist — but it never checked that the person
 * submitting the form actually controlled that inbox. Someone could
 * "claim" a staff member's email with a password of their own choosing
 * before the real owner signed up; Firebase still sends the
 * verification link to the real inbox regardless of who created the
 * account, so if the real owner later clicked that link (thinking it
 * was their own signup) it would verify the ATTACKER's account instead
 * — full account takeover. Staff accounts are now only ever created
 * here, by a Super Admin who already controls the service account key,
 * the same trust boundary already used for reset-sports-schedules.cjs.
 *
 * ─── SETUP (one-time) ────────────────────────────────────────────
 * 1. npm install firebase-admin   (already a project dependency)
 * 2. Get a service account key:
 *      Firebase Console → Project Settings → Service Accounts
 *      → "Generate new private key" → save as serviceAccountKey.json
 *      IN THE SAME FOLDER AS THIS SCRIPT. Do NOT commit it to git.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *   node create-staff-account.cjs --email=someone@gmail.com --role=admin --name="Jane Doe"
 *       # dry run, shows what would happen
 *
 *   node create-staff-account.cjs --email=someone@gmail.com --role=admin --name="Jane Doe" --yes
 *       # actually creates the account (prints a generated temp password —
 *       # share it with them out-of-band; they can change it after login
 *       # via Profile → Change Password)
 *
 *   --role must be one of: admin | moderator | superadmin
 *   --password=... optionally sets a specific temp password instead of
 *       generating a random one (must be 6+ characters, per Firebase Auth).
 */

const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

function parseArgs() {
  const args = { yes: false };
  for (const raw of process.argv.slice(2)) {
    if (raw === '--yes') { args.yes = true; continue; }
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

const ROLE_COLLECTIONS = { admin: 'admins', moderator: 'moderators', superadmin: 'superadmins' };

function randomPassword() {
  // 16 random bytes, base64url — well above Firebase Auth's 6-char minimum,
  // and safe to paste/type without escaping issues.
  return crypto.randomBytes(16).toString('base64url');
}

async function main() {
  const args = parseArgs();
  const DRY_RUN = !args.yes;

  const email = (args.email || '').trim().toLowerCase();
  const role = args.role;
  const name = args.name || '';

  if (!email || !email.includes('@')) {
    console.error('❌ --email=someone@gmail.com is required.');
    process.exit(1);
  }
  if (!ROLE_COLLECTIONS[role]) {
    console.error('❌ --role must be one of: admin | moderator | superadmin');
    process.exit(1);
  }

  const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));
  initializeApp({ credential: cert(serviceAccount) });
  const auth = getAuth();
  const db = getFirestore();

  const password = args.password || randomPassword();
  const collectionName = ROLE_COLLECTIONS[role];

  console.log(DRY_RUN ? '🔍 DRY RUN — no account will be created (pass --yes to actually create it)\n' : '⚠️  LIVE RUN — this will create a real account\n');
  console.log(`Email:      ${email}`);
  console.log(`Role:       ${role}  (${collectionName}/${email})`);
  console.log(`Name:       ${name || '(none given)'}`);
  console.log(`users/{uid} profile doc will be created, isAdmin=${role === 'admin' || role === 'superadmin'}`);

  if (DRY_RUN) {
    console.log('\nNothing was changed. Re-run with --yes to apply.');
    return;
  }

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log(`\nAn Auth account already exists for ${email} (uid: ${userRecord.uid}) — leaving it as-is, only updating the allowlist/profile docs.`);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    userRecord = await auth.createUser({
      email,
      password,
      emailVerified: true, // a Super Admin running this script is vouching for the identity out-of-band
      displayName: name || undefined,
    });
    console.log(`\n✅ Created Firebase Auth account (uid: ${userRecord.uid})`);
    console.log(`   Temp password: ${password}`);
    console.log('   Share this with them out-of-band (not email/Slack in plaintext if avoidable) — they can change it after logging in via Profile → Change Password.');
  }

  await db.collection(collectionName).doc(email).set({
    email,
    addedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`✅ ${collectionName}/${email} allowlist doc written`);

  await db.collection('users').doc(userRecord.uid).set({
    name,
    email,
    role,
    isAdmin: role === 'admin' || role === 'superadmin',
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`✅ users/${userRecord.uid} profile doc written`);

  console.log('\nDone. They can log in immediately with the credentials above (email already verified).');
}

main().catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
