// #456: the public Soul's `slowed`, from the admission's refusals addressed to that Soul; absent otherwise, gone when it ends.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from 'hono';
import {Admission, admissionMiddleware, admissionPort, classify, type PortDone} from './load/admission.ts';
import {SoulSlowed, slowedFromRefusals} from './load/soul-slowed.ts';
import type {Level} from './load/shared.ts';
import {fixture, invite, accept, factory} from '../test/native-owner-fixture.ts';

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

test('A2/A4: a Soul refused again and again: the page\'s until never lapses while it is refused, and at most one event a second', () => {
  let now = 1_000_000; const s = new SoulSlowed(() => now), sent: number[] = [];
  s.onChange = id => sent.push(s.get(id)!.until);
  const t0 = now;
  s.note('s_ada', 'world.busy', 2);
  for (let i = 0; i < 120; i++) {   // every 500 ms for 60 s, each refusal saying 2 s
    now += 500; s.note('s_ada', 'world.busy', 2);
    assert.ok(sent.at(-1)! > now, `the page's until (${sent.at(-1)! - t0}) is still ahead at ${now - t0}`);
  }
  assert.ok(sent.length <= 61, `${sent.length} events in 60 s`);
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] > sent[i - 1]);
});

test('A4: reasons flipping on every request send no more than one event a second; a longer wait is sent at once', () => {
  let now = 1_000_000; const s = new SoulSlowed(() => now), changed: string[] = [];
  s.onChange = id => changed.push(s.get(id)!.reason);
  s.note('s_ada', 'world.busy', 2);
  for (let i = 0; i < 40; i++) { now += 100; s.note('s_ada', i % 2 ? 'world.busy' : 'world.crowded', 2); }
  assert.ok(changed.length <= 5, `${changed.length} events in 4 s`);
  s.note('s_ada', 'soul.slow-down', 60);
  assert.equal(changed.at(-1), 'soul.slow-down', 'the 60 s cool-down is not held back');
  now += 100; s.note('s_ada', 'world.busy', 2);
  assert.equal(s.get('s_ada')!.reason, 'soul.slow-down', 'a shorter refusal inside a longer one changes nothing');
});

test('A1: the middleware reports a Soul\'s world.busy and world.crowded, never soul.busy (the god: below)', async () => {
  let level: Level = 'green';
  const adm = new Admission(), app = new Hono(), seen: [string, string, number][] = [];
  adm.onRefused = (t, code, s) => { seen.push([t, code, s]); };
  app.use('*', admissionMiddleware(adm, () => level, c => c.req.header('authorization')?.replace(/^Bearer\s+/i, ''), undefined, t => t === 'sim_crowd' ? {position: 3, eta_s: 40} : null));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  app.get('/v1/edge/here', async c => { await gate; return c.json({here: 1}); });
  app.post('/v1/edge/act', c => c.json({}));
  const auth = (t: string) => ({headers: {authorization: `Bearer ${t}`}});
  const first = app.request('/v1/edge/here', auth('sim_a_1')); await tick();
  assert.equal((await app.request('/v1/edge/here', auth('sim_a_1'))).status, 429, 'soul.busy');
  assert.equal(seen.length, 0, 'soul.busy is the agent overlapping itself, not the world slowing it');
  release(); await first;
  assert.equal((await app.request('/v1/edge/act', {method: 'POST', ...auth('sim_crowd')})).status, 503);
  level = 'black'; adm.setLoadLevel('black');
  assert.equal((await app.request('/v1/edge/here', auth('sim_a_1'))).status, 503);
  assert.deepEqual(seen.map(([t, c]) => [t, c]), [['sim_crowd', 'world.crowded'], ['sim_a_1', 'world.busy']]);
  assert.equal(seen[0][2], 40);
  adm.close();
});

test('A1: a refusal through the read workers\' port is reported the same way', async () => {
  const adm = new Admission(), seen: string[] = []; adm.onRefused = (t, code) => { seen.push(`${t}:${code}`); };
  adm.setLoadLevel('black');
  const sent: PortDone[] = []; let on!: (m: unknown) => void;
  admissionPort(adm, {on: (_e, f) => { on = f; }, postMessage: m => { sent.push(m as PortDone); }}, async () => ({result: null}));
  on({t: 'job', id: 1, key: 'soul:sim_r_1', god: false, route: classify('GET', '/v1/edge/here'), payload: null});
  await tick();
  assert.equal(sent[0].refusal?.code, 'world.busy');
  assert.deepEqual(seen, ['sim_r_1:world.busy']);
  adm.close();
});

test('A1/A4 end to end: a refusal to a Soul\'s token marks its card once, and the card carries `slowed`; another Soul has no key', async () => {
  const f = fixture(join(mkdtempSync(join(tmpdir(), 'soul-slowed-')), 'sim.db'), factory); f.brain.quiesce();
  await invite(f, 'a'); const ada = await accept(f.host, f.souls.create('dev:a', {name: 'Slow Ada', description: 'scripted slowed test'}));
  const bo = await accept(f.host, f.souls.create('dev:a', {name: 'Quiet Bo', description: 'scripted slowed test'}));
  const token = f.souls.pairExchange(f.souls.pairCode(ada, 'http://127.0.0.1:6361').code, 'scripted').token;
  const card = (id: string) => f.host.publicSoul(f.host.minds.get(id)!);
  assert.ok(f.host.publicSlowedOf, 'buildApp wires the store');
  assert.equal('slowed' in card(ada.id), false, 'no new bytes for a Soul that is not slowed');
  const adm = new Admission(), dirty: string[] = [], mark = f.host.markSoulDirty.bind(f.host);
  f.host.markSoulDirty = id => { dirty.push(id); mark(id); };
  slowedFromRefusals({admission: adm, soulOf: t => f.souls.soulFromToken(t)?.id ?? null, host: f.host});
  adm.refused('soul:' + token, false, 'soul.slow-down', 60);
  adm.refused('soul:' + token, false, 'soul.slow-down', 60);
  assert.deepEqual(dirty, [ada.id], 'one event');
  assert.equal(card(ada.id).slowed?.reason, 'soul.slow-down');
  assert.ok(card(ada.id).slowed!.until > Date.now() + 55_000);
  assert.equal('slowed' in card(bo.id), false);
  adm.refused('god', true, 'world.busy', 5); adm.refused('soul:unknown-token', false, 'world.busy', 5);
  assert.deepEqual(dirty, [ada.id]);
  adm.close();
});
