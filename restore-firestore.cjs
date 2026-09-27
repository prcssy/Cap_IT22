/**
 * restore-firestore.cjs
 *
 * Restores a backup made by backup-firestore.cjs, and can prove that a
 * backup is restorable WITHOUT touching live data (a "recovery drill").
 *
 * ─── MODES ─────────────────────────────────────────────────────────
 *   node restore-firestore.cjs <file>            # dry run: checks the checksum, lists what WOULD be restored
 *   node restore-firestore.cjs <file> --verify   # compares the backup with the live database (read-only)
 *   node restore-firestore.cjs <file> --drill    # recovery test: restores into temporary
 *                                                # "__restoreDrill_<collection>" collections, reads every
 *                                                # document back, compares it with the backup, then deletes
 *                                                # the temporary collections. Live collections are untouched.
 *   node restore-firestore.cjs <file> --yes      # REAL restore: writes every backed-up document back to
 *                                                # its original path (overwrites; docs created after the
 *                                                # backup are left alone)
 *   ... --only=registrations,users               # limit any mode to some top-level collections
 *
 * <file> can be the word "latest" to use the newest export in backups/:
 *   node restore-firestore.cjs latest --verify --only=venuesConfig
 *
 * ─── SETUP ─────────────────────────────────────────────────────────
 * Needs serviceAccountKey.json in this folder (gitignored).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, GeoPoint } = require('firebase-admin/firestore');

const DRILL_PREFIX = '__restoreDrill_';

function parseArgs() {
  const args = { flags: new Set(), file: null };
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
    else if (raw.startsWith('--')) args.flags.add(raw.slice(2));
    else args.file = raw;
  }
  return args;
}

let db;

function decodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  switch (value.__type) {
    case 'timestamp': return new Timestamp(value.seconds, value.nanoseconds);
    case 'geopoint': return new GeoPoint(value.latitude, value.longitude);
    case 'reference': return db.doc(value.path);
    case 'bytes': return Buffer.from(value.base64, 'base64');
    default:
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeValue(v)]));
  }
}

/* Same encoding as backup-firestore.cjs, used to compare live docs with the backup. */
function encodeValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Timestamp) return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (value && typeof value.path === 'string' && typeof value.firestore === 'object') return { __type: 'reference', path: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: 'bytes', base64: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)]));
  return value;
}

/* Key-order-independent JSON, so {a,b} and {b,a} compare equal. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/* Flattens the nested backup into [{ path, data }] entries. */
function flatten(collections, prefix = '', rename = (id) => id) {
  const out = [];
  for (const [colId, docs] of Object.entries(collections)) {
    for (const [docId, entry] of Object.entries(docs)) {
      const docPath = `${prefix}${rename(colId)}/${docId}`;
      out.push({ path: docPath, data: entry.data });
      if (entry.subcollections) out.push(...flatten(entry.subcollections, `${docPath}/`));
    }
  }
  return out;
}

async function writeAll(entries) {
  const writer = db.bulkWriter();
  for (const { path: p, data } of entries) writer.set(db.doc(p), decodeValue(data));
  await writer.close();
}

async function compare(entries, pathOf = (p) => p) {
  let matched = 0;
  const problems = [];
  for (const { path: p, data } of entries) {
    const snap = await db.doc(pathOf(p)).get();
    if (!snap.exists) problems.push(`missing: ${pathOf(p)}`);
    else if (stable(encodeValue(snap.data())) !== stable(data)) problems.push(`different: ${pathOf(p)}`);
    else matched++;
  }
  return { matched, problems };
}

async function main() {
  const args = parseArgs();
  if (!args.file) {
    console.error('Usage: node restore-firestore.cjs <backup-file.json | latest> [--verify | --drill | --yes] [--only=a,b]');
    process.exit(1);
  }
  const backupsDir = path.join(__dirname, 'backups');
  const available = fs.existsSync(backupsDir)
    ? fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.manifest.json')).sort()
    : [];

  // "latest" = the newest export in backups/ (file names sort by timestamp).
  let file;
  if (args.file === 'latest') {
    if (!available.length) {
      console.error('No backups found in backups/. Run "node backup-firestore.cjs" first.');
      process.exit(1);
    }
    file = path.join(backupsDir, available[available.length - 1]);
  } else {
    file = path.resolve(args.file);
  }
  if (!fs.existsSync(file)) {
    console.error(`Backup file not found: ${args.file}`);
    if (available.length) {
      console.error('\nAvailable backups (newest last):');
      available.forEach((f) => console.error(`  backups/${f}`));
      console.error('\nTip: use "latest" instead of a file name, e.g. node restore-firestore.cjs latest --verify');
    } else {
      console.error('No backups found in backups/. Run "node backup-firestore.cjs" first.');
    }
    process.exit(1);
  }
  console.log(`Using backup: ${path.relative(__dirname, file)}`);
  const body = fs.readFileSync(file, 'utf8');

  // Integrity check against the manifest written at backup time.
  const manifestFile = file.replace(/\.json$/, '.manifest.json');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.sha256 !== sha256) {
      console.error('Checksum mismatch: the backup file is corrupted or was modified. Aborting.');
      process.exit(1);
    }
    console.log('Checksum OK (matches manifest).');
  } else {
    console.warn('No manifest found next to the backup, so its checksum could not be verified.');
  }

  const backup = JSON.parse(body);
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  // A typo in --only (e.g. "sportConfig") would otherwise silently restore
  // nothing, so stop and list the real collection names instead.
  const unknown = only ? [...only].filter((id) => !(id in backup.collections)) : [];
  if (unknown.length) {
    console.error(`\nUnknown collection name(s) in --only: ${unknown.join(', ')}`);
    console.error('Collections in this backup:');
    Object.keys(backup.collections).sort().forEach((id) => console.error(`  ${id}`));
    console.error('\nTip: deleting a sport also removes its schedules, results and rankings, so restore them together:');
    console.error('  --only=sportsTeamsConfig,matchSchedules,matchRecords,teamRankings,scheduleRequests');
    process.exit(1);
  }
  const collections = Object.fromEntries(
    Object.entries(backup.collections).filter(([id]) => !only || only.has(id))
  );

  const keyPath = path.join(__dirname, 'serviceAccountKey.json');
  const serviceAccount = require(keyPath);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();

  if (backup.projectId !== serviceAccount.project_id) {
    console.warn(`Note: backup is from "${backup.projectId}", restoring into "${serviceAccount.project_id}".`);
  }

  const entries = flatten(collections);
  console.log(`Backup from ${backup.createdAt}: ${entries.length} document(s) in ${Object.keys(collections).length} top-level collection(s).`);
  Object.entries(collections).forEach(([id, docs]) => console.log(`  ${id.padEnd(22)} ${Object.keys(docs).length} doc(s)`));

  if (args.flags.has('verify')) {
    const { matched, problems } = await compare(entries);
    console.log(`\nVerify: ${matched}/${entries.length} documents identical to live data.`);
    problems.slice(0, 50).forEach((p) => console.log(`  ${p}`));
    if (problems.length > 50) console.log(`  ... and ${problems.length - 50} more`);
    console.log('(Differences are expected for anything changed since the backup was taken.)');
    return;
  }

  if (args.flags.has('drill')) {
    const drillEntries = flatten(collections, '', (id) => `${DRILL_PREFIX}${id}`);
    console.log(`\nRecovery drill: restoring into ${DRILL_PREFIX}* collections...`);
    const started = Date.now();
    await writeAll(drillEntries);
    const { matched, problems } = await compare(drillEntries);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`Restored and read back ${matched}/${drillEntries.length} documents identically in ${seconds}s.`);
    problems.forEach((p) => console.log(`  ${p}`));

    console.log('Cleaning up drill collections...');
    for (const colId of Object.keys(collections)) {
      await db.recursiveDelete(db.collection(`${DRILL_PREFIX}${colId}`));
    }
    console.log(problems.length ? 'DRILL FAILED — see differences above.' : 'DRILL PASSED — the backup is fully restorable.');
    if (problems.length) process.exit(1);
    return;
  }

  if (!args.flags.has('yes')) {
    console.log('\nDry run only. Re-run with --drill to test a restore safely, or --yes to restore for real.');
    return;
  }

  console.log('\nRestoring to the live database...');
  await writeAll(entries);
  console.log(`Restored ${entries.length} document(s).`);
}

main().catch((err) => {
  console.error('Restore failed:', err);
  process.exit(1);
});
