// #2542: the hourly off-site run (deploy/backup-restic.mjs backup-hourly) against a real local restic repository, with a local
// directory as the fake off-site repository (never a real bucket). Skips when restic is not installed, like backup-restic.test.mjs.
//  A1 an unchanged database is skipped; a changed one is copied, quick-checked and the snapshot tagged hourly (and sent off-site)
//  A3 20 small worlds, 2 of them changed: the hourly run copies 2 and takes under 60 s
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'deploy/backup-restic.mjs');
const hasRestic = spawnSync('restic', ['version']).status === 0;

function fixture(t) {
  const T = mkdtempSync(join(tmpdir(), 'backup-hourly-'));
  t.after(() => rmSync(T, { recursive: true, force: true }));
  const env = {
    ...process.env, TZ: 'UTC', RESTIC_REPOSITORY: join(T, 'repo'), RESTIC_PASSWORD_FILE: join(T, 'pass'), RESTIC_CACHE_DIR: join(T, 'cache'),
    SIM_BACKUP_DATA_ROOT: join(T, 'data'), SIM_BACKUP_STAGING: join(T, 'staging'), SIM_BACKUP_OFFSITE: join(T, 'offsite'), SIM_BACKUP_DATED_ROOT: join(T, 'dated'),
    SIM_BACKUP_HOST_FILES: '',
  };
  writeFileSync(env.RESTIC_PASSWORD_FILE, 'test-only-password\n', { mode: 0o600 });
  const restic = (args, extra = {}) => spawnSync('restic', args, { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(restic(['init']).status, 0);
  return {
    T, env, restic,
    run: (args, extra = {}) => spawnSync(process.execPath, ['--no-warnings', SCRIPT, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }),
    snaps: (tag, extra) => JSON.parse(restic(['snapshots', '--json', '--tag', tag], extra).stdout || '[]'),
    world: (slug) => join(T, 'data/production/worlds', slug, 'sim.db'),
    mirror: (slug) => join(T, 'staging/production/worlds', slug, 'sim.db'),
  };
}
/** A world's database, left open as a live world holds it (WAL mode, a writer present). */
function makeDb(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO events (payload) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`event ${i} ${'x'.repeat(2000)}`);
  return db;
}
/** The fixture's writes, dated 10 s back: a copy's time is 2 s before it began, so a database written in the 2 s before its
 *  copy is copied again next hour (by design); the fixture's setup writes are not the changes under test. */
const settle = (files, ms = Date.now() - 10_000) => { for (const f of files) for (const x of [f, `${f}-wal`]) utimesSync(x, ms / 1000, ms / 1000); };
const write = (db, n = 3) => { const ins = db.prepare('INSERT INTO events (payload) VALUES (?)'); for (let i = 0; i < n; i++) ins.run(`hour ${i}`); };
const count = (file) => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare('SELECT count(*) AS n FROM events').get().n; } finally { d.close(); } };

test('#2542 A1: an unchanged database is skipped; a changed one is copied, checked and tagged hourly, and sent off-site', { skip: !hasRestic && 'restic not installed', timeout: 120_000 }, (t) => {
  const f = fixture(t);
  const a = makeDb(f.world('alpha'), 100), b = makeDb(f.world('beta'), 40);
  t.after(() => { a.close(); b.close(); });
  writeFileSync(join(f.T, 'data/production/worlds.json'), '[{"slug":"alpha"},{"slug":"beta"}]\n');
  settle([f.world('alpha'), f.world('beta')]);
  let r = f.run(['backup', 'production'], { SIM_BACKUP_TIME: '2026-01-01 03:30:00' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /2\/2 databases ok \(quick_check\)/);

  // nothing written since the nightly copy: both skipped, and the snapshot is still a complete stage
  const betaCopy = statSync(f.mirror('beta')).mtimeMs;
  r = f.run(['backup-hourly', 'production'], { SIM_BACKUP_TIME: '2026-01-01 04:15:00' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^backup-hourly production: snapshot \w{8}, 0\/0 changed databases ok \(quick_check\), 2 unchanged skipped.*1 hourly snapshots kept; offsite (initialised \+ )?copied$/m);

  // alpha written: alpha copied and checked, beta skipped (its mirror copy untouched)
  write(a);
  r = f.run(['backup-hourly', 'production'], { SIM_BACKUP_TIME: '2026-01-01 05:15:00' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1\/1 changed databases ok \(quick_check\), 1 unchanged skipped.*2 hourly snapshots kept; offsite copied$/m);
  assert.equal(statSync(f.mirror('beta')).mtimeMs, betaCopy, 'beta was not copied again');
  assert.equal(count(f.mirror('alpha')), 103);
  const last = JSON.parse(readFileSync(join(f.T, 'data/production/backup-hourly-last.json'), 'utf8'));
  assert.deepEqual([last.ok, last.dbsOk, last.dbsSkipped, last.dbs, last.offsite], [true, 1, 1, 2, true]);
  assert.equal(JSON.parse(readFileSync(join(f.T, 'data/production/backup-last.json'), 'utf8')).dbsSkipped, undefined, 'the nightly record is its own');
  const hourly = f.snaps('production,hourly');
  assert.equal(hourly.length, 2); assert.deepEqual(hourly.at(-1).tags.sort(), ['hourly', 'production']);
  assert.equal(f.snaps('production,hourly', { RESTIC_REPOSITORY: f.env.SIM_BACKUP_OFFSITE }).length, 2, 'both hourly snapshots off-site');

  // the copy's time is 2 s before it began: a write in those 2 s is copied again next hour; date alpha's to its copy's,
  // so this step sees only the next write
  const alphaCopy = statSync(f.mirror('alpha')).mtimeMs;
  settle([f.world('alpha')], alphaCopy);
  // a write to the log only (a WAL append, the main file untouched) counts as a change
  const before = statSync(f.world('beta')).mtimeMs; write(b, 1);
  assert.equal(statSync(f.world('beta')).mtimeMs, before, '(the write went to the log)');
  r = f.run(['backup-hourly', 'production'], { SIM_BACKUP_TIME: '2026-01-01 06:15:00' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1\/1 changed databases ok \(quick_check\), 1 unchanged skipped/);

  // restore from the latest hourly snapshot (off-site): every database, each at its newest copy
  r = f.run(['restore', 'production', 'latest', join(f.T, 'r1')], { RESTIC_REPOSITORY: f.env.SIM_BACKUP_OFFSITE });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /2\/2 databases ok/);
  assert.equal(count(join(f.T, 'r1/worlds/alpha/sim.db')), 103); assert.equal(count(join(f.T, 'r1/worlds/beta/sim.db')), 41);

  // retention (the nightly run): hourly snapshots keep their own rule; the nightly rule never removes an hourly one
  for (const h of ['07', '08', '09']) { write(a, 1); assert.equal(f.run(['backup-hourly', 'production'], { SIM_BACKUP_TIME: `2026-01-01 ${h}:15:00` }).status, 0); }
  r = f.run(['backup', 'production'], { SIM_BACKUP_TIME: '2026-01-02 03:30:00', SIM_BACKUP_KEEP_HOURLY: '--keep-hourly 4' });
  assert.equal(r.status, 0, r.stderr);
  const kept = (repo) => f.snaps('production', repo ? { RESTIC_REPOSITORY: repo } : {}).map((s) => `${s.tags.includes('hourly') ? 'h' : 'n'} ${s.time.slice(0, 13)}`).sort();
  const want = ['h 2026-01-01T06', 'h 2026-01-01T07', 'h 2026-01-01T08', 'h 2026-01-01T09', 'n 2026-01-01T03', 'n 2026-01-02T03'];
  assert.deepEqual(kept(), want, 'the newest 4 hourly and both nightly snapshots');
  assert.deepEqual(kept(f.env.SIM_BACKUP_OFFSITE), want, 'the same off-site');

  // never a fallback: without a repository the hourly run fails loudly and writes nothing
  r = f.run(['backup-hourly', 'production'], { RESTIC_REPOSITORY: join(f.T, 'no-repo') });
  assert.equal(r.status, 1); assert.match(r.stderr, /restic not set up \(no repository at .*\); the hourly run has no fallback/);
  assert.equal(JSON.parse(readFileSync(join(f.T, 'data/production/backup-hourly-last.json'), 'utf8')).ok, false);
});

test('#2542 A3: 20 small worlds, 2 changed: the hourly run copies 2 and takes under 60 s', { skip: !hasRestic && 'restic not installed', timeout: 300_000 }, (t) => {
  const f = fixture(t);
  const slugs = Array.from({ length: 20 }, (_, i) => `w${String(i).padStart(2, '0')}`);
  const dbs = slugs.map((s) => makeDb(f.world(s), 1000));   // a few MB each, with its log
  t.after(() => { for (const d of dbs) d.close(); });
  settle(slugs.map((s) => f.world(s)));
  let r = f.run(['backup', 'production'], { SIM_BACKUP_TIME: '2026-01-01 03:30:00' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /20\/20 databases ok/);
  write(dbs[3]); write(dbs[17]);
  const t0 = performance.now();
  r = f.run(['backup-hourly', 'production'], { SIM_BACKUP_TIME: '2026-01-01 04:15:00' });
  const seconds = (performance.now() - t0) / 1000;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2\/2 changed databases ok \(quick_check\), 18 unchanged skipped.*offsite (initialised \+ )?copied$/m);
  assert.ok(seconds < 60, `under 60 s (${seconds.toFixed(1)} s)`);
  t.diagnostic(`A3: 20 worlds (${((statSync(f.world('w00')).size + statSync(`${f.world('w00')}-wal`).size) / 2 ** 20).toFixed(1)} MB each), 2 changed: hourly run ${seconds.toFixed(2)} s, off-site included; ${r.stdout.trim()}`);
});
