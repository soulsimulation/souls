import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transition, latest, prepareBackup, record } from './state.mjs';

const scratch = new URL('../../../../.local/', import.meta.url);
mkdirSync(scratch, { recursive: true });
function fixture(t) {
  const dir = mkdtempSync(new URL('o19c-state-', scratch));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const routesFile = join(dir, 'routes.json'), log = join(dir, 'transaction', 'log.jsonl');
  const other = { gateway: 'http://127.0.0.1:7313', stream: '/s/other/', canonical: true };
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: 'http://127.0.0.1:7312', stream: '/s/eden/', canonical: false }, other } }));
  const read = () => JSON.parse(readFileSync(routesFile, 'utf8')).worlds;
  const seen = [], opts = { dir: join(dir, 'transaction'), routesFile, slug: 'eden', world: 'synthetic-world',
    validate: () => seen.push('validate'), prepare: () => seen.push('prepare'), news: () => seen.push('news'),
    switchRoute: () => { assert.equal(read().eden.canonical, true); seen.push('route-new'); },
    backRoute: () => { assert.equal(read().eden.canonical, true); seen.push('route-old'); } };
  return { dir, opts, read, other, seen, last: () => latest(log) };
}

test('switch fences before routing; back restores routing before unfencing; repeats preserve unrelated worlds', async t => {
  const f = fixture(t);
  await transition({ ...f.opts, command: 'switch' });
  assert.deepEqual(f.seen, ['validate', 'prepare', 'news', 'route-new']);
  assert.equal(f.read().eden.canonical, true);
  assert.deepEqual(await transition({ ...f.opts, command: 'switch' }), { step: 'switched', repeated: true });
  await transition({ ...f.opts, command: 'back' });
  assert.equal(f.read().eden.canonical, false);
  assert.equal(f.last().step, 'back');
  assert.deepEqual(await transition({ ...f.opts, command: 'back' }), { step: 'back', repeated: true });
  assert.deepEqual(f.read().other, f.other);
});

test('validation failure changes no activation or journal', async t => {
  const f = fixture(t), bytes = readFileSync(f.opts.routesFile);
  await assert.rejects(transition({ ...f.opts, command: 'switch', validate: () => { throw Error('unprepared'); } }), /unprepared/);
  assert.deepEqual(readFileSync(f.opts.routesFile), bytes);
  assert.equal(f.last(), null);
});

test('failed switch remains fenced and retries safely; failed back stays fenced until route confirmation', async t => {
  const f = fixture(t);
  await assert.rejects(transition({ ...f.opts, command: 'switch', switchRoute: () => { throw Error('reload'); } }), /old writes remain fenced/);
  assert.equal(f.read().eden.canonical, true);
  assert.equal(f.last().step, 'switch-failed');
  await transition({ ...f.opts, command: 'switch' });
  await assert.rejects(transition({ ...f.opts, command: 'back', backRoute: () => { throw Error('reload'); } }), /old writes remain fenced/);
  assert.equal(f.read().eden.canonical, true);
  assert.equal(f.last().step, 'back-failed');
  await assert.rejects(transition({ ...f.opts, command: 'switch' }), /rollback-incomplete/);
  await transition({ ...f.opts, command: 'back' });
  assert.equal(f.read().eden.canonical, false);
  assert.deepEqual(f.read().other, f.other);
});

test('an existing writer lock refuses without stealing it', async t => {
  const f = fixture(t), lock = join(f.opts.dir, 'transaction.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner'), 'synthetic');
  await assert.rejects(transition({ ...f.opts, command: 'switch' }), /cutover.busy/);
  assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'synthetic');
  assert.equal(f.read().eden.canonical, false);
});

test('first-journal stale backup refuses without activation or replacement; matching backup and recorded retry retain bytes', async t => {
  const f = fixture(t), current = join(f.dir, 'proxy'), backup = join(f.dir, 'backup'), log = join(f.opts.dir, 'log.jsonl');
  writeFileSync(current, 'current old proxy'); writeFileSync(backup, 'unrelated stale backup');
  const prepare = () => prepareBackup({ current, backup, log });
  await assert.rejects(transition({ ...f.opts, command: 'switch', prepare }), /cutover.backup-conflict/);
  assert.equal(f.read().eden.canonical, false); assert.equal(f.last(), null);
  assert.equal(readFileSync(backup, 'utf8'), 'unrelated stale backup');
  writeFileSync(current, 'unrelated stale backup'); // An already matching old proxy can use its existing backup.
  prepare(); assert.equal(readFileSync(backup, 'utf8'), 'unrelated stale backup');
  record(log, { step: 'switch-failed', slug: f.opts.slug, world: f.opts.world });
  writeFileSync(current, 'partially switched proxy');
  await transition({ ...f.opts, command: 'switch', prepare });
  assert.equal(f.read().eden.canonical, true);
  assert.equal(readFileSync(backup, 'utf8'), 'unrelated stale backup', 'recorded retry never overwrites the first backup');
  await transition({ ...f.opts, command: 'back' });
  await assert.rejects(transition({ ...f.opts, command: 'switch', prepare }), /cutover.backup-conflict/);
  assert.equal(f.read().eden.canonical, false, 'a completed back has no partial switch whose backup may differ');
  assert.equal(f.last().step, 'back');
  assert.equal(readFileSync(backup, 'utf8'), 'unrelated stale backup');
});
