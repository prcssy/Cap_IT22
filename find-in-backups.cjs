/**
 * find-in-backups.cjs
 *
 * "Something was deleted but I don't know when." Searches every export in
 * backups/ for a name (a venue, sport, team, student…), shows which backups
 * still contain it, whether it's missing from the live database now, and
 * when the activity log says it was deleted. Then prints the exact restore
 * command using the NEWEST backup that still has it — the one that loses
 * the least other data.
 *
 * Read-only: never writes to Firestore.
 *
 * ─── USAGE ─────────────────────────────────────────────────────────
 *   node find-in-backups.cjs "Gym"
 *   node find-in-backups.cjs "Swimming" --only=sportsTeamsConfig
 *
 * --only narrows the search to some collections (faster, and avoids matches
 * inside unrelated data such as activity logs).
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = { term: null };
  for (const raw of process.argv.slice(2)) {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
    else if (!raw.startsWith('--')) args.term = raw;
  }
  return args;
}

/* Every collection a deleted item typically lives in, with the related
   collections a restore should include (a deleted sport also took its
   schedules/results/rankings/requests with it). */
const RELATED = {
  sportsTeamsConfig: 'sportsTeamsConfig,matchSchedules,matchRecords,teamRankings,scheduleRequests',
};

function collectionsContaining(backup, term, only) {
  const needle = term.toLowerCase();
  return Object.entries(backup.collections)
    .filter(([id]) => (only ? only.has(id) : id !== 'activityLogs'))
    .filter(([, docs]) => JSON.stringify(docs).toLowerCase().includes(needle))
    .map(([id]) => id);
}

async function liveCollectionsContaining(term, collectionIds) {
  const keyPath = path.join(__dirname, 'serviceAccountKey.json');
  if (!fs.existsSync(keyPath)) return { found: null, logs: [] };
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ credential: cert(require(keyPath)) });
  const db = getFirestore();
  const needle = term.toLowerCase();

  const found = [];
  for (const id of collectionIds) {
    const snap = await db.collection(id).get();
    if (snap.docs.some((d) => JSON.stringify(d.data()).toLowerCase().includes(needle))) found.push(id);
  }

  // When was it deleted? The app logs every delete/rename with a timestamp.
  const logsSnap = await db.collection('activityLogs').get();
  const logs = logsSnap.docs
    .map((d) => d.data())
    .filter((l) => `${l.details || ''} ${l.targetLabel || ''}`.toLowerCase().includes(needle))
    .filter((l) => /delet|remov|renam/i.test(`${l.type} ${l.details}`))
    .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0))
    .slice(0, 5);
  return { found, logs };
}

async function main() {
  const args = parseArgs();
  if (!args.term) {
    console.error('Usage: node find-in-backups.cjs "<name to look for>" [--only=collection1,collection2]');
    process.exit(1);
  }
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const dir = path.join(__dirname, 'backups');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.manifest.json')).sort()
    : [];
  if (!files.length) {
    console.error('No backups found in backups/. Run "node backup-firestore.cjs" first.');
    process.exit(1);
  }

  console.log(`Searching ${files.length} backup(s) for "${args.term}"...\n`);
  const hits = [];
  const allCollections = new Set();
  for (const f of files) {
    const backup = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const cols = collectionsContaining(backup, args.term, only);
    cols.forEach((c) => allCollections.add(c));
    const when = new Date(backup.createdAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'medium' });
    console.log(`  ${cols.length ? 'FOUND  ' : 'missing'}  backups/${f}   (taken ${when})${cols.length ? `  in: ${cols.join(', ')}` : ''}`);
    if (cols.length) hits.push({ file: f, cols });
  }

  const { found: liveFound, logs } = await liveCollectionsContaining(args.term, [...allCollections]);
  if (liveFound) {
    console.log(`\nLive database now: ${liveFound.length ? `still has "${args.term}" in ${liveFound.join(', ')}` : `"${args.term}" is NOT there (deleted)`}`);
  }
  if (logs.length) {
    console.log('\nActivity log (most recent first):');
    logs.forEach((l) => {
      const when = l.timestamp?.toDate?.().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'medium' }) || '?';
      console.log(`  ${when}  ${l.type}: ${l.details}  (by ${l.actorEmail || l.actorName || 'unknown'})`);
    });
  }

  if (!hits.length) {
    console.log(`\n"${args.term}" is not in any backup, so it can't be restored from these files.`);
    console.log('Point-in-time recovery (Google Cloud Console > Firestore > Disaster Recovery) can still rewind up to 7 days.');
    return;
  }

  // Only collections where the name is in a backup but GONE from live data
  // need restoring. (A name like "Gym" can also appear as a match venue or
  // on the landing page — those places weren't deleted, so leave them.)
  const missing = liveFound ? [...allCollections].filter((c) => !liveFound.includes(c)) : [...allCollections];
  if (!missing.length) {
    console.log(`\nNothing to restore: "${args.term}" is still in the live database everywhere it appears in the backups.`);
    return;
  }
  console.log(`\nDeleted from: ${missing.join(', ')}`);

  // Newest backup that still has it in EVERY collection it's missing from.
  const best = [...hits].reverse().find((h) => missing.every((c) => h.cols.includes(c)));
  if (!best) {
    console.log('No single backup has it in all of those places; restore each collection from the newest backup that has it.');
    return;
  }
  const restoreCols = [...new Set(missing.flatMap((c) => (RELATED[c] || c).split(',')))].join(',');
  console.log(`\nNewest backup that still has "${args.term}": backups/${best.file}`);
  console.log('Restore it (only the affected data) with:');
  console.log(`  node restore-firestore.cjs backups/${best.file} --yes --only=${restoreCols}`);
  console.log('\nCheck first without changing anything:');
  console.log(`  node restore-firestore.cjs backups/${best.file} --verify --only=${restoreCols}`);
}

main().catch((err) => {
  console.error('Search failed:', err.message || err);
  process.exit(1);
});
