/**
 * backup-firestore.cjs
 *
 * Exports EVERY Firestore collection (including subcollections) to a
 * timestamped JSON file under backups/, plus a manifest with per-collection
 * document counts and a SHA-256 checksum of the export. This is the
 * on-demand / offline backup that complements the managed daily backup
 * schedule on the Firestore database itself (see BACKUP_AND_RECOVERY.md).
 *
 * Special Firestore types (Timestamp, GeoPoint, DocumentReference, Bytes)
 * are written as tagged objects ({ "__type": "timestamp", ... }) so
 * restore-firestore.cjs can turn them back into the exact same types.
 *
 * backups/ is gitignored — an export contains personal data from
 * `registrations` and `users`, so never commit or share one.
 *
 * ─── SETUP ─────────────────────────────────────────────────────────
 * Same as reset-sports-schedules.cjs / create-staff-account.cjs:
 * needs serviceAccountKey.json in this folder (gitignored).
 *
 * ─── USAGE ─────────────────────────────────────────────────────────
 *   node backup-firestore.cjs                     # writes backups/firestore-<timestamp>.json
 *   node backup-firestore.cjs --out=my-copy.json  # custom output file
 *
 *   # Export a point-in-time clone (made from Firebase Console → Disaster
 *   # recovery, or `gcloud firestore databases clone`) so compare-backup.cjs,
 *   # find-in-backups.cjs and restore-firestore.cjs can use it like any other
 *   # backup. --as-of is the clone's snapshot time: the file is named and
 *   # dated by it, so it sorts in the right place among the other backups.
 *   node backup-firestore.cjs --database=recovered --as-of=2026-09-27T13:00:00+08:00
 *
 * Read-only: this script never writes to Firestore.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, GeoPoint, DocumentReference } = require('firebase-admin/firestore');

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function encodeValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Timestamp) return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return { __type: 'reference', path: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: 'bytes', base64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  }
  return value;
}

async function exportCollection(colRef, counts) {
  const snap = await colRef.get();
  counts[colRef.path] = snap.size;
  const docs = {};
  for (const docSnap of snap.docs) {
    const entry = { data: encodeValue(docSnap.data()) };
    const subcollections = await docSnap.ref.listCollections();
    if (subcollections.length) {
      entry.subcollections = {};
      for (const sub of subcollections) {
        entry.subcollections[sub.id] = await exportCollection(sub, counts);
      }
    }
    docs[docSnap.id] = entry;
  }
  return docs;
}

async function main() {
  const args = parseArgs();
  const keyPath = path.join(__dirname, 'serviceAccountKey.json');
  if (!fs.existsSync(keyPath)) {
    console.error('Missing serviceAccountKey.json in the project root (see SETUP in this file).');
    process.exit(1);
  }
  const serviceAccount = require(keyPath);
  initializeApp({ credential: cert(serviceAccount) });
  const databaseId = args.database || '(default)';
  const db = databaseId === '(default)' ? getFirestore() : getFirestore(databaseId);

  const startedAt = args['as-of'] ? new Date(args['as-of']) : new Date();
  if (Number.isNaN(startedAt.getTime())) {
    console.error(`Invalid --as-of time "${args['as-of']}". Use e.g. 2026-09-27T13:00:00+08:00`);
    process.exit(1);
  }
  // File name uses the computer's LOCAL time (Philippine time here), so
  // "firestore-2026-09-27_14-30-27.json" reads as 2:30:27 PM. The exact UTC
  // time is still stored inside the file and manifest as `createdAt`.
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`
    + `_${pad(startedAt.getHours())}-${pad(startedAt.getMinutes())}-${pad(startedAt.getSeconds())}`;
  const outFile = path.resolve(args.out || path.join(__dirname, 'backups', `firestore-${stamp}.json`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  console.log(`Backing up project "${serviceAccount.project_id}", database "${databaseId}"...`);
  const counts = {};
  const collections = {};
  const topLevel = await db.listCollections();
  if (!topLevel.length) {
    console.error(`Database "${databaseId}" is empty or doesn't exist — nothing written.`);
    process.exit(1);
  }
  for (const col of topLevel) {
    collections[col.id] = await exportCollection(col, counts);
    console.log(`  ${col.id.padEnd(22)} ${counts[col.path]} doc(s)`);
  }

  const body = JSON.stringify({ projectId: serviceAccount.project_id, sourceDatabase: databaseId, createdAt: startedAt.toISOString(), collections });
  fs.writeFileSync(outFile, body);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const totalDocs = Object.values(counts).reduce((a, b) => a + b, 0);
  const manifest = { file: path.basename(outFile), projectId: serviceAccount.project_id, sourceDatabase: databaseId, createdAt: startedAt.toISOString(), totalDocs, counts, sha256 };
  fs.writeFileSync(outFile.replace(/\.json$/, '.manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nDone: ${totalDocs} document(s) in ${Object.keys(counts).length} collection(s).`);
  console.log(`File:     ${outFile}`);
  console.log(`SHA-256:  ${sha256}`);
}

main().catch((err) => {
  if (err.code === 5) {
    console.error(`Backup failed: database "${parseArgs().database || '(default)'}" was not found in this project.`);
    console.error('List databases with: gcloud firestore databases list');
    process.exit(1);
  }
  console.error('Backup failed:', err);
  process.exit(1);
});
