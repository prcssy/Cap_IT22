/**
 * compare-backup.cjs
 *
 * "Something is missing but I don't know what." Compares every export in
 * backups/ against the LIVE database and lists each item that exists in a
 * backup but is gone now — whole documents (a registration, a user) and
 * items inside list documents (a sport, team, venue, match, result,
 * schedule request). For each missing item it names the newest backup that
 * still has it, then prints the restore command for the affected data.
 *
 * Read-only: never writes to Firestore.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────
 *   node compare-backup.cjs                   # all backups vs live
 *   node compare-backup.cjs --only=venuesConfig,sportsTeamsConfig
 *
 * Needs serviceAccountKey.json in this folder (gitignored).
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Logs only ever grow and the email index is internal bookkeeping —
// neither is something a user "loses", so they'd only add noise.
const SKIP = new Set(['activityLogs', 'emailIndex']);

// A deleted sport also takes its schedules/results/rankings/requests.
const RELATED = {
  sportsTeamsConfig: ['matchSchedules', 'matchRecords', 'teamRankings', 'scheduleRequests'],
};

const FRIENDLY = {
  sportsTeamsConfig: 'Sports & teams',
  matchSchedules: 'Match schedules',
  matchRecords: 'Match results',
  teamRankings: 'Team rankings',
  scheduleRequests: 'Schedule requests',
  venuesConfig: 'Venues',
  registrations: 'Player registrations',
  users: 'User accounts (profiles)',
  admins: 'Admin roles',
  moderators: 'Moderator roles',
  superadmins: 'Super Admin roles',
  siteConfig: 'Website settings',
  siteCounters: 'Public counters',
};

function parseArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

/* Same tagged encoding as backup-firestore.cjs, so live data can be
   compared with what's in the files. */
function encode(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value?.toMillis === 'function' && 'seconds' in value) return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object' && typeof value.path === 'string' && value.firestore) return { __type: 'reference', path: value.path };
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  return value;
}

/* A human-readable name for a document or list item. */
function labelOf(x, fallback) {
  if (!x || typeof x !== 'object') return String(fallback ?? x);
  if (x.race && Array.isArray(x.participants)) return `${x.sport || 'Race'} race: ${x.participants.map((p) => p.name).join(', ')}`;
  if (x.teamA && x.teamB) {
    const a = typeof x.teamA === 'object' ? x.teamA.name : x.teamA;
    const b = typeof x.teamB === 'object' ? x.teamB.name : x.teamB;
    const sport = x.sport || x.sportName || '';
    const when = x.date ? ` on ${x.date}${x.time ? ` ${x.time}` : ''}` : '';
    return `${sport ? `${sport}: ` : ''}${a} vs ${b}${when}`;
  }
  return x.fullName || x.name || x.label || x.email || x.sportName || String(fallback ?? '(unnamed)');
}

/* Stable identity for an item inside a list field. */
function keyOf(item) {
  if (item && typeof item === 'object') return String(item.id ?? item.name ?? JSON.stringify(item));
  return JSON.stringify(item);
}

/* Items in `before` (backup) that are no longer in `after` (live), for one document. */
function missingInsideDoc(before, after) {
  const out = [];
  for (const [field, value] of Object.entries(before || {})) {
    const now = after?.[field];
    if (Array.isArray(value)) {
      const liveKeys = new Set((Array.isArray(now) ? now : []).map(keyOf));
      value.forEach((item) => {
        if (!liveKeys.has(keyOf(item))) out.push({ field, label: labelOf(item, keyOf(item)) });
      });
    } else if (field === 'points' && value && typeof value === 'object') {
      // teamRankings: points = { "<sport>::<division>": { team: rating } }
      Object.keys(value).forEach((scope) => {
        if (!now || !(scope in now)) out.push({ field, label: `rankings for ${scope.replace('::', ' / ')}` });
      });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const dir = path.join(__dirname, 'backups');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.manifest.json')).sort()
    : [];
  if (!files.length) {
    console.error('No backups found in backups/. Run "node backup-firestore.cjs" first.');
    process.exit(1);
  }

  initializeApp({ credential: cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
  const db = getFirestore();

  const backups = files.map((f) => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const collectionIds = [...new Set(backups.flatMap((b) => Object.keys(b.data.collections)))]
    .filter((id) => !SKIP.has(id) && (!only || only.has(id)));

  console.log(`Comparing ${files.length} backup(s) with the live database...\n`);

  // missing[collection][itemKey] = { label, newestFile }
  const missing = {};
  for (const colId of collectionIds) {
    const liveSnap = await db.collection(colId).get();
    const live = new Map(liveSnap.docs.map((d) => [d.id, encode(d.data())]));
    for (const { file, data } of backups) {
      const docs = data.collections[colId] || {};
      for (const [docId, entry] of Object.entries(docs)) {
        const found = [];
        if (!live.has(docId)) {
          found.push({ key: `doc:${docId}`, label: `${labelOf(entry.data, docId)} (whole record ${docId})` });
        } else {
          missingInsideDoc(entry.data, live.get(docId)).forEach((m) => {
            found.push({ key: `${docId}:${m.field}:${m.label}`, label: `${m.label}  [${docId}]` });
          });
        }
        found.forEach(({ key, label }) => {
          missing[colId] = missing[colId] || {};
          // Files are processed oldest → newest, so this ends on the newest.
          missing[colId][key] = { label, newestFile: file };
        });
      }
    }
  }

  const affected = Object.keys(missing);
  if (!affected.length) {
    console.log('Nothing is missing: everything in your backups is still in the live database.');
    return;
  }

  let total = 0;
  for (const colId of affected) {
    const items = Object.values(missing[colId]);
    total += items.length;
    console.log(`${FRIENDLY[colId] || colId} (${colId}): ${items.length} missing`);
    items.slice(0, 25).forEach((i) => console.log(`  - ${i.label}    (newest backup with it: ${i.newestFile})`));
    if (items.length > 25) console.log(`  ... and ${items.length - 25} more`);
    console.log('');
  }

  // One backup that still has everything that's missing: the oldest of the
  // per-item "newest backup" picks (every later file lacks at least one item).
  const newestFiles = affected.flatMap((c) => Object.values(missing[c]).map((i) => i.newestFile));
  const pick = newestFiles.sort()[0];
  const restoreCols = [...new Set(affected.flatMap((c) => [c, ...(RELATED[c] || [])]))].join(',');

  console.log(`${total} missing item(s) in total.`);
  console.log(`\nBackup that still has all of them: backups/${pick}`);
  console.log('Check what a restore would change (read-only):');
  console.log(`  node restore-firestore.cjs backups/${pick} --verify --only=${restoreCols}`);
  console.log('Restore only the affected data:');
  console.log(`  node restore-firestore.cjs backups/${pick} --yes --only=${restoreCols}`);
  console.log('\nNote: a restore puts those collections back exactly as they were at that backup,');
  console.log('so changes made to them after that time are undone too.');
}

main().catch((err) => {
  console.error('Compare failed:', err.message || err);
  process.exit(1);
});
