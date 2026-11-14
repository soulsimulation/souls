// classroom-tv/1 (#2302): on a copy of an Eden world built from the template with fake minds, the policy step marks only the
// classroom screen a TV, logged and replayed to the same hash; then Souls in the classroom work it by offered ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {edenNavWorld} from '../test/eden-nav-fixture.ts';
import {accept} from '../test/native-owner-fixture.ts';
import {WorldHost} from './world.ts';
import {mountEdgeRoutes} from './edge/routes.ts';
import {installClassroomTv} from './classroom-tv.ts';

const SCREEN = 'eden-classroom-screen-1';

test('classroom-tv/1: the Eden classroom screen becomes a TV once, logged and replayed; Souls switch it and change the picture by offered ids', {timeout: 600000}, async t => {
  const w = await edenNavWorld(2), {f} = w, host = f.host;
  t.after(() => {host.stop(); f.db.close();});
  for (let i = 0; i < 5; i++) host.tickOnce();
  const ents = () => host.engine.world.entities as Record<string, any>;
  assert.deepEqual(ents()[SCREEN].equipment.config, {available: true, mode: 'on', content: 'Eden: observe, ask, give a direction, watch what changes.'});
  // the snapshot the migration is tried on first: everything else in Eden stays byte for byte
  host.saveSnapshot(true);
  const before = structuredClone(ents());
  const fact = await accept<unknown>(host, host.enableClassroomTvV1()) as {payload: {classroomTvV1: {screens: string[]}; runtimePolicy: {classroomTvV1: boolean}}};
  assert.deepEqual(fact.payload.classroomTvV1, {screens: [SCREEN]}, 'the screens it marked are logged with it');
  assert.equal(fact.payload.runtimePolicy.classroomTvV1, true);
  for (const [id, e] of Object.entries(before)) if (id !== SCREEN) assert.deepEqual(ents()[id], e, `${id} unchanged`);
  assert.deepEqual(ents()[SCREEN], {...before[SCREEN], equipment: {kind: 'display', config: {...before[SCREEN].equipment.config, tv: true, picture: 'lesson'}}}, 'only tv and picture added to the screen');
  assert.equal(await host.enableClassroomTvV1(), undefined, 'adopted once: a second call queues nothing');
  assert.equal(f.db.rulesEvents(host.worldId).filter(e => e.payload?.classroomTvV1).length, 1);
  // deterministic: the snapshot before it plus the logged event replays to the same state
  const hash = host.engine.stateHash();
  const replay = new WorldHost(f.db, w.fac, host.seed, 1e9, host.worldId, {durableClockV1: true});
  assert.equal(replay.boot().from, 'snapshot'); assert.equal(replay.engine.stateHash(), hash); replay.stop();

  // the TV for Souls
  const app = new Hono(); let soul = w.souls[0]!;
  const comms = mountEdgeRoutes(app, {host, db: f.db, souls: f.souls, ledger: w.ledger, soul: () => soul});
  t.after(() => comms.close());
  assert.equal(installClassroomTv(host, w.ledger), SCREEN);
  const tick = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}}};
  for (const s of w.souls) {
    soul = s; const r = await w.act(s, 'walk:eden-classroom-1') as {accepted: boolean; receipt: {id: string}};
    assert.equal(r.accepted, true, JSON.stringify(r)); await w.run([{soulId: s.soulId, id: r.receipt.id}], 6000);
    assert.equal(w.ledger.receipt(s.soulId, r.receipt.id)?.phase, 'completed', `${s.name} walked into the classroom`);
  }
  soul = w.souls[0]!;
  const offered = () => w.ledger.capabilities(soul).filter(c => c.object === SCREEN && c.available !== false).map(c => c.id).sort();
  const act = async (cap: string, accepted = true) => {const r = await accept<Response>(host, Promise.resolve(app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capability: cap})}))); const b = await r.json(); assert.equal(b.accepted, accepted, JSON.stringify(b)); return b;};
  const done = async (b: {receipt: {id: string}}) => {for (let n = 0; n < 600; n++) {const ph = w.ledger.receipt(soul.soulId, b.receipt.id)?.phase; if (['completed', 'failed', 'cancelled', 'replaced'].includes(ph ?? '')) return ph; await tick(1);} return 'timeout';};
  const cfg = () => ents()[SCREEN].equipment.config;
  assert.deepEqual(offered(), [`object:${SCREEN}:change-picture`, `object:${SCREEN}:switch-off`], 'on, showing the lesson: change the picture or switch off');
  assert.equal(await done(await act(`object:${SCREEN}:switch-off`)), 'completed'); assert.equal(cfg().mode, 'off');
  assert.deepEqual(offered(), [`object:${SCREEN}:switch-on`]);
  await act(`object:${SCREEN}:change-picture`, false);
  assert.equal(await done(await act(`object:${SCREEN}:switch-on`)), 'completed'); assert.equal(cfg().mode, 'on'); assert.equal(cfg().picture, 'lesson');
  const seen: string[] = [];
  for (let i = 0; i < 2; i++) {assert.equal(await done(await act(`object:${SCREEN}:change-picture`)), 'completed'); seen.push(cfg().picture);}
  assert.deepEqual(seen, ['garden', 'sea']);
  // the other Soul in the room sees the TV and its picture
  soul = w.souls[1]!; await tick(2);
  const here = await (await app.request('/v1/edge/here?include=doHere')).json() as {here: {objects?: {id: string; state?: Record<string, unknown>}[]}};
  assert.ok(here.here.objects?.some(o => o.id === SCREEN), 'the TV is among the things the other Soul sees');
  const read = await (await app.request(`/v1/edge/objects/${SCREEN}`)).json() as {object?: {state?: Record<string, unknown>}; state?: Record<string, unknown>};
  const st = read.object?.state ?? read.state;
  assert.equal(st?.on, true, JSON.stringify(read)); assert.equal(st?.picture, 'sea');
  assert.equal(await done(await act(`object:${SCREEN}:switch-off`)), 'completed', 'the other Soul switches it off'); assert.equal(cfg().mode, 'off');
  assert.deepEqual(host.engine.runtime.violations, []);
});
