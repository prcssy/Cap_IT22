/**
 * fix-waiver-downloads.js
 *
 * One-off backfill for registrations submitted BEFORE waiver uploads
 * started forcing a real download (see forceDownloadMetadata in
 * src/shared/services/firestoreService.js). Those older files are still
 * sitting in Firebase Storage without Content-Disposition/Content-Type
 * metadata, so clicking their waiver link in Admin just opens/renders
 * the raw bytes instead of downloading as the actual .pdf/.doc/.docx.
 *
 * This script does NOT re-upload anything — it patches the existing
 * Storage object's metadata in place, using each registration's saved
 * `waiverFileName` to know whether it was a PDF or a Word file.
 *
 * Registrations saved before `waiverFileName` itself existed (i.e. even
 * older than that) have no way to know the original file type from
 * Firestore alone, so those are skipped and listed separately — you'd
 * need to open each one manually to tell.
 *
 * Only touches Storage object metadata. Does NOT touch Firestore,
 * `users`, or the staff allowlist collections, and does NOT touch photo
 * uploads (those must stay inline-viewable).
 *
 * ─── SETUP (one-time) ────────────────────────────────────────────
 * 1. npm install firebase-admin
 * 2. Get a service account key:
 *      Firebase Console → Project Settings → Service Accounts
 *      → "Generate new private key" → save as serviceAccountKey.json
 *      IN THE SAME FOLDER AS THIS SCRIPT. Do NOT commit it to git.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *   node fix-waiver-downloads.cjs            # dry run, shows what would happen
 *   node fix-waiver-downloads.cjs --yes      # actually patches Storage metadata
 */

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const DRY_RUN = !process.argv.includes('--yes');

const serviceAccount = require(path.join(__dirname, 'serviceAccountKey.json'));

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const storage = getStorage();

const CONTENT_TYPE_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function metadataForFileName(fileName) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXT[ext];
  if (!contentType) return null;
  return {
    contentType,
    contentDisposition: `attachment; filename="${fileName}"`,
  };
}

// Firebase download URLs look like:
//   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<url-encoded-path>?alt=media&token=...
// Parsed per-URL (rather than assuming one hardcoded bucket) so this
// still works correctly if the project ever uses more than one bucket.
function parseStorageUrl(url) {
  try {
    const u = new URL(url);
    const marker = '/o/';
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    const bucket = u.pathname.slice('/v0/b/'.length, u.pathname.indexOf('/o/'));
    const objectPath = decodeURIComponent(u.pathname.slice(idx + marker.length));
    if (!bucket || !objectPath) return null;
    return { bucket, objectPath };
  } catch {
    return null;
  }
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — no Storage metadata will change (pass --yes to actually apply)\n' : '⚠️  LIVE RUN — this will modify Storage object metadata\n');

  const snapshot = await db.collection('registrations').get();

  let patched = 0;
  let skippedNoWaiver = 0;
  let skippedUnknownType = 0;
  let failed = 0;

  for (const docSnap of snapshot.docs) {
    const reg = docSnap.data();
    if (!reg.waiverURL) { skippedNoWaiver++; continue; }

    const meta = metadataForFileName(reg.waiverFileName);
    if (!meta) {
      skippedUnknownType++;
      console.log(`⚠️  ${docSnap.id} (${reg.fullName || 'unknown name'}) — no usable waiverFileName, can't tell PDF vs Word. Skipped.`);
      continue;
    }

    const parsed = parseStorageUrl(reg.waiverURL);
    if (!parsed) {
      failed++;
      console.log(`❌ ${docSnap.id} — couldn't parse waiverURL, skipped.`);
      continue;
    }

    console.log(`${docSnap.id}  ->  ${reg.waiverFileName}  (${meta.contentType})`);
    if (!DRY_RUN) {
      try {
        await storage.bucket(parsed.bucket).file(parsed.objectPath).setMetadata(meta);
        patched++;
      } catch (err) {
        failed++;
        console.log(`❌ ${docSnap.id} — setMetadata failed: ${err.message}`);
      }
    } else {
      patched++;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would patch' : 'Patched'}: ${patched}`);
  console.log(`Skipped (no waiver attached): ${skippedNoWaiver}`);
  console.log(`Skipped (unknown file type — no waiverFileName saved): ${skippedUnknownType}`);
  console.log(`Failed: ${failed}`);
  console.log(DRY_RUN ? '\nNothing was changed. Re-run with --yes to apply.' : '\n✅ Done.');
}

main().catch((err) => {
  console.error('❌ Backfill failed:', err.message);
  process.exit(1);
});
