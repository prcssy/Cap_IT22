# Backup and Recovery

Firestore database: `projects/srccapstone/databases/(default)` (region `asia-east1`).

## Protection layers

| Layer | What it covers | Setting |
|---|---|---|
| **Managed daily backups** | Whole database, taken automatically by Google every day | Daily, kept **14 days** |
| **Point-in-time recovery (PITR)** | Read/restore the database as it was at any minute in the past 7 days (e.g. undo an accidental bulk delete) | Enabled, **7-day** window |
| **Delete protection** | Blocks deleting the whole database by mistake | Enabled |
| **On-demand JSON export** | Offline copy on a staff computer, with SHA-256 checksum | `node backup-firestore.cjs` |
| **Multi-zone replication** | Firestore stores every write in several zones, so a server/zone failure loses no data | Built into Firestore |
| **Transactions** | Match results, rankings and every list edit commit all-or-nothing, so a crash mid-save can't leave half-written data | `runTransaction` in the app and Cloud Functions |

## Routine

- **Automatic:** nothing to do. Check the schedule with
  `firebase firestore:backups:schedules:list --database "(default)"`, and see
  the backups taken with `firebase firestore:backups:list`.
- **Before a risky change** (a season reset, bulk import, factory reset): run
  `node backup-firestore.cjs` first. The file lands in `backups/` (gitignored,
  since it contains personal data; never commit or share it).

## Recovery procedures

### A. Undo a recent mistake (last 7 days): PITR
Restore the database as of a timestamp into a **new** database, check it, then copy back what was lost:
```
gcloud firestore databases clone --source-database="projects/srccapstone/databases/(default)" \
  --snapshot-time="2026-09-27T05:00:00Z" --destination-database="recovered"
```
(or Firebase Console → Firestore → Disaster recovery). `--snapshot-time` must be a whole
minute, no earlier than the "Earliest version time" shown on that page.

Then turn the clone into a normal backup file, so the scripts below can compare and restore it:
```
node backup-firestore.cjs --database=recovered --as-of=2026-09-27T13:00:00+08:00
node compare-backup.cjs                                  # what's in the clone but gone now
node restore-firestore.cjs backups/firestore-2026-09-27_13-00-00.json --verify --only=venuesConfig
```
`--as-of` is the clone's snapshot time: the file is named after it, so it sorts correctly
among the other backups. Delete the clone when you're done (it's billed like a database):
`gcloud firestore databases delete --database=recovered`.

**Restores overwrite whole documents, they don't merge.** Sports, venues, schedules, results
and rankings are one list document per school level, so restoring e.g. `sportsTeamsConfig`
brings back the deleted sport *and* undoes every other change to that level's list since the
backup. Run `node backup-firestore.cjs` first, restore with `--only=`, and for a single lost
item in a busy list consider re-adding it by hand from the values the compare output shows.

### B. Restore a daily managed backup
```
firebase firestore:backups:list
gcloud firestore databases restore --source-backup=<backup name> --destination-database="restored"
```
A restore always goes into a new database, so the live one is never overwritten blindly.

### Don't know what was deleted?
Compare every backup with the live database and list everything that's gone (whole documents
and items inside lists, such as a sport, team, venue or match), with the restore command:
```
node compare-backup.cjs
node compare-backup.cjs --only=venuesConfig,sportsTeamsConfig
```

### Don't know when it was deleted?
Search every backup for the item's name. It shows which backups still have it,
where it's missing from the live database, any matching delete entries in the
activity log, and prints the restore command for the newest backup that has it:
```
node find-in-backups.cjs "Gym"
node find-in-backups.cjs "Swimming" --only=sportsTeamsConfig
```

### C. Restore an on-demand JSON export
`latest` picks the newest file in `backups/`; a specific file such as
`backups/firestore-2026-09-27_05-20-03.json` works too.
```
node restore-firestore.cjs latest                  # dry run: checksum + contents
node restore-firestore.cjs latest --verify         # compare with live data
node restore-firestore.cjs latest --yes            # restore to original paths
node restore-firestore.cjs latest --yes --only=venuesConfig   # one collection
```

## Recovery test log

| Date | Test | Result |
|---|---|---|
| 2026-09-27 | `backup-firestore.cjs`: full export | 279 documents, 15 collections, SHA-256 `cb18a2c1…` |
| 2026-09-27 | `restore-firestore.cjs --drill`: restored the export into temporary `__restoreDrill_*` collections, read every document back, compared field by field, then removed them | **Passed**: 279/279 identical, 49.4 s |

Repeat the drill (`--drill`) once per season and add a row above.
