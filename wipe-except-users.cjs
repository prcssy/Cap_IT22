/**
 * wipe-except-users.cjs
 *
 * Recovery drill: deletes every document the app's users have entered —
 * sports/teams, venues, schedules, results, rankings, schedule requests,
 * registrations, counters and site customization — while keeping every
 * account, so everyone can still log in afterwards. Then you prove the
 * backups work by finding and restoring it all:
 *
 *   node backup-firestore.cjs                 # 1. fresh backup (required, see below)
 *   node wipe-except-users.cjs                # 2. dry run: lists what would be deleted
 *   node wipe-except-users.cjs --yes          # 3. delete it
 *   node compare-backup.cjs                   # 4. should list everything as missing
 *   node restore-firestore.cjs latest --yes   # 5. restore
 *   node compare-backup.cjs                   # 6. should say nothing is missing
 *
 * KEPT: users, admins, moderators, superadmins, emailIndex (account data),
 * activityLogs (the audit trail of the drill itself), Firebase Auth logins
 * and Storage files (photos/waivers/logos are never touched).
 *
 * Safety: --yes refuses to run unless backups/ holds an export taken in the
 * last 15 minutes, so there is always a copy of exactly what gets deleted.
 *
 * Needs serviceAccountKey.json in this folder (gitignored).
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const KEEP = new Set(['users', 'admins', 'moderators', 'superadmins', 'emailIndex', 'activityLogs']);
const MAX_BACKUP_AGE_MIN = 15;

function newestBackup() {
  const dir = path.join(__dirname, 'backups');
  if (!fs.existsSync(dir)) return null;
  const manifests = fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json'));
  let newest = null;
  for (const f of manifests) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    // A point-in-time clone export is dated by its snapshot, not "now", and
    // only a backup of the live database protects what is about to be deleted.
    if (m.sourceDatabase && m.sourceDatabase !== '(default)') continue;
    const at = new Date(m.createdAt);
    if (!newest || at > newest.at) newest = { file: m.file, at, totalDocs: m.totalDocs };
  }
  return newest;
}

async function main() {
  const yes = process.argv.includes('--yes');
  const keyPath = path.join(__dirname, 'serviceAccountKey.json');
  if (!fs.existsSync(keyPath)) {
    console.error('Missing serviceAccountKey.json in the project root.');
    process.exit(1);
  }

  const backup = newestBackup();
  const ageMin = backup ? (Date.now() - backup.at.getTime()) / 60000 : Infinity;
  if (yes && ageMin > MAX_BACKUP_AGE_MIN) {
    console.error(backup
      ? `Newest backup (${backup.file}) is ${Math.round(ageMin)} minutes old.`
      : 'No backup found in backups/.');
    console.error(`Run "node backup-firestore.cjs" first (must be under ${MAX_BACKUP_AGE_MIN} minutes old). Nothing was deleted.`);
    process.exit(1);
  }

  initializeApp({ credential: cert(require(keyPath)) });
  const db = getFirestore();

  console.log(yes ? 'DELETING (live database)...\n' : 'DRY RUN: nothing will be deleted (pass --yes to delete)\n');

  let total = 0;
  for (const col of await db.listCollections()) {
    if (KEEP.has(col.id)) {
      console.log(`  keep    ${col.id}`);
      continue;
    }
    // recursiveDelete also removes any subcollections under these docs.
    const count = (await col.count().get()).data().count;
    total += count;
    console.log(`  delete  ${col.id.padEnd(20)} ${count} doc(s)`);
    if (yes) await db.recursiveDelete(col);
  }

  console.log(`\n${yes ? 'Deleted' : 'Would delete'} ${total} document(s).`);
  if (backup) console.log(`Backup to restore from: backups/${backup.file} (${Math.round(ageMin)} min old)`);
  if (yes) console.log('\nNext: node compare-backup.cjs, then node restore-firestore.cjs latest --yes');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
