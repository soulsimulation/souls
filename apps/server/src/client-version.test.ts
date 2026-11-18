// #1936: the client each Soul runs, counted in memory and written per Soul, client and UTC day.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {migrate} from './migrations.ts';
import {EdgeClients, clientCounter} from './client-version.ts';

const rows = (db: DatabaseSync) => db.prepare('SELECT soul_id, client, day, first_at, last_at, n FROM edge_clients_v1 ORDER BY soul_id, client, day').all().map((r) => ({...r}));

test('A2: authenticated Soul requests are counted in memory; nothing is written until a flush', async () => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  const counts = new EdgeClients(db, 0), app = new Hono();
  app.use('*', clientCounter(counts, (c) => c.req.header('authorization') === 'Bearer sim_ada' ? 's_ada' : null));
  app.get('/v1/edge/here', (c) => c.json({ok: true}));
  for (let i = 0; i < 3; i++) assert.equal((await app.request('/v1/edge/here', {headers: {authorization: 'Bearer sim_ada', 'x-soul-client': '2.32.0'}})).status, 200);
  await app.request('/v1/edge/here', {headers: {'x-soul-client': '2.32.0'}});   // no Soul: not counted
  assert.deepEqual(rows(db), [], 'no request wrote');
  counts.flush();
  assert.deepEqual(rows(db).map((r) => [r.soul_id, r.client, r.n]), [['s_ada', '2.32.0', 3]]);
  db.close();
});

test('A3: a second flush adds to the row and keeps first_at; no header is none; a tool header is kept as given', () => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  const counts = new EdgeClients(db, 0), t0 = Date.UTC(2026, 10, 11, 23, 59), t1 = t0 + 30_000, t2 = Date.UTC(2026, 10, 12, 0, 1);
  counts.note('s_ada', '2.32.0', t0); counts.note('s_ada', undefined, t0); counts.note('s_bo', 'bench/1', t0);
  counts.flush();
  counts.note('s_ada', '2.32.0', t1); counts.note('s_ada', '2.32.0', t1);
  counts.note('s_ada', '2.32.0', t2);   // a new UTC day: its own row
  counts.close();
  assert.deepEqual(rows(db), [
    {soul_id: 's_ada', client: '2.32.0', day: '2026-11-11', first_at: t0, last_at: t1, n: 3},
    {soul_id: 's_ada', client: '2.32.0', day: '2026-11-12', first_at: t2, last_at: t2, n: 1},
    {soul_id: 's_ada', client: 'none', day: '2026-11-11', first_at: t0, last_at: t0, n: 1},
    {soul_id: 's_bo', client: 'bench/1', day: '2026-11-11', first_at: t0, last_at: t0, n: 1},
  ]);
  db.close();
});

test('#2014 A1: a value that is not a short version string is recorded as invalid, and the request is still served', async () => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  const counts = new EdgeClients(db, 0), app = new Hono();
  app.use('*', clientCounter(counts, () => 's_ada'));
  app.get('/v1/edge/here', (c) => c.json({ok: true}));
  for (const v of ['9'.repeat(33), '<script>', '2.32.0 extra', '.2.32.0', '2.32.0']) assert.equal((await app.request('/v1/edge/here', {headers: {'x-soul-client': v}})).status, 200, v);
  counts.flush();
  assert.deepEqual(rows(db).map((r) => [r.client, r.n]), [['2.32.0', 1], ['invalid', 4]]);
  db.close();
});

test('#2014 A2: 1,000 distinct junk values from one Soul in one day add at most one row', () => {
  const db = new DatabaseSync(':memory:'); migrate(db);
  const counts = new EdgeClients(db, 0), t0 = Date.UTC(2026, 10, 11, 12);
  for (let i = 0; i < 1000; i++) {
    counts.note('s_ada', i % 2 ? `${i}`.padEnd(40 + i, 'x') : `junk value ${i} <>`, t0 + i);
    if (i % 100 === 99) counts.flush();   // across flushes too
  }
  counts.close();
  assert.deepEqual(rows(db).map((r) => [r.soul_id, r.client, r.day, r.n]), [['s_ada', 'invalid', '2026-11-11', 1000]]);
  db.close();
});
