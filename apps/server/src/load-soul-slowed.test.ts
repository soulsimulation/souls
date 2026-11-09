// #456: the public Soul's `slowed`, from refusals addressed to that Soul's token; absent otherwise, and gone when it ends.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {Admission, admissionMiddleware} from './load/admission.ts';
import {SoulSlowed} from './load/soul-slowed.ts';
import type {Level} from './load/shared.ts';

const tick = () => new Promise(r => setTimeout(r, 2));

test('A1: a slow-down sets reason and until; it is gone at until; a Soul never refused has nothing', () => {
  let now = 1_000_000; const s = new SoulSlowed(() => now), changed: string[] = [];
  s.onChange = id => changed.push(id);
  assert.equal(s.get('s_ada'), null);
  s.note('s_ada', 'soul.slow-down', 60);
  assert.deepEqual(s.get('s_ada'), {reason: 'soul.slow-down', until: now + 60_000});
  assert.equal(s.get('s_bo'), null, 'only the Soul the refusal was addressed to');
  now += 60_000;
  assert.equal(s.get('s_ada'), null, 'cleared when it ends');
  assert.deepEqual(changed, ['s_ada']);
});

test('A4: a Soul refused again and again re-sends its card only when the reason changes or the wait grows by 5 s or more', () => {
  let now = 1_000_000; const s = new SoulSlowed(() => now), changed: string[] = [];
  s.onChange = id => changed.push(id);
  s.note('s_ada', 'world.busy', 2);
  for (let i = 0; i < 20; i++) { now += 500; s.note('s_ada', 'world.busy', 2); }
  assert.equal(changed.length, 1, 'a polite retry loop makes no events');
  assert.equal(s.get('s_ada')!.until, now + 2_000, 'but the end moves with the last refusal');
  s.note('s_ada', 'soul.slow-down', 60);
  assert.equal(changed.length, 2);
});

test('A1: the middleware reports refusals addressed to a Soul token (slow-down, busy world), never soul.busy or the god', async () => {
  let level: Level = 'green';
  const adm = new Admission(), app = new Hono(), seen: [string, string, number][] = [];
  app.use('*', admissionMiddleware(adm, () => level, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, ''), undefined, undefined, (t, code, s) => seen.push([t, code, s])));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  app.get('/v1/edge/here', async c => { await gate; return c.json({here: 1}); });
  const auth = {headers: {authorization: 'Bearer sim_a_1'}};
  const first = app.request('/v1/edge/here', auth); await tick();
  assert.equal((await app.request('/v1/edge/here', auth)).status, 429, 'soul.busy');
  assert.deepEqual(seen, [], 'soul.busy is the agent overlapping itself, not the world slowing it');
  release(); await first;
  level = 'black'; adm.setLoadLevel('black');
  assert.equal((await app.request('/v1/edge/here', auth)).status, 503);
  assert.deepEqual(seen.map(([t, c]) => [t, c]), [['sim_a_1', 'world.busy']]); assert.ok(seen[0][2] >= 1, 'with the Retry-After it was given');
  adm.close();
});

test('A1/A4: the public Soul carries `slowed` only while it lasts; a Soul not slowed has no such key at all', async () => {
  const {mkdtempSync} = await import('node:fs'), {tmpdir} = await import('node:os'), {join} = await import('node:path');
  const {fixture, invite, accept, factory} = await import('../test/native-owner-fixture.ts');
  const f = fixture(join(mkdtempSync(join(tmpdir(), 'soul-slowed-')), 'sim.db'), factory); f.brain.quiesce();
  await invite(f, 'a'); const row = await accept(f.host, f.souls.create('dev:a', {name: 'Slow Ada', description: 'scripted slowed test'}));
  const card = () => f.host.publicSoul(f.host.minds.get(row.id)!);
  assert.ok(f.host.publicSlowedOf, 'buildApp wires the store');
  assert.equal('slowed' in card(), false, 'no new bytes for a Soul that is not slowed');
  const s = new SoulSlowed(); f.host.publicSlowedOf = id => s.get(id);
  s.note(row.id, 'world.busy', 2);
  assert.equal(card().slowed?.reason, 'world.busy');
  assert.ok(card().slowed!.until > Date.now());
});
