// #2542 A2: the in-process hourly backup files (world-main.ts): the newest 2 are kept (no dailies), and the #2303 rule that
// skips a backup when nothing has written since the newest one still holds.
import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { newestBackupCoversDb, pruneBackupFiles } from './world-main.ts';

test('#2542 A2: pruneBackups keeps the newest 2 and no daily; the skip-when-unchanged rule still works', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'world-backups-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // a week of hourly files, including the 00:00 UTC ones the old rule kept as dailies, plus files the rule must not touch
  const hours = Array.from({ length: 24 * 7 }, (_, i) => new Date(Date.UTC(2026, 10, 9) + i * 3600_000).toISOString().slice(0, 13).replace(/[-T:]/g, ''));
  for (const h of hours) writeFileSync(join(dir, `backup-${h}.db`), '');
  for (const f of ['sim.db', 'sim.db-wal', 'backup-last.json', 'backup-2026111600.db.tmp']) writeFileSync(join(dir, f), '');
  const isBackup = (f: string) => /^backup-\d{10}\.db$/.test(f);
  pruneBackupFiles(dir);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left.filter(isBackup), [`backup-${hours.at(-2)}.db`, `backup-${hours.at(-1)}.db`], 'the newest 2, no 00:00 daily');
  assert.deepEqual(left.filter((f) => !isBackup(f)), ['backup-2026111600.db.tmp', 'backup-last.json', 'sim.db', 'sim.db-wal'], 'nothing else is touched');
  pruneBackupFiles(dir); assert.equal(readdirSync(dir).length, left.length, 'idempotent');

  // the skip rule: the newest backup is as new as the database and its log -> skipped; a later write to either -> backed up
  const at = (f: string, s: number) => utimesSync(join(dir, f), s, s);
  const older = `backup-${hours.at(-2)}.db`, newest = `backup-${hours.at(-1)}.db`;
  at('sim.db', 1000); at('sim.db-wal', 1000); at(older, 900); at(newest, 1000);
  assert.equal(newestBackupCoversDb(dir), true, 'unchanged since the newest backup: skipped');
  at('sim.db-wal', 1001); assert.equal(newestBackupCoversDb(dir), false, 'the log written after it: backed up');
  at('sim.db-wal', 1000); at('sim.db', 1001); assert.equal(newestBackupCoversDb(dir), false, 'the database written after it: backed up');
  at('sim.db', 1000); at(newest, 950); at(older, 2000); assert.equal(newestBackupCoversDb(dir), false, 'the newest by name decides');
  for (const f of [older, newest]) rmSync(join(dir, f));
  assert.equal(newestBackupCoversDb(dir), false, 'no backup yet: backed up');
});
